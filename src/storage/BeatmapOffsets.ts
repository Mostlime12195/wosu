/**
 * Per-beatmap offsets (lazer's BeatmapInfo.UserSettings.Offset) and the
 * last play's timing on each difficulty for the loader's calibration.
 * Offsets persist in localStorage (they're read synchronously when a play
 * starts); last plays live for the session, like lazer's reference score.
 */
import { Signal } from '../core/Signal';
import { clampBeatmapOffset, type PlayTiming } from '../gameplay/offsetCalibration';
import { beatmapKeyOf } from './ScoreStore';

const STORAGE_KEY = 'wosu.beatmapOffsets.v1';

export class BeatmapOffsetStore {
    /** An offset changed (key = beatmapKeyOf). */
    readonly changed = new Signal<[key: string, offset: number]>();
    /** A play's timing was recorded (or cleared) for a difficulty. */
    readonly played = new Signal<[key: string]>();
    private offsets: Record<string, number> | null = null;
    private readonly lastPlays = new Map<string, PlayTiming | null>();

    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {}

    private load(): Record<string, number> {
        if (this.offsets) return this.offsets;
        let parsed: Record<string, number> = {};
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            const v: unknown = raw ? JSON.parse(raw) : null;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
                    if (typeof n === 'number' && Number.isFinite(n) && n !== 0) parsed[k] = clampBeatmapOffset(n);
                }
            }
        } catch {
            parsed = {};
        }
        this.offsets = parsed;
        return parsed;
    }

    get(key: string): number {
        return this.load()[key] ?? 0;
    }

    set(key: string, value: number): void {
        const v = clampBeatmapOffset(value);
        const all = this.load();
        if ((all[key] ?? 0) === v) return;
        if (v === 0) delete all[key];
        else all[key] = v;
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(all));
        } catch {
            /* private mode: kept for this session */
        }
        this.changed.emit(key, v);
    }

    /** The difficulty's last play timing this session (null: too few hits / not timed). */
    lastPlay(key: string): PlayTiming | null {
        return this.lastPlays.get(key) ?? null;
    }

    recordPlay(key: string, play: PlayTiming | null): void {
        this.lastPlays.set(key, play);
        this.played.emit(key);
    }
}

function safeStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

let instance: BeatmapOffsetStore | null = null;

export function beatmapOffsets(): BeatmapOffsetStore {
    instance ??= new BeatmapOffsetStore();
    return instance;
}

/** Offsets are keyed like local scores (beatmapKeyOf): the online id when known. */
export function offsetKeyFor(set: { title: string; onlineSetId?: number | null }, diff: { beatmapId: number; version: string }): string {
    return beatmapKeyOf({ beatmapId: diff.beatmapId, title: set.title, version: diff.version, setId: set.onlineSetId ?? 0 });
}
