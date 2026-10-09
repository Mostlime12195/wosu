import { Easing, type EasingFn, type EasingName } from './easing';

/**
 * Property tween engine for UI animation (osu-framework "transforms").
 *
 * Gameplay visuals are NOT driven by this: they are computed analytically
 * from the audio clock every frame so they stay exact under pause/seek.
 * UI motion (menus, overlays, buttons) uses wall-clock tweens instead.
 *
 * Starting a tween on a property that is already tweening replaces the
 * old tween for that property only (later instruction wins, like
 * osu-framework's transform clearing), so hover in/out spam is safe.
 */
export interface TweenOptions {
    duration?: number;
    ease?: EasingName | EasingFn;
    delay?: number;
    onUpdate?: (t: number) => void;
    onComplete?: () => void;
    /**
     * Stops the tween once destroyed. Use it when the target is a plain
     * proxy object whose callbacks draw into a display object.
     */
    owner?: { destroyed?: boolean };
}

type Accessor = { get(target: any): number; set(target: any, v: number): void };

const ACCESSORS: Record<string, Accessor> = {
    scale: {
        get: t => t.scale.x,
        set: (t, v) => t.scale.set(v, v),
    },
    scaleX: { get: t => t.scale.x, set: (t, v) => { t.scale.x = v; } },
    scaleY: { get: t => t.scale.y, set: (t, v) => { t.scale.y = v; } },
    pivotX: { get: t => t.pivot.x, set: (t, v) => { t.pivot.x = v; } },
    pivotY: { get: t => t.pivot.y, set: (t, v) => { t.pivot.y = v; } },
    skewX: { get: t => t.skew.x, set: (t, v) => { t.skew.x = v; } },
};

function accessorFor(prop: string): Accessor {
    return ACCESSORS[prop] ?? {
        get: t => t[prop] as number,
        set: (t, v) => { t[prop] = v; },
    };
}

interface Track {
    prop: string;
    acc: Accessor;
    from: number;
    to: number;
}

export class Tween {
    readonly target: object;
    readonly tracks: Track[];
    readonly duration: number;
    readonly delay: number;
    readonly ease: EasingFn;
    private elapsed = 0;
    private started = false;
    cancelled = false;
    done = false;
    private resolve!: () => void;
    readonly finished: Promise<void>;

    constructor(
        target: object,
        private readonly props: Record<string, number>,
        private readonly opts: TweenOptions,
    ) {
        this.target = target;
        this.duration = Math.max(0, opts.duration ?? 0);
        this.delay = Math.max(0, opts.delay ?? 0);
        const e = opts.ease ?? 'OutQuint';
        this.ease = typeof e === 'function' ? e : Easing[e];
        this.tracks = Object.keys(props).map(prop => ({ prop, acc: accessorFor(prop), from: 0, to: props[prop] }));
        this.finished = new Promise(r => (this.resolve = r));
    }

    hasProp(prop: string): boolean {
        return this.tracks.some(t => t.prop === prop);
    }

    /** Drop one property (another tween took it over). Returns true if empty. */
    dropProp(prop: string): boolean {
        const i = this.tracks.findIndex(t => t.prop === prop);
        if (i !== -1) this.tracks.splice(i, 1);
        return this.tracks.length === 0;
    }

    /** Advance; returns true when finished. */
    step(dt: number): boolean {
        if (this.cancelled || this.done) return true;
        const target = this.target as { destroyed?: boolean };
        if (target.destroyed || this.opts.owner?.destroyed) {
            this.cancel();
            return true;
        }
        this.elapsed += dt;
        if (this.elapsed < this.delay) return false;
        if (!this.started) {
            this.started = true;
            for (const t of this.tracks) t.from = t.acc.get(this.target);
        }
        const local = this.elapsed - this.delay;
        const p = this.duration <= 0 ? 1 : Math.min(1, local / this.duration);
        const k = this.ease(p);
        for (const t of this.tracks) t.acc.set(this.target, t.from + (t.to - t.from) * k);
        this.opts.onUpdate?.(p);
        if (p >= 1) {
            this.done = true;
            this.opts.onComplete?.();
            this.resolve();
            return true;
        }
        return false;
    }

    /** Jump to the end state immediately. */
    finish(): void {
        if (this.done || this.cancelled) return;
        if (!this.started) for (const t of this.tracks) t.from = t.acc.get(this.target);
        for (const t of this.tracks) t.acc.set(this.target, t.to);
        this.done = true;
        // Observers driven by onUpdate (e.g. blur levels) must see the end state too.
        this.opts.onUpdate?.(1);
        this.opts.onComplete?.();
        this.resolve();
    }

    cancel(): void {
        if (this.done || this.cancelled) return;
        this.cancelled = true;
        // Resolve so awaiting code never hangs on an interrupted animation.
        this.resolve();
    }

    get propsSnapshot(): Readonly<Record<string, number>> {
        return this.props;
    }
}

export class Tweener {
    private tweens: Tween[] = [];
    private byTarget = new Map<object, Tween[]>();

    to(target: object, props: Record<string, number>, opts: TweenOptions = {}): Tween {
        // Property-level override of running tweens on the same target.
        const existing = this.byTarget.get(target);
        if (existing) {
            for (const prop of Object.keys(props)) {
                for (const tw of existing) {
                    if (tw.hasProp(prop) && tw.dropProp(prop)) tw.cancel();
                }
            }
        }
        const tween = new Tween(target, props, opts);
        if (tween.duration === 0 && tween.delay === 0) {
            tween.finish();
            return tween;
        }
        this.tweens.push(tween);
        let list = this.byTarget.get(target);
        if (!list) this.byTarget.set(target, (list = []));
        list.push(tween);
        return tween;
    }

    /** Run a callback after `ms` of tweener time (cancellable via the Tween). */
    delay(ms: number, fn: () => void, owner: object = {}): Tween {
        return this.to(owner, {}, { duration: 0, delay: Math.max(1e-6, ms), onComplete: fn });
    }

    kill(target: object, props?: string[]): void {
        const list = this.byTarget.get(target);
        if (!list) return;
        for (const tw of list) {
            if (!props) tw.cancel();
            else for (const p of props) if (tw.hasProp(p) && tw.dropProp(p)) tw.cancel();
        }
    }

    /** Finish (jump to end) all tweens on a target. */
    finishAll(target: object): void {
        const list = this.byTarget.get(target);
        if (!list) return;
        for (const tw of list.slice()) tw.finish();
    }

    isTweening(target: object, prop?: string): boolean {
        const list = this.byTarget.get(target);
        if (!list) return false;
        return list.some(tw => !tw.done && !tw.cancelled && (!prop || tw.hasProp(prop)));
    }

    update(dt: number): void {
        if (this.tweens.length === 0) return;
        let write = 0;
        const list = this.tweens;
        // Tweens started inside callbacks append to `list`; iterate by index
        // over the live array so they begin stepping next frame.
        const n = list.length;
        for (let i = 0; i < n; i++) {
            const tw = list[i];
            let finished: boolean;
            try {
                finished = tw.step(dt);
            } catch (e) {
                // One broken animation must not take the whole frame loop down.
                console.error('[tween] callback failed; tween dropped', e);
                tw.cancel();
                finished = true;
            }
            if (!finished) list[write++] = tw;
            else this.untrack(tw);
        }
        for (let i = n; i < list.length; i++) list[write++] = list[i];
        list.length = write;
    }

    private untrack(tw: Tween): void {
        const arr = this.byTarget.get(tw.target);
        if (!arr) return;
        const i = arr.indexOf(tw);
        if (i !== -1) arr.splice(i, 1);
        if (arr.length === 0) this.byTarget.delete(tw.target);
    }

    get activeCount(): number {
        return this.tweens.length;
    }
}

/** Global UI tweener, stepped once per frame by the App. */
export const tweener = new Tweener();

export const tween = (target: object, props: Record<string, number>, opts?: TweenOptions): Tween =>
    tweener.to(target, props, opts);

export const delay = (ms: number, fn: () => void, owner?: object): Tween => tweener.delay(ms, fn, owner);
