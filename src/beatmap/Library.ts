/**
 * The local beatmap library: every .osz the player imported or
 * downloaded, persisted in IndexedDB (osz blob + parsed metadata +
 * thumbnail) like osu!'s own song folder.
 *
 * Metadata for all sets lives in memory (song select filters/sorts it
 * every keystroke); archives are opened lazily and only the two most
 * recent stay cached, since a decoded .osz can be tens of megabytes.
 */
import { Signal } from '../core/Signal';
import { openAppDatabase, type AppDatabase } from '../storage/idb';
import { migrateOnce, readLegacyData, type LegacySource } from '../storage/legacy';
import { OszArchive } from './archive';
import { parseOsu } from './parser';
import { summarizeDifficulty } from './summary';
import type { BeatmapData, DifficultySummary } from './types';

export interface LibrarySet {
    /** 'osu-<sid>' for sets with an online id, else 'local-<hash>'. */
    key: string;
    onlineSetId: number | null;
    title: string;
    titleUnicode: string;
    artist: string;
    artistUnicode: string;
    creator: string;
    source: string;
    tags: string;
    /** osu!standard difficulties, sorted by stars (unknown last) then OD. */
    difficulties: DifficultySummary[];
    audioFile: string;
    backgroundFile: string | null;
    previewTime: number;
    hasVideo: boolean;
    addedAt: number;
    lastPlayedAt: number | null;
    sizeBytes: number;
}

export interface ImportOptions {
    onlineSetId?: number;
    filename?: string;
}

export interface LibraryOptions {
    legacy?: LegacySource;
    /** Thumbnail generator override (tests); null result = none. */
    makeThumbnail?: (image: Blob) => Promise<Blob | null>;
}

const THUMB_WIDTH = 320;
const ARCHIVE_CACHE = 2;

const IMAGE_MIME: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp',
};

export function imageMime(name: string): string {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return IMAGE_MIME[ext] ?? 'image/jpeg';
}

/** Stable sort order for a set's difficulties. */
export function compareDifficulties(a: DifficultySummary, b: DifficultySummary): number {
    const sa = a.stars, sb = b.stars;
    if (sa !== null && sb !== null && sa !== sb) return sa - sb;
    if (sa === null && sb !== null) return 1;
    if (sa !== null && sb === null) return -1;
    return a.od - b.od || a.ar - b.ar || a.version.localeCompare(b.version);
}

function compareSets(a: LibrarySet, b: LibrarySet): number {
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        || a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
        || a.key.localeCompare(b.key);
}

/** Leading set id in conventional .osz names ("123456 Artist - Title.osz"). */
export function setIdFromFilename(name: string | undefined): number | null {
    if (!name) return null;
    const m = /^(\d{1,9})(?:\s|$|[._-])/.exec(name.split(/[\\/]/).pop() ?? '');
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** 64-bit FNV-1a-ish fallback when SubtleCrypto is unavailable (insecure origins). */
function fallbackHash(bytes: Uint8Array): string {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
        h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

async function contentHash(texts: string[]): Promise<string> {
    // Hash the .osu contents rather than the zip bytes: a re-zipped copy of
    // the same map maps to the same local key.
    const bytes = new TextEncoder().encode([...texts].sort().join('\u0000'));
    try {
        const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
        if (subtle) {
            const digest = new Uint8Array(await subtle.digest('SHA-1', bytes as BufferSource));
            return [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch {
        /* fall through */
    }
    return fallbackHash(bytes);
}

/** Downscale a background image to a small JPEG (best-effort). */
export async function createThumbnail(image: Blob): Promise<Blob | null> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(image);
        const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, w, h);
        return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    } catch {
        return null;
    } finally {
        bitmap?.close();
    }
}

export class BeatmapLibrary {
    readonly changed = new Signal<[]>();
    readonly imported = new Signal<[set: LibrarySet]>();
    /** Resolves when the background import of old-site .osz files ends. */
    legacyMigration: Promise<void> = Promise.resolve();

    private list: LibrarySet[] = [];
    private readonly byKey = new Map<string, LibrarySet>();
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private readonly archives = new Map<string, Promise<OszArchive>>();
    private readonly legacySource: LegacySource;
    private readonly makeThumbnail: (image: Blob) => Promise<Blob | null>;

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase(), options: LibraryOptions = {}) {
        this.legacySource = options.legacy ?? readLegacyData;
        this.makeThumbnail = options.makeThumbnail ?? createThumbnail;
    }

    get sets(): readonly LibrarySet[] {
        return this.list;
    }

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    private async load(): Promise<void> {
        const db = await this.dbSource;
        this.db = db;
        try {
            const rows = (await db.sets.getAll()) as LibrarySet[];
            for (const s of rows) {
                if (!s || typeof s.key !== 'string' || !Array.isArray(s.difficulties)) continue;
                this.byKey.set(s.key, s);
            }
            this.resort();
        } catch (e) {
            console.warn('[library] load failed', e);
        }
        // Old-site imports can be large: run in the background so the
        // library is usable immediately; sets appear through `changed`.
        this.legacyMigration = migrateOnce(db.kv, 'library', async (data) => {
            for (const name of data.beatmapFileNames) {
                try {
                    const blob = await data.readBeatmapFile(name);
                    if (blob) await this.importOsz(blob, { filename: name });
                } catch (e) {
                    console.warn(`[library] legacy import of "${name}" failed`, e);
                }
            }
        }, this.legacySource).then(() => undefined);
    }

    get(key: string): LibrarySet | undefined {
        return this.byKey.get(key);
    }

    has(onlineSetId: number): boolean {
        return this.byKey.has(`osu-${onlineSetId}`);
    }

    findByBeatmapId(beatmapId: number): { set: LibrarySet; difficulty: DifficultySummary } | undefined {
        if (!(beatmapId > 0)) return undefined;
        for (const set of this.list) {
            const difficulty = set.difficulties.find(d => d.beatmapId === beatmapId);
            if (difficulty) return { set, difficulty };
        }
        return undefined;
    }

    /**
     * Import one .osz. Re-importing a set (same online id or same
     * content) replaces it while keeping its history fields.
     */
    async importOsz(data: Blob, opts: ImportOptions = {}): Promise<LibrarySet> {
        await this.init();
        const db = this.db!;
        let archive: OszArchive;
        try {
            archive = await OszArchive.open(data);
        } catch {
            throw new Error('Not a valid .osz archive');
        }
        const osuFiles = archive.osuFiles();
        if (!osuFiles.length) throw new Error('No .osu files in archive');

        const texts: string[] = [];
        const parsed: { file: string; data: BeatmapData }[] = [];
        for (const file of osuFiles) {
            try {
                const text = await archive.readText(file);
                texts.push(text);
                parsed.push({ file, data: parseOsu(text) });
            } catch (e) {
                console.warn(`[library] skipping unreadable "${file}"`, e);
            }
        }
        const std = parsed.filter(p => p.data.general.mode === 0 && p.data.hitObjects.length > 0);
        if (!std.length) throw new Error('No osu!standard difficulties');

        const first = std[0].data;
        const metaSetId = std.map(p => p.data.metadata.beatmapSetId).find(id => id > 0);
        const hinted = opts.onlineSetId !== undefined && opts.onlineSetId > 0 ? opts.onlineSetId : null;
        const onlineSetId: number | null = metaSetId ?? hinted ?? setIdFromFilename(opts.filename);
        const key = onlineSetId ? `osu-${onlineSetId}` : `local-${await contentHash(texts)}`;
        const previous = this.byKey.get(key);

        const difficulties = std.map(p => {
            const summary = summarizeDifficulty(p.data, p.file);
            // Keep official star ratings learned earlier (online lookup) on re-import.
            const known = previous?.difficulties.find(d =>
                (summary.beatmapId > 0 && d.beatmapId === summary.beatmapId) || d.file === summary.file);
            if (known && known.stars !== null && (summary.stars === null || known.starSource === 'online')) {
                summary.stars = known.stars;
                summary.starSource = known.starSource;
            }
            return summary;
        }).sort(compareDifficulties);

        const backgroundFile = std.map(p => p.data.events.backgroundFile).find((f): f is string => !!f) ?? null;
        const hasVideo = std.some(p => {
            const v = p.data.events.video;
            return !!v && archive.find(v.filename) !== null;
        });

        const set: LibrarySet = {
            key,
            onlineSetId,
            title: first.metadata.title || first.metadata.titleUnicode || 'Unknown title',
            titleUnicode: first.metadata.titleUnicode || first.metadata.title,
            artist: first.metadata.artist || first.metadata.artistUnicode || 'Unknown artist',
            artistUnicode: first.metadata.artistUnicode || first.metadata.artist,
            creator: first.metadata.creator,
            source: first.metadata.source,
            tags: first.metadata.tags,
            difficulties,
            audioFile: first.general.audioFilename,
            backgroundFile,
            previewTime: first.general.previewTime,
            hasVideo,
            addedAt: previous?.addedAt ?? Date.now(),
            lastPlayedAt: previous?.lastPlayedAt ?? null,
            sizeBytes: data.size,
        };

        let thumbnail: Blob | null = null;
        if (backgroundFile) {
            try {
                const name = archive.findImage(backgroundFile);
                if (name) thumbnail = await this.makeThumbnail(await archive.readBlob(name, imageMime(name)));
            } catch (e) {
                console.warn('[library] thumbnail failed', e);
            }
        }

        // Blob first: a set row without its files would be unplayable.
        await db.blobs.put(data, key);
        if (thumbnail) await db.thumbs.put(thumbnail, key);
        else await db.thumbs.delete(key);
        await db.sets.put(set, key);

        this.archives.delete(key);
        this.byKey.set(key, set);
        this.resort();
        this.changed.emit();
        this.imported.emit(set);
        return set;
    }

    /** Import several files sequentially, collecting per-file errors. */
    async importMany(files: File[]): Promise<{ ok: LibrarySet[]; failed: { name: string; error: string }[] }> {
        const ok: LibrarySet[] = [];
        const failed: { name: string; error: string }[] = [];
        for (const file of files) {
            if (!/\.(osz|zip)$/i.test(file.name)) {
                failed.push({ name: file.name, error: 'Not an .osz file' });
                continue;
            }
            try {
                ok.push(await this.importOsz(file, { filename: file.name }));
            } catch (e) {
                failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
            }
        }
        return { ok, failed };
    }

    /** Open a set's archive (LRU-cached). */
    openArchive(key: string): Promise<OszArchive> {
        const hit = this.archives.get(key);
        if (hit) {
            // refresh recency
            this.archives.delete(key);
            this.archives.set(key, hit);
            return hit;
        }
        const p = (async () => {
            await this.init();
            const blob = await this.db!.blobs.get(key);
            if (!blob) throw new Error('Beatmap files are missing; re-import or re-download this set');
            return OszArchive.open(blob);
        })();
        // Failed opens must not stay cached.
        p.catch(() => {
            if (this.archives.get(key) === p) this.archives.delete(key);
        });
        this.archives.set(key, p);
        while (this.archives.size > ARCHIVE_CACHE) {
            const oldest = this.archives.keys().next().value as string;
            this.archives.delete(oldest);
        }
        return p;
    }

    async loadBeatmap(key: string, file: string): Promise<BeatmapData> {
        const archive = await this.openArchive(key);
        const name = archive.find(file) ?? file;
        return parseOsu(await archive.readText(name));
    }

    async getThumbnail(key: string): Promise<Blob | null> {
        await this.init();
        try {
            return (await this.db!.thumbs.get(key)) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Full-size background for a set; with `file`, the difficulty's own
     * background (difficulties may use different images).
     */
    async getBackground(key: string, file?: string): Promise<Blob | null> {
        const set = this.get(key);
        if (!set) return null;
        try {
            let bg = set.backgroundFile;
            if (file) bg = (await this.loadBeatmap(key, file)).events.backgroundFile ?? bg;
            if (!bg) return null;
            const archive = await this.openArchive(key);
            const name = archive.findImage(bg);
            return name ? await archive.readBlob(name, imageMime(name)) : null;
        } catch (e) {
            console.warn('[library] background load failed', e);
            return null;
        }
    }

    async delete(key: string): Promise<void> {
        await this.init();
        const db = this.db!;
        this.archives.delete(key);
        if (this.byKey.delete(key)) {
            this.resort();
            this.changed.emit();
        }
        await Promise.all([db.sets.delete(key), db.blobs.delete(key), db.thumbs.delete(key)]);
    }

    markPlayed(key: string): void {
        const set = this.byKey.get(key);
        if (!set) return;
        set.lastPlayedAt = Date.now();
        this.changed.emit();
        void this.save(set);
    }

    /** Record star ratings (by beatmap id) learned from an online lookup. */
    async setStars(key: string, stars: Map<number, number>): Promise<void> {
        const set = this.byKey.get(key);
        if (!set) return;
        let touched = false;
        for (const d of set.difficulties) {
            const s = stars.get(d.beatmapId);
            if (s !== undefined && Number.isFinite(s) && (d.stars !== s || d.starSource !== 'online')) {
                d.stars = s;
                d.starSource = 'online';
                touched = true;
            }
        }
        if (!touched) return;
        set.difficulties.sort(compareDifficulties);
        this.changed.emit();
        await this.save(set);
    }

    private async save(set: LibrarySet): Promise<void> {
        try {
            const db = this.db ?? (await this.dbSource);
            await db.sets.put(set, set.key);
        } catch (e) {
            console.warn('[library] save failed', e);
        }
    }

    private resort(): void {
        this.list = [...this.byKey.values()].sort(compareSets);
    }
}
