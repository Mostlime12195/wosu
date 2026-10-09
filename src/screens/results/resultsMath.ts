import { adjustDifficulty, sanitizeMods, type ModAcronym } from '../../gameplay/mods';

/** Pure helpers for the results screen (kept separate so they're testable). */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Strong ease-out (lazer's accuracy circle uses OutPow10). */
export const easeOutPow = (t: number, p = 6): number => 1 - Math.pow(1 - clamp01(t), p);
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - clamp01(t), 5);

export interface HitWindows {
    w300: number;
    w100: number;
    w50: number;
}

/** Stable hit windows for the difficulty's OD after EZ/HR. */
export function hitWindowsFor(od: number, mods: readonly ModAcronym[]): HitWindows {
    const adj = adjustDifficulty({ cs: 5, ar: 5, od, hp: 5 }, sanitizeMods(mods));
    return { w300: 80 - 6 * adj.od, w100: 140 - 8 * adj.od, w50: 200 - 10 * adj.od };
}

export interface ErrorStats {
    mean: number;
    early: number;
    late: number;
}

export function errorStats(errors: readonly number[]): ErrorStats {
    let sum = 0, early = 0, late = 0;
    for (const e of errors) {
        sum += e;
        if (e < 0) early++;
        else if (e > 0) late++;
    }
    return { mean: errors.length ? sum / errors.length : 0, early, late };
}

/**
 * Histogram of hit errors centred on 0: an odd number of bins so the
 * middle bin is exactly "on time". Range covers the 50 window (or the
 * largest error when it exceeds that).
 */
export function timingHistogram(errors: readonly number[], range: number, bins = 51): { counts: number[]; binWidth: number; range: number } {
    let r = Math.max(1, range);
    for (const e of errors) if (Math.abs(e) > r) r = Math.abs(e);
    r = Math.ceil(r / 5) * 5;
    const binWidth = (2 * r) / bins;
    const counts = new Array<number>(bins).fill(0);
    for (const e of errors) {
        const i = Math.min(bins - 1, Math.max(0, Math.floor((e + r) / binWidth)));
        counts[i]++;
    }
    return { counts, binWidth, range: r };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatSigned(ms: number, digits = 1): string {
    const v = ms.toFixed(digits);
    return ms >= 0 ? `+${v}` : v;
}

/** Accuracy cut-offs of lazer's rank bands (D < 70% < C < 80% < B < 90% < A < 95% < S < 100% = SS). */
export const RANK_CUTOFFS = { D: 0, C: 0.7, B: 0.8, A: 0.9, S: 0.95, X: 1 } as const;
/** SS is drawn as a 1% region so it stays visible (lazer's VIRTUAL_SS_PERCENTAGE). */
export const VIRTUAL_SS = 0.01;
/** Gap, in accuracy units, between the coloured rank bands (2°). */
export const GRADE_SPACING = 2 / 360;

/** The rank band (in gauge units) a grade letter belongs to. */
export function gradeBand(grade: string): [number, number] {
    switch (grade) {
        case 'X': case 'XH': return [1 - VIRTUAL_SS, 1];
        case 'S': case 'SH': return [RANK_CUTOFFS.S, 1 - VIRTUAL_SS];
        case 'A': return [RANK_CUTOFFS.A, RANK_CUTOFFS.S];
        case 'B': return [RANK_CUTOFFS.B, RANK_CUTOFFS.A];
        case 'C': return [RANK_CUTOFFS.C, RANK_CUTOFFS.B];
        default: return [0, RANK_CUTOFFS.C];
    }
}

/**
 * Where the accuracy gauge comes to rest. Like lazer's AccuracyCircle it
 * never lands inside a gap between bands or in the virtual SS slice
 * unless the play is an SS, and since our grades follow stable's
 * hit-ratio rules (a 96% play with a miss is an A), the gauge is kept
 * inside the achieved grade's band so it points at the letter shown.
 */
export function gaugeTarget(accuracy: number, grade: string, passed: boolean): number {
    const acc = Number.isFinite(accuracy) ? clamp01(accuracy) : 0;
    if (passed && (grade === 'X' || grade === 'XH')) return 1;
    const half = GRADE_SPACING / 2;
    if (!passed) return Math.min(acc, 1 - VIRTUAL_SS - half);
    const [lo, hi] = gradeBand(grade);
    return Math.max(lo === 0 ? 0 : lo + half, Math.min(hi - half, acc));
}
