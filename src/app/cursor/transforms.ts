/**
 * Tiny transform helpers for the cursors. The easings are osu-framework's
 * DefaultEasingFunction verbatim (including the offsets that make the
 * elastic curves end exactly on 1), so the cursor animations match lazer
 * frame for frame.
 */
export type Ease = (t: number) => number;

const ELASTIC_CONST = (2 * Math.PI) / 0.3;
const ELASTIC_CONST2 = 0.3 / 4;
const ELASTIC_OFFSET_FULL = Math.pow(2, -11);
const ELASTIC_OFFSET_HALF = Math.pow(2, -10) * Math.sin((0.5 - ELASTIC_CONST2) * ELASTIC_CONST);
const ELASTIC_OFFSET_QUARTER = Math.pow(2, -10) * Math.sin((0.25 - ELASTIC_CONST2) * ELASTIC_CONST);

export const Ease = {
    None: (t: number) => t,
    /** Easing.In (= InQuad). */
    In: (t: number) => t * t,
    /** Easing.OutQuad (and Easing.Out). */
    OutQuad: (t: number) => t * (2 - t),
    OutQuint: (t: number) => --t * t * t * t * t + 1,
    OutElastic: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_FULL * t,
    OutElasticHalf: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((0.5 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_HALF * t,
    OutElasticQuarter: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((0.25 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_QUARTER * t,
} satisfies Record<string, Ease>;

/**
 * One animated number, like a single osu-framework transform sequence:
 * `to()` starts from the current (possibly mid-animation) value, and
 * `set()` jumps and cancels, so `set(1); to(0.9, …)` is `ScaleTo(1).ScaleTo(0.9, …)`.
 */
export class Anim {
    value: number;
    private from: number;
    private target: number;
    private elapsed = 0;
    private duration = 0;
    private ease: Ease = Ease.None;

    constructor(value: number) {
        this.value = this.from = this.target = value;
    }

    get end(): number {
        return this.target;
    }

    get running(): boolean {
        return this.duration > 0;
    }

    set(value: number): this {
        this.value = this.from = this.target = value;
        this.duration = 0;
        return this;
    }

    to(target: number, duration: number, ease: Ease = Ease.None): this {
        if (duration <= 0) return this.set(target);
        this.from = this.value;
        this.target = target;
        this.elapsed = 0;
        this.duration = duration;
        this.ease = ease;
        return this;
    }

    update(dt: number): number {
        if (this.duration <= 0) return this.value;
        this.elapsed += dt;
        if (this.elapsed >= this.duration) {
            this.duration = 0;
            this.value = this.target;
        } else {
            this.value = this.from + (this.target - this.from) * this.ease(this.elapsed / this.duration);
        }
        return this.value;
    }
}
