import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateDifficulty, calculateDifficultyAttributes, calculateTimedAttributes } from '../../src/beatmap/difficulty';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import { LivePerformance } from '../../src/gameplay/hud/livePerformance';
import { NO_MODS, sanitizeMods } from '../../src/gameplay/mods';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const data = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));
const nomod = buildPlayableBeatmap(data, NO_MODS);

describe('difficulty attributes', () => {
    it('agree with the star rating calculation', () => {
        const classic = calculateDifficulty(nomod);
        const a = calculateDifficultyAttributes(nomod)!;
        expect(a.aimDifficulty).toBeCloseTo(classic.aim, 12);
        expect(a.speedDifficulty).toBeCloseTo(classic.speed, 12);
        expect(a.starRating).toBe(classic.stars);
        const dt = calculateDifficultyAttributes(buildPlayableBeatmap(data, sanitizeMods(['DT'])), { rate: 1.5 })!;
        expect(dt.starRating).toBe(calculateDifficulty(buildPlayableBeatmap(data, sanitizeMods(['DT'])), 1.5).stars);
    });

    it('count objects and combo like the beatmap', () => {
        const a = calculateDifficultyAttributes(nomod)!;
        const objs = nomod.hitObjects;
        expect(a.hitCircleCount).toBe(objs.filter(h => h.kind === 'circle').length);
        expect(a.sliderCount).toBe(objs.filter(h => h.kind === 'slider').length);
        expect(a.spinnerCount).toBe(objs.filter(h => h.kind === 'spinner').length);
        expect(a.maxCombo).toBe(objs.reduce((n, h) => n + (h.kind === 'slider' ? h.events.length : 1), 0));
        expect(a.sliderFactor).toBeGreaterThan(0.5);
        expect(a.sliderFactor).toBeLessThanOrEqual(1);
        expect(a.speedNoteCount).toBeGreaterThan(0);
        expect(a.speedNoteCount).toBeLessThan(objs.length);
        expect(a.aimDifficultStrainCount).toBeGreaterThan(1);
        expect(a.speedDifficultStrainCount).toBeGreaterThan(1);
        expect(a.aimDifficultSliderCount).toBeGreaterThan(0);
        expect(a.aimDifficultSliderCount).toBeLessThanOrEqual(a.sliderCount);
        expect(a.flashlightDifficulty).toBe(0);
    });

    it('rate-adjust OD and AR (DT: windows ÷ 1.5)', () => {
        const nm = calculateDifficultyAttributes(nomod)!;
        const dt = calculateDifficultyAttributes(buildPlayableBeatmap(data, sanitizeMods(['DT'])), { rate: 1.5 })!;
        expect(nm.overallDifficulty).toBeCloseTo(data.difficulty.overallDifficulty, 9);
        expect(dt.greatHitWindow).toBeCloseTo(nm.greatHitWindow / 1.5, 9);
        expect(dt.overallDifficulty).toBeGreaterThan(nm.overallDifficulty);
        expect(dt.approachRate).toBeGreaterThan(nm.approachRate);
    });

    it('add flashlight difficulty with FL (more with HD), and apply Relax / Autopilot', () => {
        const fl = calculateDifficultyAttributes(nomod, { flashlight: true })!;
        const hdfl = calculateDifficultyAttributes(nomod, { flashlight: true, hidden: true })!;
        expect(fl.flashlightDifficulty).toBeGreaterThan(0);
        expect(hdfl.flashlightDifficulty).toBeGreaterThan(fl.flashlightDifficulty);
        const nm = calculateDifficultyAttributes(nomod)!;
        const rx = calculateDifficultyAttributes(nomod, { relax: true })!;
        expect(rx.speedDifficulty).toBe(0);
        expect(rx.aimDifficulty).toBeCloseTo(nm.aimDifficulty * 0.9, 12);
        const ap = calculateDifficultyAttributes(nomod, { autopilot: true })!;
        expect(ap.aimDifficulty).toBe(0);
        expect(ap.speedDifficulty).toBeCloseTo(nm.speedDifficulty * 0.5, 12);
    });

    it('give timed attributes for every prefix of the map, ending with the full map', () => {
        const timed = calculateTimedAttributes(nomod);
        expect(timed).toHaveLength(nomod.hitObjects.length);
        expect(timed[0].aimDifficulty).toBe(0);
        expect(timed[timed.length - 1]).toEqual(calculateDifficultyAttributes(nomod));
        for (let i = 1; i < timed.length; i++) {
            expect(timed[i].maxCombo).toBeGreaterThan(timed[i - 1].maxCombo);
            expect(timed[i].aimDifficulty).toBeGreaterThanOrEqual(timed[i - 1].aimDifficulty - 1e-12);
        }
    });

    it('value a live play: pp grows as the map is played, and an SS is worth the most', () => {
        const live = new LivePerformance(nomod, NO_MODS, 'lazer');
        const n = nomod.hitObjects.length;
        const full = live.full!;
        const at = (judged: number, miss = 0) => live.pp({
            great: judged - miss, ok: 0, meh: 0, miss, maxCombo: live.attributesAfter(judged)!.maxCombo, accuracy: 1 - miss / Math.max(1, judged),
            sliderEndsJudged: 0, sliderEndsHit: 0, tickMisses: 0,
        });
        expect(live.pp({ great: 0, ok: 0, meh: 0, miss: 0, maxCombo: 0, accuracy: 1, sliderEndsJudged: 0, sliderEndsHit: 0, tickMisses: 0 })).toBe(0);
        expect(at(Math.floor(n / 2))).toBeLessThan(at(n));
        expect(at(n, 5)).toBeLessThan(at(n));
        expect(full.maxCombo).toBeGreaterThan(n);
        expect(at(n)).toBeGreaterThan(10);
        expect(at(n)).toBeLessThan(200);
    });
});
