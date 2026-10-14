import { describe, expect, it } from 'vitest';
import {
    countdownFrame, countdownSchedule, crossed, sectionAlpha, sectionPassed, sectionTime, warningArrowsShown,
} from '../../src/gameplay/legacyPlayEvents';

describe('countdown schedule', () => {
    it('has none when the map turns it off', () => {
        expect(countdownSchedule(5000, 500, 0)).toBeNull();
        expect(countdownSchedule(5000, 500, 4)).toBeNull();
    });

    it('counts ready, 3, 2, 1, go on the beats before the first object', () => {
        const s = countdownSchedule(10000, 500, 1)!;
        expect(s.beat).toBe(500);
        expect(s.steps.map(x => [x.element, x.time])).toEqual([
            ['ready', 7000], ['count3', 8000], ['count2', 8500], ['count1', 9000], ['go', 9500],
        ]);
        expect(s.start).toBe(7000);
        expect(s.end).toBe(10500);
        expect(s.steps[0].samples).toEqual(['readys']);
        expect(s.steps[1].samples).toEqual(['count3s', 'count']);
        expect(s.steps[4].samples).toEqual(['gos']);
    });

    it('halves or doubles the speed and shifts by CountdownOffset beats', () => {
        expect(countdownSchedule(10000, 500, 2)!.steps.map(x => x.time)).toEqual([4000, 6000, 7000, 8000, 9000]);
        expect(countdownSchedule(10000, 500, 3)!.steps.map(x => x.time)).toEqual([8500, 9000, 9250, 9500, 9750]);
        expect(countdownSchedule(10000, 500, 1, 2)!.steps.map(x => x.time)).toEqual([6000, 7000, 7500, 8000, 8500]);
    });

    it('falls back to 120 BPM for a broken beat length', () => {
        expect(countdownSchedule(10000, NaN, 1)!.beat).toBe(500);
        expect(countdownSchedule(10000, 0, 1)!.beat).toBe(500);
    });
});

describe('countdown frames', () => {
    const s = countdownSchedule(10000, 500, 1)!;
    const shown = (t: number, stacked = false) => countdownFrame(s, t, stacked).filter(f => f.alpha > 0).map(f => f.element);

    it('shows one element at a time for new skins', () => {
        expect(shown(6999)).toEqual([]);
        expect(shown(7300)).toEqual(['ready']);
        expect(shown(8100)).toEqual(['count3']);
        expect(shown(8600)).toEqual(['count2']);
        expect(shown(9100)).toEqual(['count1']);
        expect(shown(9600)).toEqual(['go']);
        expect(shown(10600)).toEqual([]);
    });

    it('stacks 3, 2 and 1 until go for Version 1 skins', () => {
        expect(shown(8100, true)).toEqual(['ready', 'count3']);
        expect(shown(9100, true)).toEqual(['count3', 'count2', 'count1']);
        expect(shown(9600, true)).toEqual(['go']);
    });

    it('fades ready in and go out', () => {
        const ready = (t: number) => countdownFrame(s, t, false).find(f => f.element === 'ready')!.alpha;
        expect(ready(7000)).toBe(0);
        expect(ready(7062.5)).toBeCloseTo(0.5);
        expect(ready(7500)).toBe(1);
        const go = (t: number) => countdownFrame(s, t, false).find(f => f.element === 'go')!.alpha;
        expect(go(9900)).toBe(1);
        expect(go(10250)).toBeCloseTo(0.5);
    });
});

describe('section pass / fail', () => {
    it('shows at the midpoint of long breaks only', () => {
        expect(sectionTime({ startTime: 1000, endTime: 11000 })).toBe(6000);
        expect(sectionTime({ startTime: 1000, endTime: 8000 })).toBeNull();
    });

    it('passes with at least half health', () => {
        expect(sectionPassed(0.5)).toBe(true);
        expect(sectionPassed(0.8)).toBe(true);
        expect(sectionPassed(0.49)).toBe(false);
    });

    it('flashes, holds, then fades', () => {
        expect(sectionAlpha(-1)).toBe(0);
        expect(sectionAlpha(50)).toBe(1);
        expect(sectionAlpha(130)).toBe(0);
        expect(sectionAlpha(200)).toBe(1);
        expect(sectionAlpha(290)).toBe(0);
        expect(sectionAlpha(600)).toBe(1);
        expect(sectionAlpha(1100)).toBeCloseTo(0.5);
        expect(sectionAlpha(1200)).toBe(0);
    });
});

describe('warning arrows', () => {
    const breaks = [{ startTime: 10000, endTime: 20000 }, { startTime: 30000, endTime: 30500 }];

    it('flash twice in the last two seconds of a break', () => {
        const at = (t: number) => warningArrowsShown(breaks, t);
        expect(at(17900)).toBe(false);
        expect(at(18000)).toBe(true);
        expect(at(18400)).toBe(true);
        expect(at(18600)).toBe(false);
        expect(at(19100)).toBe(true);
        expect(at(19600)).toBe(false);
        expect(at(20000)).toBe(false);
    });

    it('skip breaks too short to show', () => {
        expect(warningArrowsShown(breaks, 30000)).toBe(false);
    });
});

describe('crossed', () => {
    it('fires on small forward steps over the event only', () => {
        expect(crossed(1000, 990, 1005)).toBe(true);
        expect(crossed(1000, 1000, 1010)).toBe(false);
        expect(crossed(1000, 1005, 990)).toBe(false);
        // A seek (skip) across the event stays silent.
        expect(crossed(1000, 0, 5000)).toBe(false);
        // A slow frame still fires.
        expect(crossed(1000, 400, 1200)).toBe(true);
    });
});
