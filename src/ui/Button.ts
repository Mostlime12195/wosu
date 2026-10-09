import { Container, Graphics, type Text, type Texture } from 'pixi.js';
import { tween } from '../core/Tweener';
import { lerpColor } from '../core/math';
import { Box, drawRoundedRect } from './Box';
import { icon, Icons, type IconName } from './icons';
import { label, fitText } from './text';
import { Colors } from './theme';
import { Triangles } from './Triangles';
import { UIComponent, tweenTint } from './UIComponent';

export interface ButtonOptions {
    color?: number;
    textColor?: number;
    radius?: number;
    fontSize?: number;
    weight?: '400' | '500' | '600' | '700' | '800';
    icon?: IconName;
    /** Texture for lazer-style drifting triangles (pass skin.tex('triangle')). */
    triangles?: Texture;
    width?: number;
    height?: number;
    /** Sample played when pressed (default: lazer's button-select). */
    selectSample?: string;
}

/**
 * osu!lazer's rounded (triangle) button: coloured body, white flash on
 * hover, elastic squash on press. Content scales around the centre via
 * an inner container so the button's own position stays put.
 */
export class Button extends UIComponent {
    protected readonly body = new Container();
    protected readonly bg: Box;
    protected readonly flash = new Graphics();
    protected readonly text: Text;
    protected readonly iconText: Text | null = null;
    protected triangles: Triangles | null = null;
    private baseColor: number;
    private fullText: string;

    constructor(content: string, protected opts: ButtonOptions = {}) {
        super();
        this.fullText = content;
        this.baseColor = opts.color ?? Colors.pink;
        this.bg = new Box({ color: this.baseColor, radius: opts.radius ?? 5 });
        this.body.addChild(this.bg);
        if (opts.triangles) {
            this.triangles = new Triangles(opts.triangles, {
                colorLight: lerpColor(this.baseColor, 0xffffff, 0.12),
                colorDark: lerpColor(this.baseColor, 0x000000, 0.12),
                maskRadius: opts.radius ?? 5,
                velocity: 0.6,
                density: 0.9,
            });
            this.body.addChild(this.triangles);
        }
        this.flash.alpha = 0;
        this.body.addChild(this.flash);
        this.text = label(content, {
            size: opts.fontSize ?? 15,
            weight: opts.weight ?? '700',
            color: opts.textColor ?? 0xffffff,
        });
        this.text.anchor.set(0.5);
        this.body.addChild(this.text);
        if (opts.icon) {
            this.iconText = icon(opts.icon, (opts.fontSize ?? 15) + 1, opts.textColor ?? 0xffffff);
            this.body.addChild(this.iconText);
        }
        this.addChild(this.body);
        this.makeInteractive({ sounds: 'button', selectSample: opts.selectSample });
        this.resize(opts.width ?? 140, opts.height ?? 40);
    }

    set caption(v: string) {
        this.fullText = v;
        this.relayout();
    }

    get caption(): string {
        return this.fullText;
    }

    set color(c: number) {
        this.baseColor = c;
        this.bg.color = c;
        this.triangles?.setColors(lerpColor(c, 0xffffff, 0.12), lerpColor(c, 0x000000, 0.12));
    }

    get color(): number {
        return this.baseColor;
    }

    protected override onResize(w: number, h: number): void {
        this.body.pivot.set(w / 2, h / 2);
        this.body.position.set(w / 2, h / 2);
        this.bg.resize(w, h);
        this.triangles?.resize(w, h);
        this.flash.clear();
        drawRoundedRect(this.flash, 0, 0, w, h, this.opts.radius ?? 5).fill(0xffffff);
        const iconW = this.iconText ? this.iconText.width + 8 : 0;
        fitText(this.text, w - 16 - iconW, this.fullText);
        const total = iconW + this.text.width;
        const startX = (w - total) / 2;
        if (this.iconText) this.iconText.position.set(startX + this.iconText.width / 2, h / 2);
        this.text.position.set(startX + iconW + this.text.width / 2, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.flash, { alpha: hovered ? 0.12 : 0 }, { duration: hovered ? 200 : 500 });
        tweenTint(this.bg.g, hovered ? lerpColor(this.baseColor, 0xffffff, 0.1) : this.baseColor, 200);
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.body, { scale: pressed ? 0.95 : 1 }, pressed
            ? { duration: 1000, ease: 'OutQuint' }
            : { duration: 600, ease: 'OutElastic' });
    }

    protected override onClick(): void {
        this.flash.alpha = 0.35;
        tween(this.flash, { alpha: this.hovered ? 0.12 : 0 }, { duration: 400 });
    }

    protected override onEnabledChange(enabled: boolean): void {
        tween(this, { alpha: enabled ? 1 : 0.5 }, { duration: 200 });
        this.eventMode = enabled ? 'static' : 'none';
    }
}

/** Square/circular icon-only button (toolbar, player controls). */
export class IconButton extends UIComponent {
    readonly glyph: Text;
    private readonly hoverBg = new Graphics();
    private _active = false;

    constructor(
        name: IconName,
        private readonly opts: { size?: number; iconSize?: number; color?: number; hoverColor?: number; circle?: boolean; activeColor?: number } = {},
    ) {
        super();
        const size = opts.size ?? 36;
        this.hoverBg.alpha = 0;
        this.addChild(this.hoverBg);
        this.glyph = icon(name, opts.iconSize ?? Math.round(size * 0.45), opts.color ?? 0xffffff);
        this.addChild(this.glyph);
        this.makeInteractive();
        this.resize(size, size);
    }

    setIcon(name: IconName): void {
        this.glyph.text = Icons[name];
    }

    set active(v: boolean) {
        this._active = v;
        this.glyph.tint = v ? (this.opts.activeColor ?? Colors.pink) : 0xffffff;
    }

    get active(): boolean {
        return this._active;
    }

    protected override onResize(w: number, h: number): void {
        this.glyph.position.set(w / 2, h / 2);
        this.hoverBg.clear();
        if (this.opts.circle) this.hoverBg.circle(w / 2, h / 2, Math.min(w, h) / 2);
        else this.hoverBg.rect(0, 0, w, h);
        this.hoverBg.fill(this.opts.hoverColor ?? 0xffffff);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.hoverBg, { alpha: hovered ? 0.12 : 0 }, { duration: 200 });
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.glyph, { scale: pressed ? 0.85 : 1 }, { duration: pressed ? 200 : 500, ease: pressed ? 'OutQuint' : 'OutElastic' });
    }

    protected override onEnabledChange(enabled: boolean): void {
        this.alpha = enabled ? 1 : 0.4;
        this.eventMode = enabled ? 'static' : 'none';
    }
}

/**
 * lazer's bottom-left back button: a pink sheared tab with an arrow and
 * "back" label that slides out further on hover.
 */
export class BackButton extends UIComponent {
    private readonly shape = new Graphics();
    private readonly arrow: Text;
    private readonly caption: Text;
    private readonly content = new Container();
    extend = 0;

    constructor() {
        super();
        this.addChild(this.shape);
        this.arrow = icon('chevronLeft', 18, 0xffffff);
        this.caption = label('back', { size: 18, weight: '600' });
        this.caption.anchor.set(0, 0.5);
        this.content.addChild(this.arrow, this.caption);
        this.addChild(this.content);
        this.makeInteractive();
        this.resize(140, 50);
    }

    protected override onResize(_w: number, h: number): void {
        this.redraw();
        this.arrow.position.set(32, h / 2);
        this.caption.position.set(52, h / 2);
    }

    private redraw(): void {
        const h = this._h;
        const w = 120 + this.extend;
        const shear = h * 0.2;
        const g = this.shape;
        g.clear();
        g.poly([0, 0, w + shear, 0, w, h, 0, h]).fill(Colors.pink);
        g.poly([w - 8 + shear, 0, w + shear + 4, 0, w + 4, h, w - 8, h]).fill({ color: Colors.pinkDark });
    }

    protected override onHoverChange(hovered: boolean): void {
        // One animated value drives the shape and the label, so they never drift apart.
        tween(this, { extend: hovered ? 20 : 0 }, {
            duration: 400,
            ease: 'OutElastic',
            onUpdate: () => {
                this.content.x = this.extend / 2;
                this.redraw();
            },
        });
    }
}
