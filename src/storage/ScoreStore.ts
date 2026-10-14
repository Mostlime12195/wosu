/**
 * Local score records (the offline leaderboard and play history).
 *
 * All records are mirrored in memory after `init()`: even thousands of
 * scores are tiny, and song select queries them on every selection.
 */
import { Signal } from '../core/Signal';
import { modSettingsOf, parseLegacyModString, sortedMods, withSettings, type ModAcronym, type ModSettingsMap } from '../gameplay/mods';
import type { GameplayMechanics } from '../gameplay/scoring/mechanics';
import { openAppDatabase, type AppDatabase } from './idb';
import { migrateOnce, readLegacyData, type LegacyHistoryEntry, type LegacySource } from './legacy';

/** osu! grades; X = SS, H suffix = silver (Hidden/Flashlight). */
export type Grade = 'XH' | 'X' | 'SH' | 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export const GRADES: readonly Grade[] = ['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D', 'F'];

export interface ScoreRecord {
    id?: number;
    beatmapKey: string;
    beatmapId: number;
    setId: number;
    title: string;
    artist: string;
    version: string;
    creator: string;
    mods: ModAcronym[];
    /** Customised mod settings the score was set with (lazer stores them with the mods). */
    modSettings?: ModSettingsMap;
    score: number;
    accuracy: number; // 0..1
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    /** osu!stable's gekis and katus (absent on scores set before they were counted). */
    countGeki?: number;
    countKatu?: number;
    grade: Grade;
    passed: boolean;
    date: number;
    player: string;
    /** Imported from the old site's history (no hit counts). */
    legacy?: boolean;
    /** Gameplay mechanics the score was set with (absent: set before they were recorded). */
    mechanics?: GameplayMechanics;
    /** A replay is stored for this score (see `replay`). */
    hasReplay?: boolean;
}

/**
 * Stable identity for a difficulty: the online beatmap id when known,
 * otherwise set + title + version (local imports of unsubmitted maps).
 */
export function beatmapKeyOf(b: { beatmapId: number; title: string; version: string; setId: number }): string {
    if (b.beatmapId > 0) return `bid:${b.beatmapId}`;
    return `t:${b.setId > 0 ? b.setId : 0}|${b.title}|${b.version}`.toLowerCase();
}

function num(v: unknown, fallback = 0): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[,%\s]/g, ''));
        return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
}

function legacyGrade(g: unknown): Grade {
    const s = String(g ?? '').trim().toUpperCase();
    if (s === 'SS') return 'X';
    if (s === 'SSH') return 'XH';
    return (GRADES as readonly string[]).includes(s) ? (s as Grade) : 'D';
}

/** Old site's mod strings used "RL" for Relax. */
function legacyMods(s: unknown): ModAcronym[] {
    const str = String(s ?? '').replace(/\bRL\b/g, 'RX');
    return sortedMods(parseLegacyModString(str));
}

/** Convert one old `playhistory1000` row; null when unusable. */
export function migrateHistoryEntry(h: LegacyHistoryEntry): ScoreRecord | null {
    if (!h || typeof h !== 'object') return null;
    const title = String(h.title ?? '').trim();
    const version = String(h.version ?? '').trim();
    if (!title && !h.bid) return null;
    const beatmapId = Math.max(0, Math.trunc(num(h.bid)));
    const setId = Math.max(0, Math.trunc(num(h.sid)));
    const grade = legacyGrade(h.grade);
    let acc = num(h.acc, 0);
    // "98.50%" strings and 0..100 numbers both mean percent.
    if (typeof h.acc === 'string' || acc > 1) acc /= 100;
    return {
        beatmapKey: beatmapKeyOf({ beatmapId, title, version, setId }),
        beatmapId,
        setId,
        title,
        artist: '',
        version,
        creator: '',
        mods: legacyMods(h.mods),
        score: Math.max(0, Math.round(num(h.score))),
        accuracy: Math.min(1, Math.max(0, acc)),
        maxCombo: Math.max(0, Math.round(num(h.combo))),
        count300: 0,
        count100: 0,
        count50: 0,
        countMiss: 0,
        grade,
        passed: grade !== 'F',
        date: num(h.time, 0) || 0,
        player: 'Guest',
        legacy: true,
    };
}

/**
 * lazer's TopLocalRank: the grade of the best passed score (highest total
 * score; ties: the older one) on a difficulty, or null when it has none.
 */
export function topLocalGrade(records: readonly Pick<ScoreRecord, 'score' | 'date' | 'grade' | 'passed'>[]): Grade | null {
    let best: Pick<ScoreRecord, 'score' | 'date' | 'grade' | 'passed'> | null = null;
    for (const r of records) {
        if (!r.passed || r.grade === 'F') continue;
        if (!best || r.score > best.score || (r.score === best.score && r.date < best.date)) best = r;
    }
    return best?.grade ?? null;
}

/** topLocalGrade for every difficulty at once (beatmapKey → grade). */
export function topLocalGrades(records: readonly ScoreRecord[]): Map<string, Grade> {
    const byKey = new Map<string, ScoreRecord[]>();
    for (const r of records) {
        let list = byKey.get(r.beatmapKey);
        if (!list) byKey.set(r.beatmapKey, (list = []));
        list.push(r);
    }
    const out = new Map<string, Grade>();
    for (const [key, list] of byKey) {
        const g = topLocalGrade(list);
        if (g) out.set(key, g);
    }
    return out;
}

export interface ScoreStoreOptions {
    legacy?: LegacySource;
}

export class ScoreStore {
    readonly changed = new Signal<[record: ScoreRecord]>();
    /** Scores were deleted (one, or all). */
    readonly removed = new Signal<[]>();
    private records: ScoreRecord[] = [];
    private db: AppDatabase | null = null;
    private ready: Promise<void> | null = null;
    private readonly legacySource: LegacySource;
    /** topLocalGrades of `records`, rebuilt lazily after any change. */
    private grades: Map<string, Grade> | null = null;
    private loaded = false;

    constructor(private readonly dbSource: AppDatabase | Promise<AppDatabase> = openAppDatabase(), options: ScoreStoreOptions = {}) {
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
            this.records = ((await db.scores.getAll()) as ScoreRecord[]).filter(r => r && typeof r === 'object');
        } catch (e) {
            console.warn('[scores] load failed', e);
            this.records = [];
        }
        await migrateOnce(db.kv, 'scores', async (data) => {
            for (const h of data.history) {
                const rec = migrateHistoryEntry(h);
                if (!rec) continue;
                // Skip duplicates if a partial earlier run already wrote it.
                if (this.records.some(r => r.legacy && r.date === rec.date && r.beatmapKey === rec.beatmapKey)) continue;
                rec.id = await db.scores.put(rec);
                this.records.push(rec);
            }
        }, this.legacySource);
        this.loaded = true;
        this.grades = null;
    }

    /**
     * The grade of the best local score on a difficulty (lazer's
     * TopLocalRank), synchronously for song select's panels; null until
     * the store has loaded. Kept current as scores are added or deleted.
     */
    topGrade(key: string): Grade | null {
        if (!this.loaded) return null;
        this.grades ??= topLocalGrades(this.records);
        return this.grades.get(key) ?? null;
    }

    /** Persist a new record, with its encoded replay if any; resolves with it (id assigned). */
    async add(record: ScoreRecord, replay?: Uint8Array): Promise<ScoreRecord> {
        await this.init();
        const rec: ScoreRecord = { ...record, mods: [...record.mods] };
        delete rec.id;
        delete rec.hasReplay;
        // Only valid, non-default settings of the score's own mods are kept.
        const settings = record.modSettings ? modSettingsOf(withSettings(record.mods, record.modSettings)) : {};
        if (Object.keys(settings).length) rec.modSettings = settings;
        else delete rec.modSettings;
        try {
            rec.id = await this.db!.scores.put(rec);
            if (replay) {
                // Written after the score (its key is the score's id); the flag only once it's stored.
                await this.db!.replays.put(replay, rec.id);
                rec.hasReplay = true;
                await this.db!.scores.put(rec);
            }
        } catch (e) {
            // Keep the score for this session even if persistence fails.
            console.warn('[scores] save failed', e);
        }
        this.records.push(rec);
        this.grades = null;
        this.changed.emit(rec);
        return rec;
    }

    /** Scores on one difficulty, best first (ties: older first). */
    async forBeatmap(key: string): Promise<ScoreRecord[]> {
        await this.init();
        return this.records
            .filter(r => r.beatmapKey === key)
            .sort((a, b) => b.score - a.score || a.date - b.date);
    }

    async best(key: string): Promise<ScoreRecord | null> {
        const list = await this.forBeatmap(key);
        return list.find(r => r.passed) ?? list[0] ?? null;
    }

    /** Most recent plays, newest first. */
    async recent(limit = 50): Promise<ScoreRecord[]> {
        await this.init();
        return [...this.records].sort((a, b) => b.date - a.date).slice(0, limit);
    }

    async all(): Promise<ScoreRecord[]> {
        await this.init();
        return [...this.records];
    }

    /** A score's encoded replay (see gameplay/replay), or null when it has none. */
    async replay(id: number): Promise<Uint8Array | null> {
        await this.init();
        try {
            return (await this.db!.replays.get(id)) ?? null;
        } catch (e) {
            console.warn('[scores] replay load failed', e);
            return null;
        }
    }

    async delete(id: number): Promise<void> {
        await this.init();
        this.records = this.records.filter(r => r.id !== id);
        this.grades = null;
        try {
            await this.db!.scores.delete(id);
            await this.db!.replays.delete(id);
        } catch (e) {
            console.warn('[scores] delete failed', e);
        }
        this.removed.emit();
    }

    async clear(): Promise<void> {
        await this.init();
        this.records = [];
        this.grades = null;
        try {
            await this.db!.scores.clear();
            await this.db!.replays.clear();
        } finally {
            this.removed.emit();
        }
    }
}
