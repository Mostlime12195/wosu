import { describe, expect, it } from 'vitest';
import { APP_STORES, createMemoryAppDatabase, MemoryDatabase, openDatabase } from '../../src/storage/idb';

describe('idb memory fallback', () => {
    it('opens a memory database when IndexedDB is unavailable (node)', async () => {
        const db = await openDatabase('test', 1, APP_STORES);
        expect(db.persistent).toBe(false);
        const kv = db.store<string, number>('kv');
        await kv.put(3, 'a');
        expect(await kv.get('a')).toBe(3);
    });

    it('supports out-of-line keys, ordering, delete, clear, count', async () => {
        const db = new MemoryDatabase([{ name: 's' }]);
        const s = db.store<string | number, string>('s');
        await s.put('b', 'k2');
        await s.put('a', 'k1');
        await s.put('n', 5);
        // IndexedDB key order: numbers before strings, then ascending.
        expect(await s.keys()).toEqual([5, 'k1', 'k2']);
        expect(await s.getAll()).toEqual(['n', 'a', 'b']);
        await s.delete('k1');
        expect(await s.count()).toBe(2);
        // 1 and '1' are different keys
        await s.put('one', 1);
        await s.put('str-one', '1');
        expect(await s.get(1)).toBe('one');
        expect(await s.get('1')).toBe('str-one');
        await s.clear();
        expect(await s.count()).toBe(0);
    });

    it('assigns auto-increment in-line keys', async () => {
        const db = createMemoryAppDatabase();
        const a = { v: 'a' } as { id?: number; v: string };
        const b = { v: 'b' } as { id?: number; v: string };
        const ka = await db.scores.put(a);
        const kb = await db.scores.put(b);
        expect(ka).toBe(1);
        expect(kb).toBe(2);
        expect(a.id).toBe(1);
        expect(((await db.scores.getAll()) as { v: string }[]).map(r => r.v)).toEqual(['a', 'b']);
    });

    it('rejects out-of-line puts without a key', async () => {
        const db = createMemoryAppDatabase();
        await expect(db.kv.put('x')).rejects.toThrow(/missing key/);
    });
});
