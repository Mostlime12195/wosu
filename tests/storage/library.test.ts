import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
    BeatmapLibrary,
    compareDifficulties,
    imageMime,
    setIdFromFilename,
} from '../../src/beatmap/Library';
import type { DifficultySummary } from '../../src/beatmap/types';
import { createMemoryAppDatabase } from '../../src/storage/idb';
import type { LegacyData } from '../../src/storage/legacy';

const FIXTURE = readFileSync(
    join(__dirname, '../fixtures/map1', "CHiCO with HoneyWorks - Gamushara (TV size) (sanairrt) [Erisu's Normal].osu"),
    'utf8',
);

function legacy(over: Partial<LegacyData> = {}): () => Promise<LegacyData> {
    return async () => ({
        ok: true, liked: [], knownVideos: [], history: [], beatmapFileNames: [], readBeatmapFile: async () => null, ...over,
    });
}

/** Rewrite one "Key: value" header line of the fixture. */
function withHeader(text: string, key: string, value: string): string {
    return text.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}:${value}`);
}

function osz(files: Record<string, string | Uint8Array>): Blob {
    const entries: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
    return new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>]);
}

function newLibrary(over: Partial<LegacyData> = {}) {
    const db = createMemoryAppDatabase();
    const makeThumbnail = vi.fn(async (img: Blob) => new Blob(['thumb:', img], { type: 'image/jpeg' }));
    return { db, makeThumbnail, lib: new BeatmapLibrary(db, { legacy: legacy(over), makeThumbnail }) };
}

describe('BeatmapLibrary', () => {
    it('imports an osz: metadata, std-only difficulties, thumbnail, persistence', async () => {
        const { db, lib, makeThumbnail } = newLibrary();
        await lib.init();
        const changes = vi.fn();
        const imported = vi.fn();
        lib.changed.add(changes);
        lib.imported.add(imported);

        const hard = withHeader(withHeader(FIXTURE, 'Version', 'Hard'), 'BeatmapID', '42');
        const taiko = withHeader(withHeader(FIXTURE, 'Mode', ' 1'), 'Version', 'Taiko');
        const set = await lib.importOsz(osz({
            'normal.osu': FIXTURE,
            'hard.osu': withHeader(hard, 'OverallDifficulty', '8'),
            'taiko.osu': taiko,
            'aw.jpg': new Uint8Array([1, 2, 3]),
            'audio.mp3': new Uint8Array([0]),
        }));

        expect(set.key).toBe('osu-1510388');
        expect(set.onlineSetId).toBe(1510388);
        expect(set.title).toBe('Gamushara (TV Size)');
        expect(set.titleUnicode).toBe('我武者羅 (TV Size)');
        expect(set.creator).toBe('sanairrt');
        expect(set.audioFile).toBe('audio.mp3');
        expect(set.backgroundFile).toBe('aw.jpg');
        expect(set.hasVideo).toBe(false);
        expect(set.difficulties.map(d => d.version)).toEqual(["Erisu's Normal", 'Hard']);
        expect(set.sizeBytes).toBeGreaterThan(0);
        expect(changes).toHaveBeenCalledTimes(1);
        expect(imported).toHaveBeenCalledWith(set);
        expect(makeThumbnail).toHaveBeenCalledTimes(1);
        expect(await (await lib.getThumbnail(set.key))!.text()).toContain('thumb:');

        // lookups
        expect(lib.has(1510388)).toBe(true);
        expect(lib.get(set.key)).toBe(set);
        expect(lib.findByBeatmapId(42)?.difficulty.version).toBe('Hard');
        expect(lib.findByBeatmapId(0)).toBeUndefined();

        // archive + beatmap + background access
        const data = await lib.loadBeatmap(set.key, 'hard.osu');
        expect(data.metadata.version).toBe('Hard');
        const bg = await lib.getBackground(set.key);
        expect(bg!.type).toBe('image/jpeg');
        expect(new Uint8Array(await bg!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

        // persisted: a fresh library over the same DB sees it
        const again = new BeatmapLibrary(db, { legacy: legacy() });
        await again.init();
        expect(again.sets.map(s => s.key)).toEqual(['osu-1510388']);
        expect((await again.openArchive(set.key)).osuFiles()).toHaveLength(3);
    });

    it('re-import replaces the set but keeps history fields and known stars', async () => {
        const { lib } = newLibrary();
        const first = await lib.importOsz(osz({ 'a.osu': FIXTURE }));
        await lib.setStars(first.key, new Map([[3097691, 2.5]]));
        lib.markPlayed(first.key);
        const playedAt = lib.get(first.key)!.lastPlayedAt;
        expect(playedAt).toBeTypeOf('number');

        const second = await lib.importOsz(osz({ 'a.osu': FIXTURE, 'extra.osu': withHeader(FIXTURE, 'Version', 'Extra') }));
        expect(lib.sets).toHaveLength(1);
        expect(second.addedAt).toBe(first.addedAt);
        expect(second.lastPlayedAt).toBe(playedAt);
        expect(second.difficulties.find(d => d.beatmapId === 3097691)!.stars).toBe(2.5);
    });

    it('derives set ids from hints, filenames, or content hashes', async () => {
        const { lib } = newLibrary();
        const noId = withHeader(FIXTURE, 'BeatmapSetID', '-1');
        expect((await lib.importOsz(osz({ 'a.osu': noId }), { onlineSetId: 77 })).key).toBe('osu-77');
        expect((await lib.importOsz(osz({ 'a.osu': withHeader(noId, 'Title', 'B') }), { filename: '123456 Artist - Title.osz' })).key)
            .toBe('osu-123456');
        const local = await lib.importOsz(osz({ 'a.osu': withHeader(noId, 'Title', 'C') }), { filename: 'my map.osz' });
        expect(local.key).toMatch(/^local-[0-9a-f]{16}$/);
        expect(local.onlineSetId).toBeNull();
        // same content re-zipped -> same local key
        const again = await lib.importOsz(osz({ 'renamed.osu': withHeader(noId, 'Title', 'C') }));
        expect(again.key).toBe(local.key);
        expect(lib.sets).toHaveLength(3);
        // sorted by title
        expect(lib.sets.map(s => s.title)).toEqual(['B', 'C', 'Gamushara (TV Size)']);
    });

    it('rejects archives without playable difficulties', async () => {
        const { lib } = newLibrary();
        await expect(lib.importOsz(new Blob(['not a zip']))).rejects.toThrow(/valid .osz/);
        await expect(lib.importOsz(osz({ 'readme.txt': 'hi' }))).rejects.toThrow(/No .osu files/);
        await expect(lib.importOsz(osz({ 't.osu': withHeader(FIXTURE, 'Mode', ' 3') }))).rejects.toThrow(/osu!standard/);
        expect(lib.sets).toHaveLength(0);
    });

    it('importMany collects per-file results', async () => {
        const { lib } = newLibrary();
        const good = new File([osz({ 'a.osu': FIXTURE })], 'good.osz');
        const bad = new File(['x'], 'bad.osz');
        const txt = new File(['x'], 'notes.txt');
        const r = await lib.importMany([good, bad, txt]);
        expect(r.ok.map(s => s.key)).toEqual(['osu-1510388']);
        expect(r.failed.map(f => f.name)).toEqual(['bad.osz', 'notes.txt']);
        expect(r.failed[1].error).toMatch(/Not an .osz/);
    });

    it('deletes sets and their files', async () => {
        const { db, lib } = newLibrary();
        const set = await lib.importOsz(osz({ 'a.osu': FIXTURE, 'aw.jpg': new Uint8Array([9]) }));
        await lib.delete(set.key);
        expect(lib.sets).toHaveLength(0);
        expect(await db.blobs.get(set.key)).toBeUndefined();
        expect(await db.thumbs.get(set.key)).toBeUndefined();
        await expect(lib.openArchive(set.key)).rejects.toThrow(/missing/);
    });

    it('detects videos only when the file is actually in the archive', async () => {
        const { lib } = newLibrary();
        const withVideo = FIXTURE.replace('0,0,"aw.jpg",0,0', '0,0,"aw.jpg",0,0\nVideo,0,"clip.mp4"');
        expect((await lib.importOsz(osz({ 'a.osu': withVideo }))).hasVideo).toBe(false);
        expect((await lib.importOsz(osz({ 'a.osu': withVideo, 'clip.mp4': new Uint8Array([0]) }))).hasVideo).toBe(true);
    });

    it('migrates the old site imports in the background, once', async () => {
        const legacyOsz = osz({ 'a.osu': FIXTURE });
        const readBeatmapFile = vi.fn(async (name: string) => (name === 'old.osz' ? legacyOsz : null));
        const { db, lib } = newLibrary({ beatmapFileNames: ['old.osz', 'missing.osz'], readBeatmapFile });
        await lib.init();
        await lib.legacyMigration;
        expect(lib.sets.map(s => s.key)).toEqual(['osu-1510388']);
        const again = new BeatmapLibrary(db, { legacy: legacy({ beatmapFileNames: ['old.osz'], readBeatmapFile }) });
        await again.init();
        await again.legacyMigration;
        expect(readBeatmapFile).toHaveBeenCalledTimes(2); // first run only
    });
});

describe('library helpers', () => {
    it('parses set ids from conventional names', () => {
        expect(setIdFromFilename('123456 Artist - Title.osz')).toBe(123456);
        expect(setIdFromFilename('folder/987.osz')).toBe(987);
        expect(setIdFromFilename('Artist - 123.osz')).toBeNull();
        expect(setIdFromFilename(undefined)).toBeNull();
    });

    it('orders difficulties by stars (unknown last) then OD', () => {
        const d = (version: string, stars: number | null, od: number) => ({ version, stars, od, ar: 0 }) as DifficultySummary;
        const sorted = [d('x', null, 1), d('b', 3, 5), d('a', 2, 9), d('c', 3, 4)].sort(compareDifficulties);
        expect(sorted.map(s => s.version)).toEqual(['a', 'c', 'b', 'x']);
    });

    it('maps image mimes', () => {
        expect(imageMime('BG.PNG')).toBe('image/png');
        expect(imageMime('noext')).toBe('image/jpeg');
    });
});
