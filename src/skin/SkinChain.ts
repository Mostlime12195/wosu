import { SKIN_DEFAULTS, type SkinConfig } from './SkinIni';
import type { LegacySkin, SkinTexture } from './LegacySkin';

/** One source in a chain, with what it may provide (lazer's beatmap skin toggles). */
export interface SkinLayer {
    skin: LegacySkin | null;
    textures?: boolean;
    samples?: boolean;
    /** Config this layer contributes (a beatmap's .osu colours); defaults to its skin.ini. */
    config?: SkinConfig | null;
    /** Contribute config at all (off for a beatmap with "Beatmap colours" disabled). */
    useConfig?: boolean;
}

type Resolved = typeof SKIN_DEFAULTS;

/**
 * The skins in effect, highest priority first (lazer's skin source chain):
 * beatmap skin → the selected skin → wosu!'s default skin. Every element,
 * sound and setting comes from the first layer that has it, so a beatmap
 * that only ships a hitcircle.png still gets the rest from the skin below.
 */
export class SkinChain {
    constructor(readonly layers: SkinLayer[]) {}

    texture(name: string): SkinTexture | null {
        for (const l of this.layers) {
            if (!l.skin || l.textures === false) continue;
            const t = l.skin.texture(name);
            if (t) return t;
        }
        return null;
    }

    /** Animation frames from the first layer that has the element at all (frames don't mix across skins). */
    frames(name: string, animatable = true): SkinTexture[] {
        for (const l of this.layers) {
            if (!l.skin || l.textures === false) continue;
            const f = l.skin.frames(name, animatable);
            if (f.length) return f;
        }
        return [];
    }

    /** ms per frame for an animation of `count` frames (skin.ini AnimationFramerate; -1 = all frames over a second). */
    frameDuration(count: number): number {
        const fps = this.config('animationFramerate');
        if (fps > 0) return 1000 / fps;
        return 1000 / Math.max(1, count);
    }

    /** A sample from the first layer that has it; undefined if none (use the game's own). */
    sample(name: string, index = 1): AudioBuffer | null | undefined {
        for (const l of this.layers) {
            if (!l.skin || l.samples === false) continue;
            const s = l.skin.sample(name, index);
            if (s !== undefined) return s;
        }
        return undefined;
    }

    config<K extends keyof Resolved>(key: K): Resolved[K] {
        for (const l of this.layers) {
            if (l.useConfig === false) continue;
            const c = l.config ?? l.skin?.config;
            const v = c?.[key as keyof SkinConfig];
            if (v !== undefined && !(Array.isArray(v) && v.length === 0)) return v as Resolved[K];
        }
        return SKIN_DEFAULTS[key];
    }

    /** The skin's name of a font glyph ("score" + "3" → score-3, "." → score-dot). */
    glyph(prefix: 'hitCirclePrefix' | 'scorePrefix' | 'comboPrefix', ch: string): SkinTexture | null {
        const p = this.config(prefix);
        const suffix = ch === '.' ? 'dot' : ch === ',' ? 'comma' : ch === '%' ? 'percent' : ch;
        return this.texture(`${p}-${suffix}`);
    }
}
