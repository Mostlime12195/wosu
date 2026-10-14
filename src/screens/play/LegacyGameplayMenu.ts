import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { damp } from '../../core/math';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { opaqueBounds } from '../../skin/opaqueBounds';
import { UIComponent } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';
import type { GameplayMenuContent, MenuElement } from './GameplayMenu';

/** stable's button rows (768-high units, centred horizontally). */
const BUTTON_Y: Record<MenuElement, number> = { continue: 224, retry: 400, back: 576 };
const TEXTURE: Record<MenuElement, string> = { continue: 'pause-continue', retry: 'pause-retry', back: 'pause-back' };
const TRANSITION_DURATION = 200;
/** Gameplay is dimmed under the skin's overlay. */
const DIM = 0.5;

/** Plays the first of `names` the skins have; false when none has any. */
export type SkinSamplePlayer = (names: readonly string[]) => boolean;

/**
 * osu!stable's pause / fail screen, used when the skin draws one: the
 * gameplay dimmed under pause-overlay (centred, unstretched) or
 * fail-background (stretched to the screen), pause-continue / -retry /
 * -back centred at 224 / 400 / 576 of 768, and arrow-pause (or
 * play-warningarrow, tinted blue) pointing at the selected button from
 * both sides. Hover or ↑/↓ select, Enter or a click presses (with the
 * skin's pause-*-hover / -click sounds), Back presses Continue when
 * paused and Back when failed, as wosu!'s own menu does.
 */
export class LegacyGameplayMenu extends UIComponent {
    private readonly dim = new Graphics();
    private readonly overlay = new Sprite();
    private readonly buttonLayer = new Container();
    private readonly arrows: [Sprite, Sprite] | null = null;
    private readonly arrowTex: SkinTexture | null;
    private buttons: LegacyMenuButton[] = [];
    private actions: (() => void)[] = [];
    private selected = -1;
    private back: 'first' | 'last' = 'last';
    private overlayTex: SkinTexture | null = null;
    private stretchOverlay = false;
    private clock = 0;
    shown = false;

    /** Whether the skins draw a stable pause screen (all three buttons). */
    static available(chain: SkinChain): boolean {
        return Object.values(TEXTURE).every(t => chain.texture(t) !== null);
    }

    constructor(private readonly chain: SkinChain, private readonly playSample: SkinSamplePlayer) {
        super();
        const pauseArrow = chain.texture('arrow-pause');
        this.arrowTex = pauseArrow ?? chain.texture('play-warningarrow');
        this.dim.alpha = DIM;
        this.addChild(this.dim, this.overlay, this.buttonLayer);
        if (this.arrowTex) {
            const make = () => {
                const a = new Sprite(this.arrowTex!.texture);
                a.anchor.set(0.5);
                // play-warningarrow is tinted blue on the pause screen; arrow-pause is drawn as is.
                if (!pauseArrow) a.tint = 0x3399ff;
                a.visible = false;
                return a;
            };
            this.arrows = [make(), make()];
            this.addChild(...this.arrows);
        }
        this.visible = false;
        this.alpha = 0;
        this.eventMode = 'none';
        // Swallow clicks so nothing behind reacts while open.
        this.hitArea = new Rectangle(0, 0, 1, 1);
        this.onFrame(dt => this.update(dt));
    }

    show(c: GameplayMenuContent): void {
        this.back = c.back;
        const failed = c.title === 'failed';
        this.overlayTex = this.chain.texture(failed ? 'fail-background' : 'pause-overlay');
        this.stretchOverlay = failed;
        this.overlay.visible = !!this.overlayTex;
        if (this.overlayTex) this.overlay.texture = this.overlayTex.texture;
        for (const b of this.buttons) b.destroy();
        this.buttons = [];
        this.actions = [];
        for (const e of c.entries) {
            const el = e.element;
            const tex = el ? this.chain.texture(TEXTURE[el]) : null;
            if (!el || !tex) continue;
            const b = new LegacyMenuButton(el, tex);
            const i = this.buttons.length;
            b.onActivate = () => this.choose(i);
            b.onPointerSelect = sel => (sel ? this.select(i) : this.deselect(i));
            this.buttons.push(b);
            this.actions.push(e.action);
            this.buttonLayer.addChild(b);
        }
        this.selected = -1;
        this.shown = true;
        this.visible = true;
        this.eventMode = 'static';
        tween(this, { alpha: 1 }, { duration: TRANSITION_DURATION, ease: 'In' });
        this.relayout();
    }

    hide(): void {
        if (!this.shown) return;
        this.shown = false;
        this.eventMode = 'none';
        this.selected = -1;
        tween(this, { alpha: 0 }, { duration: TRANSITION_DURATION, ease: 'In' }).finished.then(() => {
            if (!this.shown && !this.destroyed) this.visible = false;
        });
    }

    private choose(i: number): void {
        if (!this.shown) return;
        const b = this.buttons[i];
        if (b && !this.playSample([`${TEXTURE[b.element]}-click`])) uiSounds()?.click('button');
        this.actions[i]?.();
        this.hide();
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        this.dim.clear().rect(0, 0, w, h).fill(0x000000);
        const u = h / 768;
        const o = this.overlayTex;
        if (o) {
            this.overlay.anchor.set(0.5);
            this.overlay.position.set(w / 2, h / 2);
            if (this.stretchOverlay) this.overlay.setSize(w, h);
            else this.overlay.scale.set(u * o.scale);
        }
        for (const b of this.buttons) b.place(w / 2, BUTTON_Y[b.element] * u, u);
    }

    private select(i: number, sound = true): void {
        if (i === this.selected) return;
        this.selected = i;
        this.buttons.forEach((b, j) => (b.selected = j === i));
        if (!sound) return;
        const el = this.buttons[i]?.element;
        if (el && !this.playSample([`${TEXTURE[el]}-hover`, 'pause-hover'])) uiSounds()?.hover('button');
    }

    private deselect(i: number): void {
        if (this.selected !== i) return;
        this.selected = -1;
        if (this.buttons[i]) this.buttons[i].selected = false;
    }

    /** Animate the buttons and the arrows bobbing at the selection. */
    private update(dt: number): void {
        this.clock += dt;
        for (const b of this.buttons) b.update(dt);
        const sel = this.buttons[this.selected];
        if (!this.arrows || !this.arrowTex) return;
        for (const a of this.arrows) a.visible = !!sel;
        if (!sel) return;
        const u = this._h / 768;
        const s = u * this.arrowTex.scale;
        const aw = this.arrowTex.texture.width * s;
        const bob = Math.sin(this.clock / 150) * 6 * u;
        const reach = sel.halfWidth + aw / 2 + 12 * u + bob;
        const [l, r] = this.arrows;
        l.scale.set(s);
        r.scale.set(-s, s);
        l.position.set(this._w / 2 - reach, sel.y);
        r.position.set(this._w / 2 + reach, sel.y);
    }

    onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (!this.shown) return false;
        const n = this.buttons.length;
        if (!n) return false;
        switch (action) {
            case 'up':
                this.select(this.selected < 0 ? n - 1 : (this.selected - 1 + n) % n);
                return true;
            case 'down':
                this.select(this.selected < 0 ? 0 : (this.selected + 1) % n);
                return true;
            case 'select':
                if (this.selected >= 0) this.buttons[this.selected].activate();
                return true;
            case 'back':
                this.buttons[this.back === 'first' ? 0 : n - 1]?.activate();
                return true;
            default:
                return false;
        }
    }
}

/**
 * A stable pause button: the skin's image centred on its row, clickable
 * where it is drawn, growing slightly and lighting up while selected.
 */
class LegacyMenuButton extends UIComponent {
    private readonly sprite: Sprite;
    private readonly glow: Sprite;
    private lit = 0;
    selected = false;
    halfWidth = 0;
    /** The pointer moved onto (true) or left (false) this button. */
    onPointerSelect: ((selected: boolean) => void) | null = null;

    constructor(readonly element: MenuElement, private readonly tex: SkinTexture) {
        super();
        this.sprite = new Sprite(tex.texture);
        this.glow = new Sprite(tex.texture);
        for (const s of [this.sprite, this.glow]) s.anchor.set(0.5);
        this.glow.blendMode = 'add';
        this.glow.alpha = 0;
        this.addChild(this.sprite, this.glow);
        // Sounds are the skin's (see LegacyGameplayMenu.select / choose).
        this.makeInteractive({ sounds: false, rectHitArea: false });
        this.on('pointermove', () => {
            if (!this.selected) this.onPointerSelect?.(true);
        });
    }

    place(x: number, y: number, unit: number): void {
        const s = unit * this.tex.scale;
        this.position.set(x, y);
        this.sprite.scale.set(s);
        this.glow.scale.set(s);
        const t = this.tex.texture;
        const b = opaqueBounds(t);
        this.halfWidth = (b.width * s) / 2;
        this.hitArea = new Rectangle((b.x - t.width / 2) * s, (b.y - t.height / 2) * s, b.width * s, b.height * s);
    }

    update(dt: number): void {
        this.lit = damp(this.lit, this.selected ? 1 : 0, 50, dt);
        this.scale.set(1 + 0.05 * this.lit);
        this.glow.alpha = 0.25 * this.lit;
    }

    protected override onHoverChange(hovered: boolean): void {
        if (!hovered) this.onPointerSelect?.(false);
    }
}
