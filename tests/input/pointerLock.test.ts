import { afterEach, describe, expect, it, vi } from 'vitest';
import { PointerLockController, type PointerLockDocument, type PointerLockTarget } from '../../src/input/PointerLock';
import { isMovementSpike, movementSteps, RelativePointer, SENSITIVITY_MAX, SENSITIVITY_MIN } from '../../src/input/RelativePointer';

describe('RelativePointer (lazer relative mode)', () => {
    const make = (w = 800, h = 600, x = 400, y = 300) => {
        const p = new RelativePointer();
        p.setBounds(w, h);
        p.reset(x, y);
        return p;
    };

    it('accumulates deltas, sub-pixel included', () => {
        const p = make();
        p.move(10, -5);
        p.move(0.25, 0.25);
        p.move(0.25, 0.25);
        expect(p.x).toBeCloseTo(410.5);
        expect(p.y).toBeCloseTo(295.5);
    });

    it('scales deltas by sensitivity', () => {
        const p = make();
        p.move(10, 10, 2.5);
        expect(p.x).toBe(425);
        expect(p.y).toBe(325);
        p.move(-100, 0, 0.1);
        expect(p.x).toBeCloseTo(415);
    });

    it('clamps to the screen and comes straight back from the edge (no debt)', () => {
        const p = make(800, 600, 790, 10);
        p.move(500, -500);
        expect(p.x).toBe(800);
        expect(p.y).toBe(0);
        p.move(-1, 1);
        expect(p.x).toBe(799);
        expect(p.y).toBe(1);
    });

    it('clamps the starting position and follows smaller bounds', () => {
        const p = make(800, 600, -50, 9999);
        expect(p.x).toBe(0);
        expect(p.y).toBe(600);
        p.reset(700, 500);
        p.setBounds(640, 480);
        expect(p.x).toBe(640);
        expect(p.y).toBe(480);
    });

    it('ignores non-finite deltas', () => {
        const p = make();
        p.move(NaN, 5);
        p.move(Infinity, 0);
        expect(p.x).toBe(400);
        expect(p.y).toBe(300);
    });

    it("uses lazer's sensitivity range", () => {
        expect(SENSITIVITY_MIN).toBe(0.1);
        expect(SENSITIVITY_MAX).toBe(10);
    });
});

describe('movement samples', () => {
    it('uses coalesced samples when they add up to the event', () => {
        const parts = [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: -1 }];
        expect(movementSteps({ x: 6, y: 0 }, parts)).toEqual(parts);
    });

    it('falls back to the total when coalesced movement is missing or repeated', () => {
        expect(movementSteps({ x: 6, y: 2 }, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toEqual([{ x: 6, y: 2 }]);
        expect(movementSteps({ x: 6, y: 2 }, [{ x: 6, y: 2 }, { x: 6, y: 2 }])).toEqual([{ x: 6, y: 2 }]);
        expect(movementSteps({ x: 6, y: 2 }, [{ x: 6, y: 2 }])).toEqual([{ x: 6, y: 2 }]);
        expect(movementSteps({ x: 6, y: 2 }, [])).toEqual([{ x: 6, y: 2 }]);
    });

    it('flags screen-crossing spikes only', () => {
        expect(isMovementSpike({ x: 40, y: -30 }, 1280, 720)).toBe(false);
        expect(isMovementSpike({ x: 1200, y: 0 }, 1280, 720)).toBe(false);
        expect(isMovementSpike({ x: 0, y: -5000 }, 1280, 720)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Controller against a fake DOM
// ---------------------------------------------------------------------------

type Behaviour = 'grant' | 'noRaw' | 'refuse' | 'legacy';

class FakeDoc extends EventTarget implements PointerLockDocument {
    pointerLockElement: unknown = null;
    hidden = false;
    exits = 0;
    hasFocus(): boolean {
        return true;
    }
    exitPointerLock(): void {
        this.exits++;
        this.setLock(null);
    }
    setLock(el: unknown): void {
        this.pointerLockElement = el;
        queueMicrotask(() => this.dispatchEvent(new Event('pointerlockchange')));
    }
}

class FakeTarget implements PointerLockTarget {
    calls: (boolean | undefined)[] = [];
    behaviour: Behaviour[] = [];
    constructor(private readonly doc: FakeDoc) {}
    requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void {
        const raw = options?.unadjustedMovement;
        this.calls.push(raw);
        const b = this.behaviour.shift() ?? 'grant';
        if (b === 'legacy') {
            this.doc.setLock(this);
            return;
        }
        if (b === 'refuse') {
            queueMicrotask(() => this.doc.dispatchEvent(new Event('pointerlockerror')));
            return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'SecurityError'));
        }
        if (b === 'noRaw' && raw) return Promise.reject(new DOMException('unadjustedMovement is not supported', 'NotSupportedError'));
        this.doc.setLock(this);
        return Promise.resolve();
    }
}

function setup(opts: { activation?: boolean; uiScale?: number } = {}) {
    const doc = new FakeDoc();
    const win = new EventTarget();
    const target = new FakeTarget(doc);
    const activation = { isActive: opts.activation ?? true };
    let now = 0;
    const uiScale = opts.uiScale ?? 1;
    const lock = new PointerLockController(target, {
        doc,
        win,
        userActivation: activation,
        now: () => now,
        toLogical: (x, y) => ({ x: x / uiScale, y: y / uiScale }),
        view: () => ({ width: 1000, height: 800, uiScale }),
    });
    const pointer = (type: string, o: Record<string, unknown> = {}) =>
        win.dispatchEvent(Object.assign(new Event(type), { pointerType: 'mouse', isPrimary: true, clientX: 0, clientY: 0, movementX: 0, movementY: 0, ...o }));
    const key = (code: string) => win.dispatchEvent(Object.assign(new Event('keydown'), { code, repeat: false }));
    const flush = () => new Promise<void>(r => setTimeout(r, 0));
    return { doc, win, target, lock, activation, pointer, key, flush, setNow: (t: number) => (now = t) };
}

describe('PointerLockController', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('locks with unadjustedMovement and drives the virtual cursor from movement × sensitivity', async () => {
        const t = setup({ uiScale: 2 });
        t.pointer('pointermove', { clientX: 400, clientY: 300 });
        t.lock.raw = true;
        t.lock.sensitivity = 1.5;
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([true]);
        expect(t.lock.locked).toBe(true);
        expect(t.lock.rawActive).toBe(true);
        // Starts where the OS cursor was (logical px).
        expect(t.lock.pointer.x).toBe(200);
        expect(t.lock.pointer.y).toBe(150);
        const moved: number[] = [];
        t.lock.moved.add((x, y) => moved.push(x, y));
        // Client position is frozen while locked; only movement counts. CSS px ÷ UI scale × sensitivity.
        t.pointer('pointermove', { clientX: 400, clientY: 300, movementX: 20, movementY: -10 });
        expect(t.lock.pointer.x).toBe(215);
        expect(t.lock.pointer.y).toBe(142.5);
        expect(moved).toEqual([215, 142.5]);
    });

    it('ignores sensitivity when only confining (no raw input)', async () => {
        const t = setup();
        t.pointer('pointermove', { clientX: 100, clientY: 100 });
        t.lock.raw = false;
        t.lock.sensitivity = 3;
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([undefined]);
        t.pointer('pointermove', { movementX: 10, movementY: 0 });
        expect(t.lock.pointer.x).toBe(110);
    });

    it('falls back to plain pointer lock where raw input is unsupported', async () => {
        const t = setup();
        t.target.behaviour = ['noRaw'];
        t.lock.raw = true;
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([true, undefined]);
        expect(t.lock.locked).toBe(true);
        expect(t.lock.rawUnsupported).toBe(true);
        expect(t.lock.rawActive).toBe(false);
        // Later locks skip the doomed raw request.
        t.lock.wanted = false;
        await t.flush();
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([true, undefined, undefined]);
    });

    it('works with the old event-only API', async () => {
        const t = setup();
        t.target.behaviour = ['legacy'];
        t.lock.wanted = true;
        await t.flush();
        expect(t.lock.locked).toBe(true);
    });

    it('waits for a user gesture instead of requesting without one', async () => {
        const t = setup({ activation: false });
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([]);
        t.activation.isActive = true;
        // Esc is never a gesture.
        t.key('Escape');
        expect(t.target.calls).toEqual([]);
        t.key('KeyZ');
        await t.flush();
        expect(t.lock.locked).toBe(true);
    });

    it('retries after Chrome\'s post-exit cooldown without unhandled rejections', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.target.behaviour = ['refuse'];
        t.lock.wanted = true;
        await vi.advanceTimersByTimeAsync(10);
        expect(t.lock.locked).toBe(false);
        expect(t.target.calls.length).toBe(1);
        await vi.advanceTimersByTimeAsync(1200);
        expect(t.target.calls.length).toBe(2);
        expect(t.lock.locked).toBe(true);
    });

    it('stops retrying once no longer wanted', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.target.behaviour = ['refuse'];
        t.lock.wanted = true;
        await vi.advanceTimersByTimeAsync(10);
        t.lock.wanted = false;
        await vi.advanceTimersByTimeAsync(5000);
        expect(t.target.calls.length).toBe(1);
        expect(t.lock.locked).toBe(false);
    });

    it('reports a lock lost to Esc, but not its own release', async () => {
        const t = setup();
        const lost = vi.fn();
        t.lock.lost.add(lost);
        t.lock.wanted = true;
        await t.flush();
        // Our own release (pause / fail / results).
        t.lock.wanted = false;
        await t.flush();
        expect(t.lock.locked).toBe(false);
        expect(lost).not.toHaveBeenCalled();
        // The user pressing Esc: the browser drops the lock by itself.
        t.lock.wanted = true;
        await t.flush();
        expect(t.lock.locked).toBe(true);
        t.setNow(5000);
        t.doc.setLock(null);
        await t.flush();
        expect(lost).toHaveBeenCalledTimes(1);
        expect(t.lock.lostWithin(500)).toBe(true);
        t.setNow(5600);
        expect(t.lock.lostWithin(500)).toBe(false);
    });

    it('hands a late grant straight back', async () => {
        const t = setup();
        t.lock.wanted = true;
        t.lock.wanted = false; // before the request resolved
        await t.flush();
        await t.flush();
        expect(t.lock.locked).toBe(false);
        expect(t.doc.exits).toBe(1);
    });

    it('steps aside for pens and touch, and relocks on the next mouse press', async () => {
        const t = setup();
        const lost = vi.fn();
        t.lock.lost.add(lost);
        t.lock.wanted = true;
        await t.flush();
        expect(t.lock.locked).toBe(true);
        t.pointer('pointermove', { pointerType: 'pen', clientX: 50, clientY: 60 });
        await t.flush();
        expect(t.lock.locked).toBe(false);
        expect(lost).not.toHaveBeenCalled();
        // Keys (tablet players tapping Z/X) don't take the pointer back.
        t.key('KeyX');
        t.pointer('pointerdown', { pointerType: 'touch' });
        await t.flush();
        expect(t.lock.locked).toBe(false);
        t.pointer('pointerdown', { clientX: 300, clientY: 200 });
        await t.flush();
        expect(t.lock.locked).toBe(true);
        expect(t.lock.pointer.x).toBe(300);
        expect(t.lock.pointer.y).toBe(200);
    });

    it('drops movement spikes', async () => {
        const t = setup();
        t.pointer('pointermove', { clientX: 500, clientY: 400 });
        t.lock.wanted = true;
        await t.flush();
        t.pointer('pointermove', { movementX: -40000, movementY: 3 });
        expect(t.lock.pointer.x).toBe(500);
        expect(t.lock.pointer.y).toBe(400);
    });
});

describe('PointerLockController where locking never works', () => {
    it('gives up after a few attempts until wanted again', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.target.behaviour = Array(100).fill('refuse');
        t.lock.wanted = true;
        for (let i = 0; i < 20; i++) {
            t.key('KeyZ');
            t.pointer('pointerdown');
            await vi.advanceTimersByTimeAsync(1500);
        }
        expect(t.target.calls.length).toBe(8);
        t.lock.wanted = false;
        t.lock.wanted = true;
        await vi.advanceTimersByTimeAsync(10);
        expect(t.target.calls.length).toBe(9);
        vi.useRealTimers();
    });
});
