/**
 * One-time import of data saved by the old DOM-based site.
 *
 * The old site used localforage (IndexedDB database "localforage", store
 * "keyvaluepairs"; or localStorage keys prefixed "localforage/" when
 * IndexedDB was unavailable) for favourites, the known-video registry,
 * play history and user-imported .osz files, plus plain localStorage
 * "osugamesettings" for settings.
 *
 * Reading is memoized per page load and never throws. Each consumer
 * (scores, favourites, library, ...) imports its slice through
 * `migrateOnce`, which records a per-consumer flag in the kv store so the
 * import happens exactly once even if consumers initialize at different
 * times or a previous run was interrupted.
 */
import { openExistingDatabase, readAllEntries, type KeyValueStore } from './idb';

export interface LegacyHistoryEntry {
    sid?: number | string;
    bid?: number | string;
    title?: string;
    version?: string;
    mods?: string;
    grade?: string;
    score?: string | number;
    combo?: string | number;
    acc?: string | number;
    time?: number;
}

export interface LegacyData {
    /** False when reading failed (consumers then retry next launch). */
    ok: boolean;
    liked: (number | string)[];
    knownVideos: (number | string)[];
    history: LegacyHistoryEntry[];
    /** Names of user-imported .osz files (old "beatmapfilelist"). */
    beatmapFileNames: string[];
    /** Load one of `beatmapFileNames` lazily (they can be large). */
    readBeatmapFile(name: string): Promise<Blob | null>;
}

// ---------------------------------------------------------------------------
// Normalizers (ports of the old site's helpers; behaviour pinned by tests)
// ---------------------------------------------------------------------------

/**
 * Port of the old `normalizeLikedList`: accepts a Set, an Array, or the
 * corrupted forms older versions persisted, and returns a deduped array
 * (falsy entries dropped, but 0 kept).
 */
export function normalizeLikedList(val: unknown): (number | string)[] {
    if (!val) return [];
    if (val instanceof Set) return Array.from(val).filter(x => x || x === 0) as (number | string)[];
    if (Array.isArray(val)) {
        const seen = new Set<string>();
        const out: (number | string)[] = [];
        for (const sid of val) {
            if (!sid && sid !== 0) continue;
            const k = String(sid);
            if (!seen.has(k)) {
                seen.add(k);
                out.push(sid as number | string);
            }
        }
        return out;
    }
    if (typeof val === 'object') {
        // A JSON-serialized Set became {} (unrecoverable); an array that
        // went through a lossy path may look like {"0": a, "1": b}.
        try {
            const keys = Object.keys(val as object);
            if (keys.length && keys.every(k => String(parseInt(k, 10)) === k)) {
                return normalizeLikedList(keys.map(k => (val as Record<string, unknown>)[k]));
            }
        } catch {
            /* ignore */
        }
        return [];
    }
    return [];
}

/** Port of the old `normalizeSidList` (video registry). */
export function normalizeSidList(val: unknown): (number | string)[] {
    if (!val) return [];
    if (val instanceof Set) return Array.from(val) as (number | string)[];
    if (Array.isArray(val)) return val.filter(x => x || x === 0) as (number | string)[];
    return [];
}

/** Positive integer set ids from a mixed list (dedupe, order kept). */
export function toSetIds(list: readonly unknown[]): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const v of list) {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

// ---------------------------------------------------------------------------
// localforage value decoding
// ---------------------------------------------------------------------------

const LF_PREFIX = 'localforage/';
const LFSC = '__lfsc__:';
const LF_BLOB = 'blob~~local_forage_type~';

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Undo localforage's encodings: Safari-era IndexedDB stored blobs as
 * { __local_forage_encoded_blob, data, type }, and the localStorage driver
 * serializes binary as "__lfsc__:<type>~~local_forage_type~<mime>~<base64>".
 */
function decodeLegacyValue(v: unknown): unknown {
    if (v && typeof v === 'object' && (v as { __local_forage_encoded_blob?: unknown }).__local_forage_encoded_blob) {
        const enc = v as { data?: string; type?: string };
        try {
            // localforage's _encodeBlob: btoa(binary string of the blob).
            return new Blob([base64ToBytes(enc.data ?? '') as BlobPart], { type: enc.type ?? '' });
        } catch {
            return null;
        }
    }
    return v;
}

function decodeLocalStorageValue(raw: string): unknown {
    if (raw.startsWith(LFSC)) {
        const body = raw.slice(LFSC.length);
        if (body.startsWith(LF_BLOB)) {
            const rest = body.slice(LF_BLOB.length);
            const sep = rest.indexOf('~');
            const mime = sep === -1 ? '' : rest.slice(0, sep);
            const b64 = sep === -1 ? rest : rest.slice(sep + 1);
            try {
                return new Blob([base64ToBytes(b64) as BlobPart], { type: mime });
            } catch {
                return null;
            }
        }
        return null; // other typed-array encodings were never used by the site
    }
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function getLocalStorage(): Storage | null {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const EMPTY: LegacyData = {
    ok: true,
    liked: [],
    knownVideos: [],
    history: [],
    beatmapFileNames: [],
    readBeatmapFile: async () => null,
};

async function readLegacyUncached(): Promise<LegacyData> {
    let ok = true;
    const values = new Map<string, unknown>();

    // 1) localforage's IndexedDB driver (the common case).
    let lfdb: IDBDatabase | null = null;
    try {
        lfdb = await openExistingDatabase('localforage');
        if (lfdb) {
            const entries = await readAllEntries(lfdb, 'keyvaluepairs');
            for (const [k, v] of entries) values.set(k, decodeLegacyValue(v));
        }
    } catch (e) {
        ok = false;
        console.warn('[legacy] reading old IndexedDB failed', e);
    } finally {
        try {
            lfdb?.close();
        } catch {
            /* ignore */
        }
    }

    // 2) localforage's localStorage driver fallback.
    const ls = getLocalStorage();
    if (ls) {
        try {
            for (let i = 0; i < ls.length; i++) {
                const key = ls.key(i);
                if (!key || !key.startsWith(LF_PREFIX)) continue;
                const name = key.slice(LF_PREFIX.length);
                if (values.has(name)) continue;
                const raw = ls.getItem(key);
                if (raw !== null) values.set(name, decodeLocalStorageValue(raw));
            }
        } catch (e) {
            console.warn('[legacy] reading old localStorage failed', e);
        }
    }

    if (!values.size) return { ...EMPTY, ok };

    const history = values.get('playhistory1000');
    const fileList = values.get('beatmapfilelist');
    const beatmapFileNames = Array.isArray(fileList)
        ? [...new Set(fileList.filter((n): n is string => typeof n === 'string' && n.length > 0))]
        : [];

    return {
        ok,
        liked: normalizeLikedList(values.get('likedsidset')),
        knownVideos: normalizeSidList(values.get('videosidset')),
        history: Array.isArray(history)
            ? history.filter((h): h is LegacyHistoryEntry => !!h && typeof h === 'object')
            : [],
        beatmapFileNames,
        readBeatmapFile: async (name: string) => {
            const v = values.get(name);
            return v instanceof Blob ? v : null;
        },
    };
}

let cached: Promise<LegacyData> | null = null;

/** Read everything the old site stored (memoized, never rejects). */
export function readLegacyData(): Promise<LegacyData> {
    cached ??= readLegacyUncached().catch((e) => {
        console.warn('[legacy] migration read failed', e);
        return { ...EMPTY, ok: false };
    });
    return cached;
}

/** Old settings object from localStorage, or null (mapped by the settings module). */
export function readLegacySettings(): Record<string, unknown> | null {
    const ls = getLocalStorage();
    if (!ls) return null;
    try {
        const raw = ls.getItem('osugamesettings');
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export type LegacySource = () => Promise<LegacyData>;

/**
 * Run `apply` with the legacy data unless `flag` is already recorded in
 * `kv`. The flag is set only after `apply` succeeds and the read was
 * complete, so failures are retried next launch. Never throws.
 */
export async function migrateOnce(
    kv: KeyValueStore<string, unknown>,
    flag: string,
    apply: (data: LegacyData) => Promise<void> | void,
    source: LegacySource = readLegacyData,
): Promise<boolean> {
    const key = `legacy:${flag}`;
    try {
        if (await kv.get(key)) return false;
        const data = await source();
        await apply(data);
        if (data.ok) await kv.put(Date.now(), key);
        return true;
    } catch (e) {
        console.warn(`[legacy] migration "${flag}" failed`, e);
        return false;
    }
}
