/**
 * One-shot sounds that can be cut short. Most samples are fire-and-forget,
 * but a skin's failsound, applause or pause-loop can run for minutes (many
 * skins ship a whole song as their death or results music), so the screen
 * that started one stops it, with a short fade, when it is left.
 */
import { rampParam } from './base';

export interface SoundHandle {
    /** Fade out over `fadeMs` (0: at once) and stop. Idempotent. */
    stop(fadeMs?: number): void;
    /** False once it has ended or been stopped. */
    readonly playing: boolean;
}

/** The fade when a screen's long sound is cut off by leaving it (osu!stable fades its skin music out quickly). */
export const LEAVE_FADE_MS = 300;

/** A handle for a sound that never played. */
export const SILENT_SOUND: SoundHandle = { stop() { /* nothing playing */ }, playing: false };

/** Play `buffer` once at `volume` into `destination`; null if playback failed. */
export function playOneShot(
    ctx: BaseAudioContext, buffer: AudioBuffer, volume: number, destination: AudioNode, opts: { rate?: number } = {},
): SoundHandle | null {
    try {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        if (opts.rate && opts.rate !== 1) src.playbackRate.value = opts.rate;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        src.connect(gain);
        gain.connect(destination);
        let playing = true;
        src.onended = () => {
            playing = false;
            try { gain.disconnect(); } catch { /* ignore */ }
        };
        src.start();
        return {
            get playing() {
                return playing;
            },
            stop(fadeMs = 0) {
                if (!playing) return;
                playing = false;
                const now = ctx.currentTime;
                const fade = Math.max(0, fadeMs) / 1000;
                if (fade > 0) rampParam(gain.gain, 0, now, fade);
                try { src.stop(now + fade); } catch { /* ignore */ }
            },
        };
    } catch {
        return null;
    }
}
