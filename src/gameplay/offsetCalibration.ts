/**
 * lazer's BeatmapOffsetControl maths: per-beatmap offsets and the
 * "Calibrate using last play" suggestion from a play's hit errors.
 *
 * wosu!'s offsets share the global audio offset's sign: positive values
 * delay hit timing (hit objects appear later). Beatmap offsets are kept in
 * real milliseconds; hit errors are in song time (they scale with rate
 * mods), so they are divided by the play's rate.
 */

/** lazer: BeatmapOffsetControl's slider range and precision. */
export const BEATMAP_OFFSET_MIN = -50;
export const BEATMAP_OFFSET_MAX = 50;
export const BEATMAP_OFFSET_PRECISION = 0.1;
/** lazer only offers calibration after at least this many timed hits. */
export const MIN_CALIBRATION_HITS = 10;

/** What a finished (or abandoned) play leaves behind for calibration. */
export interface PlayTiming {
    /** Hit errors in song-time ms (positive = late). */
    hitErrors: readonly number[];
    /** Playback rate of the play (DT 1.5, HT 0.75). */
    rate: number;
    /** The beatmap offset (real ms) the play was set with. */
    offset: number;
}

export interface OffsetSuggestion {
    /** Mean hit error in real ms (positive: the player hit late). */
    average: number;
    /** Beatmap offset that would have centred the play's hits. */
    offset: number;
    hits: number;
}

export function clampBeatmapOffset(v: number): number {
    if (!Number.isFinite(v)) return 0;
    const c = Math.min(BEATMAP_OFFSET_MAX, Math.max(BEATMAP_OFFSET_MIN, v));
    return Number((Math.round(c / BEATMAP_OFFSET_PRECISION) * BEATMAP_OFFSET_PRECISION).toFixed(1));
}

/** The calibration suggestion for a play, or null when it had too few timed hits. */
export function suggestOffset(play: PlayTiming | null | undefined): OffsetSuggestion | null {
    if (!play) return null;
    const errors = play.hitErrors.filter(Number.isFinite);
    if (errors.length < MIN_CALIBRATION_HITS) return null;
    const rate = play.rate > 0 ? play.rate : 1;
    const average = errors.reduce((a, b) => a + b, 0) / errors.length / rate;
    return { average, offset: clampBeatmapOffset(play.offset + average), hits: errors.length };
}

/** Whether calibrating would change anything (lazer disables the button then). */
export function canCalibrate(current: number, suggestion: OffsetSuggestion | null): boolean {
    return !!suggestion && Math.abs(current - suggestion.offset) >= BEATMAP_OFFSET_PRECISION / 2;
}

/** "12.3 ms late" / "4.0 ms early" / "on time". */
export function describeAverage(average: number): string {
    const v = Math.abs(average);
    if (v < 0.05) return 'right on time';
    return `${v.toFixed(1)} ms ${average > 0 ? 'late' : 'early'}`;
}

/** "+3.5 ms" / "0 ms" / "-2.0 ms". */
export function formatBeatmapOffset(v: number): string {
    if (Math.abs(v) < 0.05) return '0 ms';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)} ms`;
}

/** Song-time offset applied to the track: the global audio offset plus the beatmap's at this rate. */
export function trackOffset(globalOffset: number, beatmapOffset: number, rate: number): number {
    return globalOffset + beatmapOffset * (rate > 0 ? rate : 1);
}

/**
 * Hit errors binned for the small timing distribution graph (lazer's
 * HitEventTimingDistributionGraph): `bins` buckets across ±range ms,
 * normalised so the tallest is 1.
 */
export function errorHistogram(errors: readonly number[], range: number, bins: number): number[] {
    const out = new Array<number>(bins).fill(0);
    if (!errors.length || range <= 0 || bins <= 0) return out;
    for (const e of errors) {
        if (!Number.isFinite(e)) continue;
        const t = (e + range) / (2 * range);
        const i = Math.min(bins - 1, Math.max(0, Math.floor(t * bins)));
        out[i]++;
    }
    const max = Math.max(...out);
    return max > 0 ? out.map(v => v / max) : out;
}
