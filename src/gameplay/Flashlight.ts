import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { FLASHLIGHT_SMOOTHNESS, FlashlightState, type FlashlightFrame } from './FlashlightState';
import type { FlashlightSettings } from './mods';

/** Texture radius (px) of the hole's outer edge, where the field becomes opaque. */
const TEX_OUTER = 255;

let holeTexture: Texture | null = null;

/**
 * lazer's CircularFlashlight fragment shader baked into a texture: alpha =
 * smoothstep(r, r × smoothness, distance), black. The outermost pixels
 * are fully opaque so the surrounding fill rectangles join seamlessly.
 */
function flashlightTexture(): Texture {
    if (holeTexture && !holeTexture.destroyed) return holeTexture;
    const size = (TEX_OUTER + 1) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Texture.WHITE;
    const img = ctx.createImageData(size, size);
    const inner = TEX_OUTER / FLASHLIGHT_SMOOTHNESS;
    const c = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
            const t = Math.min(1, Math.max(0, (d - inner) / (TEX_OUTER - inner)));
            img.data[(y * size + x) * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    holeTexture = Texture.from(canvas);
    return holeTexture;
}

/**
 * The Flashlight mod's overlay (lazer's ModFlashlight.Flashlight drawn
 * with OsuFlashlight's circular shader): black everywhere except a soft
 * circle following the cursor, whose radius shrinks with combo, grows in
 * breaks and whose inside dims while a slider is held. Logic lives in
 * FlashlightState; this only draws it in screen space.
 */
export class Flashlight extends Container {
    readonly state: FlashlightState;
    private readonly hole: Sprite;
    private readonly fill = new Graphics();
    private readonly dimLayer = new Graphics();
    private w = 0;
    private h = 0;

    constructor(settings: FlashlightSettings) {
        super();
        this.state = new FlashlightState(settings);
        this.hole = new Sprite(flashlightTexture());
        this.hole.anchor.set(0.5);
        this.dimLayer.alpha = 0;
        this.addChild(this.hole, this.fill, this.dimLayer);
        this.eventMode = 'none';
    }

    resize(w: number, h: number): void {
        this.w = w;
        this.h = h;
        this.dimLayer.clear().rect(0, 0, w, h).fill(0x000000);
    }

    /**
     * Advance by `dt` gameplay ms and redraw. `scale` maps playfield units
     * to screen px (lazer scales the size by the playfield's draw scale) and
     * `toScreen` maps a playfield position.
     */
    update(dt: number, frame: FlashlightFrame, scale: number, toScreen: (x: number, y: number) => { x: number; y: number }): void {
        const s = this.state;
        s.update(dt, frame);
        const p = toScreen(s.x, s.y);
        const outer = s.size * FLASHLIGHT_SMOOTHNESS * scale;
        const hole = this.hole;
        hole.position.set(p.x, p.y);
        hole.scale.set(outer / TEX_OUTER);
        const half = (TEX_OUTER + 1) * hole.scale.x;
        const w = this.w, h = this.h;
        const x0 = p.x - half, x1 = p.x + half, y0 = p.y - half, y1 = p.y + half;
        // Overlapping by a pixel hides seams between the sprite and the field.
        this.fill.clear()
            .rect(0, 0, w, Math.max(0, y0 + 1)).fill(0x000000)
            .rect(0, y1 - 1, w, Math.max(0, h - y1 + 1)).fill(0x000000)
            .rect(0, y0, Math.max(0, x0 + 1), y1 - y0).fill(0x000000)
            .rect(x1 - 1, y0, Math.max(0, w - x1 + 1), y1 - y0).fill(0x000000);
        // sh_Flashlight.h: mix(colour, opaque black, dim) = the hole's alpha a
        // composited under a black layer of alpha `dim`: a + dim × (1 − a).
        this.dimLayer.alpha = s.dim;
    }
}
