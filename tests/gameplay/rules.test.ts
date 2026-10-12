import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap, playableOptions } from '../../src/beatmap/processing';
import type { BeatmapData, PlayableSlider } from '../../src/beatmap/types';
import { difficultyRange } from '../../src/core/math';
import { GameplayRules, sliderBallPosition, type SpinnerState } from '../../src/gameplay/GameplayRules';
import { AutoPlayer } from '../../src/gameplay/input/AutoPlayer';
import { NO_MODS, sanitizeMods, scoreMultiplier, type ModSet } from '../../src/gameplay/mods';
import { HealthProcessor } from '../../src/gameplay/scoring/HealthProcessor';
import { GAMEPLAY_MECHANICS, type GameplayMechanics } from '../../src/gameplay/scoring/mechanics';
import { ScoreProcessor } from '../../src/gameplay/scoring/ScoreProcessor';
import { makeMap } from '../beatmap/helpers';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const fixture = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

function setup(mods: ModSet = NO_MODS, mechanics: GameplayMechanics = 'lazer', data: BeatmapData = fixture, noFail?: boolean) {
    const beatmap = buildPlayableBeatmap(data, mods, playableOptions(mechanics));
    const score = new ScoreProcessor({ difficultyMultiplier: 4, modMultiplier: scoreMultiplier(mods) });
    const health = new HealthProcessor({
        hpDifficulty: beatmap.difficulty.hp, breaks: beatmap.breaks,
        drainStart: beatmap.startTime, drainEnd: beatmap.endTime,
        noFail: noFail ?? (mods.has('NF') || mods.has('AT')),
        mechanics, objects: beatmap.hitObjects, od: beatmap.difficulty.od,
    });
    const rules = new GameplayRules(beatmap, mods, score, health, mechanics);
    return { beatmap, score, health, rules };
}

/** Simulate a whole play at a fixed frame step with autoplay input. */
function simulate(mods: ModSet, frameMs: number, mechanics: GameplayMechanics = 'lazer', pressFilter: (i: number) => boolean = () => true, noFail?: boolean) {
    const s = setup(mods, mechanics, fixture, noFail);
    const auto = new AutoPlayer(s.beatmap);
    let pi = 0;
    let lowest = 1;
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
        lowest = Math.min(lowest, s.health.hp);
    }
    return { ...s, lowest };
}

const map = (objects: string[], difficulty: Parameters<typeof makeMap>[0]['difficulty'] = {}) =>
    parseOsu(makeMap({ objects, difficulty: { OverallDifficulty: 5, HPDrainRate: 5, ...difficulty } }));

describe.each(GAMEPLAY_MECHANICS)('GameplayRules (%s)', mechanics => {
    it('autoplay on the fixture map is an SS with full combo, at any frame rate', () => {
        for (const frame of [16.7, 7, 33]) {
            const { score, rules, beatmap } = simulate(sanitizeMods(['AT']), frame, mechanics);
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
        // window; the tail must use the tracking state at the end.
        for (const frame of [80, 100, 120]) {
            const { score, beatmap } = simulate(sanitizeMods(['AT']), frame, mechanics);
            expect(score.count300).toBe(beatmap.hitObjects.length);
            expect(score.sliderTicksHit).toBe(score.sliderTicksTotal);
        }
    });

    it('a perfect play never fails: the drain rate is fitted to the map', () => {
        const { health, lowest, beatmap } = simulate(NO_MODS, 16.7, mechanics, () => true, false);
        expect(health.failed).toBe(false);
        expect(health.drainRate).toBeGreaterThan(0);
        // lazer aims a perfect play's lowest health at DifficultyRange(HP, 99%, 90%, 40%) (±1%);
        // stable keeps it above DifficultyRange(HP, 97.5%, 80%, 30%).
        const floor = mechanics === 'lazer'
            ? difficultyRange(beatmap.difficulty.hp, 0.99, 0.9, 0.4) - 0.03
            : difficultyRange(beatmap.difficulty.hp, 0.975, 0.8, 0.3) - 0.03;
        expect(lowest).toBeGreaterThan(floor);
    });

    it('never pressing misses every object and drains health', () => {
        const { score, health, beatmap } = simulate(sanitizeMods(['NF']), 16, mechanics, () => false);
        // Unspun spinners are misses too.
        expect(score.countMiss).toBe(beatmap.hitObjects.length);
        expect(score.combo).toBe(0);
        expect(health.hp).toBe(0);
    });

    it('early clicks inside the 400 ms miss window miss; earlier ones shake', () => {
        const s = setup(NO_MODS, mechanics, map(['100,100,1000,1,0']));
        let shaken = 0;
        s.rules.shaken.add(() => shaken++);
        s.rules.press(500, 100, 100); // 500 ms early
        expect(shaken).toBe(1);
        expect(s.rules.states[0].result).toBeNull();
        s.rules.press(700, 100, 100); // 300 ms early
        expect(s.rules.states[0].result).toBe('miss');
    });

    it('relax spins spinners without holding a button', () => {
        const s = setup(sanitizeMods(['RX']), mechanics);
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
            const s = setup(mods, mechanics);
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
        const { health } = simulate(sanitizeMods(['SD']), 16, mechanics, i => i !== 3);
        expect(health.failed).toBe(true);
    });
});

/** Spin a spinner at `rpm` (cursor circling at radius 80) and return its state. */
function spinAt(mechanics: GameplayMechanics, rpm: number, od = 5, durationMs = 2000): SpinnerState {
    const s = setup(NO_MODS, mechanics, map([`256,192,1000,12,0,${1000 + durationMs}`], { OverallDifficulty: od }));
    const radPerMs = (rpm / 60000) * Math.PI * 2;
    for (let t = 1000; t <= 1000 + durationMs + 20; t += 8) {
        const a = (t - 1000) * radPerMs;
        s.rules.update(t, { x: 256 + Math.cos(a) * 80, y: 192 + Math.sin(a) * 80, held: true });
    }
    return s.rules.states[0] as SpinnerState;
}

describe('spinner requirements', () => {
    it('lazer: whole spins at 150 RPM (OD 5); stable: half spins at 5 per second', () => {
        // 2 s at OD 5: lazer needs (int)(2.5 × 2) = 5 spins, stable (int)(2 × 5) = 10 half spins.
        expect(spinAt('lazer', 0).required).toBeCloseTo(5 * Math.PI * 2);
        expect(spinAt('stable', 0).required).toBeCloseTo(10 * Math.PI);
        // OD 10: 225 RPM in both (7.5 spins → lazer 7, stable 15 half spins).
        expect(spinAt('lazer', 0, 10).required).toBeCloseTo(7 * Math.PI * 2);
        expect(spinAt('stable', 0, 10).required).toBeCloseTo(15 * Math.PI);
    });

    it('a steady 170 RPM clears an OD 5 spinner in both (the old rules needed 210 RPM)', () => {
        for (const m of GAMEPLAY_MECHANICS) {
            expect(spinAt(m, 170).result).toBe('great');
            expect(spinAt(m, 100).result).not.toBe('great');
        }
    });

    it('lazer has no speed cap; stable caps at ~477 RPM', () => {
        const fast = (m: GameplayMechanics) => spinAt(m, 900, 5, 1000).progress / (Math.PI * 2);
        expect(fast('lazer')).toBeGreaterThan(14);
        expect(fast('stable')).toBeLessThan(8.5);
    });

    it('lazer counts net rotation: wiggling back and forth is not a spin', () => {
        const wiggle = (m: GameplayMechanics) => {
            const s = setup(NO_MODS, m, map(['256,192,1000,12,0,3000']));
            for (let t = 1000; t <= 3000; t += 8) {
                const a = Math.sin((t - 1000) / 40) * 1.2; // ±1.2 rad, back and forth
                s.rules.update(t, { x: 256 + Math.cos(a) * 80, y: 192 + Math.sin(a) * 80, held: true });
            }
            return (s.rules.states[0] as SpinnerState).spinsAwarded;
        };
        expect(wiggle('lazer')).toBe(0);
        expect(wiggle('stable')).toBeGreaterThan(5);
    });
});

describe('note lock', () => {
    // A at 1000 (100,100), B at 1100 far away; OD 5: 50 window 150 ms.
    const pair = map(['100,100,1000,1,0', '400,300,1100,1,0']);

    it('lazer: blocked only before the earlier object starts; hitting B misses A', () => {
        const s = setup(NO_MODS, 'lazer', pair);
        let shaken = -1;
        s.rules.shaken.add(i => (shaken = i));
        s.rules.press(990, 400, 300);
        expect(shaken).toBe(1);
        expect(s.rules.states[1].result).toBeNull();
        s.rules.press(1010, 400, 300);
        expect(s.rules.states[1].result).toBe('ok'); // 90 ms early
        expect(s.rules.states[0].result).toBe('miss');
    });

    it('stable: blocked until the earlier object is judged (its whole hit window)', () => {
        const s = setup(NO_MODS, 'stable', pair);
        let shakes = 0;
        s.rules.shaken.add(() => shakes++);
        s.rules.press(1010, 400, 300);
        s.rules.press(1140, 400, 300);
        expect(shakes).toBe(2);
        expect(s.rules.states[0].result).toBeNull();
        expect(s.rules.states[1].result).toBeNull();
        // A's window passes (1150): it misses, and B can be hit.
        s.rules.press(1160, 400, 300);
        expect(s.rules.states[0].result).toBe('miss');
        expect(s.rules.states[1].result).toBe('ok'); // 60 ms late
    });

    it('stable: an active slider head swallows clicks over it; lazer lets them through', () => {
        // Slider 1000–2500 from (100,100); a circle on the head at 1600.
        const data = map(['100,100,1000,2,0,L|400:100,1,300', '100,100,1600,1,0'], { SliderMultiplier: 1 });
        for (const m of GAMEPLAY_MECHANICS) {
            const s = setup(NO_MODS, m, data);
            s.rules.press(1000, 100, 100);
            s.rules.press(1600, 100, 100);
            expect(s.rules.states[1].result).toBe(m === 'stable' ? null : 'great');
        }
    });
});

describe('slider tracking', () => {
    // 300 px at 0.2 px/ms: 1000–2500, ticks at 1500 and 2000.
    const slider = map(['100,100,1000,2,0,L|400:100,1,300'], { SliderMultiplier: 1 });

    function holdUntil(mechanics: GameplayMechanics, release: number) {
        const s = setup(NO_MODS, mechanics, slider);
        const h = s.beatmap.hitObjects[0] as PlayableSlider;
        s.rules.press(1000, h.x, h.y);
        for (let t = 1000; t <= 2700; t += 4) {
            const p = sliderBallPosition(h, t);
            s.rules.update(t, { x: p.x, y: p.y, held: t < release });
        }
        return { s, h };
    }

    it('tail leniency: lazer hits the tail if tracking at any point in the last 36 ms', () => {
        const tailHit = (m: GameplayMechanics, release: number) => {
            const { s } = holdUntil(m, release);
            const st = s.rules.states[0];
            return st.kind === 'slider' ? st.eventHit[st.eventHit.length - 1] : null;
        };
        // stable: the legacy last tick at end − 36 = 2464 is checked once.
        expect(tailHit('stable', 2470)).toBe(true);
        expect(tailHit('stable', 2460)).toBe(false);
        // lazer: tracking at 2464..2500 is enough.
        expect(tailHit('lazer', 2470)).toBe(true);
        expect(tailHit('lazer', 2460)).toBe(false);
        expect(tailHit('lazer', 2700)).toBe(true);
    });

    it('lazer: ticks wait for the head, and a late head hit credits the ticks it passed', () => {
        // Tick rate 8: a tick every 12.5 px = 62.5 ms. Click 140 ms late, on the ball.
        const data = map(['100,100,1000,2,0,L|400:100,1,300'], { SliderMultiplier: 1, SliderTickRate: 8 });
        const ticksHit = (m: GameplayMechanics) => {
            const s = setup(NO_MODS, m, data);
            const h = s.beatmap.hitObjects[0] as PlayableSlider;
            for (let t = 900; t < 1140; t += 4) {
                const p = sliderBallPosition(h, t);
                s.rules.update(t, { x: p.x, y: p.y, held: false });
            }
            const p = sliderBallPosition(h, 1140);
            s.rules.press(1140, p.x, p.y);
            const st = s.rules.states[0];
            return st.kind === 'slider' ? st.eventHit.slice(1, 3) : [];
        };
        expect(ticksHit('lazer')).toEqual([true, true]);
        expect(ticksHit('stable')).toEqual([false, false]);
    });
});

describe('processing', () => {
    it('hard rock flips positions vertically', () => {
        const nm = buildPlayableBeatmap(fixture, NO_MODS);
        const hr = buildPlayableBeatmap(fixture, sanitizeMods(['HR']));
        const c = nm.hitObjects.findIndex(h => h.kind === 'circle' && h.stackHeight === 0);
        expect(hr.hitObjects[c].x).toBeCloseTo(nm.hitObjects[c].x);
        expect(hr.hitObjects[c].y).toBeCloseTo(384 - nm.hitObjects[c].y);
    });
});
