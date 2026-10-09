import { FillGradient, Matrix, type Graphics, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import { coverUrl } from '../../online/providers';
import { textureFromBlob, textureFromUrl } from '../../graphics/textures';

/**
 * Small rendering helpers shared by song select panels: thumbnail lookup
 * (cached in the game-wide texture LRU), cover-fit texture fills (no
 * stencil masks needed for rounded/sheared shapes) and star rows.
 */
export function setThumbnail(game: Game, set: LibrarySet): Promise<Texture | null> {
    return game.covers.get(`thumb:${set.key}`, async () => {
        const blob = await game.library.getThumbnail(set.key);
        if (blob) return textureFromBlob(blob, 512);
        if (set.onlineSetId) return textureFromUrl(coverUrl(set.onlineSetId, 'jpg'), undefined, 1024);
        return null;
    });
}

/** Full background (wedge, loader card), separately cached. */
export function setBackground(game: Game, set: LibrarySet): Promise<Texture | null> {
    return game.covers.get(`bg:${set.key}`, async () => {
        const blob = await game.library.getBackground(set.key);
        if (blob) return textureFromBlob(blob, 1280);
        if (set.onlineSetId) return textureFromUrl(coverUrl(set.onlineSetId, 'jpg'), undefined, 1024);
        return null;
    });
}

/** Texture fill matrix that covers a w×h box at (x, y) (CSS object-fit: cover). */
export function coverMatrix(tex: Texture, x: number, y: number, w: number, h: number): Matrix {
    const tw = tex.width || 1, th = tex.height || 1;
    const s = Math.max(w / tw, h / th);
    return new Matrix(s, 0, 0, s, x + (w - tw * s) / 2, y + (h - th * s) / 2);
}

export function coverFill(tex: Texture, x: number, y: number, w: number, h: number) {
    return { texture: tex, matrix: coverMatrix(tex, x, y, w, h), textureSpace: 'global' as const };
}

/**
 * Song select's top wedges (info wedge, filter control) extend this far
 * past the screen edge / under the toolbar, so only their free corners
 * show (lazer's CORNER_RADIUS_HIDE_OFFSET).
 */
export const EDGE_HIDE = 20;
/** Corner radius of the free corners of the top wedges. */
export const WEDGE_RADIUS = 12;

/**
 * Info wedge shading: darker behind the title block on the left, light in
 * the middle so the art shows, a touch darker again under the stat bars.
 */
export function wedgeShade(): FillGradient {
    return new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0.62)' },
            { offset: 0.35, color: 'rgba(0,0,0,0.38)' },
            { offset: 0.6, color: 'rgba(0,0,0,0.18)' },
            { offset: 1, color: 'rgba(0,0,0,0.38)' },
        ],
        textureSpace: 'local',
    });
}

/** Left-to-right darkening used over thumbnails so text stays readable. */
export function shadeGradient(fromAlpha: number, toAlpha: number, vertical = false): FillGradient {
    return new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 },
        colorStops: [
            { offset: 0, color: `rgba(0,0,0,${fromAlpha})` },
            { offset: 1, color: `rgba(0,0,0,${toAlpha})` },
        ],
        textureSpace: 'local',
    });
}

/**
 * lazer's StarCounter: ten stars, partial stars scaled down, unlit ones
 * faint. Drawn into `g` starting at (x, y centre).
 */
export function drawStarRow(g: Graphics, x: number, y: number, stars: number | null, size = 7, color = 0xffffff): number {
    const step = size * 2.2;
    for (let i = 0; i < 10; i++) {
        const v = stars === null ? 0 : Math.min(1, Math.max(0, stars - i));
        const r = size * (0.45 + 0.55 * v);
        g.star(x + i * step + size, y, 5, r, r * 0.45).fill({ color, alpha: v > 0 ? 1 : 0.2 });
    }
    return step * 10;
}

export function formatStars(stars: number | null): string {
    return stars === null ? '?' : stars.toFixed(2);
}

export function formatLength(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBpm(min: number, max: number, main: number, rate = 1): string {
    const r = (v: number) => Math.round(v * rate);
    if (Math.abs(max - min) < 1) return String(r(main));
    return `${r(min)}-${r(max)} (${r(main)})`;
}

export function relativeDate(ts: number): string {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
    return `${Math.floor(s / (86400 * 365))}y`;
}
