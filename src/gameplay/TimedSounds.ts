/**
 * Look-ahead scheduling for sounds that belong to the music rather than
 * to the player's input: slider ticks, repeats and ends, Nightcore's beat
 * and storyboard samples.
 *
 * Judgement only notices such an event in the first frame past it, which
 * used to start its sound up to a frame late (and lazer's tail leniency
 * judged slider ends 36 ms early). Instead, a sound whose moment is due
 * within the next frame or two is started with AudioBufferSourceNode
 * .start(when) at the exact context time the music reaches it, so it
 * lands sample-accurately on the music and ignores the user's offsets
 * just like the music does. Sounds are keyed so judgement can keep (hit)
 * or call off (miss) a prediction, and everything not yet heard is
 * called off when the music's timeline changes (pause, seek, rate) or
 * the play stops (HitsoundPlayer.stopAll).
 */

/** The music's timeline (MusicTrack). */
export interface SoundTimeline {
    /** Audio-context time (s) at which the music reaches song time `ms` (NaN: not playing). */
    contextTimeAt(ms: number): number;
    /** Changes whenever that mapping does. */
    readonly timelineId: number;
}

/** Something started at a context time that can still be called off. */
export interface CancellableSound {
    cancel(): void;
}

/** Look-ahead bounds (ms of real time beyond the audio clock). */
export const LOOKAHEAD_MIN_MS = 30;
export const LOOKAHEAD_MAX_MS = 120;
/** Sounds already started are remembered this long for judgement to find (s). */
const KEEP_S = 2;

/**
 * How far ahead to schedule this frame: two frames (the next frame may
 * come late), at least LOOKAHEAD_MIN_MS. Longer means more mispredictions
 * (a slider let go just before a tick still ticks), shorter risks a frame
 * arriving after the sound's moment.
 */
export function lookaheadMs(frameMs: number): number {
    const f = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0;
    return Math.min(LOOKAHEAD_MAX_MS, Math.max(LOOKAHEAD_MIN_MS, 2 * f));
}

/**
 * Whether a sound due at context time `due` should be scheduled now: still
 * ahead, and before the window end `horizon`. One already due is left to
 * judgement, which plays it at once (or not at all while a replay seek
 * catches up).
 */
export function inWindow(due: number, now: number, horizon: number): boolean {
    return Number.isFinite(due) && due > now && due <= horizon;
}

/** The start time to pass to start(): `due` if it is still ahead, else 0 (at once). */
export function startTimeFor(due: number, now: number): number {
    return Number.isFinite(due) && due > now ? due : 0;
}

interface Entry {
    /** Context time it starts (0: at once, when scheduled). */
    at: number;
    sound: CancellableSound | null;
}

export class TimedSounds {
    private readonly entries = new Map<string, Entry>();
    private timeline = Number.NaN;

    constructor(
        private readonly clock: SoundTimeline,
        /** The audio context's current time (s). */
        private readonly now: () => number,
    ) {}

    /** Context time (s) the music reaches song time `ms`. */
    contextTimeAt(ms: number): number {
        return this.clock.contextTimeAt(ms);
    }

    /**
     * Call once a frame before scheduling: a new music timeline calls off
     * everything not yet started, and old entries are forgotten.
     */
    sync(): void {
        const id = this.clock.timelineId;
        if (id !== this.timeline) {
            this.timeline = id;
            this.cancelPending();
        }
        const now = this.now();
        for (const [key, e] of this.entries) if (e.at + KEEP_S < now) this.entries.delete(key);
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    /**
     * Start the sound for song time `ms` under `key` (once per key): at the
     * music's moment if that is still ahead, else at once. `start` gets
     * the context time to start at (0 = now).
     */
    play(key: string, ms: number, start: (when: number) => CancellableSound | null): void {
        if (this.entries.has(key)) return;
        const now = this.now();
        const at = startTimeFor(this.clock.contextTimeAt(ms), now);
        this.entries.set(key, { at: at || now, sound: start(at) });
    }

    /**
     * Schedule the sound for song time `ms` if it is due before `horizon`
     * (context seconds); returns whether it was (or already is) scheduled.
     */
    schedule(key: string, ms: number, horizon: number, start: (when: number) => CancellableSound | null): boolean {
        if (this.entries.has(key)) return true;
        if (!inWindow(this.clock.contextTimeAt(ms), this.now(), horizon)) return false;
        this.play(key, ms, start);
        return true;
    }

    /**
     * The event behind `key` was judged. A scheduled sound stays on a hit
     * and is called off on a miss; returns whether one was scheduled.
     */
    settle(key: string, hit: boolean): boolean {
        const e = this.entries.get(key);
        if (!e) return false;
        if (!hit) {
            e.sound?.cancel();
            e.sound = null;
        }
        return true;
    }

    /** Call off everything not yet started and forget it (pause, seek, fail, exit). */
    cancelPending(): void {
        const now = this.now();
        for (const [key, e] of this.entries) {
            if (e.at > now) {
                e.sound?.cancel();
                this.entries.delete(key);
            }
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
