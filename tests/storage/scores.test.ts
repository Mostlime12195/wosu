import { describe, expect, it } from 'vitest';
import { createMemoryAppDatabase } from '../../src/storage/idb';
import type { LegacyData, LegacyHistoryEntry } from '../../src/storage/legacy';
import { beatmapKeyOf, migrateHistoryEntry, ScoreStore, type ScoreRecord } from '../../src/storage/ScoreStore';

function legacyWith(history: LegacyHistoryEntry[]): () => Promise<LegacyData> {
    return async () => ({
        ok: true,
        liked: [],
        knownVideos: [],
        history,
        beatmapFileNames: [],
        readBeatmapFile: async () => null,
    });
}

function record(over: Partial<ScoreRecord> = {}): ScoreRecord {
    return {
        beatmapKey: 'bid:1',
        beatmapId: 1,
        setId: 10,
        title: 'T',
        artist: 'A',
        version: 'Hard',
        creator: 'M',
        mods: [],
        score: 1000,
        accuracy: 0.9,
        maxCombo: 100,
        count300: 90,
        count100: 10,
        count50: 0,
        countMiss: 0,
        grade: 'A',
        passed: true,
        date: 1,
        player: 'Guest',
        ...over,
    };
}

describe('beatmapKeyOf', () => {
    it('prefers the online id and falls back to set/title/version', () => {
        expect(beatmapKeyOf({ beatmapId: 75, title: 'X', version: 'Y', setId: 1 })).toBe('bid:75');
        expect(beatmapKeyOf({ beatmapId: 0, title: 'Disco', version: 'Normal', setId: 1 })).toBe('t:1|disco|normal');
        expect(beatmapKeyOf({ beatmapId: -1, title: 'A', version: 'B', setId: -1 })).toBe('t:0|a|b');
    });
});

describe('legacy history migration', () => {
    it('maps the old summary row format', () => {
        const rec = migrateHistoryEntry({
            sid: '12', bid: 34, title: 'Song', version: 'Insane', mods: 'HD+HR+RL',
            grade: 'SS', score: '1234567', combo: '321', acc: '98.50%', time: 1700000000000,
        })!;
        expect(rec.beatmapKey).toBe('bid:34');
        expect(rec.setId).toBe(12);
        expect(rec.grade).toBe('X');
        expect(rec.passed).toBe(true);
        expect(rec.score).toBe(1234567);
        expect(rec.maxCombo).toBe(321);
        expect(rec.accuracy).toBeCloseTo(0.985, 6);
        // RL (old Relax label) becomes RX; display order canonical
        expect(rec.mods).toEqual(['HR', 'HD', 'RX']);
        expect(rec.legacy).toBe(true);
        expect(rec.count300 + rec.count100 + rec.count50 + rec.countMiss).toBe(0);
        expect(rec.date).toBe(1700000000000);
    });

    it('marks failed plays and tolerates junk', () => {
        expect(migrateHistoryEntry({ title: 'x', grade: 'F' })!.passed).toBe(false);
        expect(migrateHistoryEntry({ title: 'x', grade: '??' })!.grade).toBe('D');
        expect(migrateHistoryEntry({})).toBeNull();
        expect(migrateHistoryEntry(null as unknown as LegacyHistoryEntry)).toBeNull();
        const r = migrateHistoryEntry({ title: 'x', acc: 'nope', score: 'bad' })!;
        expect(r.accuracy).toBe(0);
        expect(r.score).toBe(0);
    });
});

describe('ScoreStore', () => {
    it('migrates legacy history exactly once', async () => {
        const db = createMemoryAppDatabase();
        const source = legacyWith([
            { bid: 1, title: 'A', version: 'N', score: '10', grade: 'A', time: 5 },
            { bid: 2, title: 'B', version: 'H', score: '20', grade: 'S', time: 6 },
        ]);
        const s1 = new ScoreStore(db, { legacy: source });
        await s1.init();
        expect(await s1.all()).toHaveLength(2);
        const s2 = new ScoreStore(db, { legacy: source });
        await s2.init();
        expect(await s2.all()).toHaveLength(2);
    });

    it('adds records with ids, queries by beatmap best-first, and lists recent', async () => {
        const store = new ScoreStore(createMemoryAppDatabase(), { legacy: legacyWith([]) });
        const changed: ScoreRecord[] = [];
        store.changed.add(r => changed.push(r));
        const a = await store.add(record({ score: 500, date: 10 }));
        await store.add(record({ score: 900, date: 20, passed: false, grade: 'F' }));
        await store.add(record({ score: 700, date: 30 }));
        await store.add(record({ beatmapKey: 'bid:2', beatmapId: 2, score: 1, date: 40 }));
        expect(a.id).toBeTypeOf('number');
        expect(changed).toHaveLength(4);
        expect((await store.forBeatmap('bid:1')).map(r => r.score)).toEqual([900, 700, 500]);
        // best prefers a passed play
        expect((await store.best('bid:1'))!.score).toBe(700);
        expect(await store.best('bid:404')).toBeNull();
        expect((await store.recent(2)).map(r => r.date)).toEqual([40, 30]);
        await store.delete(a.id!);
        expect((await store.forBeatmap('bid:1')).map(r => r.score)).toEqual([900, 700]);
    });

    it('does not alias the caller record', async () => {
        const store = new ScoreStore(createMemoryAppDatabase(), { legacy: legacyWith([]) });
        const input = record({ mods: ['HD'] });
        const saved = await store.add(input);
        input.mods.push('HR');
        expect(saved.mods).toEqual(['HD']);
        expect(input.id).toBeUndefined();
    });
});
