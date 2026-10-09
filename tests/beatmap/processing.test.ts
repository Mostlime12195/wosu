import { describe, expect, it } from 'vitest';
import { buildControlPointTimeline } from '../../src/beatmap/controlPoints';
import { parseOsu } from '../../src/beatmap/parser';
import {
    buildPlayableBeatmap,
    computeCombos,
    DEFAULT_COMBO_COLORS,
    difficultyAttributes,
    generateSliderEvents,
} from '../../src/beatmap/processing';
import type { PlayableSlider, TimingPoint } from '../../src/beatmap/types';
import { NO_MODS, sanitizeMods } from '../../src/gameplay/mods';
import { MAP_BASIC, makeMap } from './helpers';

function tp(time: number, beatLength: number, extra: Partial<TimingPoint> = {}): TimingPoint {
    return {
        time, beatLength, meter: 4, sampleSet: 0, sampleIndex: 0, volume: 100,
        uninherited: beatLength > 0, kiai: false, omitFirstBarLine: false, ...extra,
    };
}

describe('control points', () => {
    it('merges red and green lines into effective state', () => {
        const tl = buildControlPointTimeline([
            tp(0, 500),
            tp(1000, -50, { sampleSet: 2, volume: 40, kiai: true }),
            tp(2000, 400),
        ], 1);
        expect(tl.at(-100)).toMatchObject({ beatLength: 500, sliderVelocity: 1, sampleSet: 1 });
        expect(tl.at(1500)).toMatchObject({ beatLength: 500, sliderVelocity: 2, sampleSet: 2, volume: 40, kiai: true });
        // a red line resets slider velocity
        expect(tl.at(2000)).toMatchObject({ beatLength: 400, sliderVelocity: 1 });
    });

    it('applies a green line on the same tick after the red line', () => {
        const tl = buildControlPointTimeline([tp(1000, -25), tp(1000, 300)], 2);
        expect(tl.at(1000)).toMatchObject({ beatLength: 300, sliderVelocity: 4, sampleSet: 2 });
        expect(tl.points).toHaveLength(1);
    });

    it('clamps slider velocity and defaults to 120 BPM without points', () => {
        expect(buildControlPointTimeline([tp(0, 500), tp(10, -1)], 1).at(20).sliderVelocity).toBe(10);
        expect(buildControlPointTimeline([tp(0, 500), tp(10, -5000)], 1).at(20).sliderVelocity).toBe(0.1);
        const empty = buildControlPointTimeline([], 0);
        expect(empty.at(12345)).toMatchObject({ beatLength: 500, sliderVelocity: 1, sampleSet: 1 });
    });
});

describe('difficulty attributes', () => {
    it('matches the osu! formulas', () => {
        const d = difficultyAttributes({ cs: 4, ar: 9, od: 8, hp: 5 });
        expect(d.circleRadius).toBeCloseTo(54.4 - 4.48 * 4);
        expect(d.preempt).toBeCloseTo(600);
        expect(d.fadeIn).toBeCloseTo(400);
        expect(d.window300).toBeCloseTo(32);
        expect(d.window100).toBeCloseTo(76);
        expect(d.window50).toBeCloseTo(120);
        expect(difficultyAttributes({ cs: 5, ar: 0, od: 0, hp: 0 }).preempt).toBeCloseTo(1800);
        expect(difficultyAttributes({ cs: 5, ar: 5, od: 0, hp: 0 }).stackOffset).toBeCloseTo(-3.2);
    });
});

describe('slider events', () => {
    it('places ticks, repeats and the legacy tail', () => {
        // 1 beat = 500ms, SV 1, SM 1 => 100px/beat; tick rate 1 => tick every 100px
        const ev = generateSliderEvents(1000, 1500, 0.2, 100, 300, 2);
        expect(ev.map(e => e.kind)).toEqual(['head', 'tick', 'tick', 'repeat', 'tick', 'tick', 'tail']);
        expect(ev.map(e => Math.round(e.time))).toEqual([1000, 1500, 2000, 2500, 3000, 3500, 3964]);
        // reversed span ticks mirror the first span's positions
        expect(ev[4].pathProgress).toBeCloseTo(2 / 3);
        expect(ev[5].pathProgress).toBeCloseTo(1 / 3);
        expect(ev[6].pathProgress).toBe(0);
    });

    it('skips ticks too close to the span end and keeps the half-duration tail floor', () => {
        // length 100, tick every 100 => no ticks; short slider tail at half duration
        const ev = generateSliderEvents(0, 50, 2, 100, 100, 1);
        expect(ev.map(e => e.kind)).toEqual(['head', 'tail']);
        expect(ev[1].time).toBe(25);
    });

    it('format < 8 ignores slider velocity for tick spacing', () => {
        const objects = ['0,0,1000,2,0,L|400:0,1,400'];
        const timing = ['0,500,4,1,0,100,1,0', '0,-50,4,1,0,100,0,0']; // SV 2
        const v14 = buildPlayableBeatmap(parseOsu(makeMap({ objects, timing, version: 14 })), NO_MODS).hitObjects[0] as PlayableSlider;
        const v7 = buildPlayableBeatmap(parseOsu(makeMap({ objects, timing, version: 7 })), NO_MODS).hitObjects[0] as PlayableSlider;
        expect(v14.tickDistance).toBeCloseTo(200);
        expect(v7.tickDistance).toBeCloseTo(100);
        expect(v14.events.filter(e => e.kind === 'tick')).toHaveLength(1);
        expect(v7.events.filter(e => e.kind === 'tick')).toHaveLength(3);
        // duration still uses SV in both
        expect(v14.duration).toBeCloseTo(1000);
        expect(v7.duration).toBeCloseTo(1000);
    });
});

describe('buildPlayableBeatmap', () => {
    it('computes slider timing and nested events from the map', () => {
        const pb = buildPlayableBeatmap(parseOsu(MAP_BASIC), NO_MODS);
        const s = pb.hitObjects[1] as PlayableSlider;
        expect(s.kind).toBe('slider');
        expect(s.spanDuration).toBeCloseTo(500 * (100 / 1.4) / 100);
        expect(s.endTime).toBeCloseTo(2000 + s.duration);
        expect(s.endX).toBeCloseTo(250);
        expect(s.events[0].kind).toBe('head');
        expect(s.events[s.events.length - 1].kind).toBe('tail');
        expect(pb.startTime).toBe(1000);
        expect(pb.endTime).toBe(3500);
        expect(pb.hitObjects[2]).toMatchObject({ kind: 'spinner', x: 256, y: 192, duration: 500 });
    });

    it('does not mutate the decoded data', () => {
        const data = parseOsu(MAP_BASIC);
        const before = JSON.stringify(data);
        buildPlayableBeatmap(data, sanitizeMods(['HR']));
        buildPlayableBeatmap(data, NO_MODS);
        expect(JSON.stringify(data)).toBe(before);
    });

    it('Hard Rock flips vertically and adjusts difficulty', () => {
        const data = parseOsu(MAP_BASIC);
        const hr = buildPlayableBeatmap(data, sanitizeMods(['HR']));
        expect(hr.hitObjects[0].y).toBeCloseTo(384 - 100);
        const s = hr.hitObjects[1] as PlayableSlider;
        expect(s.y).toBeCloseTo(234);
        expect(s.path.pointAt(1).y).toBeCloseTo(234);
        expect(hr.difficulty.cs).toBeCloseTo(5.2);
        expect(hr.difficulty.ar).toBeCloseTo(9.8);
        const ez = buildPlayableBeatmap(data, sanitizeMods(['EZ']));
        expect(ez.difficulty.od).toBeCloseTo(3);
    });

    it('stacks coinciding circles up-left', () => {
        const objects = ['100,100,1000,1,0', '100,100,1200,1,0', '100,100,1400,1,0'];
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects })), NO_MODS);
        expect(pb.hitObjects.map(h => h.stackHeight)).toEqual([2, 1, 0]);
        const off = pb.difficulty.stackOffset;
        expect(pb.hitObjects[0].x).toBeCloseTo(100 + 2 * off);
        expect(pb.hitObjects[2].x).toBe(100);
    });

    it('stacks circles under a slider end down-right', () => {
        const objects = [
            '0,100,1000,2,0,L|100:100,1,100',
            '100,100,1600,1,0',
            '100,100,1800,1,0',
        ];
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects })), NO_MODS);
        expect(pb.hitObjects[0].stackHeight).toBe(0);
        expect(pb.hitObjects[1].stackHeight).toBe(-1);
        expect(pb.hitObjects[2].stackHeight).toBe(-2);
        expect(pb.hitObjects[2].x).toBeGreaterThan(100);
    });

    it('old format maps use the old stacking algorithm', () => {
        const objects = ['100,100,1000,1,0', '100,100,1200,1,0'];
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects, version: 5 })), NO_MODS);
        expect(pb.hitObjects.map(h => h.stackHeight)).toEqual([1, 0]);
    });

    it('applies stack offsets to slider paths and events', () => {
        const objects = ['200,200,1000,2,0,L|300:200,1,100', '200,200,1100,1,0'];
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects })), NO_MODS);
        const s = pb.hitObjects[0] as PlayableSlider;
        expect(s.stackHeight).toBe(1);
        const off = pb.difficulty.stackOffset;
        expect(s.x).toBeCloseTo(200 + off);
        expect(s.path.pointAt(0).x).toBeCloseTo(200 + off);
        expect(s.events[0].x).toBeCloseTo(200 + off);
        expect(s.endY).toBeCloseTo(200 + off);
    });

    it('numbers combos, honours combo skips and spinner rules', () => {
        const objects = [
            '0,0,1000,5,0',      // first: new combo
            '0,0,1100,1,0',
            '0,0,1200,37,0',     // NC + skip 2
            '0,0,1300,12,0,1400', // spinner with NC
            '0,0,1500,1,0',      // forced new combo after spinner
        ];
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects })), NO_MODS);
        expect(pb.hitObjects.map(h => h.comboNumber)).toEqual([1, 2, 1, 2, 1]);
        expect(pb.hitObjects.map(h => h.comboColorIndex)).toEqual([1, 1, 4, 4, 5]);
        expect(pb.hitObjects.map(h => h.lastInCombo)).toEqual([false, true, false, true, true]);
        const combos = computeCombos(parseOsu(makeMap({ objects: ['0,0,1,1,0', '0,0,2,1,0'] })).hitObjects);
        expect(combos[0].newCombo).toBe(true);
        expect(combos[1].newCombo).toBe(false);
    });

    it('falls back to the default combo colours', () => {
        const pb = buildPlayableBeatmap(parseOsu(makeMap({ objects: ['0,0,1,1,0'] })), NO_MODS);
        expect(pb.comboColors).toEqual(DEFAULT_COMBO_COLORS);
        expect(buildPlayableBeatmap(parseOsu(MAP_BASIC), NO_MODS).comboColors).toEqual([(96 << 16) | (159 << 8) | 159]);
    });

    it('handles maps without objects or timing points', () => {
        const empty = parseOsu(makeMap({ objects: [], timing: [] }));
        const pb = buildPlayableBeatmap(empty, NO_MODS);
        expect(pb.hitObjects).toEqual([]);
        expect(pb.startTime).toBe(0);
        expect(pb.endTime).toBe(0);
        const noTiming = buildPlayableBeatmap(parseOsu(makeMap({ objects: ['0,0,1000,2,0,L|100:0,1,100'], timing: [] })), NO_MODS);
        const s = noTiming.hitObjects[0] as PlayableSlider;
        expect(Number.isFinite(s.duration)).toBe(true);
        expect(s.control.beatLength).toBe(500);
    });
});
