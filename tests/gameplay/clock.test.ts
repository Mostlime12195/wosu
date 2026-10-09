import { describe, expect, it } from 'vitest';
import type { MusicTrack } from '../../src/audio/MusicTrack';
import { GameplayClock } from '../../src/gameplay/GameplayClock';

/** A track whose clock the test advances by hand. */
function fakeTrack(durationMs = 10000) {
    const t = {
        time: 0,
        playing: false,
        playbackRate: 1,
        volume: 0,
        get isPlaying() { return this.playing; },
        get currentTime() { return this.time; },
        stop() { this.playing = false; this.time = 0; },
        seek(ms: number) {
            if (ms >= durationMs) return false;
            this.time = ms;
            return true;
        },
        play() { this.playing = true; },
        pause() { this.playing = false; return true; },
    };
    return t;
}

describe('GameplayClock', () => {
    it('starts from a negative lead-in and follows the track', () => {
        const track = fakeTrack();
        const clock = new GameplayClock(track as unknown as MusicTrack, -1500);
        expect(clock.now).toBe(-1500);
        clock.start();
        expect(track.time).toBe(-1500);
        expect(track.volume).toBe(1);
        track.time = -1000;
        expect(clock.tick(16)).toBe(-1000);
    });

    it('never runs backwards on small audio clock jitter', () => {
        const track = fakeTrack();
        const clock = new GameplayClock(track as unknown as MusicTrack, 0);
        clock.start();
        track.time = 500;
        clock.tick(16);
        track.time = 490;
        expect(clock.tick(16)).toBe(500);
        track.time = 300; // a real jump back (seek) is followed
        expect(clock.tick(16)).toBe(300);
    });

    it('freezes while paused and resumes the track', () => {
        const track = fakeTrack();
        const clock = new GameplayClock(track as unknown as MusicTrack, 0);
        clock.start();
        track.time = 1000;
        clock.tick(16);
        clock.pause();
        expect(track.playing).toBe(false);
        expect(clock.tick(100)).toBe(1000);
        clock.resume();
        expect(track.playing).toBe(true);
    });

    it('keeps time flowing on the wall clock after the song ends', () => {
        const track = fakeTrack();
        const clock = new GameplayClock(track as unknown as MusicTrack, 0);
        clock.start();
        track.time = 9990;
        clock.tick(16);
        track.playing = false; // natural end
        expect(clock.tick(100)).toBeCloseTo(10090);
        expect(clock.tick(100)).toBeCloseTo(10190);
    });

    it('stops advancing once frozen (fail)', () => {
        const track = fakeTrack();
        const clock = new GameplayClock(track as unknown as MusicTrack, 0);
        clock.start();
        track.time = 2000;
        clock.tick(16);
        clock.freeze();
        track.time = 2500;
        expect(clock.tick(16)).toBe(2000);
    });
});
