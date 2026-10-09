/**
 * Tiny promise wrapper over IndexedDB with a transparent in-memory
 * fallback.
 *
 * IndexedDB is missing or throws in several real environments (Firefox
 * private windows, Brave shields, some embedded webviews, node tests).
 * The game must still run there, just without persistence, so every
 * failure to open degrades to a Map-backed database with the same API.
 */

export interface StoreSchema {
    name: string;
    /** In-line key path (e.g. 'id'); omit for out-of-line keys. */
    keyPath?: string;
    autoIncrement?: boolean;
}

export interface KeyValueStore<K extends IDBValidKey, V> {
    get(key: K): Promise<V | undefined>;
    /**
     * Insert or replace. Out-of-line stores need `key`; in-line
     * (keyPath) stores take it from the value, generating one when the
     * store auto-increments. Resolves with the effective key.
     */
    put(value: V, key?: K): Promise<K>;
    delete(key: K): Promise<void>;
    getAll(): Promise<V[]>;
    keys(): Promise<K[]>;
    clear(): Promise<void>;
    count(): Promise<number>;
}

export interface Database {
    /** True when backed by real IndexedDB (data survives reloads). */
    readonly persistent: boolean;
    store<K extends IDBValidKey, V>(name: string): KeyValueStore<K, V>;
    close(): void;
}

export type UpgradeFn = (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
}

function getIndexedDB(): IDBFactory | null {
    try {
        const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        return idb ?? null;
    } catch {
        // Accessing the property itself throws under some privacy modes.
        return null;
    }
}

class IdbStore<K extends IDBValidKey, V> implements KeyValueStore<K, V> {
    constructor(private readonly db: IDBDatabase, private readonly name: string) {}

    private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const tx = this.db.transaction(this.name, mode);
        const result = await promisify(fn(tx.objectStore(this.name)));
        if (mode === 'readwrite') {
            // Resolve only once the write is durable (committed).
            await new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
                tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
            });
        }
        return result;
    }

    get(key: K): Promise<V | undefined> {
        return this.run('readonly', s => s.get(key) as IDBRequest<V | undefined>);
    }

    put(value: V, key?: K): Promise<K> {
        return this.run('readwrite', s => (s.keyPath === null ? s.put(value, key) : s.put(value)) as unknown as IDBRequest<K>);
    }

    async delete(key: K): Promise<void> {
        await this.run('readwrite', s => s.delete(key));
    }

    getAll(): Promise<V[]> {
        return this.run('readonly', s => s.getAll() as IDBRequest<V[]>);
    }

    keys(): Promise<K[]> {
        return this.run('readonly', s => s.getAllKeys() as unknown as IDBRequest<K[]>);
    }

    async clear(): Promise<void> {
        await this.run('readwrite', s => s.clear());
    }

    count(): Promise<number> {
        return this.run('readonly', s => s.count());
    }
}

class IdbDatabase implements Database {
    readonly persistent = true;
    private readonly stores = new Map<string, KeyValueStore<IDBValidKey, unknown>>();

    constructor(private readonly db: IDBDatabase) {}

    store<K extends IDBValidKey, V>(name: string): KeyValueStore<K, V> {
        let s = this.stores.get(name);
        if (!s) {
            s = new IdbStore<IDBValidKey, unknown>(this.db, name);
            this.stores.set(name, s);
        }
        return s as unknown as KeyValueStore<K, V>;
    }

    close(): void {
        this.db.close();
    }
}

/** Map-backed store mirroring IndexedDB key semantics closely enough for us. */
class MemoryStore<K extends IDBValidKey, V> implements KeyValueStore<K, V> {
    private readonly map = new Map<string, { key: K; value: V }>();
    private nextId = 1;

    constructor(private readonly schema: StoreSchema) {}

    private static id(key: IDBValidKey): string {
        // Distinguish 1 from '1' like IndexedDB does.
        return typeof key + ':' + String(key);
    }

    async get(key: K): Promise<V | undefined> {
        return this.map.get(MemoryStore.id(key))?.value;
    }

    async put(value: V, key?: K): Promise<K> {
        let k = key;
        const keyPath = this.schema.keyPath;
        if (keyPath) {
            const record = value as Record<string, unknown>;
            let inline = record[keyPath] as K | undefined;
            if (inline === undefined && this.schema.autoIncrement) {
                inline = this.nextId as unknown as K;
                record[keyPath] = inline;
            }
            k = inline;
        } else if (k === undefined && this.schema.autoIncrement) {
            k = this.nextId as unknown as K;
        }
        if (k === undefined) throw new Error(`store ${this.schema.name}: missing key`);
        if (typeof k === 'number' && k >= this.nextId) this.nextId = Math.floor(k) + 1;
        this.map.set(MemoryStore.id(k), { key: k, value });
        return k;
    }

    async delete(key: K): Promise<void> {
        this.map.delete(MemoryStore.id(key));
    }

    async getAll(): Promise<V[]> {
        return this.sorted().map(e => e.value);
    }

    async keys(): Promise<K[]> {
        return this.sorted().map(e => e.key);
    }

    async clear(): Promise<void> {
        this.map.clear();
    }

    async count(): Promise<number> {
        return this.map.size;
    }

    /** IndexedDB returns records in key order: numbers before strings. */
    private sorted(): { key: K; value: V }[] {
        return [...this.map.values()].sort((a, b) => {
            const ta = typeof a.key, tb = typeof b.key;
            if (ta !== tb) return ta === 'number' ? -1 : 1;
            return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        });
    }
}

export class MemoryDatabase implements Database {
    readonly persistent = false;
    private readonly stores = new Map<string, KeyValueStore<IDBValidKey, unknown>>();

    constructor(schemas: readonly StoreSchema[]) {
        for (const s of schemas) this.stores.set(s.name, new MemoryStore(s));
    }

    store<K extends IDBValidKey, V>(name: string): KeyValueStore<K, V> {
        const s = this.stores.get(name);
        if (!s) throw new Error(`unknown store ${name}`);
        return s as unknown as KeyValueStore<K, V>;
    }

    close(): void {
        /* nothing to release */
    }
}

/**
 * Open (creating/upgrading) a database. `schemas` describes the stores;
 * the default upgrade creates any that are missing, and `upgrade` may run
 * extra migrations. Falls back to memory on any failure.
 */
export async function openDatabase(
    name: string,
    version: number,
    schemas: readonly StoreSchema[],
    upgrade?: UpgradeFn,
): Promise<Database> {
    const idb = getIndexedDB();
    if (!idb) return new MemoryDatabase(schemas);
    try {
        const req = idb.open(name, version);
        req.onupgradeneeded = (e) => {
            const db = req.result;
            for (const s of schemas) {
                if (!db.objectStoreNames.contains(s.name)) {
                    db.createObjectStore(s.name, {
                        ...(s.keyPath ? { keyPath: s.keyPath } : {}),
                        autoIncrement: !!s.autoIncrement,
                    });
                }
            }
            if (upgrade && req.transaction) upgrade(db, e.oldVersion, req.transaction);
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
            req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
        });
        // Another tab upgrading the schema: release our handle so it can.
        db.onversionchange = () => db.close();
        return new IdbDatabase(db);
    } catch (e) {
        console.warn(`[storage] IndexedDB "${name}" unavailable, using memory`, e);
        return new MemoryDatabase(schemas);
    }
}

/**
 * Open an existing database read-only without creating it. Resolves null
 * when it does not exist (the creation attempt is aborted, so probing
 * leaves no empty database behind) or cannot be opened.
 */
export async function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
    const idb = getIndexedDB();
    if (!idb) return null;
    try {
        return await new Promise<IDBDatabase | null>((resolve) => {
            let aborted = false;
            const req = idb.open(name);
            req.onupgradeneeded = () => {
                // Version 0 -> 1 means it did not exist: abort the creation.
                aborted = true;
                try {
                    req.transaction?.abort();
                } catch {
                    /* ignore */
                }
            };
            req.onsuccess = () => {
                if (aborted) {
                    req.result.close();
                    resolve(null);
                } else {
                    resolve(req.result);
                }
            };
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
    } catch {
        return null;
    }
}

/** Read every key/value pair of a store in an already-open database. */
export async function readAllEntries(db: IDBDatabase, storeName: string): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (!db.objectStoreNames.contains(storeName)) return out;
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const [keys, values] = await Promise.all([promisify(store.getAllKeys()), promisify(store.getAll())]);
    for (let i = 0; i < keys.length; i++) out.set(String(keys[i]), values[i]);
    return out;
}

// ---------------------------------------------------------------------------
// The application database
// ---------------------------------------------------------------------------

export const APP_DB_NAME = 'webosu';
export const APP_DB_VERSION = 1;

export const APP_STORES: readonly StoreSchema[] = [
    { name: 'sets' },
    { name: 'blobs' },
    { name: 'thumbs' },
    { name: 'scores', keyPath: 'id', autoIncrement: true },
    { name: 'kv' },
];

/** Typed handles for the app's stores. */
export interface AppDatabase {
    readonly persistent: boolean;
    readonly sets: KeyValueStore<string, unknown>;
    readonly blobs: KeyValueStore<string, Blob>;
    readonly thumbs: KeyValueStore<string, Blob>;
    readonly scores: KeyValueStore<number, unknown>;
    readonly kv: KeyValueStore<string, unknown>;
}

function wrap(db: Database): AppDatabase {
    return {
        persistent: db.persistent,
        sets: db.store('sets'),
        blobs: db.store('blobs'),
        thumbs: db.store('thumbs'),
        scores: db.store('scores'),
        kv: db.store('kv'),
    };
}

let appDb: Promise<AppDatabase> | null = null;

/** Shared app database (opened once per page). */
export function openAppDatabase(): Promise<AppDatabase> {
    appDb ??= openDatabase(APP_DB_NAME, APP_DB_VERSION, APP_STORES).then(wrap);
    return appDb;
}

/** Fresh non-persistent app database (tests, or explicit opt-out). */
export function createMemoryAppDatabase(): AppDatabase {
    return wrap(new MemoryDatabase(APP_STORES));
}
