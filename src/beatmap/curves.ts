/**
 * Slider path geometry: a port of osu-framework's PathApproximator plus
 * lazer's SliderPath length fitting.
 *
 * The output keeps the approximator's adaptive vertices (dense only where
 * the path bends) instead of resampling to a uniform grid: the slider
 * renderer emits one capsule per segment, so fewer, exact vertices mean
 * less geometry and kinks that land precisely on a vertex.
 */
import type { Vec2 } from '../core/math';
import type { CurveType, PathPoint, SliderPath } from './types';

const BEZIER_TOLERANCE = 0.25;
const CATMULL_DETAIL = 50;
const CIRCULAR_ARC_TOLERANCE = 0.1;
/** osu-framework Precision.FLOAT_EPSILON, used for degenerate-triangle checks. */
const FLOAT_EPSILON = 1e-3;

// ---------------------------------------------------------------------------
// Approximators (each returns a polyline through the curve)
// ---------------------------------------------------------------------------

export function approximateLinear(points: readonly Vec2[]): Vec2[] {
    return points.map(p => ({ x: p.x, y: p.y }));
}

/** Adaptive Bézier subdivision (de Casteljau) until each piece is flat. */
export function approximateBezier(points: readonly Vec2[]): Vec2[] {
    const n = points.length;
    if (n < 2) return n === 0 ? [] : [{ x: points[0].x, y: points[0].y }];
    const output: Vec2[] = [];
    const count = n;
    const toFlatten: Vec2[][] = [points.map(p => ({ x: p.x, y: p.y }))];
    const freeBuffers: Vec2[][] = [];
    const buf1 = newBuffer(count);
    const buf2 = newBuffer(count * 2 - 1);
    const mid = newBuffer(count);
    const left = buf2;

    // An explicit stack emulates recursion without risking overflow on
    // pathological control polygons.
    let guard = 0;
    while (toFlatten.length > 0) {
        const parent = toFlatten.pop()!;
        if (bezierIsFlatEnough(parent) || ++guard > 100000) {
            bezierApproximate(parent, output, buf1, buf2, mid, count);
            freeBuffers.push(parent);
            continue;
        }
        const right = freeBuffers.pop() ?? newBuffer(count);
        bezierSubdivide(parent, left, right, mid, count);
        // Reuse the parent's buffer for the left child.
        for (let i = 0; i < count; i++) {
            parent[i].x = left[i].x;
            parent[i].y = left[i].y;
        }
        toFlatten.push(right);
        toFlatten.push(parent);
    }
    output.push({ x: points[n - 1].x, y: points[n - 1].y });
    return output;
}

function newBuffer(n: number): Vec2[] {
    const b: Vec2[] = new Array(n);
    for (let i = 0; i < n; i++) b[i] = { x: 0, y: 0 };
    return b;
}

function bezierIsFlatEnough(cp: Vec2[]): boolean {
    const limit = BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4;
    for (let i = 1; i < cp.length - 1; i++) {
        const dx = cp[i - 1].x - 2 * cp[i].x + cp[i + 1].x;
        const dy = cp[i - 1].y - 2 * cp[i].y + cp[i + 1].y;
        if (dx * dx + dy * dy > limit) return false;
    }
    return true;
}

function bezierSubdivide(cp: Vec2[], l: Vec2[], r: Vec2[], mid: Vec2[], count: number): void {
    for (let i = 0; i < count; i++) {
        mid[i].x = cp[i].x;
        mid[i].y = cp[i].y;
    }
    for (let i = 0; i < count; i++) {
        l[i].x = mid[0].x;
        l[i].y = mid[0].y;
        r[count - i - 1].x = mid[count - i - 1].x;
        r[count - i - 1].y = mid[count - i - 1].y;
        for (let j = 0; j < count - i - 1; j++) {
            mid[j].x = (mid[j].x + mid[j + 1].x) / 2;
            mid[j].y = (mid[j].y + mid[j + 1].y) / 2;
        }
    }
}

function bezierApproximate(cp: Vec2[], output: Vec2[], buf1: Vec2[], buf2: Vec2[], mid: Vec2[], count: number): void {
    const l = buf2;
    const r = buf1;
    bezierSubdivide(cp, l, r, mid, count);
    for (let i = 0; i < count - 1; i++) {
        l[count + i].x = r[i + 1].x;
        l[count + i].y = r[i + 1].y;
    }
    output.push({ x: cp[0].x, y: cp[0].y });
    for (let i = 1; i < count - 1; i++) {
        const k = 2 * i;
        output.push({
            x: 0.25 * (l[k - 1].x + 2 * l[k].x + l[k + 1].x),
            y: 0.25 * (l[k - 1].y + 2 * l[k].y + l[k + 1].y),
        });
    }
}

/** Centripetal-free (uniform) Catmull-Rom, matching osu! stable. */
export function approximateCatmull(points: readonly Vec2[]): Vec2[] {
    const out: Vec2[] = [];
    const n = points.length;
    if (n === 0) return out;
    if (n === 1) return [{ x: points[0].x, y: points[0].y }];
    for (let i = 0; i < n - 1; i++) {
        const v1 = i > 0 ? points[i - 1] : points[i];
        const v2 = points[i];
        const v3 = i < n - 1 ? points[i + 1] : { x: 2 * v2.x - v1.x, y: 2 * v2.y - v1.y };
        const v4 = i < n - 2 ? points[i + 2] : { x: 2 * v3.x - v2.x, y: 2 * v3.y - v2.y };
        for (let c = 0; c < CATMULL_DETAIL; c++) {
            out.push(catmullPoint(v1, v2, v3, v4, c / CATMULL_DETAIL));
            out.push(catmullPoint(v1, v2, v3, v4, (c + 1) / CATMULL_DETAIL));
        }
    }
    return out;
}

function catmullPoint(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: number): Vec2 {
    const t2 = t * t;
    const t3 = t * t2;
    return {
        x: 0.5 * (2 * v2.x + (-v1.x + v3.x) * t + (2 * v1.x - 5 * v2.x + 4 * v3.x - v4.x) * t2 + (-v1.x + 3 * v2.x - 3 * v3.x + v4.x) * t3),
        y: 0.5 * (2 * v2.y + (-v1.y + v3.y) * t + (2 * v1.y - 5 * v2.y + 4 * v3.y - v4.y) * t2 + (-v1.y + 3 * v2.y - 3 * v3.y + v4.y) * t3),
    };
}

export interface CircularArcProperties {
    valid: boolean;
    thetaStart: number;
    thetaRange: number;
    direction: number;
    radius: number;
    centre: Vec2;
}

export function circularArcProperties(cp: readonly Vec2[]): CircularArcProperties {
    const invalid: CircularArcProperties = { valid: false, thetaStart: 0, thetaRange: 0, direction: 1, radius: 0, centre: { x: 0, y: 0 } };
    if (cp.length !== 3) return invalid;
    const [a, b, c] = cp;
    // Degenerate triangle: fall back to a numerically stable method.
    if (Math.abs((b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)) <= FLOAT_EPSILON) return invalid;
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const aSq = a.x * a.x + a.y * a.y;
    const bSq = b.x * b.x + b.y * b.y;
    const cSq = c.x * c.x + c.y * c.y;
    const centre = {
        x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
        y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
    };
    const dAx = a.x - centre.x, dAy = a.y - centre.y;
    const dCx = c.x - centre.x, dCy = c.y - centre.y;
    const radius = Math.hypot(dAx, dAy);
    const thetaStart = Math.atan2(dAy, dAx);
    let thetaEnd = Math.atan2(dCy, dCx);
    while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;
    let direction = 1;
    let thetaRange = thetaEnd - thetaStart;
    // Draw toward whichever side of AC the middle point lies on.
    const orthoX = c.y - a.y;
    const orthoY = -(c.x - a.x);
    if (orthoX * (b.x - a.x) + orthoY * (b.y - a.y) < 0) {
        direction = -1;
        thetaRange = 2 * Math.PI - thetaRange;
    }
    if (!Number.isFinite(radius) || !Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return invalid;
    return { valid: true, thetaStart, thetaRange, direction, radius, centre };
}

function arcPointCount(pr: CircularArcProperties): number {
    if (2 * pr.radius <= CIRCULAR_ARC_TOLERANCE) return 2;
    return Math.max(2, Math.ceil(pr.thetaRange / (2 * Math.acos(1 - CIRCULAR_ARC_TOLERANCE / pr.radius))));
}

export function approximateCircularArc(cp: readonly Vec2[]): Vec2[] {
    const pr = circularArcProperties(cp);
    if (!pr.valid) return approximateBezier(cp);
    const amount = arcPointCount(pr);
    const out: Vec2[] = new Array(amount);
    for (let i = 0; i < amount; i++) {
        const theta = pr.thetaStart + pr.direction * (i / (amount - 1)) * pr.thetaRange;
        out[i] = { x: pr.centre.x + Math.cos(theta) * pr.radius, y: pr.centre.y + Math.sin(theta) * pr.radius };
    }
    return out;
}

function isCollinear(cp: readonly Vec2[]): boolean {
    const [a, b, c] = cp;
    return Math.abs((b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)) <= FLOAT_EPSILON;
}

/** One path segment, following lazer SliderPath.calculateSubPath rules. */
function approximateSegment(type: CurveType, cp: readonly Vec2[]): Vec2[] {
    switch (type) {
        case 'L':
            return approximateLinear(cp);
        case 'P': {
            if (cp.length !== 3) break;
            // Stable special-cased collinear perfect curves to a line.
            if (isCollinear(cp)) return approximateLinear(cp);
            const pr = circularArcProperties(cp);
            if (!pr.valid) break;
            // Absurdly large arcs (radius ~ 1e5) are corrupt data.
            if (arcPointCount(pr) >= 1000) break;
            const arc = approximateCircularArc(cp);
            if (arc.length === 0) break;
            return arc;
        }
        case 'C':
            return approximateCatmull(cp);
        default:
            break;
    }
    return approximateBezier(cp);
}

// ---------------------------------------------------------------------------
// SliderPath
// ---------------------------------------------------------------------------

const samePoint = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/**
 * Split the control polygon into segments at repeated consecutive points
 * ("red anchors"). The shared point ends one segment and starts the next.
 */
function splitSegments(vertices: Vec2[]): Vec2[][] {
    const segments: Vec2[][] = [];
    let start = 0;
    for (let i = 1; i < vertices.length; i++) {
        if (samePoint(vertices[i], vertices[i - 1])) {
            if (i - start >= 2) segments.push(vertices.slice(start, i));
            start = i;
        }
    }
    if (vertices.length - start >= 2) segments.push(vertices.slice(start));
    return segments;
}

/** Raw polyline through all segments (lazer calculatePath). */
export function calculatePath(head: Vec2, curveType: CurveType, controlPoints: readonly Vec2[]): Vec2[] {
    const vertices: Vec2[] = [{ x: head.x, y: head.y }];
    for (const p of controlPoints) vertices.push({ x: p.x, y: p.y });
    if (vertices.length < 2) return vertices;
    // Linear paths are a single segment: duplicates just vanish later.
    const segments = curveType === 'L' ? [vertices] : splitSegments(vertices);
    const path: Vec2[] = [];
    for (const seg of segments) {
        const sub = approximateSegment(curveType, seg);
        let j = 0;
        if (path.length > 0 && sub.length > 0 && samePoint(path[path.length - 1], sub[0])) j = 1;
        for (; j < sub.length; j++) {
            const p = sub[j];
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) path.push(p);
        }
    }
    return path;
}

class PolylinePath implements SliderPath {
    readonly points: readonly PathPoint[];
    readonly length: number;

    constructor(points: PathPoint[], length: number) {
        this.points = points;
        this.length = length;
    }

    /** Index i such that points[i].t <= t <= points[i + 1].t. */
    private segmentAt(t: number): number {
        const pts = this.points;
        let lo = 0;
        let hi = pts.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].t <= t) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    pointAt(t: number): Vec2 {
        const pts = this.points;
        if (!(t > 0)) return { x: pts[0].x, y: pts[0].y };
        const last = pts[pts.length - 1];
        if (t >= 1) return { x: last.x, y: last.y };
        const i = this.segmentAt(t);
        const a = pts[i];
        const b = pts[i + 1] ?? a;
        const span = b.t - a.t;
        const u = span > 1e-12 ? (t - a.t) / span : 0;
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }

    directionAt(t: number): Vec2 {
        const pts = this.points;
        if (pts.length < 2) return { x: 1, y: 0 };
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        let i = this.segmentAt(tc);
        if (i >= pts.length - 1) i = pts.length - 2;
        // Walk to the nearest non-degenerate segment.
        for (let k = i; k < pts.length - 1; k++) {
            const d = unit(pts[k], pts[k + 1]);
            if (d) return d;
        }
        for (let k = i - 1; k >= 0; k--) {
            const d = unit(pts[k], pts[k + 1]);
            if (d) return d;
        }
        return { x: 1, y: 0 };
    }
}

function unit(a: Vec2, b: Vec2): Vec2 | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len } : null;
}

function degeneratePath(head: Vec2): SliderPath {
    return new PolylinePath([
        { x: head.x, y: head.y, t: 0 },
        { x: head.x, y: head.y, t: 1 },
    ], 0);
}

/**
 * Build a slider path. `pixelLength` <= 0 means "use the natural length"
 * (lazer treats a zero expected distance as unset).
 */
export function createSliderPath(head: Vec2, curveType: CurveType, controlPoints: readonly Vec2[], pixelLength: number): SliderPath {
    const path = calculatePath(head, curveType, controlPoints);
    if (path.length < 2) return degeneratePath(head);

    // Cumulative lengths over the raw path.
    const cumulative: number[] = [0];
    let calculated = 0;
    for (let i = 0; i < path.length - 1; i++) {
        calculated += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
        cumulative.push(calculated);
    }

    const expected = pixelLength > 0 && Number.isFinite(pixelLength) ? pixelLength : null;
    if (expected !== null && calculated !== expected) {
        const n = path.length;
        // Stable skips extension when the last two points coincide.
        const lastTwoEqual = samePoint(path[n - 1], path[n - 2]);
        if (!(lastTwoEqual && expected > calculated)) {
            cumulative.pop();
            let end = path.length - 1;
            if (calculated > expected) {
                while (cumulative.length > 0 && cumulative[cumulative.length - 1] >= expected) {
                    cumulative.pop();
                    path.splice(end--, 1);
                }
            }
            if (end <= 0) return degeneratePath(head);
            const from = path[end - 1];
            const dir = unit(from, path[end]) ?? { x: 0, y: 0 };
            const remaining = expected - cumulative[cumulative.length - 1];
            path[end] = { x: from.x + dir.x * remaining, y: from.y + dir.y * remaining };
            cumulative.push(expected);
        }
    }

    const length = cumulative[cumulative.length - 1];
    if (!(length > 1e-9)) return degeneratePath(head);

    // Normalize and drop zero-length steps (they would become degenerate
    // capsules and break binary search monotonicity).
    const points: PathPoint[] = [];
    for (let i = 0; i < path.length; i++) {
        const t = Math.min(1, cumulative[i] / length);
        const prev = points[points.length - 1];
        if (prev && Math.abs(path[i].x - prev.x) < 1e-9 && Math.abs(path[i].y - prev.y) < 1e-9) continue;
        points.push({ x: path[i].x, y: path[i].y, t });
    }
    if (points.length < 2) return degeneratePath(head);
    points[0].t = 0;
    points[points.length - 1].t = 1;
    return new PolylinePath(points, length);
}

/** A copy of `path` translated by (dx, dy) (stack offsets). */
export function offsetSliderPath(path: SliderPath, dx: number, dy: number): SliderPath {
    if (dx === 0 && dy === 0) return path;
    const pts: PathPoint[] = path.points.map(p => ({ x: p.x + dx, y: p.y + dy, t: p.t }));
    return new PolylinePath(pts, path.length);
}
