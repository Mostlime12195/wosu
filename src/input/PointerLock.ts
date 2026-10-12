import { Signal } from '../core/Signal';
import { isMovementSpike, movementSteps, RelativePointer, type Delta } from './RelativePointer';

/** The element the pointer locks to (the game canvas). */
export interface PointerLockTarget {
    requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
}

/** The parts of `document` the controller uses. */
export interface PointerLockDocument extends EventTarget {
    readonly pointerLockElement: unknown;
    readonly hidden?: boolean;
    exitPointerLock(): void;
    hasFocus?(): boolean;
}

/** Where the controller lives: DOM, clock, and the UI's coordinate space. */
export interface PointerLockEnv {
    doc: PointerLockDocument;
    /** Receives pointer and key events (window). */
    win: EventTarget;
    /** navigator.userActivation, where the browser has it. */
    userActivation?: { readonly isActive: boolean } | null;
    now(): number;
    /** Client (CSS px) → logical UI px. */
    toLogical(clientX: number, clientY: number): { x: number; y: number };
    /** Logical screen size and CSS px per logical px. */
    view(): { width: number; height: number; uiScale: number };
}

/** Chrome refuses a new lock for about a second after the user leaves one. */
const RETRY_MS = 1100;
const MAX_RETRIES = 3;
/**
 * Requests per stretch of wanting the lock before giving up until it is
 * wanted again (a page that may never lock, e.g. a sandboxed iframe,
 * shouldn't request on every key press).
 */
const MAX_ATTEMPTS = 8;
/** A request the browser never answers (old event-only API) counts as failed after this. */
const REQUEST_TIMEOUT_MS = 2000;

/**
 * Pointer lock for gameplay: the browser's take on lazer's "High precision
 * mouse" (relative mode, raw input) and "Confine mouse cursor to window".
 *
 * While locked, mouse movement drives a virtual cursor (`pointer`) from
 * movementX/Y: times the cursor sensitivity in raw mode, 1:1 when only
 * confining, clamped to the screen. Everything that reads the gameplay
 * pointer (InputManager, GameplayInput, the cursor trail) uses that
 * position while `locked`; pens and touches stay absolute (like lazer,
 * which never applies mouse sensitivity to tablets): pen or touch input
 * hands the lock back until the mouse is used again.
 *
 * The owner sets `wanted` (gameplay running with the setting on). Locks
 * need a user gesture, so a request that can't succeed now (no recent
 * click or key, Chrome's cooldown after Esc) waits for the next mouse
 * press or key press, or retries once the cooldown has passed. Losing the
 * lock while still wanted (Esc, the browser taking it back) emits `lost`
 * so gameplay can pause. Nothing here throws or leaves a rejected promise
 * unhandled.
 */
export class PointerLockController {
    readonly pointer = new RelativePointer();
    /** The lock went away while still wanted (Esc, focus loss): gameplay should pause. */
    readonly lost = new Signal<[]>();
    /** The lock engaged or released. */
    readonly lockChanged = new Signal<[locked: boolean]>();
    /** Each virtual-cursor sample while locked (logical px), for the trail. */
    readonly moved = new Signal<[x: number, y: number]>();
    /** Request raw (unaccelerated) movement and apply `sensitivity`. */
    raw = false;
    sensitivity = 1;
    /** The browser refused `unadjustedMovement`; locks are plain from then on. */
    rawUnsupported = false;
    /** The current lock was granted with `unadjustedMovement`. */
    rawActive = false;

    private _wanted = false;
    private _locked = false;
    private requesting = false;
    /** We asked for the release (not the user's Esc). */
    private releasing = false;
    /** Pen or touch input took over: no lock until the mouse is used again. */
    private absoluteDevice = false;
    private retries = 0;
    private attempts = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private lastLostAt = -Infinity;
    /** Last absolute mouse position (logical), where the virtual cursor starts. */
    private lastX = 0;
    private lastY = 0;
    private lastSeen = false;

    constructor(private readonly target: PointerLockTarget, private readonly env: PointerLockEnv) {
        const capture = { capture: true, passive: true } as const;
        // Capture on window runs before every bubble listener, so the virtual
        // position is current by the time InputManager and gameplay read it.
        env.win.addEventListener('pointermove', e => this.onMove(e as PointerEvent), capture);
        env.win.addEventListener('pointerdown', e => this.onDown(e as PointerEvent), capture);
        env.win.addEventListener('keydown', e => this.onKey(e as KeyboardEvent), capture);
        env.doc.addEventListener('pointerlockchange', () => this.onLockChange());
        // Failures are handled where the request is made; this only keeps them quiet.
        env.doc.addEventListener('pointerlockerror', () => {});
    }

    static supported(target: unknown): boolean {
        return typeof (target as Partial<PointerLockTarget> | null)?.requestPointerLock === 'function';
    }

    get supported(): boolean {
        return PointerLockController.supported(this.target);
    }

    /** The pointer is locked to the game: positions come from `pointer`. */
    get locked(): boolean {
        return this._locked;
    }

    get wanted(): boolean {
        return this._wanted;
    }

    set wanted(v: boolean) {
        if (v === this._wanted) return;
        this._wanted = v;
        this.clearRetry();
        this.retries = 0;
        this.attempts = 0;
        if (v) this.tryAcquire();
        else this.release();
    }

    /** The lock was lost involuntarily within the last `ms` (the Esc that did it may still arrive as a key). */
    lostWithin(ms: number): boolean {
        return this.env.now() - this.lastLostAt <= ms;
    }

    /** Ask for the lock now if it could work (wanted, focused, recent user gesture). */
    tryAcquire(): void {
        if (!this._wanted || this._locked || this.requesting || this.absoluteDevice || !this.supported) return;
        const doc = this.env.doc;
        if (doc.hidden || (doc.hasFocus && !doc.hasFocus())) return;
        // Without a recent gesture the browser refuses anyway; wait for one.
        if (this.env.userActivation && !this.env.userActivation.isActive) return;
        if (this.attempts >= MAX_ATTEMPTS) return;
        this.attempts++;
        this.requesting = true;
        void this.acquire().finally(() => (this.requesting = false));
    }

    private async acquire(): Promise<void> {
        const raw = this.raw && !this.rawUnsupported;
        try {
            await this.lockOnce(raw);
            this.rawActive = raw;
            return;
        } catch (e) {
            if (raw && isUnsupported(e)) {
                // No raw input here (Linux, older browsers): plain pointer lock instead.
                this.rawUnsupported = true;
                try {
                    await this.lockOnce(false);
                    this.rawActive = false;
                    return;
                } catch {
                    /* fall through to the retry */
                }
            }
        }
        if (this._locked || !this._wanted) return;
        // Most likely Chrome's cooldown after leaving a lock: try again once it
        // has passed, while the gesture still counts; otherwise the next press does.
        if (this.retries < MAX_RETRIES) {
            this.retries++;
            this.clearRetry();
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.tryAcquire();
            }, RETRY_MS);
        }
    }

    /**
     * One lock request, settled by its promise where the browser returns one
     * (Chrome, recent Firefox / Safari), else by the lock events.
     */
    private lockOnce(raw: boolean): Promise<void> {
        const doc = this.env.doc;
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                doc.removeEventListener('pointerlockchange', onChange);
                doc.removeEventListener('pointerlockerror', onError);
                if (error === undefined) resolve();
                else reject(error);
            };
            const onChange = () => {
                if (doc.pointerLockElement === this.target) finish();
            };
            const onError = () => finish(new Error('pointer lock refused'));
            const timer = setTimeout(() => finish(new Error('pointer lock timed out')), REQUEST_TIMEOUT_MS);
            let result: Promise<void> | void;
            try {
                result = raw ? this.target.requestPointerLock({ unadjustedMovement: true }) : this.target.requestPointerLock();
            } catch (e) {
                finish(e);
                return;
            }
            if (result && typeof result.then === 'function') {
                result.then(() => finish(), e => finish(e ?? new Error('pointer lock refused')));
            } else {
                doc.addEventListener('pointerlockchange', onChange);
                doc.addEventListener('pointerlockerror', onError);
            }
        });
    }

    /** Give the pointer back (pause, fail, results, leaving gameplay). */
    release(): void {
        this.clearRetry();
        if (this.env.doc.pointerLockElement !== this.target) return;
        this.releasing = true;
        try {
            this.env.doc.exitPointerLock();
        } catch {
            this.releasing = false;
        }
    }

    private clearRetry(): void {
        if (this.retryTimer === null) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private onLockChange(): void {
        const locked = this.env.doc.pointerLockElement === this.target;
        if (locked === this._locked) return;
        this._locked = locked;
        if (locked) {
            this.clearRetry();
            this.retries = 0;
            this.attempts = 0;
            const v = this.env.view();
            this.pointer.setBounds(v.width, v.height);
            // Locked by a key before the mouse ever moved: start in the middle.
            if (this.lastSeen) this.pointer.reset(this.lastX, this.lastY);
            else this.pointer.reset(v.width / 2, v.height / 2);
            // Granted after it stopped being wanted (a slow request): hand it straight back.
            if (!this._wanted) this.release();
        } else {
            this.rawActive = false;
            const voluntary = this.releasing;
            this.releasing = false;
            if (!voluntary && this._wanted) {
                this.lastLostAt = this.env.now();
                this.lost.emit();
            }
        }
        this.lockChanged.emit(locked);
    }

    private onMove(e: PointerEvent): void {
        if (e.pointerType !== 'mouse') {
            this.onAbsoluteDevice();
            return;
        }
        if (!this._locked) {
            if (e.isPrimary) this.track(e);
            return;
        }
        const v = this.env.view();
        this.pointer.setBounds(v.width, v.height);
        const scale = (this.raw ? this.sensitivity : 1) / (v.uiScale || 1);
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const steps = movementSteps({ x: e.movementX, y: e.movementY }, events.map(c => ({ x: c.movementX, y: c.movementY })));
        const screenW = v.width * v.uiScale, screenH = v.height * v.uiScale;
        for (const d of steps) this.step(d, scale, screenW, screenH);
    }

    private track(e: PointerEvent): void {
        const p = this.env.toLogical(e.clientX, e.clientY);
        this.lastX = p.x;
        this.lastY = p.y;
        this.lastSeen = true;
    }

    private step(d: Delta, scale: number, screenW: number, screenH: number): void {
        if ((d.x === 0 && d.y === 0) || isMovementSpike(d, screenW, screenH)) return;
        this.pointer.move(d.x, d.y, scale);
        this.moved.emit(this.pointer.x, this.pointer.y);
    }

    private onDown(e: PointerEvent): void {
        if (e.pointerType !== 'mouse') {
            this.onAbsoluteDevice();
            return;
        }
        if (!this._locked) this.track(e);
        this.absoluteDevice = false;
        this.tryAcquire();
    }

    private onKey(e: KeyboardEvent): void {
        // Esc never counts as a user gesture (and means "let go" anyway).
        if (e.code === 'Escape' || e.repeat) return;
        this.tryAcquire();
    }

    /** A pen or touch: those position absolutely, so the lock steps aside. */
    private onAbsoluteDevice(): void {
        if (this.absoluteDevice) return;
        this.absoluteDevice = true;
        this.clearRetry();
        this.release();
    }
}

function isUnsupported(e: unknown): boolean {
    const name = (e as { name?: unknown } | null)?.name;
    return name === 'NotSupportedError' || name === 'TypeError' || e instanceof TypeError;
}
