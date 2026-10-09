/**
 * Easing functions mapping t in [0, 1] to progress. Names follow
 * osu-framework's Easing enum so animation values can be ported 1:1.
 */
export type EasingFn = (t: number) => number;

const c1 = 1.70158;
const c3 = c1 + 1;

const ELASTIC_CONST = (2 * Math.PI) / 0.3;
const ELASTIC_CONST2 = 0.3 / 4;
const ELASTIC_OFFSET_FULL = Math.pow(2, -11);
const ELASTIC_OFFSET_HALF = Math.pow(2, -10) * Math.sin((0.5 - ELASTIC_CONST2) * ELASTIC_CONST);
const ELASTIC_OFFSET_QUARTER = Math.pow(2, -10) * Math.sin((0.25 - ELASTIC_CONST2) * ELASTIC_CONST);

export const Easing = {
    None: (t: number) => t,
    Out: (t: number) => t * (2 - t),
    In: (t: number) => t * t,
    InQuad: (t: number) => t * t,
    OutQuad: (t: number) => t * (2 - t),
    InOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    InCubic: (t: number) => t * t * t,
    OutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
    InOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    InQuart: (t: number) => t * t * t * t,
    OutQuart: (t: number) => 1 - Math.pow(1 - t, 4),
    InQuint: (t: number) => t * t * t * t * t,
    OutQuint: (t: number) => 1 - Math.pow(1 - t, 5),
    InOutQuint: (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
    InSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
    OutSine: (t: number) => Math.sin((t * Math.PI) / 2),
    InOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
    InExpo: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
    OutExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    InOutExpo: (t: number) =>
        t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
    OutCirc: (t: number) => Math.sqrt(1 - Math.pow(t - 1, 2)),
    InBack: (t: number) => c3 * t * t * t - c1 * t * t,
    OutBack: (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
    // osu-framework's elastic curves, including the offsets that land them on 1.
    OutElastic: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_FULL * t,
    OutElasticHalf: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((0.5 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_HALF * t,
    OutElasticQuarter: (t: number) =>
        Math.pow(2, -10 * t) * Math.sin((0.25 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1 - ELASTIC_OFFSET_QUARTER * t,
    OutBounce: (t: number) => {
        const n1 = 7.5625, d1 = 2.75;
        if (t < 1 / d1) return n1 * t * t;
        if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
        if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
        return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
} satisfies Record<string, EasingFn>;

export type EasingName = keyof typeof Easing;
