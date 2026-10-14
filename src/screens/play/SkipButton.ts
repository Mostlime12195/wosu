import { Container, Graphics, Sprite, type Text } from 'pixi.js';
import { damp } from '../../core/math';
import type { SkinTexture } from '../../skin/LegacySkin';
import { opaqueBounds, type PixelRect } from '../../skin/opaqueBounds';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';

const W = 220;
const H = 64;

/** A skin's play-skip (play-skip-N frames) and how fast they animate. */
export interface SkinSkip {
    frames: SkinTexture[];
    frameDuration: number;
}

/**
 * lazer's SkipOverlay button (bottom-right): "Skip" with chevrons that
 * fades in while a long intro is skippable; a thin bar shows how much
 * of the skippable stretch is left. Space or a click triggers it.
 *
 * With a skin's play-skip it is stable's instead: the (animatable) image
 * anchored to the screen's bottom-right corner at stable's size (768-high
 * units), lighting up while hovered. Its bounds (x, y, w, h) are the
 * image's visible pixels, so a full-frame play-skip is only clickable
 * where the button is drawn.
 */
export class SkipButton extends UIComponent {
    private readonly bg = new Graphics();
    private readonly bar = new Graphics();
    private readonly content = new Container();
    private readonly caption: Text;
    private readonly chevrons: Text[] = [];
    private readonly skinSprite: Sprite | null = null;
    private readonly skinHover: Sprite | null = null;
    /** Union of the frames' visible pixels (texture units). */
    private readonly skinBounds: PixelRect | null = null;
    private shownAlpha = 0;
    private hoverGlow = 0;
    private clock = 0;
    available = false;
    /** 0..1 of the skippable stretch remaining. */
    remaining = 1;

    constructor(private readonly skin: SkinSkip | null = null) {
        super();
        this.caption = label('Skip', { size: 22, weight: '700' });
        this.caption.anchor.set(0, 0.5);
        if (skin?.frames.length) {
            const first = skin.frames[0];
            this.skinSprite = new Sprite(first.texture);
            this.skinHover = new Sprite(first.texture);
            this.skinHover.blendMode = 'add';
            this.skinHover.alpha = 0;
            this.skinBounds = skin.frames.map(f => opaqueBounds(f.texture)).reduce((a, b) => {
                const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
                return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
            });
            this.addChild(this.skinSprite, this.skinHover);
        } else {
            this.content.addChild(this.caption);
            for (let i = 0; i < 3; i++) {
                const c = icon('chevronRight', 16, 0xffffff);
                this.chevrons.push(c);
                this.content.addChild(c);
            }
            this.addChild(this.bg, this.content, this.bar);
        }
        this.makeInteractive({ sounds: 'button' });
        this.resize(W, H);
        this.alpha = 0;
        this.visible = false;
    }

    /** Place the button on a w×h screen. */
    layout(w: number, h: number): void {
        const sprite = this.skinSprite, b = this.skinBounds;
        if (!sprite || !b || !this.skin) {
            this.position.set(w - W - 24, h - H - 130);
            return;
        }
        // Bottom-right origin at the screen's corner; this component spans the visible part.
        const tex = this.skin.frames[0];
        const s = (h / 768) * tex.scale;
        const left = w - tex.texture.width * s, top = h - tex.texture.height * s;
        this.position.set(left + b.x * s, top + b.y * s);
        for (const sp of [sprite, this.skinHover!]) {
            sp.scale.set(s);
            sp.position.set(-b.x * s, -b.y * s);
        }
        this.resize(b.width * s, b.height * s);
    }

    protected override onResize(w: number, h: number): void {
        if (this.skinSprite) return;
        this.bg.clear().roundRect(0, 0, w, h, 10).fill({ color: 0x000000, alpha: 0.5 })
            .roundRect(0, 0, w, h, 10).stroke({ width: 2, color: 0xffffff, alpha: 0.25 });
        this.caption.position.set(w / 2 - 50, h / 2 - 2);
        this.chevrons.forEach((c, i) => c.position.set(w / 2 + 22 + i * 13, h / 2 - 2));
    }

    update(dt: number): void {
        this.clock += dt;
        this.shownAlpha = damp(this.shownAlpha, this.available ? 1 : 0, 80, dt);
        this.alpha = this.shownAlpha;
        this.visible = this.shownAlpha > 0.01;
        this.eventMode = this.available ? 'static' : 'none';
        if (this.skinSprite && this.skin) {
            const { frames, frameDuration } = this.skin;
            const tex = frames[Math.floor(this.clock / frameDuration) % frames.length].texture;
            this.skinSprite.texture = this.skinHover!.texture = tex;
            this.hoverGlow = damp(this.hoverGlow, this.hovered ? 0.3 : 0, 60, dt);
            this.skinHover!.alpha = this.hoverGlow;
            return;
        }
        // Chevrons ripple left to right; brighter while hovered.
        this.chevrons.forEach((c, i) => {
            const phase = (this.clock / 600 - i * 0.2) % 1;
            c.alpha = (this.hovered ? 0.6 : 0.35) + 0.4 * Math.max(0, Math.sin(phase * Math.PI));
        });
        const w = this._w, h = this._h;
        this.bar.clear().roundRect(10, h - 7, (w - 20) * Math.max(0, Math.min(1, this.remaining)), 3, 1.5).fill({ color: 0xffffff, alpha: 0.7 });
    }

    protected override onHoverChange(hovered: boolean): void {
        if (!this.skinSprite) this.content.scale.set(hovered ? 1.05 : 1);
    }
}
