import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap, playableOptions } from '../../src/beatmap/processing';
import { GameplayRules } from '../../src/gameplay/GameplayRules';
import { AutoPlayer } from '../../src/gameplay/input/AutoPlayer';
import type { GameplayButton } from '../../src/gameplay/input/GameplayInput';
import { inputMode, NO_MODS, sanitizeMods, scoreMultiplier, type ModSet } from '../../src/gameplay/mods';
import { BUTTON_BITS, decodeReplay, encodeReplay, quantize, type ReplayEvent } from '../../src/gameplay/replay/Replay';
import { ReplayPlayback } from '../../src/gameplay/replay/ReplayPlayback';
import { ReplayRecorder } from '../../src/gameplay/replay/ReplayRecorder';
import { RulesDriver } from '../../src/gameplay/RulesDriver';
import { HealthProcessor } from '../../src/gameplay/scoring/HealthProcessor';
import { GAMEPLAY_MECHANICS, type GameplayMechanics } from '../../src/gameplay/scoring/mechanics';
import { ScoreProcessor } from '../../src/gameplay/scoring/ScoreProcessor';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const fixture = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

/** Rules + driver as the Player builds them, with every judgement logged. */
function setup(mods: ModSet, mechanics: GameplayMechanics) {
    const beatmap = buildPlayableBeatmap(fixture, mods, playableOptions(mechanics));
    const score = new ScoreProcessor({ difficultyMultiplier: 4, modMultiplier: scoreMultiplier(mods), mechanics });
    const health = new HealthProcessor({
        hpDifficulty: beatmap.difficulty.hp, breaks: beatmap.breaks,
        drainStart: beatmap.startTime, drainEnd: beatmap.endTime,
        noFail: true, mechanics, objects: beatmap.hitObjects, od: beatmap.difficulty.od,
    });
    const rules = new GameplayRules(beatmap, mods, score, health, mechanics);
    const mode = inputMode(mods);
    const auto = mode === 'autopilot' ? new AutoPlayer(beatmap) : null;
    const driver = new RulesDriver(rules, mode, auto);
    const log: string[] = [];
    rules.objectJudged.add(i => log.push(`${i.index}:${i.result}@${i.time}`));
    rules.nestedJudged.add((i, ev, hit) => log.push(`${i}.${ev.kind}@${ev.time}:${hit}`));
    rules.spun.add((i, bonus) => log.push(`${i}:spin${bonus ? '+' : ''}`));
    return { beatmap, score, health, rules, driver, log };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A sloppy human play as the Player sees it: uneven frame times (with
 * hitches), a shaky cursor that drifts off sliders, presses early/late or
 * skipped between frames, early releases and a pause. Input goes through
 * the recorder and the rules judge what it records, like live play.
 */
function livePlay(mods: ModSet, mechanics: GameplayMechanics, seed: number) {
    const s = setup(mods, mechanics);
    const rand = rng(seed);
    const path = new AutoPlayer(s.beatmap);
    const rec = new ReplayRecorder();
    const presses = path.presses.map(p => ({ ...p, time: p.time + (rand() - 0.5) * 90, skip: rand() < 0.08 }))
        .sort((a, b) => a.time - b.time);
    let pi = 0;
    let button: GameplayButton = 'K1';
    let releaseEarly = -Infinity;
    const resumeAt = s.beatmap.startTime + (s.beatmap.endTime - s.beatmap.startTime) / 2;
    let resumed = false;
    const end = s.beatmap.endTime + 1000;
    const shake = () => (rand() - 0.5) * 30;
    for (let t = s.beatmap.startTime - 2000; t <= end;) {
        // Presses arrive between frames with their own timestamps.
        while (pi < presses.length && presses[pi].time <= t) {
            const p = presses[pi++];
            if (p.skip) continue;
            button = button === 'K1' ? 'K2' : 'K1';
            const e = rec.press(p.time, p.x + shake(), p.y + shake(), button);
            s.driver.press(e.time, e.x, e.y);
            if (rand() < 0.15) releaseEarly = p.time + 30;
        }
        if (!resumed && t >= resumeAt) {
            resumed = true;
            const r = rec.resume(t);
            s.driver.resume();
            expect(r.kind).toBe('resume');
        }
        const a = path.cursorAt(t);
        const held = a.held && !(t > releaseEarly && t < releaseEarly + 200);
        const drift = rand() < 0.02 ? 120 : 0;
        const f = rec.frame(t, a.x + shake() + drift, a.y + shake(), held ? BUTTON_BITS[button] : 0);
        if (f) s.driver.apply(f);
        t += rand() < 0.03 ? 60 + rand() * 80 : 3 + rand() * 15;
    }
    return { ...s, events: rec.events };
}

/** Watch a replay through the playback at its own uneven render frames. */
function watch(events: readonly ReplayEvent[], mods: ModSet, mechanics: GameplayMechanics, seed: number) {
    const s = setup(mods, mechanics);
    const playback = new ReplayPlayback(events);
    const rand = rng(seed);
    for (let t = s.beatmap.startTime - 2500; !playback.done; t += 1 + rand() * 40) playback.advance(t, e => s.driver.apply(e));
    return { ...s, playback };
}

function summary(s: ReturnType<typeof setup>) {
    const sc = s.score;
    return {
        score: sc.score, accuracy: sc.accuracy, maxCombo: sc.maxCombo, combo: sc.combo,
        counts: [sc.count300, sc.count100, sc.count50, sc.countMiss],
        ticks: [sc.sliderTicksHit, sc.sliderTicksTotal],
        hp: s.health.hp, errors: s.rules.hitErrors.slice(), finished: s.rules.finished,
    };
}

describe.each(GAMEPLAY_MECHANICS)('replays (%s)', mechanics => {
    const cases: [string, ModSet][] = [
        ['no mods', NO_MODS],
        ['HR', sanitizeMods(['HR'])],
        ['DT HD', sanitizeMods(['DT', 'HD'])],
        ['Relax', sanitizeMods(['RX'])],
        ['Autopilot', sanitizeMods(['AP'])],
    ];
    it.each(cases)('a recorded play replays to the same judgements (%s)', (_name, mods) => {
        for (const seed of [1, 7, 42]) {
            const live = livePlay(mods, mechanics, seed);
            const data = encodeReplay(live.events);
            const watched = watch(decodeReplay(data), mods, mechanics, seed + 100);
            expect(summary(watched)).toEqual(summary(live));
            expect(watched.log).toEqual(live.log);
            // A sloppy play, so the comparison means something (Relax still aims well enough).
            if (inputMode(mods) !== 'relax') expect(live.score.accuracy < 1 || live.score.sliderTicksHit < live.score.sliderTicksTotal).toBe(true);
        }
    });
});

describe('replay encoding', () => {
    it('round-trips every event exactly', () => {
        const events: ReplayEvent[] = [
            { kind: 'frame', time: quantize(-1534.27), x: quantize(256.3), y: quantize(-12.01), buttons: 0 },
            { kind: 'press', time: quantize(100.5), x: quantize(1e4), y: quantize(3.3), button: 'M2' },
            { kind: 'frame', time: quantize(99.9), x: 0, y: 0, buttons: 15 },
            { kind: 'resume', time: quantize(5e6) },
            { kind: 'press', time: quantize(5e6 + 1), x: quantize(-700.06), y: 1, button: 'K1' },
        ];
        expect(decodeReplay(encodeReplay(events))).toEqual(events);
        expect(decodeReplay(encodeReplay([]))).toEqual([]);
    });

    it('stays compact: a few bytes per frame, even for this very shaky cursor', () => {
        const live = livePlay(NO_MODS, 'lazer', 3);
        const data = encodeReplay(live.events);
        expect(live.events.length).toBeGreaterThan(1000);
        expect(data.length / live.events.length).toBeLessThan(6);
    });

    it('rejects corrupt data', () => {
        expect(() => decodeReplay(new Uint8Array([1, 2, 3]))).toThrow();
    });

    it('records button changes at once and caps frames while only moving', () => {
        const rec = new ReplayRecorder();
        expect(rec.frame(0, 1, 1, 0)).not.toBeNull();
        expect(rec.frame(2, 2, 2, 0)).toBeNull();
        expect(rec.frame(3, 2, 2, 1)).not.toBeNull();
        expect(rec.frame(3 + 1000 / 120, 5, 5, 1)).not.toBeNull();
    });

    it('playback reports the replayed keys and an interpolated cursor', () => {
        const p = new ReplayPlayback([
            { kind: 'frame', time: 0, x: 0, y: 0, buttons: 0 },
            { kind: 'press', time: 5, x: 0, y: 0, button: 'K2' },
            { kind: 'frame', time: 10, x: 100, y: 50, buttons: BUTTON_BITS.K2 },
        ]);
        const seen: string[] = [];
        p.advance(5, e => seen.push(e.kind));
        expect(seen).toEqual(['frame', 'press']);
        expect(p.down.K2).toBe(true);
        expect(p.counts.K2).toBe(1);
        expect(p.cursorAt(7.5)).toEqual({ x: 50, y: 25 });
        p.advance(10, () => {});
        expect(p.done).toBe(true);
    });
});
