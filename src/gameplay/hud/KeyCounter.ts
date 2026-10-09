import { Container, Graphics, type BitmapText } from 'pixi.js';
import { damp } from '../../core/math';
import type { KeyOverlayStyle } from '../../settings/Settings';
import { counterText } from '../../ui/text';
import type { GameplayButton } from '../input/GameplayInput';

const SIZE = 40;
const GAP = 6;
const KEY_COLOR = 0xffde59;
const MOUSE_COLOR = 0xd287ff;

interface Key {
    name: string;
    /** Physical buttons feeding this counter. */
    buttons: readonly GameplayButton[];
    color: number;
    box: Graphics;
    label: BitmapText;
    lit: number;
    count: number;
    shown: number;
    dirty: boolean;
}

/** Counter layouts: stable shows every physical button, lazer one per action. */
const LAYOUTS: Record<KeyOverlayStyle, { name: string; buttons: GameplayButton[]; color: number }[]> = {
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
 * Key overlay (right edge). "stable" style: K1 K2 M1 M2 boxes; "lazer"
 * style: two action counters where keyboard and mouse are combined (a
 * press counts once, like lazer's unique action bindings). Display only:
 * judgement never reads this.
 */
export class KeyCounter extends Container {
    private keys: Key[] = [];
    private style: KeyOverlayStyle | null = null;
    private lastDown: Partial<Record<GameplayButton, boolean>> = {};
    private lastCounts: Partial<Record<GameplayButton, number>> = {};

    constructor(style: KeyOverlayStyle = 'lazer') {
        super();
        this.eventMode = 'none';
        this.setStyle(style);
    }

    setStyle(style: KeyOverlayStyle): void {
        if (style === this.style) return;
        this.style = style;
        for (const c of this.removeChildren()) c.destroy({ children: true });
        this.keys = LAYOUTS[style].map((def, i) => {
            const box = new Graphics();
            const label = counterText(def.name, { size: 14 });
            label.anchor.set(0.5);
            const c = new Container();
            c.y = i * (SIZE + GAP);
            label.position.set(SIZE / 2, SIZE / 2);
            c.addChild(box, label);
            this.addChild(c);
            return { ...def, box, label, lit: 0, count: 0, shown: -1, dirty: true };
        });
        // Counts carry over from the physical buttons on the next update.
        this.lastCounts = {};
        this.lastDown = {};
        this.primed = false;
    }

    private primed = false;

    get stackHeight(): number {
        return this.keys.length * SIZE + (this.keys.length - 1) * GAP;
    }

    static get width(): number {
        return SIZE;
    }

    update(dt: number, down: Record<GameplayButton, boolean>, counts: Record<GameplayButton, number>): void {
        for (const k of this.keys) {
            if (!this.primed) {
                // (Re)built mid-play: start from the totals so far.
                k.count = k.buttons.length === 1 ? counts[k.buttons[0]] : Math.max(...k.buttons.map(b => counts[b]));
            } else {
                // A combined action is pressed once however many of its buttons go
                // down; a press while it is already held doesn't count again.
                const presses = Math.max(0, ...k.buttons.map(b => counts[b] - (this.lastCounts[b] ?? counts[b])));
                const held = k.buttons.some(b => this.lastDown[b]);
                if (presses > 0) k.count += held && k.buttons.length > 1 ? presses - 1 : presses;
            }
            const isDown = k.buttons.some(b => down[b]);
            const target = isDown ? 1 : 0;
            const lit = target > k.lit ? target : damp(k.lit, target, 40, dt);
            const changed = k.dirty || Math.abs(lit - k.lit) > 0.005 || k.shown !== k.count;
            k.lit = lit;
            k.dirty = false;
            if (k.shown !== k.count) {
                k.shown = k.count;
                k.label.text = k.count > 0 ? String(k.count) : k.name;
            }
            if (!changed) continue;
            const scale = 1 - 0.08 * lit;
            const inset = (SIZE * (1 - scale)) / 2;
            k.box.clear()
                .roundRect(inset, inset, SIZE * scale, SIZE * scale, 6)
                .fill({ color: lit > 0.01 ? k.color : 0x000000, alpha: 0.35 + 0.5 * lit })
                .roundRect(inset, inset, SIZE * scale, SIZE * scale, 6)
                .stroke({ width: 2, color: 0xffffff, alpha: 0.6 + 0.4 * lit });
            k.label.tint = lit > 0.5 ? 0x000000 : 0xffffff;
        }
        this.primed = true;
        for (const b of ['K1', 'K2', 'M1', 'M2'] as const) {
            this.lastCounts[b] = counts[b];
            this.lastDown[b] = down[b];
        }
    }
}
