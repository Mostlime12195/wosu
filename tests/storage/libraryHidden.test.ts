import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BeatmapLibrary } from '../../src/beatmap/Library';
import { createMemoryAppDatabase } from '../../src/storage/idb';
import type { LegacyData } from '../../src/storage/legacy';

const FIXTURE = readFileSync(
    join(__dirname, '../fixtures/map1', "CHiCO with HoneyWorks - Gamushara (TV size) (sanairrt) [Erisu's Normal].osu"),
    'utf8',
);

const legacy = async (): Promise<LegacyData> => ({
    ok: true, liked: [], knownVideos: [], history: [], beatmapFileNames: [], readBeatmapFile: async () => null,
});

function withHeader(text: string, key: string, value: string): string {
    return text.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}:${value}`);
}

function osz(): Blob {
    const files: Record<string, Uint8Array> = {
        'normal.osu': strToU8(FIXTURE),
        'hard.osu': strToU8(withHeader(withHeader(FIXTURE, 'Version', 'Hard'), 'OverallDifficulty', '8')),
        'insane.osu': strToU8(withHeader(withHeader(FIXTURE, 'Version', 'Insane'), 'OverallDifficulty', '9')),
    };
    return new Blob([zipSync(files) as Uint8Array<ArrayBuffer>]);
}

describe('deleting single difficulties (lazer hide)', () => {
    it('hides, persists, survives re-import, refuses the last one and restores', async () => {
        const db = createMemoryAppDatabase();
        const lib = new BeatmapLibrary(db, { legacy, makeThumbnail: async () => null });
        await lib.init();
        const set = await lib.importOsz(osz());
        expect(set.difficulties).toHaveLength(3);
        let changes = 0;
        lib.changed.add(() => changes++);

        expect(await lib.deleteDifficulty(set.key, 'hard.osu')).toBe(true);
        const after = lib.get(set.key)!;
        expect(after).not.toBe(set); // replaced like a re-import
        expect(after.difficulties.map(d => d.file).sort()).toEqual(['insane.osu', 'normal.osu']);
        expect(after.hidden?.map(d => d.file)).toEqual(['hard.osu']);
        expect(changes).toBe(1);
        expect(await lib.deleteDifficulty(set.key, 'missing.osu')).toBe(false);

        // Persisted.
        const reopened = new BeatmapLibrary(db, { legacy, makeThumbnail: async () => null });
        await reopened.init();
        expect(reopened.get(set.key)!.difficulties).toHaveLength(2);

        // Re-importing the same set keeps it deleted.
        const again = await lib.importOsz(osz());
        expect(again.difficulties.map(d => d.file).sort()).toEqual(['insane.osu', 'normal.osu']);
        expect(again.hidden?.map(d => d.file)).toEqual(['hard.osu']);

        // A set keeps at least one difficulty.
        expect(await lib.deleteDifficulty(set.key, 'insane.osu')).toBe(true);
        expect(lib.canDeleteDifficulty(set.key)).toBe(false);
        expect(await lib.deleteDifficulty(set.key, 'normal.osu')).toBe(false);

        expect(await lib.restoreDifficulties(set.key)).toBe(2);
        const restored = lib.get(set.key)!;
        expect(restored.difficulties.map(d => d.version)).toEqual(["Erisu's Normal", 'Hard', 'Insane']);
        expect(restored.hidden).toBeUndefined();
        expect(await lib.restoreDifficulties(set.key)).toBe(0);
    });
});
