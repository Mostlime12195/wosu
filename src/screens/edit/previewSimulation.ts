import type { PlayableBeatmap } from '../../beatmap/types';
import type { HUDState } from '../../gameplay/hud/HUDOverlay';
import type { LiveScoreStats } from '../../gameplay/hud/livePerformance';
import type { GameplayButton } from '../../gameplay/input/GameplayInput';

/** A tiny seeded PRNG (mulberry32), so the preview plays the same every loop. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface SimEvents {
    /** Hit errors of objects hit this step (the error meters). */
    hits: number[];
    /** Successful judgements this step (the health bar's flash). */
    judgements: number;
    /** The play restarted (looped). */
    restarted: boolean;
}

/**
 * The skin editor's stand-in for gameplay (lazer shows a paused or looping
 * gameplay preview): the selected beatmap plays out silently with a
 * plausible, seeded run of judgements, so every HUD component has live
 * values to show (score rolling, combo, health, keys, hit errors, the
 * progress bar, unstable rate, live pp). Loops back to the start.
 */
export class PreviewSimulation {
    private time: number;
    private next = 0;
    private random = rng(7);
    private readonly start: number;
    private readonly end: number;
    readonly errors: number[] = [];
    private score = 0;
    private combo = 0;
    private maxCombo = 0;
    private hp = 1;
    private readonly stats: LiveScoreStats = { great: 0, ok: 0, meh: 0, miss: 0, maxCombo: 0, accuracy: 1, sliderEndsJudged: 0, sliderEndsHit: 0, tickMisses: 0 };
    private readonly down: Record<GameplayButton, boolean> = { K1: false, K2: false, M1: false, M2: false };
    private readonly counts: Record<GameplayButton, number> = { K1: 0, K2: 0, M1: 0, M2: 0 };
    private releaseAt = 0;
    private button: GameplayButton = 'K1';

    constructor(private readonly beatmap: PlayableBeatmap) {
        this.start = beatmap.startTime - 1500;
        this.end = Math.max(beatmap.endTime, beatmap.startTime + 1000) + 1500;
        // Start a little into the map, so the first frame already has something to show.
        this.time = this.start;
        this.reset();
        this.advance(Math.min(15000, (beatmap.endTime - beatmap.startTime) * 0.3) + 1500);
    }

    private reset(): void {
        this.time = this.start;
        this.next = 0;
        this.random = rng(7);
        this.errors.length = 0;
        this.score = this.combo = this.maxCombo = 0;
        this.hp = 1;
        Object.assign(this.stats, { great: 0, ok: 0, meh: 0, miss: 0, maxCombo: 0, accuracy: 1, sliderEndsJudged: 0, sliderEndsHit: 0, tickMisses: 0 });
        for (const b of ['K1', 'K2', 'M1', 'M2'] as const) {
            this.down[b] = false;
            this.counts[b] = 0;
        }
    }

    /** Standard normal sample (Box–Muller). */
    private gaussian(): number {
        const u = Math.max(1e-9, this.random());
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
    }

    /** Move the clock on by `dt` ms; judge the objects passed. */
    advance(dt: number): SimEvents {
        const ev: SimEvents = { hits: [], judgements: 0, restarted: false };
        this.time += dt;
        if (this.time > this.end) {
            this.reset();
            ev.restarted = true;
        }
        const objs = this.beatmap.hitObjects;
        const d = this.beatmap.difficulty;
        const s = this.stats;
        while (this.next < objs.length && objs[this.next].time <= this.time) {
            const h = objs[this.next++];
            // A steady player: errors around -2 ms (σ 14 ms), judged by the map's windows; a few misses.
            const miss = h.kind !== 'spinner' && this.random() < 0.015;
            const e = Math.max(-d.window50, Math.min(d.window50, -2 + this.gaussian() * 14));
            const abs = Math.abs(e);
            const result = h.kind === 'spinner' ? 'great' : miss ? 'miss' : abs <= d.window300 ? 'great' : abs <= d.window100 ? 'ok' : 'meh';
            if (result === 'miss') {
                s.miss++;
                this.combo = 0;
                this.hp = Math.max(0.05, this.hp - 0.12);
            } else {
                if (h.kind !== 'spinner') {
                    this.errors.push(e);
                    ev.hits.push(e);
                }
                if (result === 'great') s.great++;
                else if (result === 'ok') s.ok++;
                else s.meh++;
                const parts = h.kind === 'slider' ? h.events.length : 1;
                this.combo += parts;
                this.maxCombo = Math.max(this.maxCombo, this.combo);
                const value = result === 'great' ? 300 : result === 'ok' ? 100 : 50;
                this.score += value * (1 + Math.max(0, this.combo - 1) / 25) + (parts - 1) * 30;
                this.hp = Math.min(1, this.hp + (result === 'great' ? 0.06 : 0.02));
                ev.judgements++;
            }
            if (h.kind === 'slider') {
                s.sliderEndsJudged++;
                if (result !== 'miss') s.sliderEndsHit++;
            }
            if (h.kind !== 'spinner') {
                this.button = this.button === 'K1' ? 'K2' : 'K1';
                this.counts[this.button]++;
                this.down[this.button] = true;
                this.releaseAt = this.time + Math.min(90, h.endTime - h.time + 60);
            }
        }
        if (this.time >= this.releaseAt) this.down.K1 = this.down.K2 = false;
        this.hp = Math.max(0.05, this.hp - dt * 0.00002);
        const judged = s.great + s.ok + s.meh + s.miss;
        s.accuracy = judged ? (300 * s.great + 100 * s.ok + 50 * s.meh) / (300 * judged) : 1;
        s.maxCombo = this.maxCombo;
        return ev;
    }

    state(rate: number): HUDState {
        const s = this.stats;
        return {
            time: this.time,
            rate,
            score: Math.round(this.score),
            accuracy: s.accuracy,
            combo: this.combo,
            maxCombo: this.maxCombo,
            hp: this.hp,
            grade: s.accuracy >= 0.95 ? 'S' : s.accuracy >= 0.9 ? 'A' : 'B',
            down: this.down,
            counts: this.counts,
            playing: false,
            stats: { ...s },
            hitErrors: this.errors,
        };
    }
}
