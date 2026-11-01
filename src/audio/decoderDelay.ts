/**
 * How many samples this browser's MP3 decoder puts in front of a stream
 * without a Xing/LAME tag (mp3Info.ts strips that tag so every browser
 * decodes the same way). Measured once per context by decoding a tiny
 * embedded MP3 with a click at a known sample: Chrome and Firefox (FFmpeg
 * and ffvpx) keep the full 529-sample decoder delay; Apple's decoder is
 * reported to remove it. Falls back to 529 when the probe can't decode.
 */
import { analyzeAudio, MP3_DECODER_DELAY } from './mp3Info';

/**
 * 120 ms of mono 44.1 kHz silence with a 2 kHz click starting at sample
 * 2205, encoded by LAME at 64 kbps (encoder delay 576, LAME tag present).
 */
const PROBE_MP3 =
    '//tQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAGAAAFtQAqKioqKioqKioqKioqKioqVVVVVVVVVVVVVVVVVVVVVVWAgICA' +
    'gICAgICAgICAgICAqqqqqqqqqqqqqqqqqqqqqqrV1dXV1dXV1dXV1dXV1dXV1f////////////////////8AAAA5TEFNRTQuMCAA' +
    'AaUAAAAALCgAABRAJAQUQgAAQAAABbV24yZuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/7UMQAA8AAAaQAAAAgAAA0' +
    'gAAABNlhxCjpsG+G9rTBygpeapBb0DmcnBoG4H+4GgYW/eXDR0BZIgqMsRX7WaOaQ4okVKX7NtOl04dMTn/+ZiQLgn/xIFwTQf/+' +
    'ZNGzJr//pBuSJF4EGhYHw6gENzHC4EDFiqOBmJYYpAEAlIyP8EIoMvC/DyI/ykXx+MT3/l5MumVH/9AuqWYoJ//62WjMTFR3//9F' +
    'lrooqOhL/7VwVFbf//S1TEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVX/+1LEXYPAAAGkAAAAIAAANIKAAARVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UsS7gAm4u1wY2YABTCHnwydAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVV//tSxKGDwAABpBwAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+1LEoYPA' +
    'AAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7UsShg8AAAaQAAAAgAAA0gAAABFVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
/** Where the click crosses the onset threshold in the source (sample 2205 + 1). */
const PROBE_ONSET = 2206;
const PROBE_RATE = 44100;
const PROBE_ENCODER_DELAY = 576;
/** Measurements this close to a known decoder (529 or 0) snap to it. */
const SNAP = 64;

/** First sample above a quarter of the peak (the click's onset), or -1. */
export function findOnset(data: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (!(peak > 0)) return -1;
    for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 0.25 * peak) return i;
    return -1;
}

/**
 * Decoder delay in samples from the probe's measured onset (in samples at
 * `rate`, the context's rate the decoder resampled to); snaps to 529 / 0.
 */
export function decoderDelayFromOnset(onset: number, rate: number): number {
    if (!(onset >= 0) || !(rate > 0)) return MP3_DECODER_DELAY;
    const delay = (onset / rate) * PROBE_RATE - PROBE_ONSET - PROBE_ENCODER_DELAY;
    if (Math.abs(delay - MP3_DECODER_DELAY) <= SNAP) return MP3_DECODER_DELAY;
    if (Math.abs(delay) <= SNAP) return 0;
    return delay > 0 && delay < 2304 ? Math.round(delay) : MP3_DECODER_DELAY;
}

const measured = new WeakMap<BaseAudioContext, Promise<number>>();

function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
        try {
            const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
            if (p && typeof p.then === 'function') p.then(resolve, reject);
        } catch (e) {
            reject(e);
        }
    });
}

/** This browser's MP3 decoder delay (samples), measured once per context. */
export function measureMp3DecoderDelay(ctx: BaseAudioContext): Promise<number> {
    let p = measured.get(ctx);
    if (!p) {
        p = (async () => {
            try {
                if (typeof atob !== 'function') return MP3_DECODER_DELAY;
                const bin = atob(PROBE_MP3);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const buf = await decode(ctx, analyzeAudio('probe.mp3', bytes.buffer).buffer);
                return decoderDelayFromOnset(findOnset(buf.getChannelData(0)), buf.sampleRate);
            } catch {
                return MP3_DECODER_DELAY;
            }
        })();
        measured.set(ctx, p);
    }
    return p;
}
