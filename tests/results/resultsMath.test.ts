import { describe, expect, it } from 'vitest';
import { GRADE_SPACING, VIRTUAL_SS, gaugeTarget, gradeBand } from '../../src/screens/results/resultsMath';

describe('gaugeTarget', () => {
    it('fills the whole ring for an SS', () => {
        expect(gaugeTarget(1, 'X', true)).toBe(1);
        expect(gaugeTarget(1, 'XH', true)).toBe(1);
    });

    it('stays out of the virtual SS slice below 100%', () => {
        expect(gaugeTarget(0.9995, 'S', true)).toBeCloseTo(1 - VIRTUAL_SS - GRADE_SPACING / 2);
        expect(gaugeTarget(1, 'F', false)).toBeLessThan(1 - VIRTUAL_SS);
    });

    it('keeps the gauge inside the achieved grade band', () => {
        // stable grades by hit ratio: 96% with a miss is an A
        const a = gaugeTarget(0.96, 'A', true);
        const [lo, hi] = gradeBand('A');
        expect(a).toBeGreaterThan(lo);
        expect(a).toBeLessThan(hi);
        expect(gaugeTarget(0.9351, 'A', true)).toBeCloseTo(0.9351);
        expect(gaugeTarget(0.85, 'C', true)).toBeLessThan(0.8);
    });

    it('never lands in a gap', () => {
        const t = gaugeTarget(0.95, 'S', true);
        expect(t).toBeGreaterThan(0.95);
        expect(gaugeTarget(0, 'D', true)).toBe(0);
        expect(gaugeTarget(Number.NaN, 'D', true)).toBe(0);
    });
});
