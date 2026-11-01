/**
 * One-time migration of the global audio offset across the 2026-11 audio
 * sync fix.
 *
 * Before it, the gameplay clock was the position coming out of the
 * speakers (output latency subtracted) and ran a further ~17-22 ms late
 * from an empirical MP3/Ogg start-offset table, so a press that sounded on
 * the beat was judged early by the output latency plus that, and players
 * set -50..-70 ms to compensate. The clock is now the rendered position
 * with osu!'s decoder trim (MusicTrack, mp3Info), so 0 ms is right for
 * most setups. A non-zero offset is moved by exactly the change on the
 * player's current device so their timing feels the same; 0 stays 0.
 */

/** The clock model the offset setting is relative to now. */
export const AUDIO_CLOCK_VERSION = 1;
/**
 * How late the old start-offset table put the clock (measured in Chrome:
 * 16.8 ms for LAME MP3s at 44.1 kHz, 21 ms at 48 kHz, 22 ms untagged, 19 ms
 * Ogg); a typical value, as maps differ.
 */
export const OLD_DECODER_LAG_MS = 19;

/** The new offset (same sign: positive delays judgement) that keeps an old one's timing. */
export function migrateAudioOffset(old: number, outputLatencyMs: number, min = -300, max = 300): number {
    if (!Number.isFinite(old) || old === 0) return 0;
    const latency = Number.isFinite(outputLatencyMs) && outputLatencyMs > 0 ? outputLatencyMs : 0;
    return Math.min(max, Math.max(min, Math.round(old + latency + OLD_DECODER_LAG_MS)));
}

interface OffsetSettings {
    readonly audioOffset: { value: number };
    readonly audioClockVersion: { value: number };
}

/**
 * Migrate `settings` once (call with the audio context running, so the
 * output latency is known). Returns the change when the offset moved.
 */
export function migrateAudioOffsetSetting(settings: OffsetSettings, outputLatencyMs: number): { from: number; to: number } | null {
    if (settings.audioClockVersion.value >= AUDIO_CLOCK_VERSION) return null;
    settings.audioClockVersion.value = AUDIO_CLOCK_VERSION;
    const from = settings.audioOffset.value;
    const to = migrateAudioOffset(from, outputLatencyMs);
    if (to === from) return null;
    settings.audioOffset.value = to;
    return { from, to };
}
