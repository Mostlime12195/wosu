import { Container, Graphics, GraphicsContext, Sprite } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import { Ease } from './transforms';

/** CursorRipple: grows 0.1 → 1 (Easing.Out) while fading out, both over 700 ms. */
const DURATION = 700;
const START_SCALE = 0.1;
/** DefaultCursorRipple: a RingPiece(3) of OBJECT_DIMENSIONS (128 units) at 10% alpha. */
const DEFAULT_SIZE = 128;
const DEFAULT_BORDER = 3;
const DEFAULT_ALPHA = 0.1;

let ringContext: GraphicsContext | null = null;

function defaultRing(): GraphicsContext {
    if (!ringContext) {
        const r = DEFAULT_SIZE / 2;
        // A masked border is drawn inside the edge: the stroke's centre sits half a border in.
        ringContext = new GraphicsContext().circle(0, 0, r - DEFAULT_BORDER / 2).stroke({ width: DEFAULT_BORDER, color: 0xffffff });
    }
    return ringContext;
}

interface Ripple {
    view: Container;
    /** Display size of the ripple's image at scale 1, in playfield units per image unit. */
    base: number;
    /** Logical px per playfield unit × cursor scale, fixed at the press (lazer sets Scale = CursorScale once). */
    unit: number;
    /** The image's own alpha (the default ring's 10%). */
    own: number;
    age: number;
}

/**
 * lazer's CursorRippleVisualiser (OsuSetting ShowCursorRipples): every
 * press leaves a ripple at the cursor, the skin's cursor-ripple
 * (LegacyCursorRipple: the image at its own size in playfield units) or
 * lazer's thin ring (DefaultCursorRipple), additive, sized with the cursor.
 * Drawn in screen space like the rest of the gameplay cursor.
 */
export class CursorRipples extends Container {
    /** The skin's cursor-ripple; null draws the default ring. */
    texture: SkinTexture | null = null;
    private readonly ripples: Ripple[] = [];

    constructor() {
        super();
        this.eventMode = 'none';
    }

    /** A ripple at (x, y) logical px; `unit` is logical px per playfield unit × the cursor's scale. */
    add(x: number, y: number, unit: number): void {
        let view: Container;
        let base: number;
        let own = 1;
        const t = this.texture;
        if (t) {
            const s = new Sprite(t.texture);
            s.anchor.set(0.5);
            view = s;
            base = t.scale;
        } else {
            view = new Graphics(defaultRing());
            base = 1;
            own = DEFAULT_ALPHA;
        }
        view.blendMode = 'add';
        view.position.set(x, y);
        this.addChild(view);
        const r: Ripple = { view, base, unit, own, age: 0 };
        this.ripples.push(r);
        this.apply(r);
    }

    private apply(r: Ripple): void {
        const f = Math.min(1, r.age / DURATION);
        const scale = START_SCALE + (1 - START_SCALE) * Ease.OutQuad(f);
        r.view.scale.set(r.base * r.unit * scale);
        // FadeOutFromOne on the ripple's container: multiplies the image's own alpha.
        r.view.alpha = r.own * (1 - f);
    }

    tick(dt: number): void {
        const list = this.ripples;
        for (let i = list.length - 1; i >= 0; i--) {
            const r = list[i];
            r.age += dt;
            if (r.age >= DURATION) {
                r.view.destroy();
                list.splice(i, 1);
                continue;
            }
            this.apply(r);
        }
    }

    clear(): void {
        for (const r of this.ripples) r.view.destroy();
        this.ripples.length = 0;
    }
}
