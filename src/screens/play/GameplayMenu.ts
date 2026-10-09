import { Container, Graphics, Rectangle, Sprite, Texture, TextStyle, type Text } from 'pixi.js';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { label, textStyle } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { Triangles } from '../../ui/Triangles';
import { UIComponent } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';

export interface MenuEntry {
    caption: string;
    color: number;
    action: () => void;
}

export interface GameplayMenuContent {
    /** Lowercase header ("paused" / "failed"). */
    title: string;
    description: string;
    entries: MenuEntry[];
    /** Which button Back (Esc) presses: pause → Continue (first), fail → Quit (last). */
    back: 'first' | 'last';
    retries: number;
    /** 0..100 through the playable part, or null when unknown. */
    progress: number | null;
    /** 0..1, or null when unknown. */
    accuracy: number | null;
}

/** lazer's GameplayMenuOverlay constants. */
const TRANSITION_DURATION = 200;
const BUTTON_HEIGHT = 80;
const BUTTON_SPACING = 2;
const SIDE_PADDING = 50;
const BACKGROUND_ALPHA = 0.75;

/**
 * lazer's GameplayMenuOverlay (PauseOverlay / FailOverlay): the screen
 * dims, a yellow lowercase header sits centred above a stack of wide
 * DialogButtons, and the retry count, song progress and accuracy sit
 * below them. ↑/↓ cycle the selection (the mouse selects what it moves
 * over), Enter presses it, Back presses Continue when paused and Quit when
 * failed. Shows and hides with lazer's 200 ms fade.
 */
export class GameplayMenu extends UIComponent {
    private readonly dim = new Graphics();
    private readonly title: Text;
    private readonly description: Text;
    private readonly buttonFlow = new Container();
    private readonly info = new Container();
    private buttons: DialogButton[] = [];
    private entries: MenuEntry[] = [];
    private selected = -1;
    private back: 'first' | 'last' = 'last';
    shown = false;

    constructor(private readonly triangles: Texture) {
        super();
        this.title = label('', { size: 48, weight: '600', letterSpacing: 5, color: Colors.yellow });
        this.description = label('', { size: 18, weight: '500', color: Colors.grayC });
        this.title.anchor.set(0.5);
        this.description.anchor.set(0.5, 0);
        this.dim.alpha = BACKGROUND_ALPHA;
        this.addChild(this.dim, this.title, this.description, this.buttonFlow, this.info);
        this.visible = false;
        this.alpha = 0;
        this.eventMode = 'none';
        // Swallow clicks so nothing behind reacts while open.
        this.hitArea = new Rectangle(0, 0, 1, 1);
    }

    show(c: GameplayMenuContent): void {
        this.title.text = c.title;
        this.description.text = c.description;
        this.back = c.back;
        for (const b of this.buttons) b.destroy();
        this.entries = c.entries;
        this.buttons = c.entries.map((e, i) => {
            const b = new DialogButton(e.caption, e.color, this.triangles);
            b.onActivate = () => this.choose(i);
            b.onPointerSelect = sel => (sel ? this.select(i, false) : this.deselect(i));
            this.buttonFlow.addChild(b);
            return b;
        });
        this.buildInfo(c);
        // lazer: the selection resets whenever the overlay's state changes.
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

    /** "Retry count: N", "Song progress: N%", "Accuracy: N%" with bold values (lazer's play info text). */
    private buildInfo(c: GameplayMenuContent): void {
        for (const child of this.info.removeChildren()) child.destroy();
        const lines: [string, string][] = [['Retry count: ', String(c.retries)]];
        if (c.progress !== null) lines.push(['Song progress: ', `${Math.round(c.progress)}%`]);
        if (c.accuracy !== null) lines.push(['Accuracy: ', `${(c.accuracy * 100).toFixed(2)}%`]);
        lines.forEach(([caption, value], i) => {
            const a = label(caption, { size: 18, weight: '400' });
            const b = label(value, { size: 18, weight: '700' });
            const line = new Container();
            b.x = a.width;
            line.addChild(a, b);
            line.position.set(-(a.width + b.width) / 2, i * 24);
            this.info.addChild(line);
        });
    }

    private choose(i: number): void {
        if (!this.shown) return;
        this.entries[i]?.action();
        this.hide();
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        this.dim.clear().rect(0, 0, w, h).fill(0x000000);
        const bh = Math.round(Math.min(BUTTON_HEIGHT, h * 0.11));
        const bw = Math.max(200, w - SIDE_PADDING * 2);
        const total = this.buttons.length * bh + Math.max(0, this.buttons.length - 1) * BUTTON_SPACING;
        // lazer's grid: header centred in the space above the buttons, info centred below.
        const top = Math.round(h / 2 - total / 2);
        const bottom = top + total;
        this.buttonFlow.position.set(SIDE_PADDING, top);
        this.buttons.forEach((b, i) => {
            b.resize(bw, bh);
            b.position.set(0, i * (bh + BUTTON_SPACING));
        });
        const headerH = this.title.height + (this.description.text ? 8 + this.description.height : 0);
        const headerTop = top / 2 - headerH / 2;
        this.title.position.set(w / 2, headerTop + this.title.height / 2);
        this.description.position.set(w / 2, headerTop + this.title.height + 8);
        const infoH = this.info.children.length * 24;
        this.info.position.set(w / 2, bottom + (h - bottom) / 2 - infoH / 2);
    }

    private select(i: number, sound: boolean): void {
        if (i === this.selected) return;
        this.selected = i;
        this.buttons.forEach((b, j) => b.setSelected(j === i));
        if (sound) uiSounds()?.hover();
    }

    private deselect(i: number): void {
        if (this.selected !== i) return;
        this.selected = -1;
        this.buttons[i]?.setSelected(false);
    }

    onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (!this.shown) return false;
        const n = this.buttons.length;
        switch (action) {
            case 'up':
                // SelectionCycleFillFlowContainer: from nothing, Previous picks the last.
                this.select(this.selected < 0 ? n - 1 : (this.selected - 1 + n) % n, true);
                return true;
            case 'down':
                this.select(this.selected < 0 ? 0 : (this.selected + 1) % n, true);
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

/** lazer's DialogButton constants. */
const IDLE_WIDTH = 0.8;
const HOVER_WIDTH = 0.9;
const HOVER_DURATION = 400;
const CLICK_DURATION = 200;
/** OsuGame.SHEAR. */
const SHEAR = 0.2;

let glowRamp: Texture | null = null;
/** Horizontal 0→1 alpha ramp, tinted per button for the glow's soft ends. */
function rampTexture(): Texture {
    if (glowRamp) return glowRamp;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 1;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 1);
    glowRamp = Texture.from(c);
    return glowRamp;
}

/**
 * lazer's DialogButton: a sheared colour bar at 80% of the row that
 * widens to 90% when selected, with drifting additive triangles inside, a
 * soft glow of the same colour behind it, and a 28 px caption that gains
 * letter spacing on selection. Clicking flashes and kicks the bar wider.
 */
class DialogButton extends UIComponent {
    private readonly glow = new Container();
    private readonly glowL: Sprite;
    private readonly glowM: Sprite;
    private readonly glowR: Sprite;
    private readonly bar = new Graphics();
    private readonly triMask = new Graphics();
    private readonly tris: Triangles;
    private readonly flash = new Graphics();
    private readonly caption: Text;
    private readonly st = { bar: IDLE_WIDTH, glow: IDLE_WIDTH * 1.08, glowAlpha: 0, spacing: 0, textScale: 1, flash: 0 };
    private selected = false;
    private clickAnimating = false;
    /** The pointer moved onto (true) or left (false) this button. */
    onPointerSelect: ((selected: boolean) => void) | null = null;

    constructor(text: string, private readonly color: number, triangles: Texture) {
        super();
        const ramp = rampTexture();
        this.glowL = new Sprite(ramp);
        this.glowM = new Sprite(Texture.WHITE);
        this.glowR = new Sprite(ramp);
        this.glowR.scale.x = -1;
        for (const s of [this.glowL, this.glowM, this.glowR]) s.tint = color;
        this.glow.addChild(this.glowL, this.glowM, this.glowR);
        this.glow.alpha = 0;
        // Shear the glow like the bar; undo the height loss skew brings.
        this.glow.skew.x = -Math.asin(SHEAR);
        this.glow.scale.y = 1 / Math.cos(this.glow.skew.x);
        this.tris = new Triangles(triangles, { colorLight: 0xffffff, colorDark: 0xffffff, velocity: 0.7, density: 1, maskRadius: null, alpha: 0.1, seed: [...text].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0 });
        this.tris.blendMode = 'add';
        this.tris.mask = this.triMask;
        this.flash.blendMode = 'add';
        this.flash.alpha = 0;
        const style: TextStyle = textStyle({ size: 28, weight: '700', shadow: true }).clone();
        this.caption = label(text);
        this.caption.style = style;
        this.caption.anchor.set(0.5);
        this.addChild(this.glow, this.bar, this.tris, this.triMask, this.flash, this.caption);
        this.makeInteractive({ sounds: 'button' });
        this.on('pointermove', () => {
            if (!this.selected) this.onPointerSelect?.(true);
        });
        this.resize(600, BUTTON_HEIGHT);
    }

    setSelected(v: boolean): void {
        if (v === this.selected) return;
        this.selected = v;
        this.applyState();
    }

    /** DialogButton.selectionChanged. */
    private applyState(): void {
        if (this.clickAnimating) return;
        const o = { owner: this, onUpdate: () => this.redraw() };
        if (this.selected) {
            tween(this.st, { spacing: 1.4, textScale: 1.02, bar: HOVER_WIDTH, glow: HOVER_WIDTH * 1.08, glowAlpha: 1 }, { ...o, duration: HOVER_DURATION, ease: 'OutQuint' });
        } else {
            tween(this.st, { bar: IDLE_WIDTH, spacing: 0, textScale: 1, glowAlpha: 0 }, { ...o, duration: HOVER_DURATION / 2, ease: 'OutQuint' });
            tween(this.st, { glow: IDLE_WIDTH * 1.08 }, { ...o, duration: HOVER_DURATION, ease: 'OutQuint' });
        }
    }

    protected override onResize(w: number, h: number): void {
        this.tris.resize(w, h);
        this.caption.position.set(w / 2, h / 2);
        this.redraw();
    }

    private parallelogram(g: Graphics, frac: number): Graphics {
        const w = this._w, h = this._h;
        const bw = w * frac;
        const x0 = (w - bw) / 2;
        const s = (SHEAR * h) / 2;
        return g.clear().roundShape([
            { x: x0 + s, y: 0 }, { x: x0 + bw + s, y: 0 }, { x: x0 + bw - s, y: h }, { x: x0 - s, y: h },
        ], 5);
    }

    private redraw(): void {
        const w = this._w, h = this._h, st = this.st;
        this.parallelogram(this.bar, st.bar).fill(this.color);
        this.parallelogram(this.triMask, st.bar).fill(0xffffff);
        this.parallelogram(this.flash, st.bar).fill(this.color);
        this.flash.alpha = st.flash;
        const gw = w * st.glow;
        const edge = gw * 0.125;
        this.glow.position.set(w / 2, h / 2);
        this.glowL.position.set(-gw / 2, -h / 2);
        this.glowL.setSize(edge, h);
        this.glowM.position.set(-gw / 2 + edge, -h / 2);
        this.glowM.setSize(gw - edge * 2, h);
        // Mirrored: its origin is its right edge.
        this.glowR.position.set(gw / 2, -h / 2);
        this.glowR.height = h;
        this.glowR.scale.x = -edge / this.glowR.texture.width;
        this.glow.alpha = st.glowAlpha;
        const spacing = Math.round(st.spacing * 10) / 10;
        if (this.caption.style.letterSpacing !== spacing) this.caption.style.letterSpacing = spacing;
        this.caption.scale.set(st.textScale);
    }

    protected override onHoverChange(hovered: boolean): void {
        // lazer's menu buttons select on mouse move, deselect on hover lost.
        if (!hovered) this.onPointerSelect?.(false);
    }

    protected override onPressChange(pressed: boolean): void {
        const o = { owner: this, onUpdate: () => this.redraw() };
        if (pressed) tween(this.st, { bar: HOVER_WIDTH * 0.98 }, { ...o, duration: CLICK_DURATION * 4, ease: 'OutQuad' });
        else if (this.selected && !this.clickAnimating) tween(this.st, { bar: HOVER_WIDTH }, { ...o, duration: CLICK_DURATION, ease: 'In' });
    }

    protected override onClick(): void {
        const o = { owner: this, onUpdate: () => this.redraw() };
        this.st.flash = 0.05;
        tween(this.st, { flash: 0 }, { ...o, duration: 100 });
        this.clickAnimating = true;
        tween(this.st, { bar: this.st.bar * 1.05 }, { ...o, duration: 100, ease: 'OutQuint' }).finished.then(() => {
            this.clickAnimating = false;
            if (!this.destroyed) this.applyState();
        });
    }
}
