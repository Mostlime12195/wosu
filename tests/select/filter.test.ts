import { describe, expect, it } from 'vitest';
import type { LibrarySet } from '../../src/beatmap/Library';
import type { DifficultySummary } from '../../src/beatmap/types';
import { effectiveAr, effectiveOd, filterSets, parseLength, parseQuery, sortEntries } from '../../src/screens/select/filter';

function diff(over: Partial<DifficultySummary> = {}): DifficultySummary {
    return {
        file: 'a.osu', version: 'Normal', beatmapId: 0, mode: 0, cs: 4, ar: 8, od: 7, hp: 5,
        bpm: 180, bpmMin: 180, bpmMax: 180, length: 120_000, circles: 300, sliders: 200, spinners: 1,
        maxCombo: 900, previewTime: 0, stars: 4.2, ...over,
    };
}

function set(over: Partial<LibrarySet> = {}): LibrarySet {
    return {
        key: 'osu-1', onlineSetId: 1, title: 'Title', titleUnicode: 'Title', artist: 'Artist', artistUnicode: 'Artist',
        creator: 'mapper', source: '', tags: '', difficulties: [diff()], audioFile: 'audio.mp3', backgroundFile: null,
        previewTime: 0, hasVideo: false, addedAt: 0, lastPlayedAt: null, sizeBytes: 0, ...over,
    };
}

describe('song select filter', () => {
    it('parses words and numeric terms', () => {
        const q = parseQuery('  Freedom ar>9 stars<=6.5 sr=5 dive length<2:30 bpm!=200 foo>bar ');
        expect(q.terms).toEqual(['freedom', 'dive', 'foo>bar']);
        expect(q.numeric).toEqual([
            { key: 'ar', op: '>', value: 9 },
            { key: 'stars', op: '<=', value: 6.5 },
            { key: 'stars', op: '=', value: 5 },
            { key: 'length', op: '<', value: 150 },
            { key: 'bpm', op: '!=', value: 200 },
        ]);
    });

    it('parses lengths in several notations', () => {
        expect(parseLength('90')).toBe(90);
        expect(parseLength('90s')).toBe(90);
        expect(parseLength('2:05')).toBe(125);
        expect(parseLength('3m')).toBe(180);
        expect(parseLength('1m30s')).toBe(90);
        expect(parseLength('abc')).toBeNaN();
    });

    it('matches every word against set text, case-insensitively', () => {
        const sets = [
            set({ key: 'a', title: 'FREEDOM DiVE', artist: 'xi', tags: 'touhou' }),
            set({ key: 'b', title: 'Blue Zenith', artist: 'xi', difficulties: [diff({ version: 'FOUR DIMENSIONS' })] }),
        ];
        expect(filterSets(sets, parseQuery('xi')).map(e => e.set.key)).toEqual(['a', 'b']);
        expect(filterSets(sets, parseQuery('xi touhou')).map(e => e.set.key)).toEqual(['a']);
        expect(filterSets(sets, parseQuery('dimensions')).map(e => e.set.key)).toEqual(['b']);
        expect(filterSets(sets, parseQuery('nothing'))).toEqual([]);
    });

    it('numeric filters hide non-matching difficulties and empty sets', () => {
        const s = set({ difficulties: [diff({ file: 'e', stars: 2 }), diff({ file: 'h', stars: 5.5 }), diff({ file: 'x', stars: null })] });
        const [entry] = filterSets([s], parseQuery('stars>4'));
        expect(entry.diffs.map(d => d.file)).toEqual(['h']);
        expect(filterSets([s], parseQuery('stars>9'))).toEqual([]);
        // Equality uses the displayed precision.
        expect(filterSets([s], parseQuery('stars=5.5'))[0].diffs.map(d => d.file)).toEqual(['h']);
    });

    it('sorts by the chosen criterion with title as tie-break', () => {
        const entries = filterSets([
            set({ key: 'b', title: 'Beta', artist: 'Zed', addedAt: 3, difficulties: [diff({ stars: 6 })] }),
            set({ key: 'a', title: 'alpha', artist: 'Yan', addedAt: 1, difficulties: [diff({ stars: 2 })] }),
            set({ key: 'c', title: 'Gamma', artist: 'Ann', addedAt: 2, difficulties: [diff({ stars: 4 })] }),
        ], parseQuery(''));
        expect(sortEntries(entries, 'title').map(e => e.set.key)).toEqual(['a', 'b', 'c']);
        expect(sortEntries(entries, 'artist').map(e => e.set.key)).toEqual(['c', 'a', 'b']);
        expect(sortEntries(entries, 'difficulty').map(e => e.set.key)).toEqual(['a', 'c', 'b']);
        expect(sortEntries(entries, 'dateAdded').map(e => e.set.key)).toEqual(['b', 'c', 'a']);
        // Sorting never mutates the input.
        expect(entries.map(e => e.set.key)).toEqual(['b', 'a', 'c']);
    });

    it('rate-adjusts AR and OD like stable', () => {
        expect(effectiveAr(9, 1)).toBeCloseTo(9);
        expect(effectiveAr(9, 1.5)).toBeCloseTo(10.33, 2);
        expect(effectiveAr(9, 0.75)).toBeCloseTo(7.67, 2);
        expect(effectiveOd(8, 1)).toBeCloseTo(8);
        expect(effectiveOd(8, 1.5)).toBeCloseTo(9.78, 2);
    });
});
