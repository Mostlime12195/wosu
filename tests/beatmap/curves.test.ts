import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../src/core/math';
import {
    approximateBezier,
    approximateCatmull,
    approximateCircularArc,
    circularArcProperties,
    createSliderPath,
    offsetSliderPath,
} from '../../src/beatmap/curves';
import type { CurveType, SliderPath } from '../../src/beatmap/types';

function polylineLength(pts: readonly Vec2[]): number {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return l;
}

function expectWellFormed(path: SliderPath): void {
    expect(path.points.length).toBeGreaterThanOrEqual(2);
    expect(path.points[0].t).toBe(0);
    expect(path.points[path.points.length - 1].t).toBe(1);
    for (let i = 0; i < path.points.length; i++) {
        const p = path.points[i];
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.t)).toBe(true);
        if (i > 0) expect(p.t).toBeGreaterThanOrEqual(path.points[i - 1].t);
    }
}

describe('approximators', () => {
    it('bezier keeps endpoints and stays near a straight line', () => {
        const pts = approximateBezier([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
        expect(pts[0]).toEqual({ x: 0, y: 0 });
        expect(pts[pts.length - 1]).toEqual({ x: 10, y: 0 });
    });

    it('bezier subdivides curved control polygons adaptively', () => {
        const pts = approximateBezier([{ x: 0, y: 0 }, { x: 100, y: 200 }, { x: 200, y: 0 }]);
        expect(pts.length).toBeGreaterThan(10);
        // apex of a quadratic is at t=0.5: (100, 100)
        const apex = pts.reduce((a, b) => (b.y > a.y ? b : a));
        expect(apex.y).toBeCloseTo(100, 0);
    });

    it('perfect circle traces the circumscribed circle', () => {
        const cp = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }];
        const pr = circularArcProperties(cp);
        expect(pr.valid).toBe(true);
        expect(pr.centre.x).toBeCloseTo(50);
        expect(pr.centre.y).toBeCloseTo(0);
        expect(pr.radius).toBeCloseTo(50);
        for (const p of approximateCircularArc(cp)) expect(Math.hypot(p.x - 50, p.y)).toBeCloseTo(50, 5);
    });

    it('collinear perfect circle is flagged invalid', () => {
        expect(circularArcProperties([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]).valid).toBe(false);
    });

    it('catmull passes through its control points', () => {
        const cp = [{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 0 }];
        const pts = approximateCatmull(cp);
        expect(pts.some(p => Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y - 30) < 1e-6)).toBe(true);
        expect(pts[pts.length - 1].x).toBeCloseTo(100);
    });
});

describe('createSliderPath', () => {
    it('linear path is truncated to the expected length', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 100, y: 0 }], 60);
        expectWellFormed(path);
        expect(path.length).toBeCloseTo(60);
        expect(path.pointAt(1)).toEqual({ x: 60, y: 0 });
        expect(path.pointAt(0.5).x).toBeCloseTo(30);
    });

    it('extends the last segment when the expected length is longer', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 50, y: 0 }, { x: 50, y: 50 }], 150);
        expect(path.length).toBeCloseTo(150);
        const end = path.pointAt(1);
        expect(end.x).toBeCloseTo(50);
        expect(end.y).toBeCloseTo(100);
    });

    it('does not extend when the last two points coincide (stable quirk)', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 50, y: 0 }, { x: 50, y: 0 }], 200);
        expect(path.length).toBeCloseTo(50);
        expectWellFormed(path);
    });

    it('zero pixel length means the natural length', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 30, y: 40 }], 0);
        expect(path.length).toBeCloseTo(50);
    });

    it('perfect curve arcs keep their length and fall back for collinear points', () => {
        const arc = createSliderPath({ x: 0, y: 0 }, 'P', [{ x: 50, y: 50 }, { x: 100, y: 0 }], 140);
        expectWellFormed(arc);
        expect(polylineLength(arc.points)).toBeCloseTo(140, 3);
        expect(arc.points.length).toBeGreaterThan(5);
        const line = createSliderPath({ x: 0, y: 0 }, 'P', [{ x: 50, y: 0 }, { x: 100, y: 0 }], 100);
        expectWellFormed(line);
        expect(line.pointAt(1).x).toBeCloseTo(100);
        expect(Math.abs(line.pointAt(0.5).y)).toBeLessThan(1e-9);
    });

    it('P with more than two control points becomes a bezier', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'P', [{ x: 50, y: 50 }, { x: 100, y: 0 }, { x: 150, y: 50 }], 180);
        expectWellFormed(path);
        expect(path.length).toBeCloseTo(180);
    });

    it('red anchors split bezier segments and keep the kink vertex exact', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'B', [{ x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 200);
        expectWellFormed(path);
        expect(path.points.some(p => p.x === 100 && p.y === 0)).toBe(true);
        expect(path.pointAt(0.5).x).toBeCloseTo(100);
        expect(path.pointAt(0.5).y).toBeCloseTo(0);
    });

    it('straight linear segments produce no extra vertices', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 100, y: 0 }, { x: 100, y: 100 }], 200);
        expect(path.points).toHaveLength(3);
    });

    it('catmull sliders are supported', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'C', [{ x: 50, y: 40 }, { x: 100, y: 0 }], 0);
        expectWellFormed(path);
        expect(path.pointAt(1).x).toBeCloseTo(100);
    });

    it('degenerate paths collapse to the head', () => {
        for (const cps of [[], [{ x: 10, y: 10 }]]) {
            const path = createSliderPath({ x: 10, y: 10 }, 'B', cps, 100);
            expect(path.points).toEqual([{ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 1 }]);
            expect(path.pointAt(0.5)).toEqual({ x: 10, y: 10 });
            expect(path.directionAt(0.5)).toEqual({ x: 1, y: 0 });
        }
    });

    it('directionAt returns unit tangents', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 100, y: 0 }, { x: 100, y: 100 }], 200);
        expect(path.directionAt(0.25)).toEqual({ x: 1, y: 0 });
        const d = path.directionAt(0.75);
        expect(d.x).toBeCloseTo(0);
        expect(d.y).toBeCloseTo(1);
    });

    it('offsetSliderPath translates every point and pointAt', () => {
        const path = createSliderPath({ x: 0, y: 0 }, 'L', [{ x: 100, y: 0 }], 100);
        const moved = offsetSliderPath(path, -3, -3);
        expect(moved.pointAt(0.5)).toEqual({ x: 47, y: -3 });
        expect(moved.length).toBe(path.length);
    });

    // Sharp/unnatural corners (ported from the old slider-shapes battery):
    // every shape must stay finite, keep its corners and match pixelLength.
    const SHAPES: [string, CurveType, Vec2[], number][] = [
        ['L-left', 'L', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 200],
        ['turn-135', 'L', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 30, y: 70 }], 190],
        ['hairpin', 'L', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 8 }, { x: 0, y: 8 }], 208],
        ['foldback', 'L', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }], 200],
        ['square-loop', 'L', [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }, { x: 0, y: 0 }], 320],
        ['micro-seg', 'L', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.5, y: 0 }, { x: 200, y: 0 }], 200],
        ['W-shape', 'L', [{ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 60, y: 0 }, { x: 90, y: 60 }, { x: 120, y: 0 }], 268],
        ['bez-cusp', 'B', [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 0, y: 0 }], 100],
        ['bez-S', 'B', [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 80 }, { x: 120, y: 80 }], 150],
    ];
    for (const [name, type, pts, length] of SHAPES) {
        it(`shape ${name} is well formed`, () => {
            const path = createSliderPath(pts[0], type, pts.slice(1), length);
            expectWellFormed(path);
            expect(path.length).toBeCloseTo(length, 3);
            expect(polylineLength(path.points)).toBeCloseTo(length, 3);
            if (type === 'L') {
                // interior corners within the length survive as vertices
                let acc = 0;
                for (let i = 1; i < pts.length - 1; i++) {
                    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
                    if (acc < length) expect(path.points.some(p => p.x === pts[i].x && p.y === pts[i].y)).toBe(true);
                }
            }
        });
    }
});
