import { difficultyRange } from '../../core/math';

/**
 * Which client's gameplay mechanics to reproduce. Scoring is ScoreV1 in
 * both; they differ in note lock (hit policy), slider tracking and tail
 * leniency, spinner requirements and health.
 *
 *  - `lazer`: osu!lazer's defaults (no mods): StartTimeOrderedHitPolicy,
 *    SliderInputManager tracking with the tail judged at the true end
 *    (36 ms leniency), non-classic slider judgement (the head is judged
 *    like a hit circle and is the slider's accuracy judgement; ticks,
 *    repeats and the tail count toward lazer's accuracy), whole-spin
 *    spinner counting, OsuHealthProcessor, lazer's accuracy-based ranks.
 *  - `stable`: osu!stable as lazer's OsuModClassic and legacy code paths
 *    reproduce it: LegacyHitPolicy (classic note lock), the legacy last
 *    tick, the slider judged as a whole by the parts hit, stable's
 *    half-spin spinner counting, OsuLegacyHealthProcessor, stable's ranks.
 * Both use the same spinner speed requirement (spinnerClearRpm) and cap.
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
 * The spin speed (RPM) wosu! requires to clear a spinner, in both
 * mechanics: DifficultyRange(OD, 108, 180, 270), i.e. 1.8 / 3 / 4.5 full
 * spins per second at OD 0 / 5 / 10.
 *
 * Players found lazer's own requirement (90/150/225 RPM, the
 * DifficultyRange(OD, 3, 5, 7.5) half spins per second stable and lazer
 * share) far too easy, while wosu!'s original rule, full spins at
 * DifficultyRange(OD, 3, 5, 7.5) × 0.7 per second (126/210/315 RPM), was
 * on the hard side. This sits halfway between the two at every OD:
 * (90 + 126) / 2 = 108, (150 + 210) / 2 = 180, (225 + 315) / 2 = 270, which
 * is DifficultyRange(OD, 3, 5, 7.5) × 0.6 full spins per second. Each
 * mechanics setting still counts spins its own way (lazer: whole spins of
 * net rotation; stable: half spins of absolute rotation), both under
 * MAX_SPIN_RPM.
 */
export function spinnerClearRpm(od: number): number {
    return difficultyRange(od, 108, 180, 270);
}

/**
 * stable's spin speed cap (lazer's SpinnerSpmCalculator / stable's
 * maxAccel, 0.05 rad/ms ≈ 477 RPM), applied in both mechanics: lazer has
 * none, so a high-polling mouse could otherwise finish a spinner at once.
 */
export const MAX_SPIN_RAD_PER_MS = 0.05;
export const MAX_SPIN_RPM = (MAX_SPIN_RAD_PER_MS * 60000) / (Math.PI * 2);

/**
 * lazer Spinner.ApplyDefaultsToSelf: spins needed to clear at `clearRpm`
 * (lazer's own 90/150/225 RPM at OD 0/5/10 by default; wosu! plays with
 * spinnerClearRpm), as whole spins, and the bonus spins available (up to
 * 250/380/430 RPM, after a gap of two spins).
 */
export function lazerSpinnerSpins(
    od: number,
    durationMs: number,
    clearRpm = difficultyRange(od, 90, 150, 225),
): { spinsRequired: number; maxBonusSpins: number } {
    const minRps = clearRpm / 60;
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
 * (int)(seconds × DifficultyRange(OD, 3, 5, 7.5)), i.e. 1.5/2.5/3.75 full
 * spins per second (90/150/225 RPM, where lazer's clear RPM range comes
 * from, see lazer's OsuLegacyScoreSimulator). `clearRpm` replaces that
 * speed (wosu! plays with spinnerClearRpm): half spins = seconds × RPM / 30.
 */
export function stableSpinnerHalfSpins(od: number, durationMs: number, clearRpm = difficultyRange(od, 90, 150, 225)): number {
    return Math.trunc((durationMs / 1000) * (clearRpm / 30));
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
