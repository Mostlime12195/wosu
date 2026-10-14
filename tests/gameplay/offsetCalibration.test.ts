import { describe, expect, it } from 'vitest';
import {
    BEATMAP_OFFSET_MAX,
    canCalibrate,
    clampBeatmapOffset,
    describeAverage,
    errorHistogram,
    formatBeatmapOffset,
    suggestOffset,
    trackOffset,
} from '../../src/gameplay/offsetCalibration';
import { BeatmapOffsetStore } from '../../src/storage/BeatmapOffsets';

const hits = (n: number, v: number) => new Array<number>(n).fill(v);

describe('offset calibration', () => {
    it('needs at least ten timed hits (lazer)', () => {
        expect(suggestOffset({ hitErrors: hits(9, 12), rate: 1, offset: 0 })).toBeNull();
        expect(suggestOffset(null)).toBeNull();
        expect(suggestOffset({ hitErrors: hits(10, 12), rate: 1, offset: 0 })).toEqual({ average: 12, offset: 12, hits: 10 });
    });

    it('adds the mean error to the offset the play was set with', () => {
        // Late hits: delay hit timing further; early hits: bring it back.
        expect(suggestOffset({ hitErrors: [...hits(10, 8), ...hits(10, 12)], rate: 1, offset: 5 })?.offset).toBe(15);
        expect(suggestOffset({ hitErrors: hits(20, -7.3), rate: 1, offset: 3 })?.offset).toBe(-4.3);
    });

    it('converts song-time errors to real time under rate mods', () => {
        // DT: 15 ms of song time is 10 ms of real time.
        const s = suggestOffset({ hitErrors: hits(12, 15), rate: 1.5, offset: 0 });
        expect(s?.average).toBeCloseTo(10);
        expect(s?.offset).toBe(10);
    });

    it('clamps to lazer\'s range and precision', () => {
        expect(clampBeatmapOffset(80)).toBe(BEATMAP_OFFSET_MAX);
        expect(clampBeatmapOffset(1.26)).toBe(1.3);
        expect(clampBeatmapOffset(Number.NaN)).toBe(0);
        expect(suggestOffset({ hitErrors: hits(10, 200), rate: 1, offset: 0 })?.offset).toBe(50);
    });

    it('only offers calibrating when it would change the offset', () => {
        const s = suggestOffset({ hitErrors: hits(10, 4), rate: 1, offset: 0 });
        expect(canCalibrate(0, s)).toBe(true);
        expect(canCalibrate(4, s)).toBe(false);
        expect(canCalibrate(0, null)).toBe(false);
    });

    it('describes and formats', () => {
        expect(describeAverage(12.34)).toBe('12.3 ms late');
        expect(describeAverage(-4)).toBe('4.0 ms early');
        expect(describeAverage(0.01)).toBe('right on time');
        expect(formatBeatmapOffset(3.5)).toBe('+3.5 ms');
        expect(formatBeatmapOffset(-2)).toBe('-2.0 ms');
        expect(formatBeatmapOffset(0)).toBe('0 ms');
    });

    it('applies the beatmap offset in real time on top of the global one', () => {
        expect(trackOffset(10, 5, 1)).toBe(15);
        expect(trackOffset(10, 4, 1.5)).toBe(16);
        expect(trackOffset(-3, 0, 0.75)).toBe(-3);
    });

    it('bins errors for the timing graph', () => {
        const h = errorHistogram([-50, 0, 0, 1, 49, 500], 50, 5);
        expect(h).toHaveLength(5);
        expect(Math.max(...h)).toBe(1);
        expect(h[2]).toBe(1);
        expect(h[0]).toBeCloseTo(1 / 3);
        expect(h[4]).toBeCloseTo(2 / 3);
        expect(errorHistogram([], 50, 3)).toEqual([0, 0, 0]);
    });
});

describe('BeatmapOffsetStore', () => {
    function memory(initial: Record<string, string> = {}) {
        const data = { ...initial };
        return { data, storage: { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } } };
    }

    it('persists non-zero offsets per beatmap and notifies', () => {
        const m = memory();
        const store = new BeatmapOffsetStore(m.storage);
        const seen: [string, number][] = [];
        store.changed.add((k, v) => seen.push([k, v]));
        store.set('bid:1', 4.04);
        store.set('bid:1', 4);
        store.set('bid:2', -3);
        store.set('bid:2', 0);
        expect(store.get('bid:1')).toBe(4);
        expect(store.get('bid:2')).toBe(0);
        expect(seen).toEqual([['bid:1', 4], ['bid:2', -3], ['bid:2', 0]]);
        expect(JSON.parse(Object.values(m.data)[0])).toEqual({ 'bid:1': 4 });
        expect(new BeatmapOffsetStore(m.storage).get('bid:1')).toBe(4);
    });

    it('ignores corrupt storage', () => {
        const store = new BeatmapOffsetStore(memory({ 'wosu.beatmapOffsets.v1': '{"a": "x", "b": 900, "c": [1]' }).storage);
        expect(store.get('a')).toBe(0);
        const store2 = new BeatmapOffsetStore(memory({ 'wosu.beatmapOffsets.v1': '{"a": "x", "b": 900}' }).storage);
        expect(store2.get('a')).toBe(0);
        expect(store2.get('b')).toBe(50);
    });

    it('remembers the last play per difficulty', () => {
        const store = new BeatmapOffsetStore(memory().storage);
        let played = 0;
        store.played.add(() => played++);
        expect(store.lastPlay('k')).toBeNull();
        store.recordPlay('k', { hitErrors: [1, 2], rate: 1, offset: 0 });
        expect(store.lastPlay('k')?.hitErrors).toEqual([1, 2]);
        expect(played).toBe(1);
    });
});
