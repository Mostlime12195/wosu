/**
 * A tiny software rasterizer for wosu!'s generated skin: shapes are signed
 * distance functions (pixels, negative inside), painted with analytic
 * anti-aliasing (coverage = 0.5 − distance at the pixel centre) into a
 * premultiplied RGBA float buffer. No canvas, so the same code draws the
 * skin in the browser (uploaded straight to the GPU) and in Node
 * (tools/default-skin writes it out as PNGs), pixel for pixel.
 */

/** Signed distance in pixels from a point to a shape's edge; negative inside. */
export type Sdf = (x: number, y: number) => number;
/** A colour (0xRRGGBB), or one per pixel (gradients). */
export type Paint = number | ((x: number, y: number) => number);

/** Pixel bounds to paint within (inclusive start, exclusive end); defaults to the whole image. */
export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export class Raster {
    /** Premultiplied RGBA, 0..1. */
    readonly data: Float32Array;
    /** Display scale as an osu! skin image: 0.5 for @2x (the default), 1 for a normal-resolution image. */
    scale = 0.5;

    constructor(readonly width: number, readonly height: number) {
        this.data = new Float32Array(width * height * 4);
    }

    /**
     * Composite `paint` at `alpha` × `coverage(x, y)` over the image
     * (source-over), or with `erase`, remove that much of what's there.
     * `coverage` and `paint` get pixel-centre coordinates.
     */
    fill(coverage: (x: number, y: number) => number, paint: Paint, alpha = 1, box?: Box, erase = false): void {
        const w = this.width, d = this.data;
        const x0 = Math.max(0, Math.floor(box?.x0 ?? 0)), y0 = Math.max(0, Math.floor(box?.y0 ?? 0));
        const x1 = Math.min(w, Math.ceil(box?.x1 ?? w)), y1 = Math.min(this.height, Math.ceil(box?.y1 ?? this.height));
        const solid = typeof paint === 'number';
        let r = 0, g = 0, b = 0;
        if (solid) [r, g, b] = rgb(paint);
        for (let y = y0; y < y1; y++) {
            const py = y + 0.5;
            for (let x = x0; x < x1; x++) {
                const px = x + 0.5;
                const c = coverage(px, py);
                if (c <= 0) continue;
                const a = alpha * (c > 1 ? 1 : c);
                const o = (y * w + x) * 4;
                if (erase) {
                    const k = 1 - a;
                    d[o] *= k;
                    d[o + 1] *= k;
                    d[o + 2] *= k;
                    d[o + 3] *= k;
                    continue;
                }
                if (!solid) [r, g, b] = rgb((paint as (x: number, y: number) => number)(px, py));
                const k = 1 - a;
                d[o] = r * a + d[o] * k;
                d[o + 1] = g * a + d[o + 1] * k;
                d[o + 2] = b * a + d[o + 2] * k;
                d[o + 3] = a + d[o + 3] * k;
            }
        }
    }

    /** Fill a shape, anti-aliased. */
    shape(sdf: Sdf, paint: Paint, alpha = 1, box?: Box): void {
        this.fill((x, y) => 0.5 - sdf(x, y), paint, alpha, box);
    }

    /** Cut a shape out of what's been painted (destination-out). */
    cut(sdf: Sdf, alpha = 1, box?: Box): void {
        this.fill((x, y) => 0.5 - sdf(x, y), 0, alpha, box, true);
    }

    /**
     * A soft glow around (and over) a shape: full inside, falling off as
     * (1 − d / radius)² over `radius` pixels outside.
     */
    glow(sdf: Sdf, paint: Paint, alpha: number, radius: number, box?: Box): void {
        this.fill((x, y) => {
            const dist = sdf(x, y);
            if (dist <= 0) return 1;
            const t = 1 - dist / radius;
            return t > 0 ? t * t : 0;
        }, paint, alpha, box);
    }

    /** 8-bit RGBA: premultiplied (for the GPU) or straight (for PNG files). */
    rgba8(premultiplied: boolean): Uint8Array {
        const d = this.data, out = new Uint8Array(d.length);
        for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3];
            const k = premultiplied || a <= 0 ? 255 : 255 / a;
            out[i] = clampByte(d[i] * k);
            out[i + 1] = clampByte(d[i + 1] * k);
            out[i + 2] = clampByte(d[i + 2] * k);
            out[i + 3] = clampByte(a * 255);
        }
        return out;
    }
}

/** Vector length (Math.hypot is several times slower, and this runs per pixel). */
export const len = (x: number, y: number): number => Math.sqrt(x * x + y * y);

const clampByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

export function rgb(c: number): [number, number, number] {
    return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a: number, b: number, t: number): number {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// ---------------------------------------------------------------------------
// Shapes (pixel coordinates)
// ---------------------------------------------------------------------------

export const circle = (cx: number, cy: number, r: number): Sdf => (x, y) => len(x - cx, y - cy) - r;

/** A ring of width `w` centred on radius `r`. */
export const ring = (cx: number, cy: number, r: number, w: number): Sdf => (x, y) => Math.abs(len(x - cx, y - cy) - r) - w / 2;

/** An ellipse (approximate distance, exact on the axes: fine for glows and soft shapes). */
export const ellipse = (cx: number, cy: number, rx: number, ry: number): Sdf => {
    const m = Math.min(rx, ry);
    return (x, y) => (len((x - cx) / rx, (y - cy) / ry) - 1) * m;
};

/** Distance from (x, y) to the segment a–b. */
export function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return len(x - (ax + dx * t), y - (ay + dy * t));
}

/** A circular arc from angle a0 to a1 (radians, y grows downwards), for strokes. */
export interface Arc {
    cx: number;
    cy: number;
    r: number;
    a0: number;
    a1: number;
}

/** Distance from (x, y) to an arc. */
export function arcDistance(x: number, y: number, a: Arc): number {
    const dx = x - a.cx, dy = y - a.cy;
    const lo = Math.min(a.a0, a.a1), hi = Math.max(a.a0, a.a1);
    if (hi - lo >= 2 * Math.PI) return Math.abs(len(dx, dy) - a.r);
    let t = Math.atan2(dy, dx);
    t = lo + ((((t - lo) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    if (t <= hi) return Math.abs(len(dx, dy) - a.r);
    return Math.min(
        len(x - (a.cx + a.r * Math.cos(a.a0)), y - (a.cy + a.r * Math.sin(a.a0))),
        len(x - (a.cx + a.r * Math.cos(a.a1)), y - (a.cy + a.r * Math.sin(a.a1))),
    );
}

/** One piece of a stroke: a polyline (x0, y0, x1, y1…; a single point is a dot) or an arc. */
export type StrokePath = readonly number[] | Arc;

/** A stroke of width `w` along paths, with round caps and joins. */
export function strokes(paths: readonly StrokePath[], w: number): Sdf {
    return (x, y) => {
        let best = Infinity;
        for (const p of paths) {
            if (!Array.isArray(p)) {
                const dist = arcDistance(x, y, p as Arc);
                if (dist < best) best = dist;
                continue;
            }
            const l = p as readonly number[];
            if (l.length === 2) {
                best = Math.min(best, len(x - l[0], y - l[1]));
                continue;
            }
            for (let i = 0; i + 3 < l.length; i += 2) {
                const dist = segmentDistance(x, y, l[i], l[i + 1], l[i + 2], l[i + 3]);
                if (dist < best) best = dist;
            }
        }
        return best - w / 2;
    };
}

/** A rounded rectangle. */
export const roundRect = (x0: number, y0: number, x1: number, y1: number, r: number): Sdf => {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
    return (x, y) => {
        const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
        return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
};

/** The box around a circle of radius r (plus a margin). */
export const around = (cx: number, cy: number, r: number): Box => ({ x0: cx - r - 1, y0: cy - r - 1, x1: cx + r + 1, y1: cy + r + 1 });
