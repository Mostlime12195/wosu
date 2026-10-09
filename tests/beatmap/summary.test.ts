import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import { summarizeDifficulty } from '../../src/beatmap/summary';
import type { PlayableSlider } from '../../src/beatmap/types';
import { NO_MODS } from '../../src/gameplay/mods';
import { MAP_BASIC, fixtureOsu, makeMap } from './helpers';

describe('summarizeDifficulty', () => {
    it('counts objects, length and max combo', () => {
        const data = parseOsu(MAP_BASIC);
        const s = summarizeDifficulty(data, 'x.osu');
        expect(s).toMatchObject({ file: 'x.osu', version: 'Normal', beatmapId: 1, circles: 1, sliders: 1, spinners: 1, starSource: 'local' });
        expect(s.stars).toBeTypeOf('number');
        expect(s.bpm).toBeCloseTo(120);
        expect(s.length).toBe(2500);
        expect(s.cs).toBe(4);
    });

    it('max combo matches the processed nested events', () => {
        const data = parseOsu(fixtureOsu());
        const s = summarizeDifficulty(data, 'fixture.osu');
        const pb = buildPlayableBeatmap(data, NO_MODS);
        let combo = 0;
        for (const h of pb.hitObjects) combo += h.kind === 'slider' ? (h as PlayableSlider).events.length : 1;
        expect(s.maxCombo).toBe(combo);
        expect(s.length).toBeCloseTo(pb.endTime - pb.startTime, 6);
    });

    it('reports the tempo covering most of the map and the BPM range', () => {
        const text = makeMap({
            objects: ['0,0,1000,1,0', '0,0,9000,1,0'],
            timing: ['0,500,4,1,0,100,1,0', '2000,250,4,1,0,100,1,0'],
        });
        const s = summarizeDifficulty(parseOsu(text), 'a.osu');
        expect(s.bpm).toBeCloseTo(240);
        expect(s.bpmMin).toBeCloseTo(120);
        expect(s.bpmMax).toBeCloseTo(240);
    });
});
