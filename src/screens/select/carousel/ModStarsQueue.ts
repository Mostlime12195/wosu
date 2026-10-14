import type { Game } from '../../../app/Game';
import type { LibrarySet } from '../../../beatmap/Library';
import type { DifficultySummary } from '../../../beatmap/types';
import { modsKey, type ModSet } from '../../../gameplay/mods';
import { modAdjustedStars, ratingMods } from '../modStars';

/** Panel kinds, most important first: the expanded set's difficulty panels, then set panels' dots. */
export const StarPriority = { Difficulty: 0, SetDot: 1 } as const;
export type StarPriority = (typeof StarPriority)[keyof typeof StarPriority];

interface Request {
    set: LibrarySet;
    diff: DifficultySummary;
    priority: StarPriority;
    /** Frame it was last asked for. */
    tick: number;
}

/** A request not repeated for this many frames scrolled away: dropped. */
const STALE_TICKS = 20;
const RESULT_LIMIT = 4000;

/**
 * lazer's BeatmapDifficultyCache for the carousel: mod-adjusted star
 * ratings, computed lazily for what's on screen. Panels ask every frame
 * (`starsFor`); only one difficulty is computed at a time, the expanded
 * set's difficulties first, the most recently wanted next, so scrolling
 * never queues up work for panels long gone. Until a rating arrives the
 * panel shows the base one (`pending`).
 */
export class ModStarsQueue {
    /** Bumps whenever displayed ratings may change (a result landed, the mods changed). */
    version = 0;
    /** Set by `starsFor`: the returned rating is the base one, the adjusted is on its way. */
    pending = false;
    private mods: ModSet | null = null;
    private relevant: ModSet | null = null;
    private key = '';
    private tick = 0;
    private running = false;
    private readonly wanted = new Map<string, Request>();
    private readonly results = new Map<string, number | null>();

    constructor(private readonly game: Game) {}

    /** Once per frame, before panels ask. */
    update(): void {
        this.tick++;
        const mods = this.game.mods.value;
        if (mods !== this.mods) {
            this.mods = mods;
            this.relevant = ratingMods(mods);
            const key = this.relevant ? modsKey(this.relevant) : '';
            if (key !== this.key) {
                this.key = key;
                this.wanted.clear();
                this.version++;
            }
        }
        this.pump();
    }

    /** The rating to show for a difficulty with the current mods (lazily requested). */
    starsFor(set: LibrarySet, diff: DifficultySummary, priority: StarPriority): number | null {
        this.pending = false;
        if (!this.relevant || diff.stars === null) return diff.stars;
        const k = this.cacheKey(set, diff);
        const hit = this.results.get(k);
        if (hit !== undefined) return hit;
        const req = this.wanted.get(k);
        if (req) {
            req.tick = this.tick;
            if (priority < req.priority) req.priority = priority;
        } else {
            this.wanted.set(k, { set, diff, priority, tick: this.tick });
        }
        this.pending = true;
        return diff.stars;
    }

    private cacheKey(set: LibrarySet, diff: DifficultySummary): string {
        return `${set.key}|${diff.file}|${diff.stars}|${this.key}`;
    }

    private pump(): void {
        if (this.running || !this.wanted.size || !this.mods) return;
        let best: [string, Request] | null = null;
        for (const entry of this.wanted) {
            const r = entry[1];
            if (this.tick - r.tick > STALE_TICKS) {
                this.wanted.delete(entry[0]);
                continue;
            }
            const b = best?.[1];
            if (!b || r.priority < b.priority || (r.priority === b.priority && r.tick > b.tick)) best = entry;
        }
        if (!best) return;
        const [k, req] = best;
        this.wanted.delete(k);
        this.running = true;
        const mods = this.mods;
        void modAdjustedStars(this.game, req.set, req.diff, mods).then(stars => {
            this.results.set(k, stars);
            if (this.results.size > RESULT_LIMIT) this.results.delete(this.results.keys().next().value as string);
            this.version++;
        }).finally(() => {
            this.running = false;
        });
    }
}
