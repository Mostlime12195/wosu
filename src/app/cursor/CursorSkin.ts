import type { LegacySkin, SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain, SkinLayer } from '../../skin/SkinChain';

/**
 * LegacySkin.STABLE_MAGIC_SCALE_FACTOR: legacy cursor images are sized in
 * stable's x480 space, so lazer's NonPlayfieldSprite (and the legacy trail)
 * divide their size by 1.6 inside the playfield. A @2x image of `w` pixels
 * therefore spans w × 0.5 / 1.6 playfield units.
 */
export const STABLE_MAGIC_SCALE = 1.6;

/** The trail as one skin provides it (lazer's LegacyCursorTrail, or DefaultCursorTrail for wosu!'s own skin). */
export interface TrailSkin {
    texture: SkinTexture;
    /** From an osu! skin: legacy fade and spacing. Otherwise lazer's default trail. */
    legacy: boolean;
    /** Stable's disjoint trail (separate sprites every 1/60 s), used when the cursor's skin has no cursormiddle. */
    disjoint: boolean;
    /** Parts centred on the cursor (CursorCentre of the trail's skin; only the disjoint trail honours it). */
    centre: boolean;
    /** CursorTrailRotate: parts follow the cursor's spin. */
    rotate: boolean;
}

/** Everything the gameplay cursor reads from the skins in effect. */
export interface CursorSkin {
    cursor: SkinTexture | null;
    /** Only from the same skin as the cursor (stable never mixes the two). */
    middle: SkinTexture | null;
    /** From an osu! skin (LegacyCursor) rather than wosu!'s own (lazer's DefaultCursor). */
    legacy: boolean;
    /** CursorCentre: anchor at the image centre, else its top-left corner. */
    centre: boolean;
    /** CursorRotate: cursor.png spins once every 10 s. */
    rotate: boolean;
    /** CursorExpand: grow on each press. */
    expand: boolean;
    trail: TrailSkin | null;
}

/** The first layer that may provide images and has `name` (lazer's per-component skin lookup). */
function provider(chain: SkinChain, name: string): SkinLayer | null {
    for (const l of chain.layers) {
        if (l.skin && l.textures !== false && l.skin.texture(name)) return l;
    }
    return null;
}

/**
 * Resolve the cursor elements the way lazer's OsuLegacySkinTransformer
 * does: each component comes whole from the first skin that has its main
 * image (cursor.png / cursortrail.png), and reads that skin's own
 * skin.ini, with lazer's fallbacks (true) for keys it leaves out.
 * `builtin` is wosu!'s default skin: its elements behave like lazer's
 * built-in (non-legacy) cursor and trail, so they look as they always did.
 */
export function resolveCursorSkin(chain: SkinChain, builtin: LegacySkin | null): CursorSkin {
    const c = provider(chain, 'cursor');
    const cs = c?.skin ?? null;
    const t = provider(chain, 'cursortrail');
    const ts = t?.skin ?? null;
    let trail: TrailSkin | null = null;
    if (ts) {
        const legacy = ts !== builtin;
        trail = {
            texture: ts.texture('cursortrail')!,
            legacy,
            // Stable decides by where the cursor came from, not the trail.
            disjoint: legacy && !cs?.texture('cursormiddle'),
            centre: ts.config.cursorCentre ?? true,
            rotate: legacy && (ts.config.cursorTrailRotate ?? true),
        };
    }
    return {
        cursor: cs?.texture('cursor') ?? null,
        middle: cs?.texture('cursormiddle') ?? null,
        legacy: !!cs && cs !== builtin,
        centre: cs?.config.cursorCentre ?? true,
        rotate: cs?.config.cursorRotate ?? true,
        // OsuCursor reads CursorExpand from the whole skin source, first skin that sets it.
        expand: chain.config('cursorExpand'),
        trail,
    };
}
