import { describe, expect, it } from 'vitest';
import {
    cleanCollectionName,
    collectionItemKey,
    membershipOf,
    sanitizeCollections,
    sortCollections,
} from '../../src/beatmap/collections';
import { CollectionStore } from '../../src/storage/Collections';
import { createMemoryAppDatabase } from '../../src/storage/idb';

describe('collection helpers', () => {
    it('keys difficulties by set key and file', () => {
        expect(collectionItemKey({ key: 'osu-1' }, { file: 'a [Hard].osu' })).toBe('osu-1|a [Hard].osu');
    });

    it('computes lazer-style ternary membership', () => {
        const c = { items: ['s|a', 's|b'] };
        expect(membershipOf(c, ['s|a', 's|b'])).toBe('all');
        expect(membershipOf(c, ['s|a', 's|c'])).toBe('some');
        expect(membershipOf(c, ['s|c'])).toBe('none');
        expect(membershipOf(c, [])).toBe('none');
    });

    it('cleans names and sorts by name', () => {
        expect(cleanCollectionName('  my \n  maps  ')).toBe('my maps');
        expect(cleanCollectionName('   ')).toBe('');
        expect(cleanCollectionName('x'.repeat(300))).toHaveLength(100);
        const sorted = sortCollections([
            { name: 'b', createdAt: 1 }, { name: 'A10', createdAt: 2 }, { name: 'a2', createdAt: 3 },
        ]);
        expect(sorted.map(c => c.name)).toEqual(['a2', 'A10', 'b']);
    });

    it('sanitizes stored rows', () => {
        const out = sanitizeCollections([
            { id: 'x', name: ' Farm ', items: ['k1', 'k1', 3, ''], createdAt: 5 },
            { id: 'x', name: 'dupe id', items: [] },
            { id: 'y', name: '   ', items: [] },
            null,
            'junk',
            { id: 'z', name: 'No items' },
        ]);
        expect(out).toEqual([
            { id: 'x', name: 'Farm', items: ['k1'], createdAt: 5 },
            { id: 'z', name: 'No items', items: [], createdAt: 0 },
        ]);
        expect(sanitizeCollections({ not: 'an array' })).toEqual([]);
    });
});

describe('CollectionStore', () => {
    it('creates, renames, edits members and deletes, persisting each change', async () => {
        const db = createMemoryAppDatabase();
        const store = new CollectionStore(db);
        await store.init();
        let events = 0;
        store.changed.add(() => events++);

        expect(store.create('   ')).toBeNull();
        const farm = store.create(' Farm ', ['s|a'])!;
        const tech = store.create('Tech')!;
        expect(farm.name).toBe('Farm');
        expect(store.all.map(c => c.name)).toEqual(['Farm', 'Tech']);

        expect(store.add(farm.id, ['s|a', 's|b', 's|b'])).toBe(1);
        expect(store.membership(farm.id, ['s|a', 's|b'])).toBe('all');
        expect(store.membership(tech.id, ['s|a'])).toBe('none');
        expect(store.removeItems(farm.id, ['s|a'])).toBe(1);
        expect(store.has(farm.id, 's|a')).toBe(false);
        expect([...store.members(farm.id)!]).toEqual(['s|b']);

        expect(store.rename(tech.id, '')).toBe(false);
        expect(store.rename(tech.id, 'Aim')).toBe(true);
        expect(store.all.map(c => c.name)).toEqual(['Aim', 'Farm']);
        expect(events).toBe(5);

        await store.flush();
        const reopened = new CollectionStore(db);
        await reopened.init();
        expect(reopened.all.map(c => [c.name, c.items])).toEqual([['Aim', []], ['Farm', ['s|b']]]);

        expect(reopened.remove(farm.id)).toBe(true);
        expect(reopened.remove(farm.id)).toBe(false);
        await reopened.flush();
        const third = new CollectionStore(db);
        await third.init();
        expect(third.all.map(c => c.name)).toEqual(['Aim']);
    });

    it('remembers the song select filter and drops it with its collection', async () => {
        const db = createMemoryAppDatabase();
        const store = new CollectionStore(db);
        await store.init();
        const c = store.create('Favs')!;
        store.filter.value = c.id;
        await store.flush();

        const again = new CollectionStore(db);
        await again.init();
        expect(again.filter.value).toBe(c.id);
        again.remove(c.id);
        expect(again.filter.value).toBe('');
        await again.flush();

        const third = new CollectionStore(db);
        await third.init();
        expect(third.filter.value).toBe('');
    });

    it('ignores a stored filter for a missing collection', async () => {
        const db = createMemoryAppDatabase();
        await db.kv.put('gone', 'collectionFilter');
        const store = new CollectionStore(db);
        await store.init();
        expect(store.filter.value).toBe('');
    });
});
