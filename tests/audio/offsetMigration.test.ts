import { describe, expect, it } from 'vitest';
import { AUDIO_CLOCK_VERSION, migrateAudioOffset, migrateAudioOffsetSetting, OLD_DECODER_LAG_MS } from '../../src/audio/offsetMigration';
import { decoderDelayFromOnset, findOnset } from '../../src/audio/decoderDelay';

describe('audio offset migration', () => {
    it('keeps the effective timing: old offset + output latency + the old decoder lag', () => {
        expect(OLD_DECODER_LAG_MS).toBe(19);
        // the reported -50..-70 ms land near 0 on a ~30-50 ms output
        expect(migrateAudioOffset(-50, 29.3)).toBe(-2);
        expect(migrateAudioOffset(-70, 50)).toBe(-1);
        expect(migrateAudioOffset(20, 10)).toBe(49);
        expect(migrateAudioOffset(0, 40)).toBe(0);
        expect(migrateAudioOffset(-300, Number.NaN)).toBe(-281);
        expect(migrateAudioOffset(290, 40)).toBe(300);
    });

    it('runs once per settings', () => {
        const s = { audioOffset: { value: -60 }, audioClockVersion: { value: 0 } };
        expect(migrateAudioOffsetSetting(s, 25)).toEqual({ from: -60, to: -16 });
        expect(s.audioClockVersion.value).toBe(AUDIO_CLOCK_VERSION);
        expect(migrateAudioOffsetSetting(s, 25)).toBeNull();
        expect(s.audioOffset.value).toBe(-16);
        const fresh = { audioOffset: { value: 0 }, audioClockVersion: { value: 0 } };
        expect(migrateAudioOffsetSetting(fresh, 25)).toBeNull();
        expect(fresh.audioClockVersion.value).toBe(AUDIO_CLOCK_VERSION);
    });
});

describe('MP3 decoder delay probe', () => {
    it('finds the click onset', () => {
        const d = new Float32Array(100);
        d[40] = 0.1;
        d[41] = 0.9;
        expect(findOnset(d)).toBe(41);
        expect(findOnset(new Float32Array(10))).toBe(-1);
    });

    it('turns the measured onset into a decoder delay (Chrome measures 3311 at 44.1 kHz)', () => {
        expect(decoderDelayFromOnset(3311, 44100)).toBe(529);
        // resampled to a 48 kHz context: 3604
        expect(decoderDelayFromOnset(3604, 48000)).toBe(529);
        // a decoder that drops its delay (Safari-like)
        expect(decoderDelayFromOnset(2206 + 576 + 3, 44100)).toBe(0);
        expect(decoderDelayFromOnset(2206 + 576 + 300, 44100)).toBe(300);
        expect(decoderDelayFromOnset(-1, 44100)).toBe(529);
        expect(decoderDelayFromOnset(100, 44100)).toBe(529);
    });
});
