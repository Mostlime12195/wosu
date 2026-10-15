import { Graphics, type Text, type Texture } from 'pixi.js';
import type { ReadonlyBindable } from '../core/Bindable';
import { drawRoundedRect } from './Box';
import { fillCover } from './coverFill';
import { icon } from './icons';
import { Colors } from './theme';
import { UIComponent } from './UIComponent';

/**
 * lazer's UpdateableAvatar: the player's picture in a rounded square (or
 * circle), or the default avatar (a grey tile with the user glyph). Bound
 * to the profile's avatar, it follows a newly uploaded picture.
 */
export class Avatar extends UIComponent {
    private readonly g = new Graphics();
    private readonly glyph: Text;
    private texture: Texture | null = null;
    private readonly baseSize: number;

    constructor(size: number, source: ReadonlyBindable<Texture | null> | Texture | null = null, private readonly opts: { radius?: number; circle?: boolean } = {}) {
        super();
        this.baseSize = size;
        this.glyph = icon('user', Math.round(size * 0.5), Colors.grayC);
        this.addChild(this.g, this.glyph);
        this.eventMode = 'none';
        if (source && 'changed' in source) this.disposer.add(source.bind(t => this.setTexture(t), true));
        else this.texture = source;
        this.resize(size, size);
    }

    setTexture(tex: Texture | null): void {
        this.texture = tex && !tex.destroyed ? tex : null;
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const r = this.opts.circle ? Math.min(w, h) / 2 : this.opts.radius ?? Math.round(Math.min(w, h) * 0.2);
        const g = this.g.clear();
        const tex = this.texture;
        if (tex) fillCover(g, tex, 0, 0, w, h, r);
        else drawRoundedRect(g, 0, 0, w, h, r).fill(Colors.gray4);
        this.glyph.visible = !tex;
        // Icon styles are shared: scale the glyph rather than restyle it.
        this.glyph.scale.set(Math.min(w, h) / this.baseSize);
        this.glyph.position.set(w / 2, h / 2);
    }
}
