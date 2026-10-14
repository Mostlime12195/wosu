import { Particle, ParticleContainer, Rectangle, Texture } from 'pixi.js';
import type { SkinChain } from '../../skin/SkinChain';
import { SMOKE_FALLBACK_SIZE, SMOKE_SIZE_FACTOR, SmokeTrail, type SmokeQuad } from '../SmokeSegment';
import { PLAYFIELD_H, PLAYFIELD_W } from './Playfield';

/**
 * Cursor smoke (lazer's SmokeContainer with Legacy/DefaultSmokeSegment):
 * hold the smoke key to lay the skin's cursor-smoke along the cursor's
 * path. Sits in playfield units under the hit objects, on the gameplay
 * clock (see SmokeSegment for the point timing). Every point is one
 * additive particle, so the whole layer is a single draw call.
 */
export class SmokeLayer extends ParticleContainer {
    private readonly trail: SmokeTrail;
    private readonly tex: Texture;
    /** Particle scale per unit of a point's size (quad extent / texture pixels). */
    private readonly sx: number;
    private readonly sy: number;
    private readonly pool: Particle[] = [];
    private wasDrawing = false;

    constructor(skin: SkinChain) {
        super({ dynamicProperties: { position: true, vertex: true, rotation: true, color: true, uvs: false } });
        this.eventMode = 'none';
        this.blendMode = 'add';
        const t = skin.texture('cursor-smoke');
        this.tex = t?.texture ?? Texture.WHITE;
        // SmokeSegment.width / height: the texture's display size × 0.165 (half extents).
        const hw = t ? this.tex.width * t.scale * SMOKE_SIZE_FACTOR : SMOKE_FALLBACK_SIZE;
        const hh = t ? this.tex.height * t.scale * SMOKE_SIZE_FACTOR : SMOKE_FALLBACK_SIZE;
        this.sx = (2 * hw) / this.tex.width;
        this.sy = (2 * hh) / this.tex.height;
        this.trail = new SmokeTrail(hw, hh);
        // Smoke can be drawn anywhere the cursor goes; bounds are only for culling.
        this.boundsArea = new Rectangle(-PLAYFIELD_W, -PLAYFIELD_H, PLAYFIELD_W * 3, PLAYFIELD_H * 3);
    }

    /**
     * The smoke key's state and the cursor (playfield units) at gameplay
     * time `time`. Returns true when the key went down (a new segment).
     */
    input(time: number, drawing: boolean, x: number, y: number): boolean {
        const pressed = drawing && !this.wasDrawing;
        this.wasDrawing = drawing;
        if (pressed) {
            this.trail.setDrawing(true, time);
            // SmokeContainer.OnPressed adds the current position at once.
            this.trail.addPosition(x, y, time);
        } else if (drawing) {
            this.trail.addPosition(x, y, time);
        } else {
            this.trail.setDrawing(false, time);
        }
        return pressed;
    }

    /** Draw every visible point at gameplay time `time`. */
    draw(time: number): void {
        const kids = this.particleChildren;
        kids.length = 0;
        let n = 0;
        this.trail.draw(time, (q: SmokeQuad) => {
            let p = this.pool[n];
            if (!p) {
                p = this.pool[n] = new Particle({ texture: this.tex, anchorX: 0.5, anchorY: 0.5 });
            }
            n++;
            p.x = q.x;
            p.y = q.y;
            p.scaleX = q.scale * this.sx;
            p.scaleY = q.scale * this.sy;
            // lazer's quad runs its texture x axis along (sin a, -cos a).
            p.rotation = q.angle - Math.PI / 2;
            p.alpha = q.alpha;
            kids.push(p);
        });
        this.visible = n > 0;
        this.update();
    }
}
