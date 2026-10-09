import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { Bindable } from '../../src/core/Bindable';
import { Signal } from '../../src/core/Signal';
import { NotificationManager } from '../../src/overlays/notifications/Notifications';
import {
    archiveName, classifyArchive, exportFilename, findSkinIni, readSkinArchive, skinId, skinMetadata, UNKNOWN_AUTHOR,
} from '../../src/skin/SkinImport';
import { SkinManager, type SkinHost } from '../../src/skin/SkinManager';
import { MemoryDatabase } from '../../src/storage/idb';
import { SKIN_STORES, SkinStore } from '../../src/storage/SkinStore';

function zip(files: Record<string, string>): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
    return zipSync(entries);
}

const file = (name: string, files: Record<string, string>) => new File([zip(files) as Uint8Array<ArrayBuffer>], name);

const INI = '[General]\r\nName: Rafis\r\nAuthor: Rafis\r\n';

describe('skin detection', () => {
    it('finds skin.ini at the root or in one wrapping folder', () => {
        expect(findSkinIni(['Skin.INI', 'hitcircle.png'])).toBe('Skin.INI');
        expect(findSkinIni(['My Skin/skin.ini', 'My Skin/hitcircle.png'])).toBe('My Skin/skin.ini');
        expect(findSkinIni(['My Skin/skin.ini', '__MACOSX/My Skin/._skin.ini'])).toBe('My Skin/skin.ini');
        expect(findSkinIni(['a/skin.ini', 'b/hitcircle.png'])).toBeNull();
        expect(findSkinIni(['a/b/skin.ini'])).toBeNull();
        expect(findSkinIni(['hitcircle.png'])).toBeNull();
    });

    it('classifies archives by contents, and .osk by extension', () => {
        expect(classifyArchive(['skin.ini', 'cursor.png'], 'x.zip')).toBe('skin');
        expect(classifyArchive(['map [Hard].osu', 'audio.mp3', 'skin.ini'], 'x.zip')).toBe('beatmap');
        expect(classifyArchive(['map.osu', 'audio.mp3'])).toBe('beatmap');
        expect(classifyArchive(['readme.txt'], 'x.zip')).toBe('unknown');
        expect(classifyArchive(['cursor.png'], 'Something.OSK')).toBe('skin');
    });
});

describe('skin metadata', () => {
    it('uses skin.ini, falling back to the file name and "Unknown"', () => {
        expect(skinMetadata({ name: 'Rafis', author: 'Rafis' }, 'Rafis.osk')).toEqual({ name: 'Rafis', author: 'Rafis' });
        expect(skinMetadata({}, 'path/to/Cool Skin.osk')).toEqual({ name: 'Cool Skin', author: UNKNOWN_AUTHOR });
        expect(skinMetadata({ name: '  ', author: '' }, 'Cool.zip')).toEqual({ name: 'Cool', author: UNKNOWN_AUTHOR });
    });

    it('appends a differing file name as lazer does', () => {
        expect(skinMetadata({ name: 'Rafis', author: 'R' }, 'Rafis HDDT edit.osk').name).toBe('Rafis [Rafis HDDT edit]');
        expect(skinMetadata({ name: 'Rafis', author: 'R' }, 'Rafis (R).osk').name).toBe('Rafis');
    });

    it('derives a stable, case-insensitive id from name and author', () => {
        expect(skinId({ name: 'Rafis', author: 'me' })).toBe(skinId({ name: 'RAFIS', author: 'Me' }));
        expect(skinId({ name: 'Rafis', author: 'me' })).not.toBe(skinId({ name: 'Rafis', author: 'you' }));
        expect(skinId({ name: 'a', author: 'b' })).toMatch(/^skin-[0-9a-f]{16}$/);
    });

    it('names exports safely', () => {
        expect(archiveName('x/y\\My Skin.OSK')).toBe('My Skin');
        expect(exportFilename({ name: 'a/b: c?', author: '' })).toBe('a_b_ c_.osk');
    });

    it('reads a skin archive and rejects beatmaps', async () => {
        const read = await readSkinArchive(zip({ 'Rafis/skin.ini': INI, 'Rafis/cursor.png': '' }), 'Rafis.zip');
        expect(read.meta).toEqual({ name: 'Rafis', author: 'Rafis' });
        await expect(readSkinArchive(zip({ 'a.osu': 'osu file format v14' }), 'map.zip')).rejects.toThrow(/beatmap/);
        await expect(readSkinArchive(new Uint8Array([1, 2, 3]), 'broken.osk')).rejects.toThrow(/valid/);
    });
});

describe('SkinStore', () => {
    it('stores, replaces, lists by name and deletes', async () => {
        const db = new MemoryDatabase(SKIN_STORES);
        const store = new SkinStore(db);
        await store.init();
        const row = (id: string, name: string) => ({ id, name, author: 'x', filename: `${name}.osk`, addedAt: 1, sizeBytes: 3 });
        await store.put(row('b', 'beta'), new Blob(['1']));
        await store.put(row('a', 'Alpha'), new Blob(['2']));
        await store.put({ ...row('b', 'beta'), sizeBytes: 9 }, new Blob(['3']));
        expect(store.list.map(s => s.id)).toEqual(['a', 'b']);
        expect(store.get('b')?.sizeBytes).toBe(9);
        expect(await (await store.blob('b'))!.text()).toBe('3');

        const reopened = new SkinStore(db);
        await reopened.init();
        expect(reopened.list.length).toBe(2);

        await store.delete('a');
        expect(store.list.map(s => s.id)).toEqual(['b']);
        expect(await store.blob('a')).toBeNull();
    });
});

function host(): SkinHost & { settings: { skin: Bindable<string> }; notifications: NotificationManager } {
    return {
        settings: { skin: new Bindable('') },
        notifications: new NotificationManager(),
        audio: { context: {} as BaseAudioContext },
        screens: { screens: [], changed: new Signal() },
    };
}

describe('SkinManager import and selection', () => {
    it('routes .osk, skin zips and beatmaps', async () => {
        const m = new SkinManager(new SkinStore(new MemoryDatabase(SKIN_STORES)));
        const parts = await m.partition([
            file('a.osk', { 'cursor.png': '' }),
            file('b.zip', { 'skin.ini': INI }),
            file('c.zip', { 'm.osu': '' }),
            file('d.osz', { 'm.osu': '' }),
            new File(['x'], 'e.txt'),
        ]);
        expect(parts.skins.map(f => f.name)).toEqual(['a.osk', 'b.zip']);
        expect(parts.beatmaps.map(f => f.name)).toEqual(['c.zip', 'd.osz']);
        expect(parts.rejected.map(f => f.name)).toEqual(['e.txt']);
    });

    it('imports with notifications, replaces on re-import, selects and falls back', async () => {
        const h = host();
        const m = new SkinManager(new SkinStore(new MemoryDatabase(SKIN_STORES)));
        await m.attach(h);
        const ok = await m.importFiles([file('Rafis.osk', { 'skin.ini': INI }), file('bad.osk', {})]);
        expect(ok.map(s => s.name)).toEqual(['Rafis']);
        await m.importFiles([file('Rafis.osk', { 'skin.ini': INI, 'cursor.png': '' })]);
        expect(m.imported.length).toBe(1);
        const texts = h.notifications.list.map(n => n.text.value);
        expect(texts).toContain('Imported Rafis! Click to view.');
        expect(texts.some(t => t.startsWith('bad.osk:'))).toBe(true);

        // Clicking the notification selects the skin; it loads into `current`.
        h.notifications.list.find(n => n.text.value.startsWith('Imported Rafis'))!.onClick!();
        expect(h.settings.skin.value).toBe(ok[0].id);
        await vi.waitFor(() => expect(m.current.value).not.toBeNull());
        expect(m.currentInfo.value?.name).toBe('Rafis');

        // Deleting the selected skin goes back to the default.
        await m.deleteSkin(ok[0].id);
        expect(h.settings.skin.value).toBe('');
        expect(m.current.value).toBeNull();
        expect(m.imported.length).toBe(0);

        // A persisted selection that no longer exists falls back too.
        h.settings.skin.value = 'skin-missing';
        expect(h.settings.skin.value).toBe('');
    });

    it('falls back to the default with a notification when a skin fails to load', async () => {
        const h = host();
        const db = new MemoryDatabase(SKIN_STORES);
        const store = new SkinStore(db);
        await store.put({ id: 'broken', name: 'Broken', author: 'x', filename: 'b.osk', addedAt: 0, sizeBytes: 3 }, new Blob(['nope']));
        h.settings.skin.value = 'broken';
        const m = new SkinManager(store);
        await m.attach(h);
        await vi.waitFor(() => expect(h.settings.skin.value).toBe(''));
        expect(m.current.value).toBeNull();
        expect(h.notifications.list[0].text.value).toMatch(/Couldn't load the skin "Broken"/);
    });
});
