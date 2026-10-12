/**
 * The player's beatmap collections (osu!lazer's collections, which live
 * in realm). Stored as one array in the app database's key-value store,
 * plus the song select collection filter (lazer's
 * SongSelectCollectionFilter setting) so it survives reloads.
 */
import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import {
    cleanCollectionName,
    membershipOf,
    sanitizeCollections,
    sortCollections,
    type BeatmapCollection,
    type MembershipState,
} from '../beatmap/collections';
import { openAppDatabase, type AppDatabase } from './idb';

const KEY = 'collections';
const FILTER_KEY = 'collectionFilter';

let idCounter = 0;

function newId(): string {
    const c = (globalThis.crypto as Crypto | undefined);
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `c${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class CollectionStore {
    readonly changed = new Signal<[]>();
    /** Song select's collection filter: a collection id, or '' for all beatmaps. */
    readonly filter = new Bindable<string>('');
    private list: BeatmapCollection[] = [];
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private loaded = false;
    /** Writes run in order so a slow put can't overwrite a newer one. */
    private writes: Promise<void> = Promise.resolve();

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase()) {
        this.filter.bind(v => {
            if (this.loaded) this.enqueue(db => db.kv.put(v, FILTER_KEY));
        });
    }

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    private async load(): Promise<void> {
        try {
            const db = await this.dbSource;
            this.db = db;
            this.list = sanitizeCollections(await db.kv.get(KEY));
            const f = await db.kv.get(FILTER_KEY);
            if (typeof f === 'string' && this.get(f)) this.filter.value = f;
        } catch (e) {
            console.warn('[collections] load failed', e);
        }
        this.loaded = true;
        this.changed.emit();
    }

    /** Collections ordered by name, like lazer's lists. */
    get all(): readonly BeatmapCollection[] {
        return sortCollections(this.list);
    }

    get size(): number {
        return this.list.length;
    }

    get(id: string): BeatmapCollection | undefined {
        return this.list.find(c => c.id === id);
    }

    /** Member keys of a collection as a set (for filtering); null when it doesn't exist. */
    members(id: string): ReadonlySet<string> | null {
        const c = this.get(id);
        return c ? new Set(c.items) : null;
    }

    has(id: string, key: string): boolean {
        return this.get(id)?.items.includes(key) ?? false;
    }

    membership(id: string, keys: readonly string[]): MembershipState {
        const c = this.get(id);
        return c ? membershipOf(c, keys) : 'none';
    }

    /** New collection (optionally with members). Returns null for an empty name. */
    create(name: string, items: readonly string[] = []): BeatmapCollection | null {
        const clean = cleanCollectionName(name);
        if (!clean) return null;
        const c: BeatmapCollection = { id: newId(), name: clean, items: [...new Set(items)], createdAt: Date.now() };
        this.list.push(c);
        this.commit();
        return c;
    }

    rename(id: string, name: string): boolean {
        const c = this.get(id);
        const clean = cleanCollectionName(name);
        if (!c || !clean) return false;
        if (c.name === clean) return true;
        c.name = clean;
        this.commit();
        return true;
    }

    remove(id: string): boolean {
        const i = this.list.findIndex(c => c.id === id);
        if (i < 0) return false;
        this.list.splice(i, 1);
        if (this.filter.value === id) this.filter.value = '';
        this.commit();
        return true;
    }

    /** Add members (already present ones are skipped). Returns how many were added. */
    add(id: string, keys: readonly string[]): number {
        const c = this.get(id);
        if (!c) return 0;
        const have = new Set(c.items);
        let n = 0;
        for (const k of keys) {
            if (!k || have.has(k)) continue;
            have.add(k);
            c.items.push(k);
            n++;
        }
        if (n) this.commit();
        return n;
    }

    /** Remove members. Returns how many were removed. */
    removeItems(id: string, keys: readonly string[]): number {
        const c = this.get(id);
        if (!c) return 0;
        const drop = new Set(keys);
        const before = c.items.length;
        c.items = c.items.filter(k => !drop.has(k));
        const n = before - c.items.length;
        if (n) this.commit();
        return n;
    }

    /** Resolves once every write queued so far has been attempted. */
    flush(): Promise<void> {
        return this.writes;
    }

    private commit(): void {
        this.changed.emit();
        const snapshot = this.list.map(c => ({ ...c, items: [...c.items] }));
        this.enqueue(db => db.kv.put(snapshot, KEY));
    }

    private enqueue(write: (db: AppDatabase) => Promise<unknown>): void {
        this.writes = this.writes.then(async () => {
            try {
                const db = this.db ?? (await this.dbSource);
                await write(db);
            } catch (e) {
                console.warn('[collections] save failed', e);
            }
        });
    }
}

let shared: CollectionStore | null = null;

/** The app-wide collection store (opened on first use). */
export function collections(): CollectionStore {
    if (!shared) {
        shared = new CollectionStore();
        void shared.init();
    }
    return shared;
}
