import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SampleBank } from '../../src/audio/SampleBank';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import type { PlayableSlider } from '../../src/beatmap/types';
import { HitsoundPlayer } from '../../src/gameplay/HitsoundPlayer';
import { NO_MODS } from '../../src/gameplay/mods';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const data = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

interface Call { fn: string; args: unknown[] }

/** Records what the player asks the sample bank to do. */
function fakeBank() {
    const calls: Call[] = [];
    const loops: { name: string; stopped: boolean; volume: number }[] = [];
    const bank = {
        playHit: (...args: unknown[]) => calls.push({ fn: 'playHit', args }),
        playTick: (...args: unknown[]) => calls.push({ fn: 'playTick', args }),
        play: (...args: unknown[]) => calls.push({ fn: 'play', args }),
        startLoop: (name: string, volume: number) => {
            const l = { name, stopped: false, volume };
            loops.push(l);
            return { setVolume: (v: number) => (l.volume = v), stop: () => (l.stopped = true) };
        },
    };
    return { bank: bank as unknown as SampleBank, calls, loops };
}

describe('HitsoundPlayer', () => {
    const beatmap = buildPlayableBeatmap(data, NO_MODS);

    it('inherits the timing point sample set and volume when the object says 0', () => {
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const circle = beatmap.hitObjects.find(h => h.kind === 'circle' && h.hitSample.normalSet === 0)!;
        player.hit(circle);
        const cp = beatmap.controlPoints.at(circle.time);
        const [bits, normal, addition, volume] = calls[0].args as number[];
        expect(bits).toBe(circle.hitSound);
        expect(normal).toBe(cp.sampleSet);
        expect(addition).toBe(circle.hitSample.additionSet || cp.sampleSet);
        expect(volume).toBeCloseTo((circle.hitSample.volume || cp.volume) / 100);
    });

    it('uses the default set when beatmap hitsounds are turned off', () => {
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        player.useBeatmapSets = false;
        player.hit(beatmap.hitObjects[0]);
        const [, normal, addition] = calls[0].args as number[];
        expect(normal).toBe(1);
        expect(addition).toBe(1);
    });

    it('pans by horizontal position', () => {
        const { bank, calls } = fakeBank();
        const player = new HitsoundPlayer(bank, beatmap);
        const left = { ...beatmap.hitObjects[0], x: 0 };
        const right = { ...beatmap.hitObjects[0], x: 512 };
        player.hit(left);
        player.hit(right);
        expect(calls[0].args[4]).toBeCloseTo(-0.4);
        expect(calls[1].args[4]).toBeCloseTo(0.4);
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
