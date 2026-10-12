import { difficultyRange } from '../../core/math';

/**
 * Which client's gameplay mechanics to reproduce. Scoring is ScoreV1 in
 * both; they differ in note lock (hit policy), slider tracking and tail
 * leniency, spinner requirements and health.
 *
 *  - `lazer`: osu!lazer's defaults (no mods): StartTimeOrderedHitPolicy,
 *    SliderInputManager tracking with the tail judged at the true end
 *    (36 ms leniency), Spinner.SpinsRequired, OsuHealthProcessor.
 *  - `stable`: osu!stable as lazer's OsuModClassic and legacy code paths
 *    reproduce it: LegacyHitPolicy (classic note lock), the legacy last
 *    tick, stable's half-spin spinner counting, OsuLegacyHealthProcessor.
 */
export type GameplayMechanics = 'lazer' | 'stable';

export const GAMEPLAY_MECHANICS: readonly GameplayMechanics[] = ['lazer', 'stable'];

/** wosu! is modelled on lazer, so its mechanics are the default. */
export const DEFAULT_MECHANICS: GameplayMechanics = 'lazer';

/** osu!'s fixed miss window: early clicks within it miss (lazer OsuHitWindows.MISS_WINDOW). */
export const MISS_WINDOW = 400;

/** lazer SliderEventGenerator.TAIL_LENIENCY (ms before the true end the tail may be hit). */
export const TAIL_LENIENCY = 36;

/** lazer Spinner.bonus_spins_gap: spins between clearing and the first bonus spin. */
export const BONUS_SPINS_GAP = 2;

/**
 * lazer Spinner.ApplyDefaultsToSelf: spins needed to clear (90/150/225 RPM
 * at OD 0/5/10, as whole spins) and the bonus spins available (up to
 * 250/380/430 RPM, after a gap of two spins).
 */
export function lazerSpinnerSpins(od: number, durationMs: number): { spinsRequired: number; maxBonusSpins: number } {
    const minRps = difficultyRange(od, 90, 150, 225) / 60;
    const maxRps = difficultyRange(od, 250, 380, 430) / 60;
    const seconds = durationMs / 1000;
    // Allow a 0.1 ms floating point error in the duration (as lazer does).
    const durationError = 0.0001;
    const spinsRequired = Math.trunc(minRps * seconds + durationError);
    const maxBonusSpins = Math.max(0, Math.trunc(maxRps * seconds + durationError) - spinsRequired - BONUS_SPINS_GAP);
    return { spinsRequired, maxBonusSpins };
}

/**
 * osu!stable's spinner requirement, counted in half spins:
 * (int)(seconds × DifficultyRange(OD, 3, 5, 7.5)). That's 1.5/2.5/3.75 full
 * spins per second (90/150/225 RPM), which is where lazer's clear RPM range
 * comes from (see lazer's OsuLegacyScoreSimulator).
 */
export function stableSpinnerHalfSpins(od: number, durationMs: number): number {
    return Math.trunc((durationMs / 1000) * difficultyRange(od, 3, 5, 7.5));
}

/**
 * Stable's per-half-spin scoring (OsuLegacyScoreSimulator): after reaching
 * `halfSpins` half rotations, is that half spin a bonus spin, a normal
 * spin (every full rotation after the first half), or nothing?
 */
export function stableHalfSpinAward(halfSpins: number, halfSpinsRequired: number): 'bonus' | 'spin' | null {
    const beforeBonus = halfSpinsRequired + 3;
    if (halfSpins > beforeBonus && (halfSpins - beforeBonus) % 2 === 0) return 'bonus';
    if (halfSpins > 1 && halfSpins % 2 === 0) return 'spin';
    return null;
}
