import { Container, Sprite, type Texture } from 'pixi.js';
import type { Skin } from '../../skin/Skin';

const NAMES: Record<string, string> = { '.': 'score-..png', '%': 'score-percent.png', x: 'score-x.png' };

/**
 * Text drawn with the skin's score font sprites (score-0.png … score-x.png),
 * like stable's score/combo counters. Sprites are reused between updates,
 * so changing the text every frame allocates nothing.
 */
export class SpriteText extends Container {
    private readonly sprites: Sprite[] = [];
    private current = '';
    /** Width in unscaled texture pixels of the current text. */
    textWidth = 0;
    readonly glyphHeight: number;

    constructor(private readonly skin: Skin, private readonly overlap = 12, private readonly anchorX = 0) {
        super();
        this.eventMode = 'none';
        this.glyphHeight = skin.get('score-0.png').height || 76;
    }

    private tex(ch: string): Texture {
        return this.skin.get(NAMES[ch] ?? `score-${ch}.png`);
    }

    set text(s: string) {
        if (s === this.current) return;
        this.current = s;
        while (this.sprites.length < s.length) {
            const sp = new Sprite();
            sp.anchor.set(0, 0.5);
            this.sprites.push(sp);
            this.addChild(sp);
        }
        let x = 0;
        for (let i = 0; i < this.sprites.length; i++) {
            const sp = this.sprites[i];
            if (i >= s.length) {
                sp.visible = false;
                continue;
            }
            sp.visible = true;
            sp.texture = this.tex(s[i]);
            sp.x = x;
            // Narrow glyphs (the decimal point) barely overlap their neighbours.
            x += sp.texture.width - Math.min(this.overlap, sp.texture.width * 0.12);
        }
        this.textWidth = Math.max(0, x);
        const shift = -this.textWidth * this.anchorX;
        for (let i = 0; i < s.length; i++) this.sprites[i].x += shift;
    }

    get text(): string {
        return this.current;
    }
}
