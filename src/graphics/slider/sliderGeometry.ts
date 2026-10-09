/**
 * CPU side of the slider renderer (pure functions, unit tested).
 *
 * A slider body is the union of capsules (segment ± radius) along its
 * path. Each path segment becomes one quad, extended by the radius at
 * both ends so the rounded caps/joins fit inside it; the GPU prepass
 * then writes a per-fragment distance coverage with MAX blending, which
 * resolves overlaps, kinks and folds exactly without CPU geometry work.
 */
import type { PathPoint } from '../../beatmap/types';

export interface CapsuleQuads {
    pos: Float32Array;
    segA: Float32Array;
    segB: Float32Array;
    index: Uint32Array;
    quads: number;
}

export interface Bounds {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/**
 * Snaking: the visible part of the path [fromT, toT] with exact
 * interpolated end points, so the moving head is a true round cap.
 * `pts` must be sorted by t.
 */
export function partialPoints(pts: readonly PathPoint[], fromT: number, toT: number): PathPoint[] {
    const out: PathPoint[] = [];
    const n = pts.length;
    if (!n) return out;
    const at = (t: number): PathPoint => {
        if (t <= pts[0].t) return { x: pts[0].x, y: pts[0].y, t };
        const last = pts[n - 1];
        if (t >= last.t) return { x: last.x, y: last.y, t };
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pts[mid].t <= t) lo = mid; else hi = mid;
        }
        const a = pts[lo], b = pts[hi];
        const span = b.t - a.t;
        const u = span > 1e-12 ? (t - a.t) / span : 0;
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, t };
    };
    if (fromT > pts[0].t + 1e-12) out.push(at(fromT));
    for (let i = 0; i < n; i++) if (pts[i].t >= fromT && pts[i].t <= toT) out.push(pts[i]);
    if (toT < pts[n - 1].t - 1e-12) out.push(at(toT));
    // An on-grid cut duplicates that point (kept + interpolated); drop exact
    // consecutive duplicates.
    return out.filter((p, i) => i === 0 ||
        Math.abs(p.x - out[i - 1].x) > 1e-9 ||
        Math.abs(p.y - out[i - 1].y) > 1e-9 ||
        Math.abs(p.t - out[i - 1].t) > 1e-12);
}

/**
 * One quad per segment, extended by `radius` along the segment at both
 * ends. Near-coincident points are dropped (neighbouring quads cover the
 * joint); a fully degenerate path becomes a tiny segment so the mesh is
 * never empty and never produces NaN normals.
 */
export function capsuleQuads(pts0: readonly { x: number; y: number }[], radius: number): CapsuleQuads {
    let pts: { x: number; y: number }[] = [];
    for (let i = 0; i < pts0.length; i++) {
        if (i === 0 || Math.abs(pts0[i].x - pts0[i - 1].x) > 1e-5 || Math.abs(pts0[i].y - pts0[i - 1].y) > 1e-5) {
            pts.push(pts0[i]);
        }
    }
    if (pts.length < 2) {
        const p0 = pts0[0] ?? { x: 0, y: 0 };
        pts = [{ x: p0.x, y: p0.y }, { x: p0.x + 0.001, y: p0.y }];
    }
    const quads = pts.length - 1;
    const pos = new Float32Array(quads * 8);
    const segA = new Float32Array(quads * 8);
    const segB = new Float32Array(quads * 8);
    const index = new Uint32Array(quads * 6);
    for (let k = 0; k < quads; k++) {
        const p0 = pts[k], p1 = pts[k + 1];
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy);
        const inv = radius / len;
        const ux = dx * inv, uy = dy * inv; // direction × radius
        const nx = -uy, ny = ux; // normal × radius
        const a0x = p0.x - ux, a0y = p0.y - uy;
        const a1x = p1.x + ux, a1y = p1.y + uy;
        const v = k * 8;
        pos[v] = a0x - nx; pos[v + 1] = a0y - ny;
        pos[v + 2] = a0x + nx; pos[v + 3] = a0y + ny;
        pos[v + 4] = a1x - nx; pos[v + 5] = a1y - ny;
        pos[v + 6] = a1x + nx; pos[v + 7] = a1y + ny;
        for (let c = 0; c < 4; c++) {
            segA[v + 2 * c] = p0.x; segA[v + 2 * c + 1] = p0.y;
            segB[v + 2 * c] = p1.x; segB[v + 2 * c + 1] = p1.y;
        }
        const t = k * 6, w = k * 4;
        index[t] = w; index[t + 1] = w + 1; index[t + 2] = w + 2;
        index[t + 3] = w + 2; index[t + 4] = w + 1; index[t + 5] = w + 3;
    }
    return { pos, segA, segB, index, quads };
}

export function boundsOf(pos: Float32Array): Bounds {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.length; i += 2) {
        if (pos[i] < x0) x0 = pos[i];
        if (pos[i] > x1) x1 = pos[i];
        if (pos[i + 1] < y0) y0 = pos[i + 1];
        if (pos[i + 1] > y1) y1 = pos[i + 1];
    }
    return { x0, y0, x1, y1 };
}

/**
 * Gradient LUT rows (one per combo colour), premultiplied RGBA, sampled
 * by (1 − coverage). Ported from the tuned legacy profile: white border
 * (12.8%), inner track fading 0.8 → 0.3 opacity toward the centre, tiny
 * blur bands at the rim and the border/track boundary.
 */
export function sliderLutData(colors: readonly number[], trackOverride: number | null, border: number | null): { data: Uint8Array; width: number; height: number } {
    const borderwidth = 0.128;
    const innerPortion = 1 - borderwidth;
    const edgeOpacity = 0.8;
    const centerOpacity = 0.3;
    const blurrate = 0.015;
    const width = 200;
    const rows = Math.max(1, colors.length);
    const buff = new Uint8Array(rows * width * 4);
    for (let k = 0; k < rows; k++) {
        const tint = trackOverride ?? colors[k] ?? 0xffffff;
        const bordertint = border ?? 0xffffff;
        const borderR = ((bordertint >> 16) & 255) / 255;
        const borderG = ((bordertint >> 8) & 255) / 255;
        const borderB = (bordertint & 255) / 255;
        const borderA = 1.0;
        const innerR = ((tint >> 16) & 255) / 255;
        const innerG = ((tint >> 8) & 255) / 255;
        const innerB = (tint & 255) / 255;
        const innerA = 1.0;
        for (let i = 0; i < width; i++) {
            const position = i / width;
            let R: number, G: number, B: number, A: number;
            if (position >= innerPortion) {
                R = borderR; G = borderG; B = borderB; A = borderA;
            } else {
                R = innerR; G = innerG; B = innerB;
                A = innerA * ((edgeOpacity - centerOpacity) * position / innerPortion + centerOpacity);
            }
            R *= A; G *= A; B *= A;
            if (1 - position < blurrate) {
                const f = (1 - position) / blurrate;
                R *= f; G *= f; B *= f; A *= f;
            }
            if (innerPortion - position > 0 && innerPortion - position < blurrate) {
                const mu = (innerPortion - position) / blurrate;
                R = mu * R + (1 - mu) * borderR * borderA;
                G = mu * G + (1 - mu) * borderG * borderA;
                B = mu * B + (1 - mu) * borderB * borderA;
                A = mu * innerA + (1 - mu) * borderA;
            }
            const o = (k * width + i) * 4;
            buff[o] = R * 255;
            buff[o + 1] = G * 255;
            buff[o + 2] = B * 255;
            buff[o + 3] = A * 255;
        }
    }
    return { data: buff, width, height: rows };
}
