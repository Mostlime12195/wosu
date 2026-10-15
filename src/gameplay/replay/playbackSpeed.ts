/**
 * lazer's ReplayPlayer playback speed (PlaybackSettings): the viewer's
 * speed multiplies the mods' rate on the track's tempo (pitch is kept), so
 * a DT replay at 0.5x plays at 0.75x of the song. Only the clock's rate
 * changes: the replay's events are still applied in their recorded order
 * at their recorded times, so judgement is identical at any speed.
 */

export const REPLAY_SPEED_MIN = 0.25;
export const REPLAY_SPEED_MAX = 2;
export const REPLAY_SPEED_STEP = 0.05;
export const REPLAY_SPEED_DEFAULT = 1;

/** A speed the slider can hold: within range and on its step. */
export function clampReplaySpeed(speed: number): number {
    if (!Number.isFinite(speed)) return REPLAY_SPEED_DEFAULT;
    const s = Math.min(REPLAY_SPEED_MAX, Math.max(REPLAY_SPEED_MIN, speed));
    return Number((Math.round(s / REPLAY_SPEED_STEP) * REPLAY_SPEED_STEP).toFixed(6));
}

/** The track's rate for a replay: the mods' rate times the viewer's speed. */
export function replayTrackRate(modRate: number, speed: number): number {
    const base = modRate > 0 && Number.isFinite(modRate) ? modRate : 1;
    return base * clampReplaySpeed(speed);
}

/** lazer shows the speed as "1.00x". */
export function formatReplaySpeed(speed: number): string {
    return `${clampReplaySpeed(speed).toFixed(2)}x`;
}

/** Where `time` sits between `start` and `end` (0–1). */
export function seekFraction(time: number, start: number, end: number): number {
    if (!(end > start)) return 0;
    return Math.min(1, Math.max(0, (time - start) / (end - start)));
}

/** The song time at `fraction` of the way from `start` to `end`. */
export function seekTimeAt(fraction: number, start: number, end: number): number {
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    return start + (end - start) * f;
}
