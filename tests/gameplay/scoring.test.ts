import { describe, expect, it } from 'vitest';
import {
    difficultyMultiplier, resultForError, ScoreProcessor, sliderResult, spinnerResult,
} from '../../src/gameplay/scoring/ScoreProcessor';
import { HealthProcessor } from '../../src/gameplay/scoring/HealthProcessor';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import { difficultyRange } from '../../src/core/math';
import { NO_MODS } from '../../src/gameplay/mods';
import { makeMap } from '../beatmap/helpers';

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

    it('spins score 100, bonus spins 1100 (stable)', () => {
        const s = make();
        s.applySpin(false);
        s.applySpin(true);
        expect(s.score).toBe(1200);
        expect(s.combo).toBe(0);
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
        const h = new HealthProcessor({ ...base, drainRate: 0.0001 });
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

    const pen = (hp: number) => difficultyRange(hp, 0.02, 0.075, 0.14);

    it('lazer: tick miss costs, a missed slider tail is free; stable charges both', () => {
        const lazer = new HealthProcessor({ ...base, mechanics: 'lazer' });
        lazer.hp = 0.5;
        lazer.applyNested('tail', false);
        expect(lazer.hp).toBeCloseTo(0.5);
        lazer.applyNested('tick', false);
        expect(lazer.hp).toBeCloseTo(0.5 - pen(5));
        lazer.applyNested('tick', true);
        lazer.applyNested('tail', true);
        expect(lazer.hp).toBeCloseTo(0.5 - pen(5) + 0.015 + 0.02);

        const stable = new HealthProcessor({ ...base, mechanics: 'stable' });
        stable.hp = 0.5;
        stable.applyNested('tail', false);
        expect(stable.hp).toBeCloseTo(0.5 - pen(5));
        stable.applyNested('repeat', false);
        expect(stable.hp).toBeCloseTo(0.5 - 2 * pen(5));
    });

    it('lazer judges the slider head like a circle, stable like a tick', () => {
        const lazer = new HealthProcessor({ ...base, mechanics: 'lazer' });
        lazer.hp = 0.5;
        lazer.applyNested('head', true, 'meh');
        expect(lazer.hp).toBeCloseTo(0.502);
        lazer.applyNested('head', false);
        expect(lazer.hp).toBeCloseTo(0.502 - difficultyRange(5, 0.03, 0.125, 0.2));
        const stable = new HealthProcessor({ ...base, mechanics: 'stable' });
        stable.hp = 0.5;
        stable.applyNested('head', true, 'meh');
        expect(stable.hp).toBeCloseTo(0.52);
    });

    it('lazer adds the end-of-combo bonus (+0.07 perfect, +0.05 good, +0.03 otherwise)', () => {
        const map = parseOsu(makeMap({ objects: ['0,0,1000,5,0', '0,0,1200,1,0', '0,0,1400,5,0', '0,0,1600,1,0', '0,0,1800,5,0'] }));
        const objects = buildPlayableBeatmap(map, NO_MODS).hitObjects;
        const h = new HealthProcessor({ ...base, mechanics: 'lazer', objects, drainRate: 0 });
        h.hp = 0.2;
        h.applyMain('great', 0);
        h.applyMain('great', 1); // last in combo, all perfect
        expect(h.hp).toBeCloseTo(0.2 + 0.03 + 0.03 + 0.07);
        h.applyMain('ok', 2);
        const before = h.hp;
        h.applyMain('great', 3); // last in combo with a 100
        expect(h.hp).toBeCloseTo(before + 0.03 + 0.05);
        const s = new HealthProcessor({ ...base, mechanics: 'stable', objects, drainRate: 0 });
        s.hp = 0.2;
        s.applyMain('great', 0);
        s.applyMain('great', 1);
        expect(s.hp).toBeCloseTo(0.2 + 0.06 * s.hpMultiplier);
    });

    it('drain alone fails you in stable; lazer waits for a judgement', () => {
        const stable = new HealthProcessor({ ...base, mechanics: 'stable', drainRate: 0.001 });
        stable.drain(2000, 1000);
        expect(stable.failed).toBe(true);
        const lazer = new HealthProcessor({ ...base, mechanics: 'lazer', drainRate: 0.001 });
        lazer.drain(2000, 1000);
        expect(lazer.hp).toBe(0);
        expect(lazer.failed).toBe(false);
        lazer.applyMain('great'); // survives: health above zero again
        expect(lazer.failed).toBe(false);
        lazer.hp = 0;
        lazer.applyMain('miss');
        expect(lazer.failed).toBe(true);
    });

    it('the drain rate is fitted per map, and breaks (to the objects around them) do not drain', () => {
        const objects = ['0,0,1000,1,0', '0,0,2000,1,0', '0,0,3000,1,0', '0,0,9000,1,0', '0,0,10000,1,0'];
        const data = parseOsu(makeMap({ objects }).replace('[TimingPoints]', '[Events]\n2,4000,8000\n[TimingPoints]'));
        const pb = buildPlayableBeatmap(data, NO_MODS);
        for (const mechanics of ['lazer', 'stable'] as const) {
            const h = new HealthProcessor({ hpDifficulty: 5, breaks: pb.breaks, drainStart: 1000, drainEnd: 10000, mechanics, objects: pb.hitObjects });
            expect(h.drainRate).toBeGreaterThan(0);
            expect(h.isDraining(1500)).toBe(true);
            // lazer widens the break to the objects either side (3000–9000).
            expect(h.isDraining(3500)).toBe(false);
            expect(h.isDraining(8500)).toBe(false);
            expect(h.isDraining(9500)).toBe(true);
        }
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
