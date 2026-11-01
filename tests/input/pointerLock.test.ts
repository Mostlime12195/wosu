import { afterEach, describe, expect, it, vi } from 'vitest';
import { movementScale, PointerLockController, rawCountsInDevicePixels, setVirtualPointerSource, virtualCanvasPoint, type PointerLockDocument, type PointerLockTarget } from '../../src/input/PointerLock';
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

function setup(opts: { activation?: boolean; uiScale?: number; dpr?: number } = {}) {
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
        view: () => ({ width: 1000, height: 800, uiScale, dpr: opts.dpr ?? 1 }),
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
        t.lock.relative = true;
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
        t.lock.relative = true;
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

describe('movement scale', () => {
    it('moves one device pixel per raw count at 1x (lazer / stable raw input)', () => {
        expect(movementScale({ relative: true, rawActive: true, sensitivity: 1, uiScale: 1, dpr: 2, rawInDevicePixels: true })).toBe(0.5);
        expect(movementScale({ relative: true, rawActive: true, sensitivity: 3, uiScale: 1.5, dpr: 2, rawInDevicePixels: true })).toBe(1);
    });

    it('scales the OS cursor motion (CSS px) by the sensitivity without raw input', () => {
        expect(movementScale({ relative: true, rawActive: false, sensitivity: 2, uiScale: 1, dpr: 2, rawInDevicePixels: true })).toBe(2);
        expect(movementScale({ relative: true, rawActive: false, sensitivity: 2, uiScale: 2, dpr: 1, rawInDevicePixels: true })).toBe(1);
    });

    it('moves one point per raw count on macOS (no Retina halving)', () => {
        expect(rawCountsInDevicePixels('macOS')).toBe(false);
        expect(rawCountsInDevicePixels('MacIntel')).toBe(false);
        expect(rawCountsInDevicePixels('Windows')).toBe(true);
        expect(rawCountsInDevicePixels('Linux x86_64')).toBe(true);
        expect(movementScale({ relative: true, rawActive: true, sensitivity: 1, uiScale: 1, dpr: 2, rawInDevicePixels: false })).toBe(1);
    });

    it('follows the OS cursor 1:1 when only confining', () => {
        expect(movementScale({ relative: false, rawActive: false, sensitivity: 5, uiScale: 2, dpr: 2, rawInDevicePixels: true })).toBe(0.5);
        expect(movementScale({ relative: false, rawActive: false, sensitivity: 5, uiScale: 0, dpr: 0, rawInDevicePixels: true })).toBe(1);
    });
});

describe('PointerLockController everywhere (menus included)', () => {
    afterEach(() => {
        vi.useRealTimers();
        setVirtualPointerSource(null);
    });

    it('applies the sensitivity per device pixel with raw input', async () => {
        const t = setup({ dpr: 2 });
        t.lock.rawInDevicePixels = true; // Windows / Linux
        t.pointer('pointermove', { clientX: 500, clientY: 400 });
        t.lock.raw = true;
        t.lock.relative = true;
        t.lock.sensitivity = 2;
        t.lock.wanted = true;
        await t.flush();
        t.pointer('pointermove', { movementX: 10, movementY: -4 });
        expect(t.lock.pointer.x).toBe(510);
        expect(t.lock.pointer.y).toBe(396);
    });

    it('exposes the virtual cursor in canvas CSS px for Pixi and DOM listeners', async () => {
        const t = setup({ uiScale: 2 });
        setVirtualPointerSource(t.lock);
        t.pointer('pointermove', { clientX: 300, clientY: 200 });
        expect(t.lock.virtualClient()).toBeNull();
        t.lock.wanted = true;
        await t.flush();
        expect(t.lock.virtual).toBe(true);
        t.pointer('pointermove', { movementX: 20, movementY: 0 });
        // Logical (150 + 10, 100) × UI scale 2.
        expect(t.lock.virtualClient()).toEqual({ x: 320, y: 200 });
        expect(virtualCanvasPoint({ pointerType: 'mouse' })).toEqual({ x: 320, y: 200 });
        expect(virtualCanvasPoint({ pointerType: 'pen' })).toBeNull();
        // A pen takes over: positions are absolute again at once, before the lock is even gone.
        t.pointer('pointerdown', { pointerType: 'pen' });
        expect(t.lock.virtual).toBe(false);
        expect(virtualCanvasPoint({ pointerType: 'mouse' })).toBeNull();
    });

    it('lets go while suspended and comes back without a new gesture', async () => {
        const t = setup();
        const lost = vi.fn();
        t.lock.lost.add(lost);
        t.lock.wanted = true;
        await t.flush();
        expect(t.lock.locked).toBe(true);
        t.pointer('pointermove', { movementX: 25, movementY: 0 });
        const resume = t.lock.suspend();
        await t.flush();
        expect(t.lock.locked).toBe(false);
        expect(lost).not.toHaveBeenCalled();
        // The file dialog's click is long gone.
        t.activation.isActive = false;
        resume();
        resume(); // idempotent
        await t.flush();
        expect(t.lock.locked).toBe(true);
        expect(t.target.calls.length).toBe(2);
        // Carries on from the virtual cursor, not the frozen OS position.
        expect(t.lock.pointer.x).toBe(525);
    });

    it('tries the gesture-less relock only once, then waits for a click', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.lock.wanted = true;
        await vi.advanceTimersByTimeAsync(10);
        const resume = t.lock.suspend();
        await vi.advanceTimersByTimeAsync(10);
        t.activation.isActive = false;
        // Chrome refuses it.
        t.target.behaviour = ['refuse'];
        resume();
        await vi.advanceTimersByTimeAsync(5000);
        t.win.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(t.target.calls.length).toBe(2);
        expect(t.lock.locked).toBe(false);
        t.activation.isActive = true;
        t.pointer('pointerdown');
        await vi.advanceTimersByTimeAsync(10);
        expect(t.lock.locked).toBe(true);
    });

    it("drops Chrome's jump on the first locked sample only", async () => {
        const t = setup();
        t.pointer('pointermove', { clientX: 500, clientY: 400 });
        t.lock.wanted = true;
        await t.flush();
        t.pointer('pointermove', { movementX: 282, movementY: 312 });
        expect(t.lock.pointer.x).toBe(500);
        t.pointer('pointermove', { movementX: 100, movementY: 0 });
        expect(t.lock.pointer.x).toBe(600);
    });

    it('takes locked movement from pointerrawupdate alone once it arrives (never twice)', async () => {
        const t = setup();
        t.pointer('pointermove', { clientX: 500, clientY: 400 });
        t.lock.wanted = true;
        await t.flush();
        // No rawupdate yet: pointermove moves it.
        t.pointer('pointermove', { movementX: 10, movementY: 0 });
        expect(t.lock.pointer.x).toBe(510);
        t.pointer('pointerrawupdate', { movementX: 4, movementY: 0 });
        t.pointer('pointerrawupdate', { movementX: 6, movementY: 0 });
        // The frame's pointermove reports the same motion again.
        t.pointer('pointermove', { movementX: 10, movementY: 0 });
        expect(t.lock.pointer.x).toBe(520);
        // Unlocked rawupdates move nothing.
        t.lock.wanted = false;
        await t.flush();
        t.pointer('pointerrawupdate', { movementX: 50, movementY: 0 });
        expect(t.lock.pointer.x).toBe(520);
    });

    it('needs a new click after the user leaves with Esc', async () => {
        const t = setup();
        t.lock.wanted = true;
        await t.flush();
        t.activation.isActive = false;
        t.doc.setLock(null);
        await t.flush();
        t.win.dispatchEvent(new Event('focus'));
        await t.flush();
        expect(t.lock.locked).toBe(false);
        expect(t.target.calls.length).toBe(1);
        t.activation.isActive = true;
        t.pointer('pointerdown', { clientX: 10, clientY: 20 });
        await t.flush();
        expect(t.lock.locked).toBe(true);
    });

    it('only takes the pointer on a click in menus (keyGestures off)', async () => {
        const t = setup({ activation: false });
        t.lock.keyGestures = false;
        t.lock.wanted = true;
        t.activation.isActive = true;
        t.key('KeyA');
        await t.flush();
        expect(t.target.calls).toEqual([]);
        t.pointer('pointerdown');
        await t.flush();
        expect(t.lock.locked).toBe(true);
    });

    it('relocks in the new mode when high precision is toggled while locked', async () => {
        const t = setup();
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([undefined]);
        t.activation.isActive = false;
        t.lock.raw = true;
        t.lock.relative = true;
        await t.flush();
        await t.flush();
        expect(t.target.calls).toEqual([undefined, true]);
        expect(t.lock.locked).toBe(true);
        expect(t.lock.rawActive).toBe(true);
    });

    it('waits for focus before asking', async () => {
        const t = setup();
        let focused = false;
        t.doc.hasFocus = () => focused;
        t.lock.wanted = true;
        await t.flush();
        expect(t.target.calls).toEqual([]);
        focused = true;
        t.win.dispatchEvent(new Event('focus'));
        await t.flush();
        expect(t.lock.locked).toBe(true);
    });
});
