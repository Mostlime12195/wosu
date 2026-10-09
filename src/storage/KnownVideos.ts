/**
 * Registry of online sets confirmed to ship a background video.
 *
 * SayoBot never flags video maps, so ground truth is remembered locally:
 * once a downloaded set turns out to contain a video, its VIDEO badge
 * shows from then on regardless of the browsing provider.
 */
import { Signal } from '../core/Signal';
import { openAppDatabase, type AppDatabase } from './idb';
import { migrateOnce, readLegacyData, toSetIds, type LegacySource } from './legacy';

const KEY = 'knownVideos';

export class KnownVideos {
    readonly changed = new Signal<[]>();
    private ids = new Set<number>();
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
            if (Array.isArray(stored)) this.ids = new Set(toSetIds(stored));
        } catch (e) {
            console.warn('[videos] load failed', e);
        }
        await migrateOnce(db.kv, 'knownVideos', async (data) => {
            let added = false;
            for (const id of toSetIds(data.knownVideos)) {
                if (!this.ids.has(id)) {
                    this.ids.add(id);
                    added = true;
                }
            }
            if (added) await this.persist();
        }, this.legacySource);
    }

    /** Accepts number or numeric-string ids (providers disagree). */
    has(sid: number | string | null | undefined): boolean {
        if (sid === null || sid === undefined || sid === '') return false;
        return this.ids.has(Number(sid));
    }

    record(sid: number | string | null | undefined): void {
        const [id] = toSetIds([sid]);
        if (id === undefined || this.ids.has(id)) return;
        this.ids.add(id);
        this.changed.emit();
        void this.persist();
    }

    private async persist(): Promise<void> {
        try {
            const db = this.db ?? (await this.dbSource);
            await db.kv.put([...this.ids], KEY);
        } catch (e) {
            console.warn('[videos] save failed', e);
        }
    }
}
