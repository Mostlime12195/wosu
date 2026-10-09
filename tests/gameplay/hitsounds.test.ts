import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SampleBank } from '../../src/audio/SampleBank';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import type { PlayableSlider } from '../../src/beatmap/types';
import { HitsoundPlayer } from '../../src/gameplay/HitsoundPlayer';
import { NO_MODS } from '../../src/gameplay/mods';
import type { BeatmapSkin } from '../../src/skin/BeatmapSkin';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const data = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

interface Call { fn: string; args: unknown[] }

/** Records what the player asks the sample bank to do. */
function fakeBank() {
    const calls: Call[] = [];
    const loops: { name: string; stopped: boolean; volume: number }[] = [];
    const loop = (name: string, volume: number) => {
        const l = { name, stopped: false, volume };
        loops.push(l);
        return { setVolume: (v: number) => (l.volume = v), stop: () => (l.stopped = true) };
    };
    const bank = {
        play: (...args: unknown[]) => calls.push({ fn: 'play', args }),
        playBuffer: (...args: unknown[]) => calls.push({ fn: 'playBuffer', args }),
        startLoop: loop,
        startLoopBuffer: (buf: { name: string } | null, volume: number) => loop(buf ? `buffer:${buf.name}` : 'silent', volume),
    };
    return { bank: bank as unknown as SampleBank, calls, loops };
}

/** A beatmap skin with the given sample overrides (null = silenced). */
function fakeSkin(samples: Record<string, { name: string } | null>) {
    return {
        sample: (name: string, index = 1) => samples[index > 1 ? `${name}${index}` : name],
        file: (f: string) => samples[f],
    } as unknown as BeatmapSkin;
}

describe('HitsoundPlayer', () => {
    const beatmap = buildPlayableBeatmap(data, NO_MODS);
    const setName = (n: number) => (n === 2 ? 'soft' : n === 3 ? 'drum' : 'normal');

    it('inherits the timing point sample set and volume when the object says 0', () => {
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const circle = beatmap.hitObjects.find(h => h.kind === 'circle' && h.hitSample.normalSet === 0)!;
        player.hit(circle);
        const cp = beatmap.controlPoints.at(circle.time);
        const [name, volume] = calls[0].args as [string, number];
        expect(name).toBe(`${setName(cp.sampleSet)}-hitnormal`);
        expect(volume).toBeCloseTo((circle.hitSample.volume || cp.volume) / 100);
        expect(calls).toHaveLength(1 + [2, 4, 8].filter(b => circle.hitSound & b).length);
    });

    it("plays the map's own sample for a custom index, and silence for a blank file", () => {
        const circle = { ...beatmap.hitObjects.find(h => h.kind === 'circle')!, hitSound: 8 };
        const cp = beatmap.controlPoints.at(circle.time);
        const set = setName(circle.hitSample.normalSet || cp.sampleSet);
        const add = setName(circle.hitSample.additionSet || circle.hitSample.normalSet || cp.sampleSet);
        const withIndex = { ...circle, hitSample: { ...circle.hitSample, index: 2 } };
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap, fakeSkin({ [`${set}-hitnormal2`]: { name: 'mine' }, [`${add}-hitclap2`]: null }));
        player.hit(withIndex);
        expect(calls).toEqual([{ fn: 'playBuffer', args: [{ name: 'mine' }, expect.any(Number), expect.anything()] }]);
    });

    it("ignores the map's samples at index 0 or when beatmap hitsounds are off", () => {
        const circle = beatmap.hitObjects.find(h => h.kind === 'circle')!;
        const cp = beatmap.controlPoints.at(circle.time);
        const set = setName(circle.hitSample.normalSet || cp.sampleSet);
        const skin = fakeSkin({ [`${set}-hitnormal`]: { name: 'mine' }, [`${set}-hitnormal2`]: { name: 'mine2' } });
        const zero = { ...circle, hitSample: { ...circle.hitSample, index: 0 } };
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap, skin);
        if (cp.sampleIndex === 0) {
            player.hit(zero);
            expect(calls[0].fn).toBe('play');
        }
        calls.length = 0;
        player.useBeatmapSamples = false;
        player.hit({ ...circle, hitSample: { ...circle.hitSample, index: 2 } });
        expect(calls[0].fn).toBe('play');
    });

    it('pans by horizontal position', () => {
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const left = { ...beatmap.hitObjects[0], x: 0 };
        const right = { ...beatmap.hitObjects[0], x: 512 };
        player.hit(left);
        const first = calls.length;
        player.hit(right);
        expect((calls[0].args[2] as { pan: number }).pan).toBeCloseTo(-0.4);
        expect((calls[first].args[2] as { pan: number }).pan).toBeCloseTo(0.4);
    });

    it('starts one slide loop per slider and stops it', () => {
        const { bank, loops } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const slider = beatmap.hitObjects.find(h => h.kind === 'slider') as PlayableSlider;
        player.setSliding(slider, true);
        player.setSliding(slider, true);
        expect(loops.filter(l => l.name.endsWith('sliderslide'))).toHaveLength(1);
        player.setSliding(slider, false);
        expect(loops.every(l => l.stopped)).toBe(true);
    });

    it('stopAll silences every loop', () => {
        const { bank, loops } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const sliders = beatmap.hitObjects.filter(h => h.kind === 'slider').slice(0, 3) as PlayableSlider[];
        for (const s of sliders) player.setSliding(s, true);
        player.setSpinning(beatmap.hitObjects[0], true, 0.5);
        player.stopAll();
        expect(loops.length).toBeGreaterThan(0);
        expect(loops.every(l => l.stopped)).toBe(true);
    });
});
