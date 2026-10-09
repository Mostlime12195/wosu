import { Graphics, Sprite, type Text, type Texture } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { scoreMultiplier, sortedMods, type ModSet } from '../../gameplay/mods';
import { ModIconRow, modCategoryColor } from '../../overlays/mods/ModIcon';
import { BackButton } from '../../ui/Button';
import { label } from '../../ui/text';
import { Colors, Metrics } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

export const FOOTER_HEIGHT = Metrics.footerHeight;
const BUTTON_WIDTH = 140;

/**
 * lazer's (classic) FooterButton: a caption under a thin light strip in
 * the button's colour; hovering lights the strip up and washes the
 * button in its colour.
 */
export class FooterButton extends UIComponent {
    protected readonly wash = new Graphics();
    protected readonly light = new Graphics();
    protected readonly glow: Sprite;
    protected readonly text: Text;

    constructor(caption: string, protected readonly color: number, glowTexture: Texture) {
        super();
        this.wash.alpha = 0;
        this.glow = new Sprite(glowTexture);
        this.glow.tint = color;
        this.glow.alpha = 0;
        this.text = label(caption, { size: 17, weight: '600' });
        this.text.anchor.set(0.5);
        this.light.alpha = 0.6;
        this.addChild(this.wash, this.glow, this.light, this.text);
        // What they open (mods, options, random) has its own sound.
        this.makeInteractive({ sounds: 'button', selectSample: null });
        this.resize(BUTTON_WIDTH, FOOTER_HEIGHT);
    }

    set caption(v: string) {
        if (this.text.text === v) return;
        this.text.text = v;
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        this.wash.clear().rect(0, 0, w, h).fill(this.color);
        this.light.clear().rect(0, 0, w, 3).fill(this.color);
        this.glow.position.set(0, 3);
        this.glow.width = w;
        this.glow.height = h * 0.6;
        this.layoutContent(w, h);
    }

    protected layoutContent(w: number, h: number): void {
        this.text.position.set(w / 2, h / 2 + 1);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.wash, { alpha: hovered ? 0.1 : 0 }, { duration: hovered ? 200 : 400 });
        tween(this.light, { alpha: hovered ? 1 : 0.6 }, { duration: 200 });
        tween(this.glow, { alpha: hovered ? 0.35 : 0 }, { duration: hovered ? 200 : 400 });
    }

    protected override onClick(): void {
        this.wash.alpha = 0.3;
        tween(this.wash, { alpha: this.hovered ? 0.1 : 0 }, { duration: 500, ease: 'OutQuint' });
    }

    /** Light the button while its popup is open. */
    set selected(v: boolean) {
        tween(this.light, { alpha: v || this.hovered ? 1 : 0.6 }, { duration: 200 });
        tween(this.glow, { alpha: v ? 0.25 : this.hovered ? 0.35 : 0 }, { duration: 200 });
    }
}

/** "mods" plus the active mod icons and the score multiplier. */
export class FooterModsButton extends FooterButton {
    private readonly icons = new ModIconRow(18, 2);
    private readonly multiplier: Text;
    /** Width changes when mods change; the footer re-flows. */
    onWidthChange: (() => void) | null = null;

    constructor(glowTexture: Texture) {
        super('mods', Colors.yellow, glowTexture);
        this.multiplier = label('', { size: 14, weight: '700', color: 0xffffff });
        this.multiplier.anchor.set(0, 0.5);
        this.addChild(this.icons, this.multiplier);
    }

    setMods(mods: ModSet): void {
        const list = sortedMods(mods);
        this.icons.setMods(list);
        const m = scoreMultiplier(mods);
        this.multiplier.visible = list.length > 0;
        this.icons.visible = list.length > 0;
        this.multiplier.text = `${m.toFixed(2)}x`;
        this.multiplier.tint = m > 1.0001 ? modCategoryColor('increase') : m < 0.9999 ? modCategoryColor('reduction') : 0xffffff;
        const content = list.length ? this.text.width + 12 + this.icons.rowWidth + 10 + this.multiplier.width + 32 : 0;
        const w = Math.max(BUTTON_WIDTH, Math.ceil(content));
        if (w !== this._w) {
            this.resize(w, FOOTER_HEIGHT);
            this.onWidthChange?.();
        } else {
            this.relayout();
        }
    }

    protected override layoutContent(w: number, h: number): void {
        if (!this.icons?.visible) {
            super.layoutContent(w, h);
            return;
        }
        let x = 16;
        this.text.position.set(x + this.text.width / 2, h / 2 + 1);
        x += this.text.width + 12;
        this.icons.position.set(x, h / 2 - 9);
        x += this.icons.rowWidth + 10;
        this.multiplier.position.set(x, h / 2 + 1);
    }
}

/**
 * Song select's bottom bar: back button, then mods / random / options.
 * The bar itself swallows clicks so nothing behind it reacts.
 */
export class SongSelectFooter extends UIComponent {
    readonly back = new BackButton();
    readonly mods: FooterModsButton;
    readonly random: FooterButton;
    readonly options: FooterButton;
    private readonly bg = new Graphics();
    private readonly buttons: FooterButton[];

    constructor(glowTexture: Texture) {
        super();
        this.mods = new FooterModsButton(glowTexture);
        this.random = new FooterButton('random', Colors.green, glowTexture);
        this.options = new FooterButton('options', Colors.blue, glowTexture);
        this.buttons = [this.mods, this.random, this.options];
        this.mods.onWidthChange = () => this.relayout();
        this.addChild(this.bg, ...this.buttons, this.back);
        this.eventMode = 'static';
        this.resize(800, FOOTER_HEIGHT);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.6 })
            .rect(0, 0, w, 1).fill({ color: 0xffffff, alpha: 0.08 });
        this.back.position.set(0, 0);
        let x = 150;
        for (const b of this.buttons) {
            b.position.set(x, 0);
            x += b.w;
        }
    }
}
