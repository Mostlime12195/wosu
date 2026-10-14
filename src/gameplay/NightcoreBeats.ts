import type { TimingPoint } from '../beatmap/types';

/**
 * The Nightcore mod's beat (lazer's ModNightcore.NightcoreBeatContainer,
 * itself osu!stable's NightcoreBeat): a kick, clap and hi-hat pattern on
 * the beatmap's timing, with a cymbal ("finish") every four bars.
 *
 * Beats are half-beats of the red line in effect (BeatSyncedContainer with
 * Divisor 2, doubled while shorter than 50 ms), counted from that line
 * (one fewer when it omits its first bar line); nothing plays before a
 * line's first beat. In 4/4, kicks fall on beats 1 and 3, claps on 2 and
 * 4, hats on the offbeats; in 3/4, a kick on 1, a clap on the second
 * half of 2, hats elsewhere. Hats only play when the slider tick rate is
 * a multiple of 2 (other tick rates imply no regular offbeat). The finish
 * plays at the start of every 4-bar segment, except a line's very first
 * beat when it omits its first bar line. Other meters only get the finish.
 */
export type NightcoreSample = 'nightcore-kick' | 'nightcore-clap' | 'nightcore-hat' | 'nightcore-finish';

/** BeatSyncedContainer.MinimumBeatLength. */
const MIN_BEAT_LENGTH = 50;
/** lazer's bars_per_segment. */
const BARS_PER_SEGMENT = 4;
/** Half-beats (Divisor). */
const DIVISOR = 2;

export interface NightcoreBeat {
    /** Index of the red line in effect (among the uninherited points). */
    line: number;
    /** Half-beat index from that line (negative before it). */
    index: number;
    /** ms since that half-beat. */
    since: number;
}

/** The red lines (uninherited, positive beat length) in time order. */
export function redLines(points: readonly TimingPoint[]): TimingPoint[] {
    return points.filter(p => p.uninherited && p.beatLength > 0).sort((a, b) => a.time - b.time);
}

/** The half-beat at `time` (lazer's BeatSyncedContainer.Update), or null without red lines. */
export function nightcoreBeatAt(lines: readonly TimingPoint[], time: number): NightcoreBeat | null {
    if (!lines.length) return null;
    // TimingPointAt: the last line at or before `time`, else the first.
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    const tp = lines[lo];
    let beatLength = tp.beatLength / DIVISOR;
    while (beatLength < MIN_BEAT_LENGTH) beatLength *= 2;
    let index = Math.trunc((time - tp.time) / beatLength) - (tp.omitFirstBarLine ? 1 : 0);
    if (time < tp.time) index--;
    let until = (tp.time - time) % beatLength;
    if (until <= 0) until += beatLength;
    return { line: lo, index, since: beatLength - until };
}

/** The samples for half-beat `index` of a line (lazer's playBeatFor); none before the line's first beat. */
export function nightcoreSamples(index: number, meter: number, omitFirstBarLine: boolean, playHats: boolean): NightcoreSample[] {
    if (index < 0) return [];
    const out: NightcoreSample[] = [];
    const segment = meter * DIVISOR * BARS_PER_SEGMENT;
    const inSegment = index % segment;
    if (inSegment === 0 && (index > 0 || !omitFirstBarLine)) out.push('nightcore-finish');
    const step = meter === 3 ? inSegment % 6 : meter === 4 ? inSegment % 4 : -1;
    if (step < 0) return out;
    if (step === 0) out.push('nightcore-kick');
    else if (step === (meter === 3 ? 3 : 2)) out.push('nightcore-clap');
    else if (playHats) out.push('nightcore-hat');
    return out;
}

/** stable / lazer: hats only for slider tick rates that are multiples of 2. */
export const nightcorePlaysHats = (tickRate: number): boolean => Math.abs(tickRate % 2) < 1e-6;

/**
 * lazer's BeatSyncedContainer.MISTIMED_ALLOWANCE (16 ms at lazer's
 * update rate): a beat this late stays silent. Here it's widened to the
 * frame that crossed it (a slow frame still plays its beat), up to
 * MAX_FRAME; a longer jump is a seek.
 */
const LATE_ALLOWANCE = 16;
const MAX_FRAME = 250;

/**
 * Plays the beat as song time advances: call `update` every frame while
 * the song runs (not while paused) and it fires each new half-beat once.
 */
export class NightcoreBeats {
    private readonly lines: TimingPoint[];
    private lastLine = -1;
    private lastIndex = Number.NaN;
    private lastTime = Number.NaN;

    constructor(points: readonly TimingPoint[], private readonly playHats: boolean, private readonly play: (sample: NightcoreSample) => void) {
        this.lines = redLines(points);
    }

    update(time: number): void {
        const frame = time - this.lastTime;
        this.lastTime = time;
        const beat = nightcoreBeatAt(this.lines, time);
        if (!beat || (beat.line === this.lastLine && beat.index === this.lastIndex)) return;
        this.lastLine = beat.line;
        this.lastIndex = beat.index;
        const allowance = frame >= 0 && frame <= MAX_FRAME ? Math.max(LATE_ALLOWANCE, frame) : LATE_ALLOWANCE;
        if (beat.since > allowance) return;
        const tp = this.lines[beat.line];
        for (const s of nightcoreSamples(beat.index, tp.meter, tp.omitFirstBarLine, this.playHats)) this.play(s);
    }

    /** Forget the last beat (after a seek or pause). */
    reset(): void {
        this.lastLine = -1;
        this.lastIndex = Number.NaN;
        this.lastTime = Number.NaN;
    }
}
