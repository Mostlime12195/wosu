import { describe, expect, it } from 'vitest';
import type { OsuDifficultyAttributes } from '../../src/beatmap/difficulty';
import { calculatePerformance, difficultyToPerformance, erf, erfInv, type PerformanceScore } from '../../src/gameplay/performance';

/** Attributes as lazer reports them (hit windows from OD: 80 / 140 / 200 − 6 / 8 / 10 × OD). */
function attrs(o: {
    aim: number; speed: number; fl: number; od: number; ar: number; maxCombo: number; circles: number; sliders: number; spinners: number;
    speedNotes: number; sliderFactor: number; diffSliders: number; aimStrains: number; speedStrains: number;
}): OsuDifficultyAttributes {
    return {
        starRating: 0,
        aimDifficulty: o.aim,
        speedDifficulty: o.speed,
        flashlightDifficulty: o.fl,
        sliderFactor: o.sliderFactor,
        speedNoteCount: o.speedNotes,
        aimDifficultSliderCount: o.diffSliders,
        aimDifficultStrainCount: o.aimStrains,
        speedDifficultStrainCount: o.speedStrains,
        approachRate: o.ar,
        overallDifficulty: o.od,
        drainRate: 5,
        greatHitWindow: 80 - 6 * o.od,
        okHitWindow: 140 - 8 * o.od,
        mehHitWindow: 200 - 10 * o.od,
        maxCombo: o.maxCombo,
        hitCircleCount: o.circles,
        sliderCount: o.sliders,
        spinnerCount: o.spinners,
    };
}

const A1 = attrs({ aim: 2.8, speed: 2.5, fl: 0, od: 9, ar: 9.5, maxCombo: 1200, circles: 500, sliders: 250, spinners: 2, speedNotes: 380, sliderFactor: 0.97, diffSliders: 60, aimStrains: 180, speedStrains: 150 });
const A2 = attrs({ aim: 3.4, speed: 3.1, fl: 1.9, od: 9.6, ar: 10.6, maxCombo: 900, circles: 420, sliders: 180, spinners: 1, speedNotes: 300, sliderFactor: 0.94, diffSliders: 45, aimStrains: 120, speedStrains: 95 });

function score(o: Omit<Partial<PerformanceScore>, 'mods'> & { great: number; ok?: number; meh?: number; miss?: number; combo: number; acc: number; mods?: string[] }): PerformanceScore {
    return {
        accuracy: o.acc,
        maxCombo: o.combo,
        countGreat: o.great,
        countOk: o.ok ?? 0,
        countMeh: o.meh ?? 0,
        countMiss: o.miss ?? 0,
        sliderEndsDropped: o.sliderEndsDropped,
        largeTickMisses: o.largeTickMisses,
        classicSliderAccuracy: o.classicSliderAccuracy ?? false,
        mods: new Set(o.mods ?? []),
    };
}

describe('osu!standard performance points', () => {
    it('erf and its inverse match reference values', () => {
        expect(erf(0.5)).toBeCloseTo(0.5204998778130465, 14);
        expect(erf(2)).toBeCloseTo(0.9953222650189527, 14);
        expect(erf(-1)).toBeCloseTo(-0.8427007929497148, 14);
        expect(erfInv(0.5)).toBeCloseTo(0.4769362762044698, 12);
        expect(erfInv(0.999)).toBeCloseTo(2.3267537655135455, 10);
        for (const y of [-0.9, -0.2, 0.01, 0.7, 0.99999]) expect(erf(erfInv(y))).toBeCloseTo(y, 12);
    });

    it('maps difficulty to performance like lazer', () => {
        expect(difficultyToPerformance(0)).toBeCloseTo(0.00001, 10);
        expect(difficultyToPerformance(2.8)).toBeCloseTo(Math.pow(5 * (2.8 / 0.0675) - 4, 3) / 100000, 10);
    });

    // Reference values from an independent transcription of lazer's OsuPerformanceCalculator.
    it('values a full-combo SS', () => {
        const r = calculatePerformance(A1, score({ great: 752, combo: 1200, acc: 1 }));
        expect(r.aim).toBeCloseTo(93.7568508053, 6);
        expect(r.speed).toBeCloseTo(69.2475323808, 6);
        expect(r.accuracy).toBeCloseTo(113.5236571505, 6);
        expect(r.speedDeviation).toBeCloseTo(10.4454414596, 6);
        expect(r.total).toBeCloseTo(288.3456195158, 6);
    });

    it('penalises misses, dropped slider ends and tick misses (lazer scores)', () => {
        const r = calculatePerformance(A1, score({ great: 700, ok: 40, meh: 6, miss: 6, combo: 420, acc: 0.9412, sliderEndsDropped: 5, largeTickMisses: 3 }));
        expect(r.effectiveMissCount).toBe(6);
        expect(r.aim).toBeCloseTo(62.1972832562, 6);
        expect(r.speed).toBeCloseTo(39.8719774927, 6);
        expect(r.accuracy).toBeCloseTo(32.9620694949, 6);
        expect(r.total).toBeCloseTo(141.0494004348, 6);
    });

    it('handles classic slider accuracy with Hidden', () => {
        const r = calculatePerformance(A2, score({ great: 560, ok: 35, meh: 2, miss: 4, combo: 610, acc: 0.9562, classicSliderAccuracy: true, mods: ['HD'] }));
        expect(r.total).toBeCloseTo(252.8461430098, 6);
        expect(r.speedDeviation).toBeCloseTo(17.0212109239, 6);
    });

    it('adds flashlight and applies No Fail', () => {
        const r = calculatePerformance(A2, score({ great: 580, ok: 15, meh: 1, miss: 5, combo: 300, acc: 0.9745, classicSliderAccuracy: true, mods: ['FL', 'NF', 'HD'] }));
        expect(r.flashlight).toBeCloseTo(32.9819356654, 6);
        expect(r.total).toBeCloseTo(282.0928815184, 6);
    });

    it('gives Relax no speed or accuracy value and counts 100s as partial misses', () => {
        const r = calculatePerformance(A1, score({ great: 730, ok: 20, meh: 2, combo: 1200, acc: 0.9805, mods: ['RX'] }));
        expect(r.speed).toBe(0);
        expect(r.accuracy).toBe(0);
        expect(r.effectiveMissCount).toBeCloseTo(6.5918654492, 8);
        expect(r.total).toBeCloseTo(75.1596325758, 6);
    });

    it('is zero before anything is judged, and drops with more misses', () => {
        expect(calculatePerformance(A1, score({ great: 0, combo: 0, acc: 1 })).total).toBe(0);
        const few = calculatePerformance(A1, score({ great: 745, miss: 2, combo: 800, acc: 0.997 })).total;
        const many = calculatePerformance(A1, score({ great: 727, miss: 20, combo: 200, acc: 0.973 })).total;
        expect(few).toBeGreaterThan(many);
    });
});
