import type { Grade } from '../storage/ScoreStore';
import type { ModAcronym } from './mods';

/** Final outcome of a play, handed from the Player to the Results screen. */
export interface ScoreResult {
    setKey: string;
    beatmapId: number;
    setId: number;
    title: string;
    artist: string;
    version: string;
    creator: string;
    mods: ModAcronym[];
    score: number;
    accuracy: number; // 0..1
    maxCombo: number;
    /** Highest achievable combo for the map. */
    mapMaxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    sliderTicksHit: number;
    sliderTicksTotal: number;
    grade: Grade;
    passed: boolean;
    perfect: boolean; // full combo
    date: number;
    player: string;
    /** Signed hit errors in ms (for the timing distribution). */
    hitErrors: number[];
    /** HP sampled over time [timeMs, hp 0..1] for the results graph. */
    healthGraph: [number, number][];
    /** Unstable rate (stddev of hit errors × 10, rate-adjusted). */
    unstableRate: number;
    /** Map length in ms (for display). */
    length: number;
    stars: number | null;
}
