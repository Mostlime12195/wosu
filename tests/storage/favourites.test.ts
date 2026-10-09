import { describe, expect, it } from 'vitest';
import { Favourites } from '../../src/storage/Favourites';
import { createMemoryAppDatabase } from '../../src/storage/idb';
import { KnownVideos } from '../../src/storage/KnownVideos';
import type { LegacyData } from '../../src/storage/legacy';

function legacy(over: Partial<LegacyData>): () => Promise<LegacyData> {
    return async () => ({
        ok: true,
        liked: [],
        knownVideos: [],
        history: [],
        beatmapFileNames: [],
        readBeatmapFile: async () => null,
        ...over,
    });
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('Favourites', () => {
    it('migrates legacy liked sets (mixed types, dupes) once', async () => {
        const db = createMemoryAppDatabase();
        const f = new Favourites(db, { legacy: legacy({ liked: ['10', 20, 10, 'junk', 0] }) });
        await f.init();
        expect(f.list()).toEqual([20, 10]); // newest (last liked) first
        f.remove(10);
        await flush();
        // a second instance must not resurrect the removed legacy entry
        const g = new Favourites(db, { legacy: legacy({ liked: ['10', 20] }) });
        await g.init();
        expect(g.list()).toEqual([20]);
    });

    it('toggles, dedupes, emits and persists', async () => {
        const db = createMemoryAppDatabase();
        const f = new Favourites(db, { legacy: legacy({}) });
        await f.init();
        let events = 0;
        f.changed.add(() => events++);
        expect(f.toggle(5)).toBe(true);
        f.add(5);
        f.add(7);
        f.add(-3);
        expect(f.has(5)).toBe(true);
        expect(f.size).toBe(2);
        expect(f.toggle(5)).toBe(false);
        expect(f.list()).toEqual([7]);
        expect(events).toBe(3);
        await flush();
        const reloaded = new Favourites(db, { legacy: legacy({}) });
        await reloaded.init();
        expect(reloaded.list()).toEqual([7]);
    });
});

describe('KnownVideos', () => {
    it('records number/string ids, ignores junk, persists, migrates', async () => {
        const db = createMemoryAppDatabase();
        const v = new KnownVideos(db, { legacy: legacy({ knownVideos: ['1510388', 2] }) });
        await v.init();
        expect(v.has(1510388)).toBe(true);
        expect(v.has('1510388')).toBe(true);
        expect(v.has(2)).toBe(true);
        expect(v.has(999)).toBe(false);
        v.record('77');
        v.record(77);
        v.record(null);
        v.record(undefined);
        v.record('');
        expect(v.has(77)).toBe(true);
        await flush();
        const w = new KnownVideos(db, { legacy: legacy({}) });
        await w.init();
        expect([1510388, 2, 77].every(id => w.has(id))).toBe(true);
        expect(w.has(null)).toBe(false);
    });
});
