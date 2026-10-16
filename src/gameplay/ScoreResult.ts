import type { Grade } from '../storage/ScoreStore';
import type { ModAcronym, ModSettingsMap } from './mods';

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
    /** Customised mod settings (e.g. DT's speed); absent or empty at defaults. */
    modSettings?: ModSettingsMap;
    score: number;
    accuracy: number; // 0..1
    maxCombo: number;
    /** Highest achievable combo for the map. */
    mapMaxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    /** osu!stable's combo-end judgements (see scoring/comboEnd): gekis, and katus (hit300k + hit100k). */
    countGeki: number;
    countKatu: number;
    sliderTicksHit: number;
    sliderTicksTotal: number;
    /** Slider tails hit / total: lazer's "slider end" statistic (lazer mechanics only). */
    sliderEndsHit?: number;
    sliderEndsTotal?: number;
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
    /** Performance points (wosu!'s estimate of the osu! formula); null/absent when unknown (older scores). */
    pp?: number | null;
}
