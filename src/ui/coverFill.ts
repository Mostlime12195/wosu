import { Matrix, type Graphics, type Texture } from 'pixi.js';
import { drawRoundedRect, type BoxOptions } from './Box';

export interface CoverFillOptions {
    /** Multiplied with the texture (dims/tints the image). */
    color?: number;
    alpha?: number;
    /** Focal point for the crop (0..1 per axis; default centre). */
    alignX?: number;
    alignY?: number;
    /** Which corners `radius` rounds (default all). */
    corners?: BoxOptions['corners'];
}

/**
 * Fill a rect / rounded rect with `tex` scaled to cover it (CSS
 * object-fit: cover), cropping the overflow. The image is a texture fill
 * of the shape itself, so rounded corners need no mask (masks break
 * batching, and listings draw dozens of these).
 */
export function fillCover(
    g: Graphics, tex: Texture, x: number, y: number, w: number, h: number, radius = 0, o: CoverFillOptions = {},
): Graphics {
    if (w <= 0 || h <= 0 || tex.width <= 0 || tex.height <= 0) return g;
    const s = Math.max(w / tex.width, h / tex.height);
    const dx = x + (w - tex.width * s) * (o.alignX ?? 0.5);
    const dy = y + (h - tex.height * s) * (o.alignY ?? 0.5);
    drawRoundedRect(g, x, y, w, h, Math.min(radius, w / 2, h / 2), o.corners ?? 'all');
    return g.fill({
        texture: tex,
        matrix: new Matrix(s, 0, 0, s, dx, dy),
        textureSpace: 'global',
        color: o.color ?? 0xffffff,
        alpha: o.alpha ?? 1,
    });
}
