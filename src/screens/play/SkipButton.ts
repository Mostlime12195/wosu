import { Container, Graphics, type Text } from 'pixi.js';
import { damp } from '../../core/math';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';

const W = 220;
const H = 64;

/**
 * lazer's SkipOverlay button (bottom-right): "Skip" with chevrons that
 * fades in while a long intro is skippable; a thin bar shows how much
 * of the skippable stretch is left. Space or a click triggers it.
 */
export class SkipButton extends UIComponent {
    private readonly bg = new Graphics();
    private readonly bar = new Graphics();
    private readonly content = new Container();
    private readonly caption: Text;
    private readonly chevrons: Text[] = [];
    private shownAlpha = 0;
    private clock = 0;
    available = false;
    /** 0..1 of the skippable stretch remaining. */
    remaining = 1;

    constructor() {
        super();
        this.caption = label('Skip', { size: 22, weight: '700' });
        this.caption.anchor.set(0, 0.5);
        this.content.addChild(this.caption);
        for (let i = 0; i < 3; i++) {
            const c = icon('chevronRight', 16, 0xffffff);
            this.chevrons.push(c);
            this.content.addChild(c);
        }
        this.addChild(this.bg, this.content, this.bar);
        this.makeInteractive({ sounds: 'button' });
        this.resize(W, H);
        this.alpha = 0;
        this.visible = false;
    }

    protected override onResize(w: number, h: number): void {
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
        // Chevrons ripple left to right; brighter while hovered.
        this.chevrons.forEach((c, i) => {
            const phase = (this.clock / 600 - i * 0.2) % 1;
            c.alpha = (this.hovered ? 0.6 : 0.35) + 0.4 * Math.max(0, Math.sin(phase * Math.PI));
        });
        const w = this._w, h = this._h;
        this.bar.clear().roundRect(10, h - 7, (w - 20) * Math.max(0, Math.min(1, this.remaining)), 3, 1.5).fill({ color: 0xffffff, alpha: 0.7 });
    }

    protected override onHoverChange(hovered: boolean): void {
        this.content.scale.set(hovered ? 1.05 : 1);
    }
}
