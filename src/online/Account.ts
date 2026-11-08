/**
 * The player's wosu! account: sign in / register against the site's own
 * API (server/), score submission and the global leaderboards.
 *
 * Everything degrades quietly: with no API (a static preview, offline)
 * the player stays signed out and scores are only kept locally.
 */
import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import type { ModAcronym, ModSettingsMap } from '../gameplay/mods';
import type { Grade, ScoreRecord } from '../storage/ScoreStore';

export interface OnlineUser {
    id: number;
    name: string;
    pp: number;
    accuracy: number;
    rankedScore: number;
    playCount: number;
    /** Global rank, or null before the first submitted play. */
    rank: number | null;
    created: number;
}

/** A score from the server (same shape as a local record, with its owner's name and rank). */
export interface OnlineScore {
    id: number;
    userId: number;
    player: string;
    beatmapId: number;
    setId: number;
    title: string;
    artist: string;
    version: string;
    creator: string;
    mods: ModAcronym[];
    modSettings?: ModSettingsMap;
    score: number;
    accuracy: number;
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    countGeki?: number;
    countKatu?: number;
    grade: Grade;
    pp?: number;
    ranked: boolean;
    date: number;
    hasReplay: boolean;
    rank?: number;
}

export interface Leaderboard {
    scores: OnlineScore[];
    /** The signed-in player's own best on the map (with its rank), if any. */
    mine: OnlineScore | null;
}

export interface SubmitResult {
    score: OnlineScore;
    /** Position of the player's best score on this map after submitting. */
    rank: number;
    /** This play is the player's new best on the map. */
    best: boolean;
    user: OnlineUser;
}

export interface RankingsPage {
    users: { rank: number; id: number; name: string; pp: number; accuracy: number; rankedScore: number; playCount: number }[];
    page: number;
    pages: number;
    total: number;
}

export class ApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/** Where the API lives: next to the site, so previews and sub-paths work without configuration. */
export const DEFAULT_API_BASE = '/api';

export type Fetch = typeof fetch;

/** An online score as a local record (for the shared leaderboard rows). */
export function toScoreRecord(s: OnlineScore): ScoreRecord {
    return {
        beatmapKey: `bid:${s.beatmapId}`,
        beatmapId: s.beatmapId,
        setId: s.setId,
        title: s.title,
        artist: s.artist,
        version: s.version,
        creator: s.creator,
        mods: s.mods,
        modSettings: s.modSettings,
        score: s.score,
        accuracy: s.accuracy,
        maxCombo: s.maxCombo,
        count300: s.count300,
        count100: s.count100,
        count50: s.count50,
        countMiss: s.countMiss,
        countGeki: s.countGeki,
        countKatu: s.countKatu,
        grade: s.grade,
        passed: true,
        date: s.date,
        player: s.player,
        pp: s.pp,
        // Online replays are fetched on demand, not held in the local store.
        hasReplay: false,
    };
}

/** Bytes to base64 without blowing the call stack on large replays. */
export function base64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export class AccountManager {
    /** The signed-in player, or null. */
    readonly user = new Bindable<OnlineUser | null>(null);
    /** The API answered at least once (false: offline or no server here). */
    readonly available = new Bindable(false);
    /** A score was accepted by the server (song select refreshes the global board). */
    readonly submitted = new Signal<[result: SubmitResult]>();

    constructor(private readonly base = DEFAULT_API_BASE, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

    get signedIn(): boolean {
        return this.user.value !== null;
    }

    /** Restore the session cookie's user (never throws). */
    async init(): Promise<void> {
        try {
            const r = await this.request<{ user: OnlineUser | null }>('GET', '/auth/me');
            this.available.value = true;
            this.user.value = r.user;
        } catch (e) {
            if (e instanceof ApiError) this.available.value = true;
            this.user.value = null;
        }
    }

    async register(name: string, password: string): Promise<OnlineUser> {
        const r = await this.request<{ user: OnlineUser }>('POST', '/auth/register', { name, password });
        this.user.value = r.user;
        return r.user;
    }

    async login(name: string, password: string): Promise<OnlineUser> {
        const r = await this.request<{ user: OnlineUser }>('POST', '/auth/login', { name, password });
        this.user.value = r.user;
        return r.user;
    }

    async logout(): Promise<void> {
        try {
            await this.request('POST', '/auth/logout');
        } finally {
            this.user.value = null;
        }
    }

    /** Re-read the player's stats (after a submission elsewhere). */
    async refresh(): Promise<void> {
        if (!this.signedIn) return;
        const r = await this.request<{ user: OnlineUser | null }>('GET', '/auth/me');
        this.user.value = r.user;
    }

    /** Whether a play would be accepted: signed in, passed, on an online beatmap. */
    canSubmit(r: { passed: boolean; beatmapId: number }): boolean {
        return this.signedIn && r.passed && r.beatmapId > 0;
    }

    async submit(record: ScoreRecord, replay?: Uint8Array): Promise<SubmitResult> {
        const body = {
            beatmapId: record.beatmapId,
            setId: record.setId,
            title: record.title,
            artist: record.artist,
            version: record.version,
            creator: record.creator,
            mods: record.mods,
            modSettings: record.modSettings,
            score: record.score,
            accuracy: record.accuracy,
            maxCombo: record.maxCombo,
            count300: record.count300,
            count100: record.count100,
            count50: record.count50,
            countMiss: record.countMiss,
            countGeki: record.countGeki,
            countKatu: record.countKatu,
            grade: record.grade,
            passed: record.passed,
            pp: record.pp,
            date: record.date,
            mechanics: record.mechanics,
            replay: replay ? base64(replay) : undefined,
            client: typeof __BUILD_INFO__ === 'string' ? __BUILD_INFO__ : undefined,
        };
        const r = await this.request<SubmitResult>('POST', '/scores', body);
        this.user.value = r.user;
        this.submitted.emit(r);
        return r;
    }

    /** Top scores on a beatmap; `mods` filters to that exact mod set (undefined: any). */
    async leaderboard(beatmapId: number, mods?: readonly ModAcronym[], signal?: AbortSignal): Promise<Leaderboard> {
        const query = mods ? `?mods=${encodeURIComponent([...mods].sort().join(','))}` : '';
        return this.request<Leaderboard>('GET', `/beatmaps/${beatmapId}/scores${query}`, undefined, signal);
    }

    async rankings(page = 1): Promise<RankingsPage> {
        return this.request<RankingsPage>('GET', `/rankings?page=${page}`);
    }

    async replay(scoreId: number): Promise<Uint8Array> {
        const res = await this.fetchFn(`${this.base}/scores/${scoreId}/replay`, { credentials: 'same-origin' });
        if (!res.ok) throw new ApiError(res.status, 'That replay is not available.');
        return new Uint8Array(await res.arrayBuffer());
    }

    private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        const res = await this.fetchFn(`${this.base}${path}`, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
        let data: unknown = null;
        const text = await res.text();
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!res.ok) {
            const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
                ? (data as { error: string }).error
                : `The server answered ${res.status}.`;
            if (res.status === 401 && path !== '/auth/login') this.user.value = null;
            throw new ApiError(res.status, message);
        }
        if (data === null || typeof data !== 'object') throw new ApiError(res.status, 'The server gave an unexpected answer.');
        return data as T;
    }
}
