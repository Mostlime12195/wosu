import { Container, Sprite } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { SKIN_DEFAULTS } from '../../skin/SkinIni';

/** lazer's LegacyFont (the two HUD fonts). */
export type LegacyFontKind = 'score' | 'combo';

/** Characters a fixed-width font keeps at their own width (lazer's FixedWidthExcludeCharacters). */
const FIXED_WIDTH_EXCLUDE = new Set([',', '.', '%', 'x']);

/**
 * A skin's score or combo font (lazer's LegacyGlyphStore + GetFontPrefix /
 * GetFontOverlap): glyphs `${prefix}-0` … `${prefix}-x` from the skin
 * chain, and the overlap of the skin that actually provides the font, so
 * a skin that leaves ComboOverlap out gets osu!'s 0 rather than the
 * overlap of wosu!'s default skin underneath it.
 */
export class LegacyFont {
    readonly prefix: string;
    /** Display units each glyph overlaps the previous one; negative spreads them out. */
    readonly overlap: number;
    private readonly cache = new Map<string, SkinTexture | null>();

    constructor(private readonly chain: SkinChain, readonly kind: LegacyFontKind) {
        const prefixKey = kind === 'score' ? 'scorePrefix' : 'comboPrefix';
        const overlapKey = kind === 'score' ? 'scoreOverlap' : 'comboOverlap';
        this.prefix = chain.config(prefixKey);
        let overlap = SKIN_DEFAULTS[overlapKey];
        for (const l of chain.layers) {
            if (!l.skin || l.textures === false) continue;
            if (l.skin.texture(`${this.prefix}-0`)) {
                overlap = l.skin.config[overlapKey] ?? SKIN_DEFAULTS[overlapKey];
                break;
            }
        }
        this.overlap = overlap;
    }

    glyph(ch: string): SkinTexture | null {
        let g = this.cache.get(ch);
        if (g === undefined) {
            g = this.chain.glyph(this.kind === 'score' ? 'scorePrefix' : 'comboPrefix', ch);
            this.cache.set(ch, g);
        }
        return g;
    }

    /** Display width of a glyph (@2x images count half). */
    width(ch: string): number {
        const g = this.glyph(ch);
        return g ? g.texture.width * g.scale : 0;
    }
}

/**
 * lazer's LegacySpriteText: text drawn with a skin font's glyph images in
 * display units (@2x glyphs at half size), glyphs top-aligned, spaced by
 * -overlap. With `fixedWidth`, digits take the width of "5" and are
 * centred in it (o!f's fixed-width text), so rolling numbers don't jitter.
 * The origin is the text's top-left, or its top-right with `alignRight`.
 * Sprites are reused, so changing the text every frame allocates nothing.
 */
export class LegacySpriteText extends Container {
    private readonly sprites: Sprite[] = [];
    private current: string | null = null;
    /** Size of the current text in display units (before this container's scale). */
    textWidth = 0;
    textHeight = 0;
    private readonly fixed: number;

    constructor(readonly font: LegacyFont, private readonly opts: { fixedWidth?: boolean; alignRight?: boolean } = {}) {
        super();
        this.eventMode = 'none';
        this.fixed = opts.fixedWidth ? font.width('5') : 0;
    }

    set text(s: string) {
        if (s === this.current) return;
        this.current = s;
        while (this.sprites.length < s.length) {
            const sp = new Sprite();
            this.sprites.push(sp);
            this.addChild(sp);
        }
        const overlap = this.font.overlap;
        let x = 0;
        let h = 0;
        let n = 0;
        for (let i = 0; i < this.sprites.length; i++) {
            const sp = this.sprites[i];
            const g = i < s.length ? this.font.glyph(s[i]) : null;
            if (!g) {
                sp.visible = false;
                continue;
            }
            if (n++ > 0) x -= overlap;
            const w = g.texture.width * g.scale;
            const advance = this.fixed && !FIXED_WIDTH_EXCLUDE.has(s[i]) ? this.fixed : w;
            sp.visible = true;
            sp.texture = g.texture;
            sp.scale.set(g.scale);
            sp.x = x + (advance - w) / 2;
            sp.y = 0;
            x += advance;
            h = Math.max(h, g.texture.height * g.scale);
        }
        this.textWidth = Math.max(0, x);
        this.textHeight = h;
        if (this.opts.alignRight) {
            for (const sp of this.sprites) sp.x -= this.textWidth;
        }
    }

    get text(): string {
        return this.current ?? '';
    }
}
