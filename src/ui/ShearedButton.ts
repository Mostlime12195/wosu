import { Container, Graphics, type Text } from 'pixi.js';
import { tween } from '../core/Tweener';
import { lerpColor } from '../core/math';
import { icon, type IconName } from './icons';
import { label, fitText } from './text';
import { UIComponent, tweenTint } from './UIComponent';

/** lazer's global shear: the top edge leans right by 0.2 × height. */
export const SHEAR = 0.2;

/**
 * Parallelogram with rounded corners, `w` wide including the lean (the
 * top edge spans [shear, w], the bottom edge [0, w - shear]).
 */
export function drawSheared(g: Graphics, x: number, y: number, w: number, h: number, radius: number, shear = h * SHEAR): Graphics {
    const r = Math.max(0, Math.min(radius, h / 2, (w - shear) / 2));
    const pts = [
        { x: x + shear, y },
        { x: x + w, y },
        { x: x + w - shear, y: y + h },
        { x, y: y + h },
    ];
    return r > 0 ? g.roundShape(pts, r) : g.poly(pts);
}

/** Hit test matching `drawSheared` (corner rounding ignored). */
export function shearedHitArea(w: number, h: number, shear = h * SHEAR): { contains(x: number, y: number): boolean } {
    return {
        contains: (x: number, y: number) => {
            if (y < 0 || y > h) return false;
            const off = shear * (1 - y / h);
            return x >= off && x <= w - shear + off;
        },
    };
}

export interface ShearedButtonOptions {
    color?: number;
    textColor?: number;
    fontSize?: number;
    icon?: IconName;
    width?: number;
    height?: number;
    radius?: number;
}

/**
 * osu!lazer's ShearedButton (mod select footer, overlay headers): a
 * leaning slab that lightens on hover, flashes on click and squashes
 * slightly while held. The fill is drawn white and tinted.
 */
export class ShearedButton extends UIComponent {
    private readonly body = new Container();
    private readonly bg = new Graphics();
    private readonly flash = new Graphics();
    private readonly text: Text;
    private readonly glyph: Text | null = null;
    private baseColor: number;
    private fullText: string;

    constructor(caption: string, private readonly opts: ShearedButtonOptions = {}) {
        super();
        this.fullText = caption;
        this.baseColor = opts.color ?? 0x2b3a2e;
        this.bg.tint = this.baseColor;
        this.flash.alpha = 0;
        this.text = label(caption, { size: opts.fontSize ?? 16, weight: '700', color: 0xffffff });
        this.text.anchor.set(0.5);
        this.text.tint = opts.textColor ?? 0xffffff;
        this.body.addChild(this.bg, this.flash, this.text);
        if (opts.icon) {
            this.glyph = icon(opts.icon, (opts.fontSize ?? 16) - 1, 0xffffff);
            this.glyph.tint = opts.textColor ?? 0xffffff;
            this.body.addChild(this.glyph);
        }
        this.addChild(this.body);
        this.makeInteractive({ sounds: 'button' });
        this.resize(opts.width ?? 200, opts.height ?? 50);
    }

    set caption(v: string) {
        this.fullText = v;
        this.relayout();
    }

    set color(c: number) {
        this.baseColor = c;
        tweenTint(this.bg, this.hovered ? lerpColor(c, 0xffffff, 0.1) : c, 200);
    }

    set textColor(c: number) {
        tweenTint(this.text, c, 200);
        if (this.glyph) tweenTint(this.glyph, c, 200);
    }

    protected override updateHitArea(): void {
        this.hitArea = shearedHitArea(this._w, this._h);
    }

    protected override onResize(w: number, h: number): void {
        this.body.pivot.set(w / 2, h / 2);
        this.body.position.set(w / 2, h / 2);
        const r = this.opts.radius ?? 7;
        drawSheared(this.bg.clear(), 0, 0, w, h, r).fill(0xffffff);
        drawSheared(this.flash.clear(), 0, 0, w, h, r).fill(0xffffff);
        const shear = h * SHEAR;
        const iconW = this.glyph ? this.glyph.width + 8 : 0;
        fitText(this.text, w - shear - 24 - iconW, this.fullText);
        const total = iconW + this.text.width;
        const cx = w / 2;
        const start = cx - total / 2;
        if (this.glyph) this.glyph.position.set(start + this.glyph.width / 2, h / 2);
        this.text.position.set(start + iconW + this.text.width / 2, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        tweenTint(this.bg, hovered ? lerpColor(this.baseColor, 0xffffff, 0.1) : this.baseColor, 200);
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.body, { scale: pressed ? 0.95 : 1 }, pressed
            ? { duration: 2000, ease: 'OutQuint' }
            : { duration: 500, ease: 'OutElastic' });
    }

    protected override onClick(): void {
        this.flash.alpha = 0.25;
        tween(this.flash, { alpha: 0 }, { duration: 400, ease: 'OutQuint' });
    }

    protected override onEnabledChange(enabled: boolean): void {
        tween(this, { alpha: enabled ? 1 : 0.5 }, { duration: 200 });
        this.eventMode = enabled ? 'static' : 'none';
    }
}
