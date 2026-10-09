/**
 * Favourited online beatmap sets (the old site's "liked" hearts).
 * Stored oldest-first as a plain array (JSON/structured-clone safe:
 * the old Set-based storage once silently wiped everyone's favourites).
 */
import { Signal } from '../core/Signal';
import { openAppDatabase, type AppDatabase } from './idb';
import { migrateOnce, readLegacyData, toSetIds, type LegacySource } from './legacy';

const KEY = 'favourites';

export class Favourites {
    readonly changed = new Signal<[]>();
    private ids: number[] = [];
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private readonly legacySource: LegacySource;

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase(), options: { legacy?: LegacySource } = {}) {
        this.legacySource = options.legacy ?? readLegacyData;
    }

    init(): Promise<void> {
        this.ready ??= this.load();
        return this.ready;
    }

    private async load(): Promise<void> {
        const db = await this.dbSource;
        this.db = db;
        try {
            const stored = await db.kv.get(KEY);
            this.ids = Array.isArray(stored) ? toSetIds(stored) : [];
        } catch (e) {
            console.warn('[favourites] load failed', e);
        }
        await migrateOnce(db.kv, 'favourites', async (data) => {
            const legacy = toSetIds(data.liked);
            const merged = [...legacy.filter(id => !this.ids.includes(id)), ...this.ids];
            if (merged.length !== this.ids.length) {
                this.ids = merged;
                await this.persist();
                this.changed.emit();
            }
        }, this.legacySource);
    }

    has(sid: number): boolean {
        return this.ids.includes(sid);
    }

    /** Favourite set ids, newest first. */
    list(): number[] {
        return [...this.ids].reverse();
    }

    get size(): number {
        return this.ids.length;
    }

    add(sid: number): void {
        if (!Number.isInteger(sid) || sid <= 0 || this.has(sid)) return;
        this.ids.push(sid);
        this.commit();
    }

    remove(sid: number): void {
        const i = this.ids.indexOf(sid);
        if (i === -1) return;
        this.ids.splice(i, 1);
        this.commit();
    }

    /** Returns the new state (true = favourited). */
    toggle(sid: number): boolean {
        if (this.has(sid)) {
            this.remove(sid);
            return false;
        }
        this.add(sid);
        return this.has(sid);
    }

    private commit(): void {
        this.changed.emit();
        void this.persist();
    }

    private async persist(): Promise<void> {
        try {
            const db = this.db ?? (await this.dbSource);
            await db.kv.put([...this.ids], KEY);
        } catch (e) {
            console.warn('[favourites] save failed', e);
        }
    }
}
