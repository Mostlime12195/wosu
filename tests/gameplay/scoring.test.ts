import { describe, expect, it } from 'vitest';
import {
    difficultyMultiplier, resultForError, ScoreProcessor, sliderResult, spinnerResult,
} from '../../src/gameplay/scoring/ScoreProcessor';
import { HealthProcessor } from '../../src/gameplay/scoring/HealthProcessor';

const make = (diff = 4, mods = 1) => new ScoreProcessor({ difficultyMultiplier: diff, modMultiplier: mods });

describe('ScoreProcessor (ScoreV1)', () => {
    it('uses the combo before the hit for the multiplier', () => {
        const s = make(4, 1);
        s.applyMain('great', true); // combo 0 → 300
        expect(s.score).toBe(300);
        s.applyMain('great', true); // combo 1 → max(0) → 300
        expect(s.score).toBe(600);
        s.applyMain('great', true); // combo 2 → 300 + 300*1*4/25 = 348
        expect(s.score).toBe(948);
        expect(s.combo).toBe(3);
    });

    it('applies the mod multiplier', () => {
        const a = make(5, 1), b = make(5, 1.12);
        for (let i = 0; i < 10; i++) {
            a.applyMain('great', true);
            b.applyMain('great', true);
        }
        expect(b.score).toBeGreaterThan(a.score);
    });

    it('slider parts: head/tick/repeat/tail score and combo; tail miss keeps combo', () => {
        const s = make();
        s.applyNested('head', true);
        s.applyNested('tick', true);
        s.applyNested('repeat', true);
        s.applyNested('tail', false);
        expect(s.score).toBe(70);
        expect(s.combo).toBe(3);
        let broke = 0;
        s.comboBroken.add(() => broke++);
        s.applyNested('tick', false);
        expect(s.combo).toBe(0);
        expect(broke).toBe(1);
        expect(s.sliderTicksTotal).toBe(2);
        expect(s.sliderTicksHit).toBe(1);
    });

    it('accuracy counts main judgements only', () => {
        const s = make();
        s.applyMain('great', true);
        s.applyMain('ok', true);
        s.applyNested('tick', false);
        expect(s.accuracy).toBeCloseTo(400 / 600);
    });

    it('stable grade thresholds', () => {
        const g = (c300: number, c100: number, c50: number, miss: number, silver = false) => {
            const s = make();
            s.count300 = c300; s.count100 = c100; s.count50 = c50; s.countMiss = miss;
            return s.grade(silver);
        };
        expect(g(100, 0, 0, 0)).toBe('X');
        expect(g(100, 0, 0, 0, true)).toBe('XH');
        expect(g(95, 5, 0, 0)).toBe('S');
        expect(g(190, 9, 1, 0, true)).toBe('SH'); // 0.5% fifties
        expect(g(95, 4, 1, 0)).toBe('A'); // exactly 1% fifties is not < 1%
        expect(g(95, 3, 1, 1)).toBe('A'); // >90% 300s but a miss → A
        expect(g(85, 15, 0, 0)).toBe('A');
        expect(g(85, 14, 0, 1)).toBe('B');
        expect(g(75, 25, 0, 0)).toBe('B');
        expect(g(65, 35, 0, 0)).toBe('C');
        expect(g(50, 50, 0, 0)).toBe('D');
        expect(make().grade(false, true)).toBe('F');
    });

    it('slider/spinner/timing helpers', () => {
        expect(sliderResult(4, 4)).toBe('great');
        expect(sliderResult(2, 4)).toBe('ok');
        expect(sliderResult(1, 4)).toBe('meh');
        expect(sliderResult(0, 4)).toBe('miss');
        expect(spinnerResult(1.2)).toBe('great');
        expect(spinnerResult(0.95)).toBe('ok');
        expect(spinnerResult(0.8)).toBe('meh');
        expect(spinnerResult(0.2)).toBe('miss');
        expect(resultForError(-10, 20, 60, 100)).toBe('great');
        expect(resultForError(70, 20, 60, 100)).toBe('meh');
        expect(resultForError(150, 20, 60, 100)).toBeNull();
    });

    it('difficulty multiplier matches the stable formula', () => {
        // (5 + 4 + 6 + clamp(300 / 120 * 8, 0, 16)) / 38 * 5 = (15 + 16) / 38 * 5 ≈ 4.08 → 4
        expect(difficultyMultiplier({ hp: 5, cs: 4, od: 6 }, 300, 120_000)).toBe(4);
        expect(difficultyMultiplier({ hp: 2, cs: 3, od: 2 }, 50, 120_000)).toBe(1);
    });
});

describe('HealthProcessor', () => {
    const base = { hpDifficulty: 5, breaks: [{ startTime: 5000, endTime: 8000 }], drainStart: 1000, drainEnd: 20000 };

    it('drains only during play time outside breaks', () => {
        const h = new HealthProcessor(base);
        h.drain(500, 100);
        expect(h.hp).toBe(1);
        h.drain(2000, 1000);
        const afterPlay = h.hp;
        expect(afterPlay).toBeLessThan(1);
        h.drain(6000, 1000);
        expect(h.hp).toBe(afterPlay);
    });

    it('fails at zero unless no-fail, and Easy lives refill', () => {
        const h = new HealthProcessor(base);
        let failed = 0;
        h.failedSignal.add(() => failed++);
        for (let i = 0; i < 20; i++) h.applyMain('miss');
        expect(h.failed).toBe(true);
        expect(failed).toBe(1);

        const nf = new HealthProcessor({ ...base, noFail: true });
        for (let i = 0; i < 20; i++) nf.applyMain('miss');
        expect(nf.failed).toBe(false);
        expect(nf.hp).toBe(0);

        const ez = new HealthProcessor({ ...base, lives: 2 });
        let used = 0;
        ez.lifeUsed.add(() => used++);
        for (let i = 0; i < 9; i++) ez.applyMain('miss');
        expect(used).toBe(1);
        expect(ez.failed).toBe(false);
    });

    it('hits restore health, capped at 1', () => {
        const h = new HealthProcessor(base);
        h.applyMain('miss');
        const low = h.hp;
        h.applyMain('great');
        expect(h.hp).toBeGreaterThan(low);
        for (let i = 0; i < 100; i++) h.applyMain('great');
        expect(h.hp).toBe(1);
    });
});
