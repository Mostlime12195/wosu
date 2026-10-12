/**
 * The gameplay leaderboard's data (lazer's GameplayLeaderboardScore +
 * SoloGameplayLeaderboardProvider), kept free of drawing so it can be
 * tested: the beatmap's local top scores plus the player's live score,
 * re-sorted by total score at most once a second (lazer's provider sorts
 * on a 1 s schedule when the live score has changed), with display order
 * and leaderboard position for each entry.
 */

/** The fields of a saved score the leaderboard shows. */
export interface LeaderboardSource {
    player: string;
    score: number;
    accuracy: number;
    maxCombo: number;
    date: number;
}

export interface LeaderboardEntry {
    name: string;
    score: number;
    accuracy: number;
    /** Highest combo (lazer's ComboDisplayMode.Highest). */
    combo: number;
    /** The player's live score (lazer: the local user, "tracked"). */
    readonly tracked: boolean;
    /** Lower sorts higher on equal score; the live score is always last among ties. */
    readonly tiebreaker: number;
    /** Position on the full leaderboard when play started (null for the live score). */
    readonly initialPosition: number | null;
    /** Shown rank: null when it can't be known (a partial leaderboard). */
    position: number | null;
    /** 1-based place in this list. */
    displayOrder: number;
}

/** lazer's solo provider re-sorts on this schedule. */
export const SORT_INTERVAL = 1000;

export class GameplayLeaderboardModel {
    readonly entries: LeaderboardEntry[] = [];
    readonly tracked: LeaderboardEntry;
    /** True when only the top part of the scores is listed (positions below it are unknown). */
    readonly partial: boolean;
    /** Bumped on every sort that changed an order or position. */
    version = 0;
    private dirty = true;
    private sinceSort = 0;

    /**
     * `scores` is the whole local leaderboard, best first; only the first
     * `limit` are listed (lazer lists what the song select leaderboard
     * fetched, all of it for local scores).
     */
    constructor(scores: readonly LeaderboardSource[], playerName: string, limit = Infinity) {
        const shown = scores.slice(0, limit);
        this.partial = shown.length < scores.length;
        shown.forEach((s, i) => this.entries.push({
            name: s.player || 'Guest',
            score: s.score,
            accuracy: s.accuracy,
            combo: s.maxCombo,
            tracked: false,
            tiebreaker: s.date,
            initialPosition: i + 1,
            position: i + 1,
            displayOrder: i + 1,
        }));
        this.tracked = {
            name: playerName || 'Guest',
            score: 0,
            accuracy: 1,
            combo: 0,
            tracked: true,
            tiebreaker: Number.MAX_SAFE_INTEGER,
            initialPosition: null,
            position: null,
            displayOrder: shown.length + 1,
        };
        this.entries.push(this.tracked);
        this.sort();
    }

    /** The live score; a new total marks the order stale (lazer's sorting.Invalidate). */
    setLive(score: number, accuracy: number, combo: number): void {
        const t = this.tracked;
        if (score !== t.score) this.dirty = true;
        t.score = score;
        t.accuracy = accuracy;
        t.combo = combo;
    }

    /** Advance the sort schedule; true when the order or a position changed. */
    update(dt: number): boolean {
        this.sinceSort += dt;
        if (this.sinceSort < SORT_INTERVAL) return false;
        this.sinceSort %= SORT_INTERVAL;
        return this.sort();
    }

    /** lazer's SoloGameplayLeaderboardProvider.sort (positions included). */
    sort(): boolean {
        if (!this.dirty) return false;
        this.dirty = false;
        const ordered = [...this.entries].sort((a, b) => b.score - a.score || a.tiebreaker - b.tiebreaker);
        let changed = false;
        let delta = 0;
        for (let i = 0; i < ordered.length; i++) {
            const e = ordered[i];
            let position: number | null;
            if (!this.partial) position = i + 1;
            else if (e.tracked) {
                // A partial board has gaps: the live score only gets a rank when it sits between two
                // neighbouring known positions, and pushes every score below it down one.
                const prev = i > 0 ? ordered[i - 1].initialPosition : 0;
                const next = i < ordered.length - 1 ? ordered[i + 1].initialPosition : null;
                if (prev !== null && next !== null && prev + 1 === next) {
                    position = prev + 1;
                    delta++;
                } else position = null;
            } else position = e.initialPosition === null ? null : e.initialPosition + delta;
            if (e.displayOrder !== i + 1 || e.position !== position) changed = true;
            e.displayOrder = i + 1;
            e.position = position;
        }
        if (changed) this.version++;
        return changed;
    }
}
