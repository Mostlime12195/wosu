/**
 * Beatmap collections (osu!lazer's BeatmapCollection): named lists of
 * difficulties. lazer keys members by .osu MD5; our library keys
 * difficulties by set key + .osu file name, which survives re-imports
 * of the same set just as well.
 */
import type { LibrarySet } from './Library';
import type { DifficultySummary } from './types';

export interface BeatmapCollection {
    /** Stable id (survives renames; the song select filter remembers it). */
    id: string;
    name: string;
    /** Member difficulties as `collectionItemKey` strings, in insertion order. */
    items: string[];
    createdAt: number;
}

/** lazer's TernaryState for a set's membership in a collection. */
export type MembershipState = 'none' | 'some' | 'all';

export const MAX_COLLECTION_NAME = 100;

/** Identity of one difficulty inside collections. */
export function collectionItemKey(set: Pick<LibrarySet, 'key'>, diff: Pick<DifficultySummary, 'file'>): string {
    return `${set.key}|${diff.file}`;
}

/** How many of `keys` a collection holds: none, some or all (lazer's set menu ternary). */
export function membershipOf(collection: Pick<BeatmapCollection, 'items'>, keys: readonly string[]): MembershipState {
    if (!keys.length) return 'none';
    const have = new Set(collection.items);
    let n = 0;
    for (const k of keys) if (have.has(k)) n++;
    return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

/** Trimmed, single-line, length-capped collection name ('' when unusable). */
export function cleanCollectionName(name: string): string {
    return name.replace(/\s+/g, ' ').trim().slice(0, MAX_COLLECTION_NAME);
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** lazer lists collections ordered by name. */
export function sortCollections<T extends Pick<BeatmapCollection, 'name' | 'createdAt'>>(list: readonly T[]): T[] {
    return [...list].sort((a, b) => nameCollator.compare(a.name, b.name) || a.createdAt - b.createdAt);
}

/** Validate stored rows (IndexedDB data may be from older builds or hand-edited). */
export function sanitizeCollections(raw: unknown): BeatmapCollection[] {
    if (!Array.isArray(raw)) return [];
    const out: BeatmapCollection[] = [];
    const ids = new Set<string>();
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        const id = typeof o.id === 'string' && o.id ? o.id : null;
        const name = typeof o.name === 'string' ? cleanCollectionName(o.name) : '';
        if (!id || !name || ids.has(id)) continue;
        ids.add(id);
        const items = Array.isArray(o.items) ? [...new Set(o.items.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
        const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0;
        out.push({ id, name, items, createdAt });
    }
    return out;
}
