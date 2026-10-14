import { describe, expect, it } from 'vitest';
import { legacyFrames } from '../../src/gameplay/replay/osr';
import { decodeReplay, encodeReplay, PRESS_BITS, SMOKE_BIT, type ReplayEvent } from '../../src/gameplay/replay/Replay';
import { ReplayPlayback } from '../../src/gameplay/replay/ReplayPlayback';
import { RulesDriver } from '../../src/gameplay/RulesDriver';
import type { CursorState, GameplayRules } from '../../src/gameplay/GameplayRules';
import { SmokeSegment, SmokeTrail, statelessSingle, type SmokeQuad } from '../../src/gameplay/SmokeSegment';

/** A fixed angle source, so point angles are predictable. */
const fixed = () => 0.25;

function quads(seg: { draw(now: number, out: (q: SmokeQuad) => void): void }, now: number): SmokeQuad[] {
    const out: SmokeQuad[] = [];
    seg.draw(now, q => out.push({ ...q }));
    return out;
}

describe('SmokeSegment', () => {
    it('lays points one interval (7/8 of the half width) apart along the path', () => {
        const s = new SmokeSegment(0, 8, 8, fixed);
        expect(s.pointInterval).toBe(7);
        // The first position always lays a point.
        s.addPosition(0, 0, 0);
        expect(s.points.map(p => p.x)).toEqual([0]);
        // 20 units on: points at 7 and 14, 6 units carried over.
        s.addPosition(20, 0, 10);
        expect(s.points.map(p => p.x)).toEqual([0, 7, 14]);
        s.addPosition(21, 0, 20);
        expect(s.points.map(p => p.x)).toEqual([0, 7, 14, 21]);
        expect(s.points.every(p => p.angle === 0.25 * 2 * Math.PI)).toBe(true);
    });

    it('never adds points older than the newest one (a rewound clock)', () => {
        const s = new SmokeSegment(0, 8, 8, fixed);
        s.addPosition(0, 0, 100);
        s.addPosition(50, 0, 50);
        expect(s.points).toHaveLength(1);
    });

    it('fades a point from 0.6 to 0 over 4 s while the key is held', () => {
        const s = new SmokeSegment(0, 8, 8, fixed);
        s.addPosition(0, 0, 0);
        expect(quads(s, 0)[0].alpha).toBe(1);
        expect(quads(s, 1000)[0].alpha).toBeCloseTo(0.45);
        expect(quads(s, 3000)[0].alpha).toBeCloseTo(0.15);
        expect(quads(s, 4000)).toHaveLength(0);
    });

    it('grows from 0.65 to 1 over 1.2 s', () => {
        const s = new SmokeSegment(0, 8, 8, fixed);
        s.addPosition(0, 0, 0);
        expect(quads(s, 0)[0].scale).toBeCloseTo(0.65);
        expect(quads(s, 1200)[0].scale).toBeCloseTo(1);
    });

    it('flashes back in on release, then fades out within its lifetime', () => {
        const s = new SmokeSegment(0, 8, 8, fixed);
        s.addPosition(0, 0, 0);
        s.addPosition(70, 0, 1000);
        s.finish(1000);
        // 1 s held: lifetime = end + 8000 + 1000/3 + 1000/2.
        expect(s.lifetimeEnd).toBeCloseTo(1000 + 8000 + 1000 / 3 + 500);
        const atRelease = quads(s, 1000);
        expect(atRelease[0].alpha).toBeCloseTo(0.45);
        // The re-fade-in reaches full opacity (oldest point first) shortly after.
        const later = quads(s, 1000 + 400);
        expect(later[0].alpha).toBeCloseTo(1, 1);
        expect(quads(s, s.lifetimeEnd)).toHaveLength(0);
        expect(quads(s, s.lifetimeEnd - 2000).length).toBeGreaterThan(0);
    });
});

describe('SmokeTrail', () => {
    it('starts a segment per press and drops it once faded', () => {
        const t = new SmokeTrail(8, 8, fixed);
        expect(t.setDrawing(true, 0)).toBe(true);
        expect(t.setDrawing(true, 5)).toBe(false);
        t.addPosition(0, 0, 0);
        t.setDrawing(false, 100);
        t.setDrawing(true, 200);
        t.addPosition(10, 10, 200);
        t.setDrawing(false, 300);
        expect(t.segments).toHaveLength(2);
        quads(t, 100000);
        expect(t.segments).toHaveLength(0);
    });

    it('gives each point a stable extra turn', () => {
        expect(statelessSingle(7, 3)).toBe(statelessSingle(7, 3));
        const v = statelessSingle(7, 3);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
    });
});

describe('smoke in replays', () => {
    const events: ReplayEvent[] = [
        { kind: 'frame', time: 0, x: 10, y: 10, buttons: 0 },
        { kind: 'frame', time: 10, x: 20, y: 10, buttons: SMOKE_BIT },
        { kind: 'frame', time: 20, x: 30, y: 10, buttons: SMOKE_BIT | 1 },
        { kind: 'frame', time: 30, x: 40, y: 10, buttons: 1 },
    ];

    it('round-trips the smoke bit', () => {
        expect(decodeReplay(encodeReplay(events))).toEqual(events);
    });

    it('plays the smoke key back without pressing anything', () => {
        const p = new ReplayPlayback(events);
        p.advance(10, () => {});
        expect(p.smoke).toBe(true);
        expect(p.down.K1).toBe(false);
        p.advance(30, () => {});
        expect(p.smoke).toBe(false);
        expect(p.down.K1).toBe(true);
    });

    it('never judges smoke as a held button', () => {
        const steps: CursorState[] = [];
        const rules = { update: (_t: number, c: CursorState) => steps.push(c) } as unknown as GameplayRules;
        const d = new RulesDriver(rules, 'normal');
        d.apply(events[1]);
        expect(steps.at(-1)!.held).toBe(false);
        d.apply(events[2]);
        expect(steps.at(-1)!.held).toBe(true);
        expect(PRESS_BITS & SMOKE_BIT).toBe(0);
    });

    it('exports smoke as osu!\'s ReplayButtonState.Smoke', () => {
        expect(legacyFrames(events)).toBe('0|256|-500|0,-1|256|-500|0,1|10|10|0,10|20|10|16,10|30|10|21,10|40|10|5,-12345|0|0|0,');
    });
});
