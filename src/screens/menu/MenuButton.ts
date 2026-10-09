import { Container, Graphics, type FederatedPointerEvent, type Text } from 'pixi.js';
import { tween, type Tween } from '../../core/Tweener';
import { clamp01, lerpColor } from '../../core/math';
import { icon, type IconName } from '../../ui/icons';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';

/** lazer's ButtonSystem.BUTTON_WIDTH is 140; a little wider so the bar breathes. */
export const MENU_BUTTON_WIDTH = 160;
/** lazer ButtonArea.BUTTON_AREA_HEIGHT. */
export const MENU_BUTTON_HEIGHT = 100;
/** lazer ButtonSystem.WEDGE_WIDTH: horizontal shear offset, and the (negative) flow spacing. */
export const MENU_WEDGE = 20;

const HOVER_SCALE = 1.2;
const BOUNCE_COMPRESSION = 0.9;
const BOUNCE_ROTATION = (8 * Math.PI) / 180;

export type MenuButtonState = 'contracted' | 'expanded' | 'exploded';

export interface MenuBeat {
    beatLength: number;
    phase: number;
}

/**
 * lazer's MainMenuButton: a sheared coloured slab with an icon over its
 * caption. The button never positions itself: `widthScale` (animated by
 * state changes and hover) gives its current slot width, and the menu
 * lays every button out from those widths in one pass per frame, so
 * neighbours move with the elastic hover exactly (no gaps, no overlap).
 *
 * The slot spans x ∈ [0, slotWidth]; the slab is sheared around its
 * vertical centre (top edge +WEDGE/2, bottom edge −WEDGE/2), like lazer's
 * `Shear = WEDGE_WIDTH / height` background.
 */
export class MenuButton extends UIComponent {
    private readonly shadow = new Graphics();
    private readonly slab = new Graphics();
    private readonly flash = new Graphics();
    private readonly content = new Container();
    private readonly iconHolder = new Container();
    private readonly glyph: Text;
    private readonly caption: Text;
    /** Width with padding at scale 1 (lazer's initialSize.X). */
    readonly baseWidth: number;
    /** Current slot width = baseWidth × widthScale; animated. */
    widthScale = 0;
    private drawnWidth = -1;
    private _state: MenuButtonState = 'contracted';
    private rightward = false;
    private glyphChain: Tween | null = null;
    readonly hotkeys: string[];
    /** Beat timing for the hover icon bounce (time until the next beat). */
    beatSource: (() => MenuBeat) | null = null;

    constructor(
        text: string,
        iconName: IconName,
        private readonly color: number,
        hotkeys: string[] = [],
        private readonly pad: { left?: number; right?: number } = {},
        /** lazer's MainMenuButton sampleName (play uses its own). */
        selectSample: string = 'Menu/button-default-select',
    ) {
        super();
        this.hotkeys = hotkeys;
        this.baseWidth = MENU_BUTTON_WIDTH + (pad.left ?? 0) + (pad.right ?? 0);
        this.glyph = icon(iconName, 32, 0xffffff);
        this.caption = label(text, { size: 16, weight: '600', shadow: true });
        this.caption.anchor.set(0.5, 1);
        this.flash.alpha = 0;
        this.flash.blendMode = 'add';
        this.iconHolder.addChild(this.glyph);
        this.content.addChild(this.iconHolder, this.caption);
        this.addChild(this.shadow, this.slab, this.flash, this.content);
        this.makeInteractive({ sounds: 'menu', selectSample });
        this._h = MENU_BUTTON_HEIGHT;
        this.alpha = 0;
        this.visible = false;
        this.hitArea = {
            contains: (x: number, y: number) => {
                if (this._state !== 'expanded' || this.widthScale < 0.8) return false;
                const h = MENU_BUTTON_HEIGHT;
                if (y < 0 || y > h) return false;
                const off = MENU_WEDGE * (0.5 - y / h);
                return x >= off && x <= this.slotWidth + off;
            },
        };
        this.sync();
    }

    get state(): MenuButtonState {
        return this._state;
    }

    get slotWidth(): number {
        return Math.max(0, this.baseWidth * this.widthScale);
    }

    /** Takes part in the flow (lazer's IsPresent). */
    get present(): boolean {
        return this._state === 'expanded' || this.alpha > 0;
    }

    /** lazer MainMenuButton.animateState. `contractSlow` = ContractStyle 1 (entering a mode). */
    setState(s: MenuButtonState, opts: { delay?: number; contractSlow?: boolean } = {}): void {
        const delay = opts.delay ?? 0;
        if (s === this._state) return;
        this._state = s;
        this.enabled = s === 'expanded';
        switch (s) {
            case 'contracted':
                if (opts.contractSlow) tween(this, { widthScale: 0 }, { duration: 400, ease: 'InSine', delay });
                else tween(this, { widthScale: 0 }, { duration: 500, ease: 'OutExpo', delay });
                this.fadeOutTo(opts.contractSlow ? 800 : 500, delay);
                break;
            case 'expanded':
                this.visible = true;
                tween(this, { widthScale: 1 }, { duration: 500, ease: 'OutExpo', delay });
                tween(this, { alpha: 1 }, { duration: 500 / 6, ease: 'None', delay });
                break;
            case 'exploded':
                tween(this, { widthScale: 2 }, { duration: 200, ease: 'OutExpo', delay });
                this.fadeOutTo(150, delay);
                break;
        }
    }

    /** Jump all state animations to their end (used for instant layout). */
    finishState(): void {
        this.widthScale = this._state === 'expanded' ? 1 : this._state === 'exploded' ? 2 : 0;
        this.alpha = this._state === 'expanded' ? 1 : 0;
        tween(this, { widthScale: this.widthScale, alpha: this.alpha }, { duration: 0 });
        this.visible = this._state === 'expanded';
        this.sync();
    }

    private fadeOutTo(duration: number, delay: number): void {
        const t = tween(this, { alpha: 0 }, { duration, ease: 'None', delay });
        t.finished.then(() => {
            if (!t.cancelled && !this.destroyed && this._state !== 'expanded') this.visible = false;
        });
    }

    /** Redraw for the current animated width. Called by the menu's layout pass. */
    sync(): void {
        const w = this.slotWidth;
        this.content.alpha = clamp01((this.widthScale - 0.5) / 0.3);
        if (Math.abs(w - this.drawnWidth) < 0.01) return;
        this.drawnWidth = w;
        this.draw(w);
    }

    private draw(w: number): void {
        const h = MENU_BUTTON_HEIGHT;
        const half = MENU_WEDGE / 2;
        const pts = [half, 0, w + half, 0, w - half, h, -half, h];
        this.shadow.clear();
        this.slab.clear();
        this.flash.clear();
        if (w <= 0) return;
        // lazer's EdgeEffect shadow (black 0.2, radius 8), as stacked soft layers.
        // Spread sideways only: the band is exactly button height, so a shadow
        // above or below it would show as dark tabs over the background.
        for (const d of [8, 5, 2]) {
            this.shadow.poly([half - d, 0, w + half + d, 0, w - half + d, h, -half - d, h]).fill({ color: 0x000000, alpha: 0.07 });
        }
        this.slab.poly(pts).fill(this.color);
        // Faint top highlight.
        this.slab.poly([half, 0, w + half, 0, w + half * 0.88, h * 0.06, half * 0.88, h * 0.06])
            .fill({ color: lerpColor(this.color, 0xffffff, 0.3), alpha: 0.6 });
        this.flash.poly(pts).fill(0xffffff);
        const padL = this.pad.left ?? 0, padR = this.pad.right ?? 0;
        this.content.position.set(padL + (w - padL - padR) / 2, 0);
        this.iconHolder.position.set(0, h / 2 - 6);
        this.caption.position.set(-3, h - 7);
    }

    // ------------------------------------------------------------------

    protected override onHoverChange(hovered: boolean): void {
        if (hovered) {
            if (this._state !== 'expanded') return;
            const b = this.beatSource?.();
            const untilBeat = b && b.beatLength > 0 ? (1 - b.phase) * b.beatLength : 300;
            this.stopGlyph();
            tween(this.glyph, { rotation: this.rightward ? -BOUNCE_ROTATION : BOUNCE_ROTATION }, { duration: untilBeat, ease: 'InOutSine' });
            tween(this.glyph, { scaleX: HOVER_SCALE, scaleY: HOVER_SCALE * BOUNCE_COMPRESSION }, { duration: untilBeat, ease: 'Out' });
            tween(this, { widthScale: 1.5 }, { duration: 500, ease: 'OutElastic' });
        } else {
            this.stopGlyph();
            tween(this.glyph, { rotation: 0, y: 0 }, { duration: 500, ease: 'Out' });
            tween(this.glyph, { scaleX: 1, scaleY: 1 }, { duration: 200, ease: 'Out' });
            if (this._state === 'expanded') tween(this, { widthScale: 1 }, { duration: 500, ease: 'OutElastic' });
        }
    }

    protected override onPressChange(pressed: boolean, _e?: FederatedPointerEvent): void {
        tween(this.flash, { alpha: pressed ? 0.1 : 0 }, { duration: 1000, ease: 'OutQuint' });
    }

    protected override onClick(): void {
        this.flash.alpha = 0.9;
        tween(this.flash, { alpha: 0 }, { duration: 800, ease: 'OutExpo' });
    }

    private stopGlyph(): void {
        this.glyphChain?.cancel();
        this.glyphChain = null;
    }

    /** lazer OnNewBeat: only the hovered button's icon bounces. */
    onBeat(beatLength: number): void {
        if (!this.hovered || this._state !== 'expanded' || beatLength <= 0) return;
        const duration = beatLength / 2;
        tween(this.glyph, { rotation: this.rightward ? BOUNCE_ROTATION : -BOUNCE_ROTATION }, { duration: duration * 2, ease: 'InOutSine' });
        this.stopGlyph();
        const up = tween(this.glyph, { y: -10, scaleX: HOVER_SCALE, scaleY: HOVER_SCALE }, { duration, ease: 'Out' });
        this.glyphChain = up;
        up.finished.then(() => {
            if (up.cancelled || this.destroyed || this.glyphChain !== up) return;
            this.glyphChain = tween(this.glyph, { y: 0, scaleX: HOVER_SCALE, scaleY: HOVER_SCALE * BOUNCE_COMPRESSION }, { duration, ease: 'In' });
        });
        this.rightward = !this.rightward;
    }
}
