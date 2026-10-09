import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateDifficulty } from '../../src/beatmap/difficulty';
import { parseOsu } from '../../src/beatmap/parser';
import { buildPlayableBeatmap } from '../../src/beatmap/processing';
import { NO_MODS, sanitizeMods } from '../../src/gameplay/mods';

const FIXDIR = join(__dirname, '..', 'fixtures', 'map1');
const osuFile = readdirSync(FIXDIR).find(f => f.endsWith('.osu'))!;
const data = parseOsu(readFileSync(join(FIXDIR, osuFile), 'utf8'));

describe('calculateDifficulty', () => {
    it('lands near the official rating of the fixture (2.49★)', () => {
        const r = calculateDifficulty(buildPlayableBeatmap(data, NO_MODS));
        expect(r.stars).toBeGreaterThan(2.2);
        expect(r.stars).toBeLessThan(2.8);
        expect(r.aim).toBeGreaterThan(0);
        expect(r.speed).toBeGreaterThan(0);
    });

    it('rates DT and HR above nomod, HT and EZ below', () => {
        const nm = calculateDifficulty(buildPlayableBeatmap(data, NO_MODS)).stars;
        expect(calculateDifficulty(buildPlayableBeatmap(data, sanitizeMods(['DT'])), 1.5).stars).toBeGreaterThan(nm * 1.2);
        expect(calculateDifficulty(buildPlayableBeatmap(data, sanitizeMods(['HR']))).stars).toBeGreaterThan(nm);
        expect(calculateDifficulty(buildPlayableBeatmap(data, sanitizeMods(['HT'])), 0.75).stars).toBeLessThan(nm);
        expect(calculateDifficulty(buildPlayableBeatmap(data, sanitizeMods(['EZ']))).stars).toBeLessThan(nm);
    });

    it('handles a single object', () => {
        const one = { ...data, hitObjects: data.hitObjects.slice(0, 1) };
        expect(calculateDifficulty(buildPlayableBeatmap(one, NO_MODS)).stars).toBe(0);
    });
});
