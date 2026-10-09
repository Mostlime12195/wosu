import { Container, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { tween } from '../../core/Tweener';
import { lerpColor } from '../../core/math';
import type { Action } from '../../input/bindings';
import { drawSheared, shearedHitArea } from '../../ui/ShearedButton';
import { icon, type IconName } from '../../ui/icons';
import { label } from '../../ui/text';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { FOOTER_HEIGHT } from './Footer';
import { shadeGradient } from './visuals';

const BAND = 120;
const BUTTON_W = 150;
const BUTTON_H = 74;

export interface BeatmapOption {
    icon: IconName;
    first: string;
    second: string;
    color: number;
    action: () => void;
    /** Greyed out (e.g. nothing selected). */
    enabled?: () => boolean;
}

/** lazer's BeatmapOptionButton: coloured slab, icon, two-line caption. */
class OptionButton extends UIComponent {
    private readonly body = new Container();
    private readonly bg = new Graphics();
    private readonly glyph: Text;
    private readonly first: Text;
    private readonly second: Text;

    constructor(readonly option: BeatmapOption) {
        super();
        this.bg.tint = option.color;
        this.glyph = icon(option.icon, 20, 0xffffff);
        this.first = label(option.first, { size: 14, weight: '700' });
        this.second = label(option.second, { size: 12, weight: '500' });
        this.first.anchor.set(0.5, 0);
        this.second.anchor.set(0.5, 0);
        this.body.addChild(this.bg, this.glyph, this.first, this.second);
        this.addChild(this.body);
        this.makeInteractive();
        this.resize(BUTTON_W, BUTTON_H);
    }

    protected override updateHitArea(): void {
        this.hitArea = shearedHitArea(this._w, this._h);
    }

    protected override onResize(w: number, h: number): void {
        this.body.pivot.set(w / 2, h / 2);
        this.body.position.set(w / 2, h / 2);
        drawSheared(this.bg.clear(), 0, 0, w, h, 8).fill(0xffffff);
        this.glyph.position.set(w / 2, 20);
        this.first.position.set(w / 2, 36);
        this.second.position.set(w / 2, 53);
    }

    protected override onHoverChange(hovered: boolean): void {
        tweenTint(this.bg, hovered ? lerpColor(this.option.color, 0xffffff, 0.15) : this.option.color, 200);
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.body, { scale: pressed ? 0.94 : 1 }, pressed ? { duration: 1000, ease: 'OutQuint' } : { duration: 500, ease: 'OutElastic' });
    }

    protected override onEnabledChange(enabled: boolean): void {
        this.alpha = enabled ? 1 : 0.4;
        this.eventMode = enabled ? 'static' : 'none';
    }
}

/**
 * lazer's BeatmapOptionsOverlay: a band of big buttons that rises above
 * the footer's "options" button. Picking one closes the band first.
 */
export class BeatmapOptionsOverlay extends Overlay {
    override readonly exclusive = false;
    private readonly band = new Container();
    private readonly shade = new Graphics();
    private readonly buttons: OptionButton[];

    constructor(game: Game, options: BeatmapOption[]) {
        super(game);
        this.backdropAlpha = 0.2;
        this.shade.eventMode = 'static';
        this.band.addChild(this.shade);
        this.buttons = options.map(o => {
            const b = new OptionButton(o);
            b.onActivate = () => {
                this.hide();
                o.action();
            };
            this.band.addChild(b);
            return b;
        });
        this.addChild(this.band);
    }

    protected layout(w: number, h: number): void {
        this.shade.clear().rect(0, 0, w, BAND).fill(shadeGradient(0, 0.8, true));
        this.band.position.set(0, h - FOOTER_HEIGHT - BAND);
        const gap = 10;
        const total = this.buttons.length * BUTTON_W + (this.buttons.length - 1) * gap;
        let x = Math.round((w - total) / 2);
        for (const b of this.buttons) {
            b.position.set(x, BAND - BUTTON_H - 18);
            x += BUTTON_W + gap;
        }
    }

    protected popIn(): void {
        for (const b of this.buttons) b.enabled = b.option.enabled?.() ?? true;
        this.band.alpha = 0;
        this.buttons.forEach((b, i) => {
            b.y = BAND;
            tween(b, { y: BAND - BUTTON_H - 18 }, { duration: 500, delay: i * 30, ease: 'OutQuint' });
        });
        tween(this.band, { alpha: 1 }, { duration: 250 });
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (super.onKey(e, action)) return true;
        // Keep type-to-search from reaching song select underneath.
        return !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1;
    }

    protected async popOut(): Promise<void> {
        await tween(this.band, { alpha: 0 }, { duration: 200 }).finished;
    }
}
