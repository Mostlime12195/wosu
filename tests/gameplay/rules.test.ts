import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import { GameplayRules } from '../../src/gameplay/GameplayRules';
import { AutoPlayer } from '../../src/gameplay/input/AutoPlayer';
import { NO_MODS, sanitizeMods, scoreMultiplier, type ModSet } from '../../src/gameplay/mods';
import { HealthProcessor } from '../../src/gameplay/scoring/HealthProcessor';
import { ScoreProcessor } from '../../src/gameplay/scoring/ScoreProcessor';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const data = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

function setup(mods: ModSet = NO_MODS) {
    const beatmap = buildPlayableBeatmap(data, mods);
    const score = new ScoreProcessor({ difficultyMultiplier: 4, modMultiplier: scoreMultiplier(mods) });
    const health = new HealthProcessor({
        hpDifficulty: beatmap.difficulty.hp, breaks: beatmap.breaks,
        drainStart: beatmap.startTime, drainEnd: beatmap.endTime, noFail: mods.has('NF') || mods.has('AT'),
    });
    const rules = new GameplayRules(beatmap, mods, score, health);
    return { beatmap, score, health, rules };
}

/** Simulate a whole play at a fixed frame step with autoplay input. */
function simulate(mods: ModSet, frameMs: number, pressFilter: (i: number) => boolean = () => true) {
    const s = setup(mods);
    const auto = new AutoPlayer(s.beatmap);
    let pi = 0;
    for (let t = s.beatmap.startTime - 2000; t <= s.beatmap.endTime + 1000; t += frameMs) {
        while (pi < auto.presses.length && auto.presses[pi].time <= t) {
            const p = auto.presses[pi];
            if (pressFilter(pi)) s.rules.press(p.time, p.x, p.y);
            pi++;
        }
        const c = auto.cursorAt(t);
        // A player who never presses never holds either.
        if (!pressFilter(-1)) c.held = false;
        s.rules.update(t, c);
    }
    return s;
}

describe('GameplayRules', () => {
    it('autoplay on the fixture map is an SS with full combo, at any frame rate', () => {
        for (const frame of [16.7, 7, 33]) {
            const { score, rules, beatmap } = simulate(sanitizeMods(['AT']), frame);
            expect(rules.finished).toBe(true);
            expect(score.countMiss).toBe(0);
            expect(score.count100 + score.count50).toBe(0);
            expect(score.count300).toBe(beatmap.hitObjects.length);
            expect(score.accuracy).toBe(1);
            expect(score.grade(false)).toBe('X');
            expect(score.sliderTicksHit).toBe(score.sliderTicksTotal);
        }
    });

    it('slider tails are still judged when a frame lands past the slider end', () => {
        // Low frame rates (or a hitch) can jump straight past the tail's
        // 36 ms window; the tail must use the tracking state at the end.
        for (const frame of [80, 100, 120]) {
            const { score, beatmap } = simulate(sanitizeMods(['AT']), frame);
            expect(score.count300).toBe(beatmap.hitObjects.length);
            expect(score.sliderTicksHit).toBe(score.sliderTicksTotal);
        }
    });

    it('never pressing misses every object and drains health', () => {
        const { score, health, beatmap } = simulate(sanitizeMods(['NF']), 16, () => false);
        // Unspun spinners are misses too.
        expect(score.countMiss).toBe(beatmap.hitObjects.length);
        expect(score.combo).toBe(0);
        expect(health.hp).toBe(0);
    });

    it('note lock: a later object cannot be hit while an earlier one is pending', () => {
        const { beatmap, rules } = setup();
        // Two consecutive objects close in time but apart on screen (a
        // stacked pair would legitimately hit the earlier object instead).
        const r = beatmap.difficulty.circleRadius;
        let a = -1;
        for (let i = 0; i + 1 < beatmap.hitObjects.length; i++) {
            const h0 = beatmap.hitObjects[i], h1 = beatmap.hitObjects[i + 1];
            if (h0.kind === 'spinner' || h1.kind === 'spinner') continue;
            if (h1.time - h0.time >= 400) continue;
            if (Math.hypot(h1.x - h0.x, h1.y - h0.y) <= 2 * r) continue;
            a = i;
            break;
        }
        expect(a).not.toBe(-1);
        const h1 = beatmap.hitObjects[a + 1];
        let shaken = -1;
        rules.shaken.add(i => (shaken = i));
        // Click the later object while the earlier one is still hittable.
        rules.press(beatmap.hitObjects[a].time, h1.x, h1.y);
        expect(shaken).toBe(a + 1);
        expect(rules.states[a + 1].result).toBeNull();
    });

    it('relax spins spinners without holding a button', () => {
        const s = setup(sanitizeMods(['RX']));
        const i = s.beatmap.hitObjects.findIndex(h => h.kind === 'spinner');
        expect(i).not.toBe(-1);
        const h = s.beatmap.hitObjects[i];
        for (let t = h.time; t <= h.endTime; t += 16) {
            const a = (t - h.time) * 0.03;
            s.rules.update(t, { x: h.x + Math.cos(a) * 50, y: h.y + Math.sin(a) * 50, held: false });
        }
        const st = s.rules.states[i];
        expect(st.kind === 'spinner' && st.progress > 0).toBe(true);
    });

    it('autoplay spins at the speed cap, faster than spun out', () => {
        const spin = (mods: ModSet) => {
            const s = setup(mods);
            const i = s.beatmap.hitObjects.findIndex(h => h.kind === 'spinner');
            const h = s.beatmap.hitObjects[i];
            for (let t = h.time; t <= h.time + 1000; t += 16) s.rules.update(t, { x: h.x, y: h.y, held: false });
            const st = s.rules.states[i];
            return st.kind === 'spinner' ? st.progress / (Math.PI * 2) : 0;
        };
        // ~477 RPM vs 287 RPM over one second.
        expect(spin(sanitizeMods(['AT']))).toBeGreaterThan(7.5);
        expect(spin(sanitizeMods(['SO']))).toBeLessThan(5);
    });

    it('sudden death fails on the first miss', () => {
        const { health } = simulate(sanitizeMods(['SD']), 16, i => i !== 3);
        expect(health.failed).toBe(true);
    });

    it('hard rock flips positions vertically', () => {
        const nm = buildPlayableBeatmap(data, NO_MODS);
        const hr = buildPlayableBeatmap(data, sanitizeMods(['HR']));
        const c = nm.hitObjects.findIndex(h => h.kind === 'circle' && h.stackHeight === 0);
        expect(hr.hitObjects[c].x).toBeCloseTo(nm.hitObjects[c].x);
        expect(hr.hitObjects[c].y).toBeCloseTo(384 - nm.hitObjects[c].y);
    });
});
