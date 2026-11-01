import { strokes, type Arc, type Raster, type StrokePath } from './raster';

/**
 * wosu!'s skin font: a rounded geometric stroke font (digits, the HUD's
 * "x", "%", "." and ",", and the capitals the judgements and spinner
 * spell), drawn as strokes with round caps so it stays crisp at any size
 * and weight. Coordinates are in cap heights: (0, 0) is a glyph's
 * top-left, y grows downwards, the baseline is y = 1.
 */
interface Glyph {
    /** Advance width of the strokes' centre lines (the stroke weight adds to it). */
    w: number;
    paths: StrokePath[];
}

const PI = Math.PI;

/** An arc from angle a0 to a1 (radians; 0 = right, PI / 2 = down). */
const A = (cx: number, cy: number, r: number, a0: number, a1: number): Arc => ({ cx, cy, r, a0, a1 });
/** Where an arc ends (a1) or starts (a0), to join lines onto it. */
const at = (a: Arc, end = true): [number, number] => {
    const t = end ? a.a1 : a.a0;
    return [a.cx + a.r * Math.cos(t), a.cy + a.r * Math.sin(t)];
};

/** A stadium (box with round ends) of width w. */
function stadium(w: number): StrokePath[] {
    const r = w / 2;
    return [A(r, r, r, PI, 2 * PI), A(r, 1 - r, r, 0, PI), [0, r, 0, 1 - r], [w, r, w, 1 - r]];
}

/** C's open stadium (and G's top). */
const cTop = A(0.31, 0.31, 0.31, PI, 2 * PI - 0.45);
const cBottom = A(0.31, 0.69, 0.31, 0.45, PI);
const two = A(0.3, 0.3, 0.3, PI + 0.2, 2 * PI + 0.6);
const five = A(0.3, 0.68, 0.32, PI + 0.8, 3 * PI - 0.45);
const pBowl = A(0.3, 0.27, 0.27, -PI / 2, PI / 2);

const GLYPHS: Record<string, Glyph> = {
    '0': { w: 0.6, paths: stadium(0.6) },
    '1': { w: 0.36, paths: [[0.02, 0.2, 0.3, 0, 0.3, 1]] },
    '2': { w: 0.6, paths: [two, [...at(two), 0, 1, 0.6, 1]] },
    '3': { w: 0.6, paths: [A(0.3, 0.26, 0.26, PI + 0.35, 2.5 * PI), A(0.3, 0.73, 0.27, 1.5 * PI, 3 * PI - 0.35), [0.3, 0.52, 0.3, 0.46]] },
    '4': { w: 0.62, paths: [[0.46, 1, 0.46, 0, 0, 0.66, 0.62, 0.66]] },
    '5': { w: 0.62, paths: [[0.56, 0, 0.08, 0, 0.06, 0.44, ...at(five, false)], five] },
    '6': { w: 0.6, paths: [A(0.3, 0.69, 0.3, 0, 2 * PI), [0.03, 0.6, 0.4, 0]] },
    '7': { w: 0.6, paths: [[0, 0, 0.6, 0, 0.17, 1]] },
    '8': { w: 0.6, paths: [A(0.3, 0.25, 0.24, 0, 2 * PI), A(0.3, 0.725, 0.275, 0, 2 * PI)] },
    '9': { w: 0.6, paths: [A(0.3, 0.31, 0.3, 0, 2 * PI), [0.57, 0.4, 0.2, 1]] },
    'x': { w: 0.5, paths: [[0, 0.38, 0.5, 1], [0.5, 0.38, 0, 1]] },
    '.': { w: 0, paths: [[0, 0.97]] },
    ',': { w: 0.06, paths: [[0.06, 0.95, 0, 1.12]] },
    '%': { w: 0.78, paths: [A(0.15, 0.17, 0.15, 0, 2 * PI), A(0.63, 0.83, 0.15, 0, 2 * PI), [0.68, 0, 0.1, 1]] },
    '!': { w: 0, paths: [[0, 0, 0, 0.64], [0, 0.98]] },
    ' ': { w: 0.3, paths: [] },
    'A': { w: 0.68, paths: [[0, 1, 0.34, 0, 0.68, 1], [0.13, 0.64, 0.55, 0.64]] },
    'C': { w: 0.62, paths: [cTop, cBottom, [0, 0.31, 0, 0.69]] },
    'E': { w: 0.54, paths: [[0.54, 0, 0, 0, 0, 1, 0.54, 1], [0, 0.5, 0.46, 0.5]] },
    'G': { w: 0.62, paths: [cTop, A(0.31, 0.69, 0.31, 0, PI), [0, 0.31, 0, 0.69], [0.62, 0.69, 0.62, 0.56, 0.36, 0.56]] },
    'H': { w: 0.6, paths: [[0, 0, 0, 1], [0.6, 0, 0.6, 1], [0, 0.5, 0.6, 0.5]] },
    'I': { w: 0, paths: [[0, 0, 0, 1]] },
    'K': { w: 0.58, paths: [[0, 0, 0, 1], [0.56, 0, 0, 0.62], [0.2, 0.45, 0.58, 1]] },
    'L': { w: 0.5, paths: [[0, 0, 0, 1, 0.5, 1]] },
    'M': { w: 0.74, paths: [[0, 1, 0, 0, 0.37, 0.62, 0.74, 0, 0.74, 1]] },
    'N': { w: 0.6, paths: [[0, 1, 0, 0, 0.6, 1, 0.6, 0]] },
    'O': { w: 0.68, paths: stadium(0.68) },
    'P': { w: 0.57, paths: [[0, 1, 0, 0, 0.3, 0], pBowl, [0.3, 0.54, 0, 0.54]] },
    'R': { w: 0.58, paths: [[0, 1, 0, 0, 0.3, 0], pBowl, [0.3, 0.54, 0, 0.54], [0.28, 0.54, 0.58, 1]] },
    'S': { w: 0.58, paths: [A(0.29, 0.26, 0.26, PI / 2, 2 * PI - 0.4), A(0.29, 0.75, 0.25, -PI / 2, PI - 0.4)] },
    'T': { w: 0.62, paths: [[0, 0, 0.62, 0], [0.31, 0, 0.31, 1]] },
};

export interface TextStyle {
    /** Cap height in pixels. */
    size: number;
    /** Stroke weight in pixels. */
    weight: number;
    /** Extra space between glyphs, in pixels. */
    spacing?: number;
}

/** Advance of one glyph in pixels (its strokes plus their weight). */
export function glyphWidth(ch: string, style: TextStyle): number {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    return g.w * (style.size - style.weight) + style.weight;
}

/** Width of a whole string in pixels. */
export function textWidth(text: string, style: TextStyle): number {
    let w = 0;
    for (const ch of text) w += glyphWidth(ch, style);
    return w + Math.max(0, [...text].length - 1) * (style.spacing ?? 0);
}

/**
 * Draw `text` with its cap top-left at (x, y) (the stroke's own half
 * weight is inside that box, so ink starts exactly at x, y).
 * `outline`: a darker stroke `outline` px wide around the glyphs first.
 */
export function drawText(r: Raster, text: string, x: number, y: number, style: TextStyle, colour: number, alpha = 1,
    outline?: { width: number; colour: number; alpha: number }): void {
    let pen = x;
    for (const ch of text) {
        const g = GLYPHS[ch] ?? GLYPHS[' '];
        const ox = pen + style.weight / 2, oy = y + style.weight / 2;
        const h = style.size - style.weight;
        // The stroke centre lines span the cap height minus the weight, so the ink spans exactly `size`.
        const lines = g.paths.map((p): StrokePath => (Array.isArray(p)
            ? (p as readonly number[]).map((v, i) => (i % 2 === 0 ? ox + v * h : oy + v * h))
            : { ...(p as Arc), cx: ox + (p as Arc).cx * h, cy: oy + (p as Arc).cy * h, r: (p as Arc).r * h }));
        const pad = style.weight + (outline?.width ?? 0) * 2 + 2;
        const box = { x0: pen - pad, y0: y - pad, x1: pen + g.w * h + style.weight + pad, y1: y + style.size * 1.2 + pad };
        if (outline) r.shape(strokes(lines, style.weight + outline.width * 2), outline.colour, outline.alpha, box);
        r.shape(strokes(lines, style.weight), colour, alpha, box);
        pen += g.w * h + style.weight + (style.spacing ?? 0);
    }
}

