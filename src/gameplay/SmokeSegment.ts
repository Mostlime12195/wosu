/**
 * Cursor smoke (osu!lazer's SmokeSegment, shared by its DefaultSmokeSegment
 * and LegacySmokeSegment, which differ only in the texture). Rendering lives
 * in drawables/Smoke.ts. Everything is in playfield units and gameplay
 * milliseconds: lazer's SmokeContainer sits in the playfield on the
 * gameplay clock, so rate mods speed the fades up and pausing freezes them.
 *
 * While the smoke key is held, the cursor's path is dotted with points one
 * `pointInterval` apart, each with a random angle. A point appears at full
 * opacity for the frame it is laid in, then fades from 0.6 to 0 over 4 s.
 * On release, the points of the segment's last 4 s flash back in to full
 * opacity (oldest first, a third of real time) and then fade out over 8 s
 * (half real time, OutQuint-like ^5 curve). Each point also grows from
 * 0.65 to 1 over 1.2 s and turns by up to ±0.25 rad over 0.5 s.
 */

// fade anim values
const INITIAL_FADE_OUT_DURATION = 4000;
const RE_FADE_IN_SPEED = 3;
const RE_FADE_IN_DURATION = 50;
const FINAL_FADE_OUT_SPEED = 2;
const FINAL_FADE_OUT_DURATION = 8000;
const INITIAL_ALPHA = 0.6;
const RE_FADE_IN_ALPHA = 1;

// scale anim values
const SCALE_DURATION = 1200;
const INITIAL_SCALE = 0.65;
const FINAL_SCALE = 1;

// rotation anim values
const ROTATION_DURATION = 500;
const MAX_ROTATION = 0.25;

/** A point's half extent is the texture's display size × this (SmokeSegment.width / height). */
export const SMOKE_SIZE_FACTOR = 0.165;
/** Half extent without a texture (lazer's white pixel fallback). */
export const SMOKE_FALLBACK_SIZE = 3;

export interface SmokePoint {
    x: number;
    y: number;
    time: number;
    /** Initial angle (radians). */
    angle: number;
}

/** One point as drawn at some time. */
export interface SmokeQuad {
    x: number;
    y: number;
    alpha: number;
    /** Multiplies the half extents. */
    scale: number;
    /**
     * lazer's angle: the quad's texture x axis runs along (sin a, -cos a),
     * its y axis 90° clockwise of that (a sprite rotation of a - π/2).
     */
    angle: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const outQuint = (f: number) => 1 - Math.pow(1 - f, 5);

/** osu-framework's StatelessRNG.NextSingle: a uniform [0, 1) from (seed, index), without state. */
export function statelessSingle(seed: number, index: number): number {
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 8) / 0x1000000;
}

export class SmokeSegment {
    readonly points: SmokePoint[] = [];
    readonly startTime: number;
    endTime = Infinity;
    /** Per-segment seed for the points' extra rotation. */
    readonly rotationSeed: number;
    /** Distance between points (7/8 of the half width). */
    readonly pointInterval: number;
    private totalDistance: number;
    private lastX = 0;
    private lastY = 0;
    private hasLast = false;

    /**
     * `halfWidth` / `halfHeight`: the texture's display size (playfield
     * units) × SMOKE_SIZE_FACTOR. `random` gives each point's angle.
     */
    constructor(
        startTime: number,
        readonly halfWidth: number,
        readonly halfHeight: number,
        private readonly random: () => number = Math.random,
    ) {
        this.startTime = startTime;
        this.rotationSeed = Math.floor(random() * 0x7fffffff);
        this.pointInterval = (halfWidth * 7) / 8;
        // StartDrawing: the first position always lays a point.
        this.totalDistance = this.pointInterval;
    }

    get drawing(): boolean {
        return this.endTime === Infinity;
    }

    /** AddPosition: extend the path to (x, y) at `time`. */
    addPosition(x: number, y: number, time: number): void {
        if (!this.hasLast) {
            this.hasLast = true;
            this.lastX = x;
            this.lastY = y;
        }
        const interval = this.pointInterval;
        const dx = x - this.lastX, dy = y - this.lastY;
        const delta = Math.hypot(dx, dy);
        this.totalDistance += delta;
        const count = interval > 0 ? Math.floor(this.totalDistance / interval) : 0;
        if (count > 0) {
            const ux = delta > 0 ? dx / delta : 0, uy = delta > 0 ? dy / delta : 0;
            const along = interval - (this.totalDistance - delta);
            let px = this.lastX + ux * along, py = this.lastY + uy * along;
            this.totalDistance %= interval;
            const pts = this.points;
            if (pts.length === 0 || pts[pts.length - 1].time <= time) {
                for (let i = 0; i < count; i++) {
                    pts.push({ x: px, y: py, time, angle: this.random() * 2 * Math.PI });
                    px += ux * interval;
                    py += uy * interval;
                }
            }
        }
        this.lastX = x;
        this.lastY = y;
    }

    /** FinishDrawing: the smoke key was released. */
    finish(time: number): void {
        this.endTime = time;
    }

    /** How far back from the end (or now) points stay visible. */
    private get initialFadeOutDurationTrunc(): number {
        return Math.min(INITIAL_FADE_OUT_DURATION, this.endTime - this.startTime);
    }

    /** LifetimeEnd: nothing is visible after this (Infinity while drawing). */
    get lifetimeEnd(): number {
        const trunc = this.initialFadeOutDurationTrunc;
        return this.endTime + FINAL_FADE_OUT_DURATION + trunc / RE_FADE_IN_SPEED + trunc / FINAL_FADE_OUT_SPEED;
    }

    /**
     * SmokeDrawNode: every point that can be visible at `now` (points laid
     * after `now`, after a rewind, are not), skipping fully transparent ones.
     */
    draw(now: number, out: (q: SmokeQuad) => void): void {
        const pts = this.points;
        if (pts.length === 0) return;
        const end = this.endTime;
        const trunc = this.initialFadeOutDurationTrunc;
        const firstAfterEnd = end - trunc;
        const initialFadeOutTime = Math.min(now, end);
        const reFadeInTime = now - trunc - firstAfterEnd * (1 - 1 / RE_FADE_IN_SPEED);
        const finalFadeOutTime = now - trunc - firstAfterEnd * (1 - 1 / FINAL_FADE_OUT_SPEED);
        const firstVisibleTime = Math.min(end, now) - trunc;
        const first = lowerBound(pts, firstVisibleTime);
        const future = upperBound(pts, now);
        const q: SmokeQuad = { x: 0, y: 0, alpha: 0, scale: 0, angle: 0 };
        for (let i = first; i < future; i++) {
            const p = pts[i];
            // PointColour
            let alpha = 1;
            const finalFade = finalFadeOutTime - p.time / FINAL_FADE_OUT_SPEED;
            if (finalFade > 0 && p.time >= firstAfterEnd) {
                const f = Math.pow(clamp01(finalFade / FINAL_FADE_OUT_DURATION), 5);
                alpha = (1 - f) * RE_FADE_IN_ALPHA;
            } else {
                const initialFade = initialFadeOutTime - p.time;
                if (initialFade > 0) alpha = (1 - clamp01(initialFade / INITIAL_FADE_OUT_DURATION)) * INITIAL_ALPHA;
                if (p.time > firstAfterEnd) {
                    const reFade = reFadeInTime - p.time / RE_FADE_IN_SPEED;
                    if (reFade > 0) {
                        const f = outQuint(clamp01(reFade / RE_FADE_IN_DURATION));
                        alpha = f * (RE_FADE_IN_ALPHA - alpha) + alpha;
                    }
                }
            }
            if (alpha <= 0) continue;
            // PointScale
            const age = now - p.time;
            const scale = outQuint(clamp01(age / SCALE_DURATION)) * (FINAL_SCALE - INITIAL_SCALE) + INITIAL_SCALE;
            // PointDirection
            const turn = MAX_ROTATION * (statelessSingle(this.rotationSeed, i) * 2 - 1);
            q.x = p.x;
            q.y = p.y;
            q.alpha = alpha;
            q.scale = scale;
            q.angle = outQuint(clamp01(age / ROTATION_DURATION)) * turn + p.angle;
            out(q);
        }
    }
}

/** First index with time >= t (SmokePoint.LowerBoundComparer). */
function lowerBound(pts: readonly SmokePoint[], t: number): number {
    let lo = 0, hi = pts.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].time < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** First index with time > t (SmokePoint.UpperBoundComparer). */
function upperBound(pts: readonly SmokePoint[], t: number): number {
    let lo = 0, hi = pts.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].time <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * lazer's SmokeContainer for one player: a new segment each time the smoke
 * key goes down, finished when it comes up, dropped once fully faded.
 */
export class SmokeTrail {
    readonly segments: SmokeSegment[] = [];
    private current: SmokeSegment | null = null;

    constructor(
        readonly halfWidth: number,
        readonly halfHeight: number,
        private readonly random: () => number = Math.random,
    ) {}

    get drawing(): boolean {
        return this.current !== null;
    }

    /** The smoke key's state at `time`. Returns true on a press (a new segment). */
    setDrawing(on: boolean, time: number): boolean {
        if (on === !!this.current) return false;
        if (on) {
            this.current = new SmokeSegment(time, this.halfWidth, this.halfHeight, this.random);
            this.segments.push(this.current);
            return true;
        }
        this.current!.finish(time);
        this.current = null;
        return false;
    }

    addPosition(x: number, y: number, time: number): void {
        this.current?.addPosition(x, y, time);
    }

    /** Every visible point at `now` (oldest segment first); expired segments are dropped. */
    draw(now: number, out: (q: SmokeQuad) => void): void {
        const segs = this.segments;
        for (let i = segs.length - 1; i >= 0; i--) {
            if (now > segs[i].lifetimeEnd) segs.splice(i, 1);
        }
        for (const s of segs) {
            if (now >= s.startTime) s.draw(now, out);
        }
    }
}
