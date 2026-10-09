// Parse + process a real ranked map end to end.
import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import type { PlayableSlider } from '../../src/beatmap/types';
import { sanitizeMods, NO_MODS } from '../../src/gameplay/mods';
import { fixtureOsu } from './helpers';

describe('fixture map', () => {
    const data = parseOsu(fixtureOsu());

    it('decodes metadata and events', () => {
        expect(data.formatVersion).toBe(14);
        expect(data.metadata.beatmapId).toBe(3097691);
        expect(data.metadata.beatmapSetId).toBe(1510388);
        expect(data.metadata.titleUnicode).toBe('我武者羅 (TV Size)');
        expect(data.general.previewTime).toBe(56222);
        expect(data.general.sampleSet).toBe(2);
        expect(data.events.backgroundFile).toBe('aw.jpg');
        expect(data.events.breaks).toEqual([{ startTime: 17376, endTime: 20999 }]);
        expect(data.hitObjects.length).toBeGreaterThan(100);
    });

    for (const mods of [NO_MODS, sanitizeMods(['HR']), sanitizeMods(['EZ'])]) {
        it(`processes cleanly with mods [${[...mods].join('')}]`, () => {
            const pb = buildPlayableBeatmap(data, mods);
            expect(pb.hitObjects).toHaveLength(data.hitObjects.length);
            let prevTime = -Infinity;
            for (const h of pb.hitObjects) {
                for (const v of [h.x, h.y, h.time, h.endTime]) expect(Number.isFinite(v)).toBe(true);
                expect(h.time).toBeGreaterThanOrEqual(prevTime);
                expect(h.endTime).toBeGreaterThanOrEqual(h.time);
                expect(h.comboNumber).toBeGreaterThanOrEqual(1);
                prevTime = h.time;
                if (h.kind === 'slider') {
                    const s = h as PlayableSlider;
                    expect(s.events[0].kind).toBe('head');
                    expect(s.events[s.events.length - 1].kind).toBe('tail');
                    for (let i = 1; i < s.events.length; i++) expect(s.events[i].time).toBeGreaterThanOrEqual(s.events[i - 1].time);
                    for (const p of s.path.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t)).toBe(true);
                    expect(s.path.length).toBeGreaterThan(0);
                    expect(s.events.filter(e => e.kind === 'repeat')).toHaveLength(s.slides - 1);
                }
            }
            expect(pb.endTime).toBeGreaterThan(pb.startTime);
        });
    }
});
