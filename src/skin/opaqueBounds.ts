import type { Texture } from 'pixi.js';

export interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const cache = new WeakMap<Texture, PixelRect>();
/** Scan at most this many pixels across (bounds are for hit areas, not drawing). */
const MAX_SCAN = 512;

/**
 * The box around a texture's visible pixels (alpha above ~3%), in texture
 * pixels. Full-frame skin elements (a 1366×768 play-skip with the button
 * drawn in one corner) are clickable only where something is drawn.
 * The whole texture when its pixels can't be read.
 */
export function opaqueBounds(tex: Texture): PixelRect {
    const hit = cache.get(tex);
    if (hit) return hit;
    const full = { x: 0, y: 0, width: tex.width, height: tex.height };
    let out = full;
    try {
        const res = tex.source.resource as CanvasImageSource | undefined;
        const sw = tex.source.pixelWidth, sh = tex.source.pixelHeight;
        if (res && sw > 0 && sh > 0 && typeof document !== 'undefined') {
            const k = Math.min(1, MAX_SCAN / Math.max(sw, sh));
            const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const g = canvas.getContext('2d', { willReadFrequently: true });
            if (g) {
                g.drawImage(res, 0, 0, w, h);
                const data = g.getImageData(0, 0, w, h).data;
                let x0 = w, y0 = h, x1 = -1, y1 = -1;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (data[(y * w + x) * 4 + 3] <= 8) continue;
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
                if (x1 >= 0) {
                    // Back to texture units (source pixels over the resolution), a scan pixel of slack.
                    const u = 1 / (k * tex.source.resolution);
                    const x = Math.max(0, (x0 - 1) * u), y = Math.max(0, (y0 - 1) * u);
                    out = { x, y, width: Math.min(tex.width, (x1 + 2) * u) - x, height: Math.min(tex.height, (y1 + 2) * u) - y };
                }
            }
        }
    } catch {
        out = full;
    }
    cache.set(tex, out);
    return out;
}
