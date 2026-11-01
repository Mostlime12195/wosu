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
    /** Logical screen size, CSS px per logical px and device px per CSS px. */
    view(): { width: number; height: number; uiScale: number; dpr?: number };
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
 * Whether raw (`unadjustedMovement`) mouse counts land on device pixels.
 * Windows and Linux move the system cursor one physical pixel per count
 * (osu! raw input at 1x), so at a display scale above 100% a count is less
 * than a CSS px. macOS moves it in points, which are CSS px: dividing by
 * the Retina pixel ratio there made 1x half as fast as the system cursor.
 */
export function rawCountsInDevicePixels(platform: string): boolean {
    return !/mac|iphone|ipad|ios/i.test(platform);
}

const RAW_IN_DEVICE_PIXELS = rawCountsInDevicePixels(
    typeof navigator === 'undefined'
        ? ''
        : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '',
);

/**
 * Pointer lock: the browser's take on lazer's "High precision mouse"
 * (relative mode, raw input) and "Confine mouse cursor to window".
 *
 * While locked, mouse movement drives a virtual cursor (`pointer`) from
 * movementX/Y, clamped to the screen: times the cursor sensitivity in raw
 * mode, 1:1 with the OS cursor when only confining. Everything that reads
 * the pointer (InputManager, Pixi's event system, GameplayInput, the
 * cursors) uses that position while `virtual`; pens and touches stay
 * absolute (like lazer, which never applies mouse sensitivity to
 * tablets): pen or touch input hands the lock back until the mouse is
 * used again.
 *
 * The owner sets `wanted` (Game: from the settings and the screen), and
 * `suspend()` hands the pointer back for a while (file dialogs). Locks
 * need a user gesture, so a request that can't succeed now (no recent
 * click or key, Chrome's cooldown after Esc, the window unfocused) waits
 * for the next mouse press (or key press, with `keyGestures`), or retries
 * once the cooldown has passed. After our own release the browser needs
 * no new gesture, so that lock comes straight back. Losing the lock while
 * still wanted (Esc, the window losing focus) emits `lost` so gameplay can
 * pause. Nothing here throws or leaves a rejected promise unhandled.
 */
export class PointerLockController {
    readonly pointer = new RelativePointer();
    /** The lock went away while still wanted (Esc, focus loss): gameplay should pause. */
    readonly lost = new Signal<[]>();
    /** The lock engaged or released. */
    readonly lockChanged = new Signal<[locked: boolean]>();
    /** Each virtual-cursor sample while locked (logical px), for the trail. */
    readonly moved = new Signal<[x: number, y: number]>();
    sensitivity = 1;
    /** High precision mouse: movement is scaled by `sensitivity` (else it follows the OS cursor 1:1). */
    relative = false;
    /** Raw counts are device pixels on this platform (see rawCountsInDevicePixels). */
    rawInDevicePixels = RAW_IN_DEVICE_PIXELS;
    /** The browser refused `unadjustedMovement`; locks are plain from then on. */
    rawUnsupported = false;
    /** The current lock was granted with `unadjustedMovement`. */
    rawActive = false;
    /** Key presses count as the gesture that (re)takes the lock (gameplay); otherwise only mouse presses do. */
    keyGestures = true;

    private _wanted = false;
    private _raw = false;
    /** Our release is only to lock again in the other mode (raw ↔ plain). */
    private relocking = false;
    /** Outstanding `suspend()` holds. */
    private holds = 0;
    /** The last lock ended by our own release (the spec lets the page relock without a gesture). */
    private releasedByUs = false;
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
    /** No movement applied since the lock engaged (Chrome's first locked sample can be a jump). */
    private freshLock = false;
    /** This lock's movement arrives as pointerrawupdate (pointermove's is then the same motion again). */
    private rawUpdates = false;

    constructor(private readonly target: PointerLockTarget, private readonly env: PointerLockEnv) {
        const capture = { capture: true, passive: true } as const;
        // Capture on window runs before every bubble listener, so the virtual
        // position is current by the time InputManager and gameplay read it.
        env.win.addEventListener('pointermove', e => this.onMove(e as PointerEvent), capture);
        env.win.addEventListener('pointerrawupdate', e => this.onRawUpdate(e as PointerEvent), capture);
        env.win.addEventListener('pointerdown', e => this.onDown(e as PointerEvent), capture);
        env.win.addEventListener('keydown', e => this.onKey(e as KeyboardEvent), capture);
        env.doc.addEventListener('pointerlockchange', () => this.onLockChange());
        // Back from an OS dialog or another window: a lock we let go of returns without a click.
        env.win.addEventListener('focus', () => this.tryAcquire());
        // Failures are handled where the request is made; this only keeps them quiet.
        env.doc.addEventListener('pointerlockerror', () => {});
    }

    static supported(target: unknown): boolean {
        return typeof (target as Partial<PointerLockTarget> | null)?.requestPointerLock === 'function';
    }

    get supported(): boolean {
        return PointerLockController.supported(this.target);
    }

    /** The pointer is locked to the game. */
    get locked(): boolean {
        return this._locked;
    }

    /** Mouse positions come from the virtual cursor (`pointer`): locked, and no pen or touch took over. */
    get virtual(): boolean {
        return this._locked && !this.absoluteDevice;
    }

    /** The virtual cursor in CSS px from the canvas's top-left (Pixi's screen space), or null when not `virtual`. */
    virtualClient(): { x: number; y: number } | null {
        if (!this.virtual) return null;
        const k = this.env.view().uiScale || 1;
        return { x: this.pointer.x * k, y: this.pointer.y * k };
    }

    get wanted(): boolean {
        return this._wanted;
    }

    /** Request raw (unaccelerated) movement (high precision mouse with raw input). */
    get raw(): boolean {
        return this._raw;
    }

    set raw(v: boolean) {
        if (v === this._raw) return;
        this._raw = v;
        // A lock taken in the other mode is retaken in this one (no gesture needed after our own release).
        if (this._locked && this.active && v !== this.rawActive && !(v && this.rawUnsupported)) {
            this.relocking = true;
            this.release();
        }
    }

    set wanted(v: boolean) {
        if (v === this._wanted) return;
        const before = this.active;
        this._wanted = v;
        this.sync(before);
    }

    /** Wanted and not suspended. */
    private get active(): boolean {
        return this._wanted && this.holds === 0;
    }

    /**
     * Hand the pointer back until the returned function is called (an
     * OS dialog such as a file picker needs the real cursor). Releasing it
     * ourselves also lets the lock return afterwards without a new click.
     */
    suspend(): () => void {
        const before = this.active;
        this.holds++;
        this.sync(before);
        let done = false;
        return () => {
            if (done) return;
            done = true;
            const was = this.active;
            this.holds--;
            this.sync(was);
        };
    }

    private sync(before: boolean): void {
        const now = this.active;
        if (now === before) return;
        this.clearRetry();
        this.retries = 0;
        this.attempts = 0;
        if (now) this.tryAcquire();
        else this.release();
    }

    /** The lock was lost involuntarily within the last `ms` (the Esc that did it may still arrive as a key). */
    lostWithin(ms: number): boolean {
        return this.env.now() - this.lastLostAt <= ms;
    }

    /** When the lock was last lost involuntarily (env clock). */
    get lostAt(): number {
        return this.lastLostAt;
    }

    /** Ask for the lock now if it could work (wanted, focused, recent user gesture or our own release). */
    tryAcquire(): void {
        if (!this.active || this._locked || this.requesting || this.absoluteDevice || !this.supported) return;
        const doc = this.env.doc;
        if (doc.hidden || (doc.hasFocus && !doc.hasFocus())) return;
        // Without a recent gesture the browser refuses, so wait for one. The spec
        // lets a page retake a lock it let go of itself without one: that gets one
        // try (Chrome refuses it too, so it costs no attempt and waits for a click).
        const gesture = !this.env.userActivation || this.env.userActivation.isActive;
        if (!gesture && !this.releasedByUs) return;
        this.releasedByUs = false;
        if (gesture) {
            if (this.attempts >= MAX_ATTEMPTS) return;
            this.attempts++;
        }
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
        if (this._locked || !this.active) return;
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
            this.freshLock = true;
            this.rawUpdates = false;
            const v = this.env.view();
            this.pointer.setBounds(v.width, v.height);
            // Locked by a key before the mouse ever moved: start in the middle.
            if (this.lastSeen) this.pointer.reset(this.lastX, this.lastY);
            else this.pointer.reset(v.width / 2, v.height / 2);
            // Granted after it stopped being wanted (a slow request): hand it straight back.
            if (!this.active) this.release();
        } else {
            this.rawActive = false;
            const voluntary = this.releasing;
            this.releasing = false;
            this.releasedByUs = voluntary;
            // A lock retaken before the mouse moves carries on from the virtual cursor.
            this.lastX = this.pointer.x;
            this.lastY = this.pointer.y;
            this.lastSeen = true;
            if (!voluntary && this._wanted) {
                this.lastLostAt = this.env.now();
                this.lost.emit();
            }
        }
        this.lockChanged.emit(locked);
        if (!locked && this.relocking) {
            this.relocking = false;
            this.tryAcquire();
        }
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
        // Movement already came in through pointerrawupdate (one source, never counted twice).
        if (!this.rawUpdates) this.applyMovement(e);
    }

    /**
     * Chrome's pointerrawupdate: every mouse sample as it arrives, not once
     * per displayed frame like pointermove, so frames drawn above the
     * refresh rate (low latency mode) see fresh positions. Once one arrives
     * while locked, movement comes from these alone.
     */
    private onRawUpdate(e: PointerEvent): void {
        if (e.pointerType !== 'mouse' || !this._locked) return;
        this.rawUpdates = true;
        this.applyMovement(e);
    }

    private applyMovement(e: PointerEvent): void {
        const v = this.env.view();
        this.pointer.setBounds(v.width, v.height);
        const scale = movementScale({
            relative: this.relative, rawActive: this.rawActive, sensitivity: this.sensitivity,
            uiScale: v.uiScale, dpr: v.dpr ?? 1, rawInDevicePixels: this.rawInDevicePixels,
        });
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
        if (d.x === 0 && d.y === 0) return;
        const first = this.freshLock;
        this.freshLock = false;
        if (isMovementSpike(d, screenW, screenH) || (first && isLockJump(d))) return;
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
        // Esc never counts as a user gesture (and means "let go" anyway); shortcuts (Ctrl+O…) aren't aiming.
        if (!this.keyGestures || e.code === 'Escape' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
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

/**
 * Chrome's first movement after the lock engages sometimes reports the
 * distance from a stale position (a jump of hundreds of px); a real first
 * sample is a few px.
 */
export function isLockJump(d: Delta): boolean {
    return Math.abs(d.x) > 64 || Math.abs(d.y) > 64;
}

/**
 * Logical px per reported movement unit. High precision mouse (`relative`)
 * scales movement by the sensitivity: raw counts (`rawActive`) move one
 * system-cursor unit each at 1x (a device pixel on Windows/Linux, a point
 * on macOS, see rawCountsInDevicePixels), and without raw input the
 * browser reports the OS cursor's own (accelerated) motion in CSS px.
 * Confine only: 1:1 with the OS cursor.
 */
export function movementScale(o: { relative: boolean; rawActive: boolean; sensitivity: number; uiScale: number; dpr: number; rawInDevicePixels: boolean }): number {
    const ui = o.uiScale > 0 ? o.uiScale : 1;
    if (!o.relative) return 1 / ui;
    const dpr = o.rawActive && o.rawInDevicePixels && o.dpr > 0 ? o.dpr : 1;
    return o.sensitivity / (ui * dpr);
}

function isUnsupported(e: unknown): boolean {
    const name = (e as { name?: unknown } | null)?.name;
    return name === 'NotSupportedError' || name === 'TypeError' || e instanceof TypeError;
}

let virtualSource: PointerLockController | null = null;

/** The game's pointer lock, for code that reads raw DOM pointer events (see `virtualCanvasPoint`). */
export function setVirtualPointerSource(lock: PointerLockController | null): void {
    virtualSource = lock;
}

/**
 * Where a DOM mouse event really points while the pointer is locked: the
 * virtual cursor in CSS px from the canvas's top-left (Pixi's global
 * space). Null when the event's own client position is valid.
 */
export function virtualCanvasPoint(e: { readonly pointerType?: string }): { x: number; y: number } | null {
    if (!virtualSource || (e.pointerType !== undefined && e.pointerType !== 'mouse')) return null;
    return virtualSource.virtualClient();
}

/**
 * Open a file input's dialog with the pointer let go (an OS dialog needs
 * the real cursor). The lock comes back by itself once the dialog closes:
 * after our own release the browser allows that without a click.
 */
export function openFileDialog(el: HTMLInputElement): void {
    const resume = virtualSource?.suspend() ?? (() => {});
    const done = () => {
        el.removeEventListener('change', done);
        el.removeEventListener('cancel', done);
        window.removeEventListener('focus', onFocus);
        resume();
    };
    // The window gets focus back when the dialog closes (before `change` in some browsers; older ones have no `cancel`).
    const onFocus = () => setTimeout(done, 0);
    el.addEventListener('change', done);
    el.addEventListener('cancel', done);
    window.addEventListener('focus', onFocus);
    try {
        el.click();
    } catch {
        done();
    }
}
