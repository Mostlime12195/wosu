import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryAppDatabase } from '../../src/storage/idb';
import {
    migrateOnce,
    normalizeLikedList,
    normalizeSidList,
    toSetIds,
    type LegacyData,
} from '../../src/storage/legacy';

function legacy(over: Partial<LegacyData> = {}): LegacyData {
    return {
        ok: true,
        liked: [],
        knownVideos: [],
        history: [],
        beatmapFileNames: [],
        readBeatmapFile: async () => null,
        ...over,
    };
}

describe('legacy normalizers (ported behaviour)', () => {
    it('normalizes Set, Array, corrupt {} and null like the old site', () => {
        expect(normalizeLikedList(new Set([123, 456, 123]))).toEqual([123, 456]);
        expect(normalizeLikedList([1, 2, 2, 0, null, 3])).toEqual([1, 2, 0, 3]);
        expect(normalizeLikedList({})).toEqual([]);
        expect(normalizeLikedList(null)).toEqual([]);
        expect(normalizeLikedList(undefined)).toEqual([]);
        // array that survived as an index-keyed object
        expect(normalizeLikedList({ 0: 5, 1: 6, 2: 5 })).toEqual([5, 6]);
        // dedupe is by string form
        expect(normalizeLikedList([7, '7', 8])).toEqual([7, 8]);
    });

    it('normalizes the video registry list', () => {
        expect(normalizeSidList(new Set([1, 2]))).toEqual([1, 2]);
        expect(normalizeSidList([1, null, '', 0, 3])).toEqual([1, 0, 3]);
        expect(normalizeSidList('junk')).toEqual([]);
    });

    it('converts mixed ids to positive integers', () => {
        expect(toSetIds(['1510388', 1510388, ' 42 ', 0, -1, 'x', 3.5, null, 7])).toEqual([1510388, 42, 7]);
    });
});

describe('migrateOnce', () => {
    it('runs once and records the flag', async () => {
        const db = createMemoryAppDatabase();
        const apply = vi.fn();
        const source = async () => legacy();
        expect(await migrateOnce(db.kv, 'x', apply, source)).toBe(true);
        expect(await migrateOnce(db.kv, 'x', apply, source)).toBe(false);
        expect(apply).toHaveBeenCalledTimes(1);
        // independent consumers have independent flags
        expect(await migrateOnce(db.kv, 'y', apply, source)).toBe(true);
    });

    it('retries next time when the read was incomplete or apply threw', async () => {
        const db = createMemoryAppDatabase();
        const apply = vi.fn();
        await migrateOnce(db.kv, 'x', apply, async () => legacy({ ok: false }));
        await migrateOnce(db.kv, 'x', apply, async () => legacy());
        expect(apply).toHaveBeenCalledTimes(2);

        const boom = vi.fn(() => {
            throw new Error('boom');
        });
        expect(await migrateOnce(db.kv, 'z', boom, async () => legacy())).toBe(false);
        expect(await migrateOnce(db.kv, 'z', apply, async () => legacy())).toBe(true);
    });
});

describe('readLegacyData from localStorage (localforage fallback driver)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    function fakeStorage(entries: Record<string, string>): Storage {
        const keys = Object.keys(entries);
        return {
            get length() {
                return keys.length;
            },
            key: (i: number) => keys[i] ?? null,
            getItem: (k: string) => (k in entries ? entries[k] : null),
            setItem: () => undefined,
            removeItem: () => undefined,
            clear: () => undefined,
        } as Storage;
    }

    it('decodes JSON values and lfsc-encoded blobs', async () => {
        const osz = btoa('PK\u0003\u0004rest');
        vi.stubGlobal('localStorage', fakeStorage({
            'localforage/likedsidset': JSON.stringify([1, 2, 2, 3]),
            'localforage/videosidset': JSON.stringify(['9']),
            'localforage/playhistory1000': JSON.stringify([{ sid: 1, title: 'T', grade: 'SS' }, null]),
            'localforage/beatmapfilelist': JSON.stringify(['a.osz', 'a.osz', '', 'b.osz']),
            'localforage/a.osz': `__lfsc__:blob~~local_forage_type~application/zip~${osz}`,
            'osugamesettings': JSON.stringify({ dim: 70 }),
            'unrelated': 'x',
        }));
        const mod = await import('../../src/storage/legacy');
        const data = await mod.readLegacyData();
        expect(data.ok).toBe(true);
        expect(data.liked).toEqual([1, 2, 3]);
        expect(data.knownVideos).toEqual(['9']);
        expect(data.history).toHaveLength(1);
        expect(data.beatmapFileNames).toEqual(['a.osz', 'b.osz']);
        const blob = await data.readBeatmapFile('a.osz');
        expect(blob).toBeInstanceOf(Blob);
        expect(blob!.type).toBe('application/zip');
        expect(await blob!.text()).toBe('PK\u0003\u0004rest');
        expect(await data.readBeatmapFile('b.osz')).toBeNull();
        expect(mod.readLegacySettings()).toEqual({ dim: 70 });
        // memoized: same promise on repeated reads
        expect(mod.readLegacyData()).toBe(mod.readLegacyData());
    });

    it('is empty and ok when nothing was stored', async () => {
        vi.stubGlobal('localStorage', fakeStorage({}));
        const mod = await import('../../src/storage/legacy');
        const data = await mod.readLegacyData();
        expect(data.ok).toBe(true);
        expect(data.liked).toEqual([]);
        expect(mod.readLegacySettings()).toBeNull();
    });
});
