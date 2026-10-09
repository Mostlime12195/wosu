import { FillGradient, Graphics } from 'pixi.js';
import { UIComponent } from './UIComponent';

export interface BoxOptions {
    color?: number;
    alpha?: number;
    radius?: number;
    /** Vertical gradient: second colour at the bottom. */
    gradientTo?: number;
    gradientAlphaTo?: number;
    border?: { width: number; color: number; alpha?: number };
    /** Only round the left/right side (pill-shaped toolbars, wedge panels). */
    corners?: 'all' | 'left' | 'right' | 'top' | 'bottom' | 'none';
}

/**
 * Resizable rectangle/rounded panel. The fill is drawn white and tinted,
 * so colour changes (hover states, tweens) never re-tessellate.
 */
export class Box extends UIComponent {
    readonly g = new Graphics();
    private opts: BoxOptions;

    constructor(opts: BoxOptions = {}, w = 0, h = 0) {
        super();
        this.opts = opts;
        this.addChild(this.g);
        this.g.tint = opts.gradientTo === undefined ? (opts.color ?? 0xffffff) : 0xffffff;
        this.g.alpha = opts.alpha ?? 1;
        this.resize(w, h);
    }

    get color(): number {
        return Number(this.g.tint);
    }

    set color(c: number) {
        this.g.tint = c;
    }

    get fillAlpha(): number {
        return this.g.alpha;
    }

    set fillAlpha(a: number) {
        this.g.alpha = a;
    }

    set radius(r: number) {
        this.opts.radius = r;
        this.relayout();
    }

    setBorder(border: BoxOptions['border']): void {
        this.opts.border = border;
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const g = this.g;
        const o = this.opts;
        g.clear();
        if (w <= 0 || h <= 0) return;
        const r = Math.min(o.radius ?? 0, w / 2, h / 2);
        drawRoundedRect(g, 0, 0, w, h, r, o.corners ?? 'all');
        if (o.gradientTo !== undefined) {
            const grad = new FillGradient({
                type: 'linear',
                start: { x: 0, y: 0 },
                end: { x: 0, y: 1 },
                colorStops: [
                    { offset: 0, color: colorWithAlpha(o.color ?? 0xffffff, 1) },
                    { offset: 1, color: colorWithAlpha(o.gradientTo, o.gradientAlphaTo ?? 1) },
                ],
                textureSpace: 'local',
            });
            g.fill(grad);
        } else {
            g.fill(0xffffff);
        }
        if (o.border && o.border.width > 0) {
            const bw = o.border.width;
            drawRoundedRect(g, bw / 2, bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2), o.corners ?? 'all');
            g.stroke({ width: bw, color: o.border.color, alpha: o.border.alpha ?? 1 });
        }
    }
}

function colorWithAlpha(c: number, a: number): string {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    return `rgba(${r},${g},${b},${a})`;
}

export function drawRoundedRect(
    g: Graphics, x: number, y: number, w: number, h: number, r: number,
    corners: NonNullable<BoxOptions['corners']> = 'all',
): Graphics {
    if (r <= 0 || corners === 'none') return g.rect(x, y, w, h);
    if (corners === 'all') return g.roundRect(x, y, w, h, r);
    const tl = corners === 'left' || corners === 'top' ? r : 0;
    const tr = corners === 'right' || corners === 'top' ? r : 0;
    const br = corners === 'right' || corners === 'bottom' ? r : 0;
    const bl = corners === 'left' || corners === 'bottom' ? r : 0;
    g.moveTo(x + tl, y);
    g.lineTo(x + w - tr, y);
    if (tr) g.arcTo(x + w, y, x + w, y + tr, tr);
    g.lineTo(x + w, y + h - br);
    if (br) g.arcTo(x + w, y + h, x + w - br, y + h, br);
    g.lineTo(x + bl, y + h);
    if (bl) g.arcTo(x, y + h, x, y + h - bl, bl);
    g.lineTo(x, y + tl);
    if (tl) g.arcTo(x, y, x + tl, y, tl);
    return g.closePath();
}
