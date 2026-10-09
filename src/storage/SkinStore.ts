/**
 * Imported skins, persisted in IndexedDB like the beatmap library: the
 * .osk blob plus a small metadata row. Metadata for every skin stays in
 * memory (the skin dropdown lists it); blobs are read only when a skin is
 * loaded or exported.
 *
 * Skins live in their own database so the app database's schema (and
 * version) stays untouched.
 */
import { Signal } from '../core/Signal';
import { openDatabase, type Database, type KeyValueStore, type StoreSchema } from './idb';

export interface StoredSkin {
    /** Derived from name + author (see skinId): re-importing replaces. */
    id: string;
    name: string;
    author: string;
    /** File name it was imported from. */
    filename: string;
    addedAt: number;
    sizeBytes: number;
}

export const SKIN_DB_NAME = 'wosu-skins';
export const SKIN_DB_VERSION = 1;
export const SKIN_STORES: readonly StoreSchema[] = [
    { name: 'skins', keyPath: 'id' },
    { name: 'files' },
];

export function openSkinDatabase(): Promise<Database> {
    return openDatabase(SKIN_DB_NAME, SKIN_DB_VERSION, SKIN_STORES);
}

/** Case-insensitive by name (lazer's skin dropdown order), then author. */
export function compareSkins(a: StoredSkin, b: StoredSkin): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        || a.author.localeCompare(b.author, undefined, { sensitivity: 'base' })
        || a.id.localeCompare(b.id);
}

function isStoredSkin(v: unknown): v is StoredSkin {
    const s = v as StoredSkin;
    return !!s && typeof s.id === 'string' && typeof s.name === 'string';
}

export class SkinStore {
    readonly changed = new Signal<[]>();
    private readonly byId = new Map<string, StoredSkin>();
    private sorted: StoredSkin[] = [];
    private rows: KeyValueStore<string, StoredSkin> | null = null;
    private files: KeyValueStore<string, Blob> | null = null;
    private ready: Promise<void> | null = null;

    constructor(private readonly dbSource: Database | Promise<Database> = openSkinDatabase()) {}

    /** True when skins survive a reload (real IndexedDB). */
    persistent = false;

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    private async load(): Promise<void> {
        const db = await this.dbSource;
        this.persistent = db.persistent;
        this.rows = db.store<string, StoredSkin>('skins');
        this.files = db.store<string, Blob>('files');
        try {
            for (const row of await this.rows.getAll()) {
                if (isStoredSkin(row)) this.byId.set(row.id, row);
            }
        } catch (e) {
            console.warn('[skins] load failed', e);
        }
        this.resort();
        this.changed.emit();
    }

    /** Every stored skin, sorted by name. */
    get list(): readonly StoredSkin[] {
        return this.sorted;
    }

    get(id: string): StoredSkin | undefined {
        return this.byId.get(id);
    }

    /** Store (or replace) a skin. The blob goes first: a row without files would be unusable. */
    async put(info: StoredSkin, data: Blob): Promise<StoredSkin> {
        await this.init();
        const row: StoredSkin = { ...info };
        await this.files!.put(data, row.id);
        await this.rows!.put(row);
        this.byId.set(row.id, row);
        this.resort();
        this.changed.emit();
        return row;
    }

    async blob(id: string): Promise<Blob | null> {
        await this.init();
        return (await this.files!.get(id)) ?? null;
    }

    async delete(id: string): Promise<void> {
        await this.init();
        if (this.byId.delete(id)) {
            this.resort();
            this.changed.emit();
        }
        await Promise.all([this.rows!.delete(id), this.files!.delete(id)]);
    }

    private resort(): void {
        this.sorted = [...this.byId.values()].sort(compareSkins);
    }
}
