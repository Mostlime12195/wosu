import { Container, Graphics, Sprite, type BitmapText } from 'pixi.js';
import { Easing } from '../../core/easing';
import { damp } from '../../core/math';
import type { KeyOverlayStyle } from '../../settings/Settings';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { counterText } from '../../ui/text';
import type { GameplayButton } from '../input/GameplayInput';

const SIZE = 40;
const GAP = 6;
const KEY_COLOR = 0xffde59;
const MOUSE_COLOR = 0xd287ff;

interface KeyDef {
    name: string;
    /** Physical buttons feeding this counter. */
    buttons: readonly GameplayButton[];
    color: number;
}

/** Counter layouts: stable shows every physical button, lazer one per action. */
const LAYOUTS: Record<KeyOverlayStyle, KeyDef[]> = {
    stable: [
        { name: 'K1', buttons: ['K1'], color: KEY_COLOR },
        { name: 'K2', buttons: ['K2'], color: KEY_COLOR },
        { name: 'M1', buttons: ['M1'], color: MOUSE_COLOR },
        { name: 'M2', buttons: ['M2'], color: MOUSE_COLOR },
    ],
    // lazer's RulesetInputManager attaches one counter per OsuAction, so Z
    // and left mouse both drive the first one, X and right mouse the second.
    lazer: [
        { name: 'K1', buttons: ['K1', 'M1'], color: KEY_COLOR },
        { name: 'K2', buttons: ['K2', 'M2'], color: KEY_COLOR },
    ],
};

/**
 * Press counting shared by both key overlays. A combined action is
 * pressed once however many of its buttons go down; a press while it is
 * already held doesn't count again. Display only: judgement never reads it.
 */
class KeyTracker {
    readonly counts: number[];
    private lastDown: Partial<Record<GameplayButton, boolean>> = {};
    private lastCounts: Partial<Record<GameplayButton, number>> = {};
    private primed = false;

    constructor(readonly defs: readonly KeyDef[]) {
        this.counts = defs.map(() => 0);
    }

    update(down: Record<GameplayButton, boolean>, counts: Record<GameplayButton, number>): void {
        this.defs.forEach((k, i) => {
            if (!this.primed) {
                // (Re)built mid-play: start from the totals so far.
                this.counts[i] = k.buttons.length === 1 ? counts[k.buttons[0]] : Math.max(...k.buttons.map(b => counts[b]));
                return;
            }
            const presses = Math.max(0, ...k.buttons.map(b => counts[b] - (this.lastCounts[b] ?? counts[b])));
            const held = k.buttons.some(b => this.lastDown[b]);
            if (presses > 0) this.counts[i] += held && k.buttons.length > 1 ? presses - 1 : presses;
        });
        this.primed = true;
        for (const b of ['K1', 'K2', 'M1', 'M2'] as const) {
            this.lastCounts[b] = counts[b];
            this.lastDown[b] = down[b];
        }
    }

    isDown(i: number, down: Record<GameplayButton, boolean>): boolean {
        return this.defs[i].buttons.some(b => down[b]);
    }
}

/** What HUDOverlay needs from a key overlay. */
export interface KeyOverlay extends Container {
    setStyle(style: KeyOverlayStyle): void;
    update(dt: number, down: Record<GameplayButton, boolean>, counts: Record<GameplayButton, number>): void;
    /** Place the overlay for a w×h screen; `unit` is the HUD's own scale, `legacyUnit` lazer's 1024×768 one. */
    place(w: number, h: number, unit: number, legacyUnit: number): void;
}

interface Key {
    box: Graphics;
    label: BitmapText;
    color: number;
    name: string;
    lit: number;
    shown: number;
    dirty: boolean;
}

/**
 * wosu!'s key overlay (right edge). "stable" style: K1 K2 M1 M2 boxes;
 * "lazer" style: two action counters where keyboard and mouse are
 * combined (a press counts once, like lazer's unique action bindings).
 */
export class KeyCounter extends Container implements KeyOverlay {
    private keys: Key[] = [];
    private tracker!: KeyTracker;
    private style: KeyOverlayStyle | null = null;

    constructor(style: KeyOverlayStyle = 'lazer') {
        super();
        this.eventMode = 'none';
        this.setStyle(style);
    }

    setStyle(style: KeyOverlayStyle): void {
        if (style === this.style) return;
        this.style = style;
        for (const c of this.removeChildren()) c.destroy({ children: true });
        this.tracker = new KeyTracker(LAYOUTS[style]);
        this.keys = LAYOUTS[style].map((def, i) => {
            const box = new Graphics();
            const label = counterText(def.name, { size: 14 });
            label.anchor.set(0.5);
            const c = new Container();
            c.y = i * (SIZE + GAP);
            label.position.set(SIZE / 2, SIZE / 2);
            c.addChild(box, label);
            this.addChild(c);
            return { box, label, color: def.color, name: def.name, lit: 0, shown: -1, dirty: true };
        });
    }

    get stackHeight(): number {
        return this.keys.length * SIZE + (this.keys.length - 1) * GAP;
    }

    place(w: number, h: number, unit: number): void {
        const s = Math.min(1, unit);
        this.scale.set(s);
        this.position.set(w - SIZE * s - 8 * unit, h / 2 - (this.stackHeight * s) / 2);
    }

    update(dt: number, down: Record<GameplayButton, boolean>, counts: Record<GameplayButton, number>): void {
        this.tracker.update(down, counts);
        this.keys.forEach((k, i) => {
            const count = this.tracker.counts[i];
            const target = this.tracker.isDown(i, down) ? 1 : 0;
            const lit = target > k.lit ? target : damp(k.lit, target, 40, dt);
            const changed = k.dirty || Math.abs(lit - k.lit) > 0.005 || k.shown !== count;
            k.lit = lit;
            k.dirty = false;
            if (k.shown !== count) {
                k.shown = count;
                k.label.text = count > 0 ? String(count) : k.name;
            }
            if (!changed) return;
            const scale = 1 - 0.08 * lit;
            const inset = (SIZE * (1 - scale)) / 2;
            k.box.clear()
                .roundRect(inset, inset, SIZE * scale, SIZE * scale, 6)
                .fill({ color: lit > 0.01 ? k.color : 0x000000, alpha: 0.35 + 0.5 * lit })
                .roundRect(inset, inset, SIZE * scale, SIZE * scale, 6)
                .stroke({ width: 2, color: 0xffffff, alpha: 0.6 + 0.4 * lit });
            k.label.tint = lit > 0.5 ? 0x000000 : 0xffffff;
        });
    }
}

/** lazer's LegacyKeyCounterDisplay active colours: keys, then mouse buttons. */
const LEGACY_ACTIVE_TOP = 0xffde00;
const LEGACY_ACTIVE_BOTTOM = 0xf8009e;
const LEGACY_KEY_SIZE = 46;
const LEGACY_SPACING = 1.2;
const LEGACY_TOP = 7.35;
const LEGACY_TRANSITION = 160;

interface LegacyKey {
    holder: Container;
    sprite: Sprite;
    name: BitmapText;
    count: BitmapText;
    down: boolean;
    activatedOnce: boolean;
    /** Scale transform start (from → to over 160 ms, Easing.Out). */
    from: number;
    to: number;
    at: number;
    textAt: number;
    active: number;
}

/**
 * lazer's LegacyKeyCounterDisplay, for skins with inputoverlay-key and
 * inputoverlay-background: the background strip rotated 90° down the
 * right edge (stretched 1.05×), 46-unit keys stacked 1.2 apart from 7.35
 * down, the whole display's top-right 64 units above the screen's middle
 * right. A press shrinks the key to 0.8 (160 ms, Out) and tints it
 * yellow (keys) or pink (mouse buttons); the first press swaps the key's
 * name for its count. Text is black (osu!'s InputOverlayText default).
 */
export class LegacyKeyCounter extends Container implements KeyOverlay {
    private readonly bgSprite = new Sprite();
    private readonly flow = new Container();
    private keys: LegacyKey[] = [];
    private tracker!: KeyTracker;
    private style: KeyOverlayStyle | null = null;
    private clock = 0;

    /** The skin's key overlay, or null when no skin in the chain has one (use wosu!'s). */
    static create(chain: SkinChain, style: KeyOverlayStyle): LegacyKeyCounter | null {
        const key = chain.texture('inputoverlay-key');
        const bg = chain.texture('inputoverlay-background');
        return key && bg ? new LegacyKeyCounter(key, bg, style) : null;
    }

    private constructor(private readonly keyTex: SkinTexture, bg: SkinTexture, style: KeyOverlayStyle) {
        super();
        this.eventMode = 'none';
        this.bgSprite.texture = bg.texture;
        this.bgSprite.scale.set(1.05 * bg.scale, bg.scale);
        this.bgSprite.rotation = Math.PI / 2;
        this.bgSprite.x = 1;
        this.flow.y = LEGACY_TOP;
        this.addChild(this.bgSprite, this.flow);
        this.setStyle(style);
    }

    setStyle(style: KeyOverlayStyle): void {
        if (style === this.style) return;
        this.style = style;
        for (const c of this.flow.removeChildren()) c.destroy({ children: true });
        const defs = LAYOUTS[style];
        this.tracker = new KeyTracker(defs);
        this.keys = defs.map((def, i) => {
            const holder = new Container();
            holder.position.set(-LEGACY_KEY_SIZE / 2, i * (LEGACY_KEY_SIZE + LEGACY_SPACING) + LEGACY_KEY_SIZE / 2);
            const sprite = new Sprite(this.keyTex.texture);
            sprite.anchor.set(0.5);
            sprite.scale.set(this.keyTex.scale);
            const name = counterText(def.name, { size: 15, color: 0x000000 });
            const count = counterText('0', { size: 15, color: 0x000000 });
            name.anchor.set(0.5);
            count.anchor.set(0.5);
            count.alpha = 0;
            holder.addChild(sprite, name, count);
            this.flow.addChild(holder);
            const active = def.buttons.every(b => b === 'M1' || b === 'M2') || (style === 'stable' && i >= 2)
                ? LEGACY_ACTIVE_BOTTOM : LEGACY_ACTIVE_TOP;
            return { holder, sprite, name, count, down: false, activatedOnce: false, from: 1, to: 1, at: -1e9, textAt: -1e9, active };
        });
    }

    place(w: number, h: number, _unit: number, lu: number): void {
        this.scale.set(lu);
        this.position.set(w, h / 2 - 64 * lu);
    }

    update(dt: number, down: Record<GameplayButton, boolean>, counts: Record<GameplayButton, number>): void {
        const now = (this.clock += dt);
        this.tracker.update(down, counts);
        this.keys.forEach((k, i) => {
            const isDown = this.tracker.isDown(i, down);
            if (isDown !== k.down) {
                k.down = isDown;
                k.from = k.holder.scale.x;
                k.to = isDown ? 0.8 : 1;
                k.at = now;
                k.sprite.tint = isDown ? k.active : 0xffffff;
                if (isDown) {
                    k.count.text = String(this.tracker.counts[i]);
                    if (!k.activatedOnce) {
                        k.activatedOnce = true;
                        k.textAt = now;
                    }
                }
            }
            const t = Math.min(1, (now - k.at) / LEGACY_TRANSITION);
            k.holder.scale.set(k.from + (k.to - k.from) * Easing.Out(t));
            if (k.activatedOnce) {
                const f = Easing.Out(Math.min(1, (now - k.textAt) / LEGACY_TRANSITION));
                k.name.alpha = 1 - f;
                k.count.alpha = f;
            }
        });
    }
}
