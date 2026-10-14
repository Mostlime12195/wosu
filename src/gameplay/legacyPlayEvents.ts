import type { BreakPeriod } from '../beatmap/types';

/**
 * Timing of osu!stable's play-screen events that lazer doesn't have: the
 * countdown before the first object, the section pass / fail at a break's
 * midpoint and the warning arrows before a break ends. Pure functions of
 * song time, so seeking (skip) and pausing need no bookkeeping.
 */

export type CountdownElement = 'ready' | 'count3' | 'count2' | 'count1' | 'go';

export interface CountdownStep {
    element: CountdownElement;
    /** Song time the element appears and its sound plays. */
    time: number;
    /** Sample names to try in order (the first the skin has plays). */
    samples: readonly string[];
}

export interface CountdownSchedule {
    /** ms per countdown beat (the map's beat, halved or doubled by the countdown speed). */
    beat: number;
    steps: readonly CountdownStep[];
    /** When "ready" appears: the countdown's first moment. */
    start: number;
    /** When "go" has faded out. */
    end: number;
}

/** In beats before the first object (stable: ready, a beat of rest, 3, 2, 1, go). */
const STEP_BEATS: readonly [CountdownElement, number, readonly string[]][] = [
    ['ready', 6, ['readys']],
    // count.wav stands in for the numbered voices when a skin wants one sound.
    ['count3', 4, ['count3s', 'count']],
    ['count2', 3, ['count2s', 'count']],
    ['count1', 2, ['count1s', 'count']],
    ['go', 1, ['gos']],
];

/**
 * The beatmap's countdown (General: Countdown, CountdownOffset), or null
 * when it has none. One count per beat of the timing point in effect at
 * the first object: half speed counts every two beats, double speed every
 * half beat; CountdownOffset starts it that many (countdown) beats earlier.
 */
export function countdownSchedule(firstObjectTime: number, beatLength: number, countdown: number, offset = 0): CountdownSchedule | null {
    if (!(countdown >= 1 && countdown <= 3)) return null;
    let beat = Number.isFinite(beatLength) && beatLength > 0 ? beatLength : 500;
    if (countdown === 2) beat *= 2;
    else if (countdown === 3) beat /= 2;
    const shift = Math.max(0, Math.trunc(offset) || 0);
    const steps = STEP_BEATS.map(([element, beats, samples]) => ({ element, time: firstObjectTime - (beats + shift) * beat, samples }));
    const go = steps[steps.length - 1].time;
    return { beat, steps, start: steps[0].time, end: go + 2 * beat };
}

export interface CountdownFrame {
    element: CountdownElement;
    alpha: number;
}

/**
 * What the countdown shows at `time`. `stacked` is skin.ini Version 1's
 * layout (3 on the left, 2 on the right, 1 in the middle, all staying up
 * until "go"); newer skins show one centred element at a time.
 */
export function countdownFrame(s: CountdownSchedule, time: number, stacked: boolean): CountdownFrame[] {
    if (time < s.start || time >= s.end) return [];
    const b = s.beat;
    const at = (e: CountdownElement) => s.steps.find(x => x.element === e)!.time;
    const ready = at('ready'), c3 = at('count3'), c2 = at('count2'), c1 = at('count1'), go = at('go');
    const out: CountdownFrame[] = [];
    // "ready" fades in over a quarter beat and out over the quarter beat before it goes.
    const readyEnd = stacked ? c2 : c3;
    if (time < readyEnd) {
        const fade = Math.min(b / 4, (readyEnd - ready) / 2);
        out.push({ element: 'ready', alpha: Math.min(1, (time - ready) / fade, (readyEnd - time) / fade) });
    }
    const counts: [CountdownElement, number, number][] = stacked
        ? [['count3', c3, go], ['count2', c2, go], ['count1', c1, go]]
        : [['count3', c3, c2], ['count2', c2, c1], ['count1', c1, go]];
    for (const [element, from, to] of counts) {
        if (time >= from && time < to) out.push({ element, alpha: 1 });
    }
    // "go" stays up for its beat, then fades over the next.
    if (time >= go) out.push({ element: 'go', alpha: time < go + b ? 1 : Math.max(0, 1 - (time - go - b) / b) });
    return out;
}

/** Breaks at least this long show the section pass / fail (stable: "a long enough break"). */
export const SECTION_MIN_BREAK = 8000;
/** How long the section pass / fail stays up (flashes included) before fading. */
const SECTION_SHOW = 1000;
const SECTION_FADE = 200;
/** On/off flashes as it appears (ms from the start: visible while inside a span). */
const SECTION_FLASHES: readonly [number, number][] = [[0, 100], [160, 260], [320, SECTION_SHOW + SECTION_FADE]];

/** When a break's section pass / fail shows (its midpoint), or null for a short break. */
export function sectionTime(b: BreakPeriod): number | null {
    return b.endTime - b.startTime >= SECTION_MIN_BREAK ? (b.startTime + b.endTime) / 2 : null;
}

/** Pass with at least half health (stable: "about 50%"). */
export function sectionPassed(hp: number): boolean {
    return hp >= 0.5;
}

/** The section image's alpha `t` ms after it appears: three flashes, a hold, a fade. */
export function sectionAlpha(t: number): number {
    if (t < 0 || t >= SECTION_SHOW + SECTION_FADE) return 0;
    if (!SECTION_FLASHES.some(([a, z]) => t >= a && t < z)) return 0;
    return t < SECTION_SHOW ? 1 : 1 - (t - SECTION_SHOW) / SECTION_FADE;
}

/** Breaks shorter than this show nothing (stable's 650 ms threshold, as BreakOverlay). */
export const MIN_BREAK = 650;
/** The warning arrows flash on twice, for these spans before a break ends (ms before its end). */
const ARROW_FLASHES: readonly [number, number][] = [[2000, 1500], [1000, 500]];

/** The break-end warning arrows show at `time`: two 500 ms flashes in the last two seconds of a break. */
export function warningArrowsShown(breaks: readonly BreakPeriod[], time: number): boolean {
    for (const b of breaks) {
        if (b.endTime - b.startTime < MIN_BREAK || time < b.startTime || time >= b.endTime) continue;
        const left = b.endTime - time;
        if (ARROW_FLASHES.some(([from, to]) => left <= from && left > to)) return true;
    }
    return false;
}

/**
 * Events crossed going from `prev` to `now` (exclusive, inclusive). Only
 * forward steps up to a second count (a slow frame still fires late): a
 * rewind or a long seek fires nothing, and the player resets `prev` on a
 * skip, so skipping past the countdown doesn't burst all its sounds at once.
 */
export function crossed(eventTime: number, prev: number, now: number, maxStep = 1000): boolean {
    return now > prev && now - prev <= maxStep && eventTime > prev && eventTime <= now;
}
