import { calculateTimedAttributes, type OsuDifficultyAttributes } from '../../beatmap/difficulty';
import type { PlayableBeatmap } from '../../beatmap/types';
import { playbackRate, type ModSet } from '../mods';
import { calculatePerformance } from '../performance';
import type { GameplayMechanics } from '../scoring/mechanics';

/** The judgements so far, as the live pp counter needs them. */
export interface LiveScoreStats {
    great: number;
    ok: number;
    meh: number;
    miss: number;
    maxCombo: number;
    accuracy: number;
    /** Slider tails judged so far / hit (lazer mechanics). */
    sliderEndsJudged: number;
    sliderEndsHit: number;
    /** Slider ticks missed (lazer mechanics). */
    tickMisses: number;
}

/**
 * lazer's PerformancePointsCounter maths: the difficulty attributes of the
 * map up to the last judged object (timed attributes, computed once), and
 * the pp the judgements so far are worth against them.
 */
export class LivePerformance {
    private readonly timed: OsuDifficultyAttributes[];
    private readonly mods: ReadonlySet<string>;

    constructor(beatmap: PlayableBeatmap, mods: ModSet, private readonly mechanics: GameplayMechanics) {
        this.mods = new Set(mods);
        this.timed = calculateTimedAttributes(beatmap, {
            rate: playbackRate(mods),
            hidden: mods.has('HD'),
            flashlight: mods.has('FL'),
            relax: mods.has('RX'),
            autopilot: mods.has('AP'),
        });
    }

    /** Attributes of the map cut off after `judged` objects (null before the first). */
    attributesAfter(judged: number): OsuDifficultyAttributes | null {
        if (judged <= 0 || !this.timed.length) return null;
        return this.timed[Math.min(judged, this.timed.length) - 1];
    }

    /** The full map's attributes. */
    get full(): OsuDifficultyAttributes | null {
        return this.timed[this.timed.length - 1] ?? null;
    }

    pp(s: LiveScoreStats): number {
        const attr = this.attributesAfter(s.great + s.ok + s.meh + s.miss);
        if (!attr) return 0;
        const classic = this.mechanics === 'stable';
        return calculatePerformance(attr, {
            accuracy: s.accuracy,
            maxCombo: s.maxCombo,
            countGreat: s.great,
            countOk: s.ok,
            countMeh: s.meh,
            countMiss: s.miss,
            sliderEndsDropped: classic ? undefined : Math.max(0, s.sliderEndsJudged - s.sliderEndsHit),
            largeTickMisses: classic ? undefined : s.tickMisses,
            classicSliderAccuracy: classic,
            mods: this.mods,
        }).total;
    }
}
