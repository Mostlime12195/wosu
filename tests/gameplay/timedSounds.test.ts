import { describe, expect, it } from 'vitest';
import { nestedSoundTime } from '../../src/gameplay/HitsoundPlayer';
import { inWindow, lookaheadMs, LOOKAHEAD_MAX_MS, LOOKAHEAD_MIN_MS, startTimeFor, TimedSounds } from '../../src/gameplay/TimedSounds';
import type { PlayableSlider, SliderEvent } from '../../src/beatmap/types';

/** Music started at context time 10 s from song time 0, rate `rate`. */
function timeline(rate = 1) {
    const t = { id: 1, playing: true, contextTimeAt: (ms: number) => (t.playing ? 10 + ms / 1000 / rate : Number.NaN), get timelineId() { return t.id; } };
    return t;
}

function recorder() {
    const log: { when: number; cancelled: boolean }[] = [];
    const start = (when: number) => {
        const e = { when, cancelled: false };
        log.push(e);
        return { cancel: () => { e.cancelled = true; } };
    };
    return { log, start };
}

describe('look-ahead window', () => {
    it('covers two frames, within bounds', () => {
        expect(lookaheadMs(16.7)).toBeCloseTo(33.4, 6);
        expect(lookaheadMs(4)).toBe(LOOKAHEAD_MIN_MS);
        expect(lookaheadMs(500)).toBe(LOOKAHEAD_MAX_MS);
        expect(lookaheadMs(Number.NaN)).toBe(LOOKAHEAD_MIN_MS);
    });

    it('starts at the due time while it is ahead, else at once', () => {
        expect(startTimeFor(10.5, 10.4)).toBe(10.5);
        expect(startTimeFor(10.3, 10.4)).toBe(0);
        expect(startTimeFor(Number.NaN, 10.4)).toBe(0);
        expect(inWindow(10.43, 10.4, 10.44)).toBe(true);
        expect(inWindow(10.45, 10.4, 10.44)).toBe(false);
        expect(inWindow(10.39, 10.4, 10.44)).toBe(false); // already due: judgement's call
        expect(inWindow(Number.NaN, 10.4, 10.44)).toBe(false);
    });
});

describe('TimedSounds', () => {
    it('schedules a sound once, exactly when the music reaches it', () => {
        const tl = timeline();
        let now = 10.4;
        const sounds = new TimedSounds(tl, () => now);
        const { log, start } = recorder();
        sounds.sync();
        // song 450 ms -> context 10.45 s: outside a 10.44 s horizon, inside 10.46 s
        expect(sounds.schedule('a', 450, 10.44, start)).toBe(false);
        expect(sounds.schedule('a', 450, 10.46, start)).toBe(true);
        expect(sounds.schedule('a', 450, 10.46, start)).toBe(true);
        expect(log).toEqual([{ when: 10.45, cancelled: false }]);
        // at 1.5x the same song time comes sooner
        const fast = new TimedSounds(timeline(1.5), () => now);
        fast.play('b', 750, start);
        expect(log[1].when).toBeCloseTo(10.5, 9);
        now = 11;
    });

    it('keeps a predicted sound on a hit and calls it off on a miss', () => {
        const sounds = new TimedSounds(timeline(), () => 10.4);
        const { log, start } = recorder();
        sounds.schedule('hit', 420, 10.5, start);
        sounds.schedule('miss', 430, 10.5, start);
        expect(sounds.settle('hit', true)).toBe(true);
        expect(sounds.settle('miss', false)).toBe(true);
        expect(log.map(e => e.cancelled)).toEqual([false, true]);
        // never scheduled: the caller plays it itself
        expect(sounds.settle('other', true)).toBe(false);
        // a long-past event (a replay seek) is never scheduled
        expect(sounds.schedule('past', 100, 10.5, start)).toBe(false);
    });

    it('plays a late sound at once and a lazer tail (judged early) at its moment', () => {
        const sounds = new TimedSounds(timeline(), () => 10.4);
        const { log, start } = recorder();
        sounds.play('late', 380, start);
        sounds.play('tail', 436, start);
        expect(log.map(e => e.when)).toEqual([0, 10.436]);
    });

    it('calls off what has not started when the timeline changes (pause, seek), keeping what was heard', () => {
        const tl = timeline();
        let now = 10.4;
        const sounds = new TimedSounds(tl, () => now);
        const { log, start } = recorder();
        sounds.sync();
        sounds.play('heard', 390, start);
        sounds.schedule('pending', 430, 10.5, start);
        tl.id++; // paused
        sounds.sync();
        expect(log.map(e => e.cancelled)).toEqual([false, true]);
        expect(sounds.has('heard')).toBe(true);
        expect(sounds.has('pending')).toBe(false); // re-scheduled after resume
        // stopAll (fail, exit)
        sounds.schedule('again', 430, 10.5, start);
        sounds.cancelPending();
        expect(log[2].cancelled).toBe(true);
        // old entries are forgotten
        now = 13;
        sounds.sync();
        expect(sounds.size).toBe(0);
    });

    it('does nothing while the music is not playing', () => {
        const tl = timeline();
        tl.playing = false;
        const sounds = new TimedSounds(tl, () => 10.4);
        const { log, start } = recorder();
        expect(sounds.schedule('x', 420, 10.5, start)).toBe(false);
        sounds.play('y', 420, start); // judged while stopped: at once
        expect(log).toEqual([{ when: 0, cancelled: false }]);
    });
});

describe('nestedSoundTime', () => {
    it('puts the tail sound at the true end and others at their time', () => {
        const h = { endTime: 4000 } as PlayableSlider;
        const ev = (kind: SliderEvent['kind'], time: number) => ({ kind, time, spanIndex: 0, pathProgress: 0, x: 0, y: 0 });
        expect(nestedSoundTime(h, ev('tail', 3964))).toBe(4000);
        expect(nestedSoundTime(h, ev('tick', 2500))).toBe(2500);
        expect(nestedSoundTime(h, ev('repeat', 3000))).toBe(3000);
    });
});
