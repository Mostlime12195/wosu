import type { MusicTrack } from '../audio/MusicTrack';

/**
 * Song-time clock for a play (lazer's GameplayClockContainer, minus the
 * framework). Time comes straight from the audio track, so judgement and
 * visuals can never drift from the music; a negative start time becomes a
 * lead-in of silence before the song.
 *
 * `frameTime` is sampled once per frame for visuals; input handlers read
 * `now` at event time so presses are judged at the moment they happened.
 */
export class GameplayClock {
    private _frameTime: number;
    private _paused = true;
    private started = false;
    private stopped = false;

    constructor(private readonly track: MusicTrack, readonly startTime: number) {
        this._frameTime = startTime;
    }

    get frameTime(): number {
        return this._frameTime;
    }

    get paused(): boolean {
        return this._paused;
    }

    get rate(): number {
        return this.track.playbackRate;
    }

    /** Current song time (ms), read live from the audio clock. */
    get now(): number {
        if (!this.started) return this.startTime;
        return this.track.currentTime;
    }

    /** Begin playback from `startTime` (lead-in when negative). */
    start(): void {
        this.started = true;
        this._paused = false;
        this.track.stop();
        this.track.volume = 1;
        this.track.seek(this.startTime);
        this.track.play();
        this._frameTime = this.now;
    }

    /**
     * Sample the clock for this frame; time never runs backwards while
     * playing. If the audio ends before the map does (or never started),
     * time keeps flowing on the wall clock so the play can still finish.
     */
    tick(dt: number): number {
        if (this.started && !this._paused && !this.stopped) {
            if (this.track.isPlaying) {
                const t = this.track.currentTime;
                if (t > this._frameTime || this._frameTime - t > 50) this._frameTime = t;
            } else {
                this._frameTime += dt * this.rate;
            }
        }
        return this._frameTime;
    }

    pause(): void {
        if (this._paused || this.stopped) return;
        this._paused = true;
        this.track.pause();
        this._frameTime = this.track.currentTime;
    }

    resume(): void {
        if (!this._paused || this.stopped) return;
        this._paused = false;
        this.track.play();
    }

    /** Jump forward (skip intro / outro). */
    seek(time: number): void {
        if (this.stopped) return;
        if (!this.track.seek(time)) return;
        this._frameTime = time;
        if (!this._paused && !this.track.isPlaying) this.track.play();
    }

    /** Stop advancing (fail / end); the music itself is left to the caller. */
    freeze(): void {
        this.stopped = true;
    }
}
