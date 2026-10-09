import { Container, Sprite } from 'pixi.js';
import type { SkinChain } from '../../skin/SkinChain';

type FontPrefix = 'hitCirclePrefix' | 'scorePrefix' | 'comboPrefix';
const OVERLAP = { hitCirclePrefix: 'hitCircleOverlap', scorePrefix: 'scoreOverlap', comboPrefix: 'comboOverlap' } as const;

/**
 * lazer's LegacySpriteText (non fixed-width): a skin font's glyph images
 * laid out left to right, each advancing by its own width minus the
 * font's overlap, top-aligned (UseFullGlyphHeight = false). `originX` /
 * `originY` (0..1) pick the origin within the text's bounds, like an
 * osu-framework Origin. Characters the skin has no image for are skipped.
 */
export class LegacySpriteText extends Container {
    private current = '';
    private readonly sprites: Sprite[] = [];

    constructor(
        private readonly chain: SkinChain,
        private readonly font: FontPrefix,
        private readonly originX = 0.5,
        private readonly originY = 0.5,
    ) {
        super();
        this.eventMode = 'none';
    }

    get text(): string {
        return this.current;
    }

    set text(value: string) {
        if (value === this.current) return;
        this.current = value;
        const overlap = this.chain.config(OVERLAP[this.font]);
        let x = 0, height = 0, n = 0;
        for (const ch of value) {
            const g = this.chain.glyph(this.font, ch);
            if (!g) continue;
            let s = this.sprites[n];
            if (!s) {
                s = new Sprite();
                s.eventMode = 'none';
                this.sprites.push(s);
                this.addChild(s);
            }
            s.texture = g.texture;
            s.scale.set(g.scale);
            s.visible = true;
            if (n > 0) x -= overlap;
            s.position.set(x, 0);
            x += g.texture.width * g.scale;
            height = Math.max(height, g.texture.height * g.scale);
            n++;
        }
        for (let i = n; i < this.sprites.length; i++) this.sprites[i].visible = false;
        this.pivot.set(x * this.originX, height * this.originY);
    }
}
