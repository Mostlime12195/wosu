import { Particle, ParticleContainer, Rectangle } from 'pixi.js';
import { STABLE_MAGIC_SCALE, type TrailSkin } from './CursorSkin';

/** CursorTrail.max_sprites. */
const MAX_PARTS = 2048;
/** LegacyCursorTrail.disjoint_trail_time_separation. */
const DISJOINT_SEPARATION = 1000 / 60;

type TrailPart = Particle & { born: number };

/**
 * osu!lazer's CursorTrail, in its two skinned forms:
 *
 * - wosu!'s own skin (lazer's DefaultCursorTrail): every movement is
 *   subdivided into parts spaced 1/2.5 of a part's width apart, which fade
 *   as (1 - age / 300ms)^1.7, drawn additively.
 * - an osu! skin (LegacyCursorTrail): with cursormiddle in the cursor's
 *   skin, the same continuous trail but fading linearly over 500ms, the
 *   spacing not growing past cursor size 1, and no part closer to the
 *   cursor than one spacing. Without cursormiddle, stable's disjoint trail:
 *   one part at the cursor every 1/60 s, fading linearly over 150ms with
 *   normal blending, top-left anchored unless CursorCentre.
 *
 * Part size is the texture's legacy display size (pixels × 0.5 for @2x,
 * / 1.6) × the cursor's expand scale at creation × the cursor size. With
 * CursorTrailRotate, all parts take the cursor's current spin.
 *
 * Parts are pooled particles in one ParticleContainer, so the whole trail
 * is a single draw call however fast the cursor moves.
 */
export class CursorTrail extends ParticleContainer {
    private readonly parts: TrailPart[] = [];
    private readonly pool: TrailPart[] = [];
    private readonly fadeDuration: number;
    private readonly fadeExponent: number;
    /** Texture display width in playfield units (before part and cursor scale). */
    private readonly displayWidth: number;
    private readonly anchor0: number;
    private now = 0;
    private lastX = 0;
    private lastY = 0;
    private hasLast = false;
    private lastTrailTime = -Infinity;

    /** Logical px per playfield unit. */
    playfieldScale = 1;
    /** OsuCursor.CursorScale (user size × beatmap auto size). */
    cursorScale = 1;
    /** OsuSetting.GameplayCursorSize (the legacy spacing ignores sizes above 1). */
    userScale = 1;
    /** NewPartScale: the cursor's current expand scale. */
    partScale = 1;
    /** PartRotation (radians): the cursor's current spin. */
    partRotation = 0;

    constructor(readonly skin: TrailSkin) {
        super({
            texture: skin.texture.texture,
            dynamicProperties: { position: true, vertex: true, rotation: skin.rotate, uvs: false, color: true },
        });
        const legacy = skin.legacy;
        this.fadeDuration = !legacy ? 300 : skin.disjoint ? 150 : 500;
        this.fadeExponent = legacy ? 1 : 1.7;
        this.displayWidth = (skin.texture.texture.width * skin.texture.scale) / STABLE_MAGIC_SCALE;
        this.anchor0 = skin.disjoint && !skin.centre ? 0 : 0.5;
        this.blendMode = skin.disjoint ? 'normal' : 'add';
        this.eventMode = 'none';
        // Particles are in screen space; skip bounds walking entirely.
        this.boundsArea = new Rectangle(-1e6, -1e6, 2e6, 2e6);
        this.particleChildren = this.parts;
    }

    /** Forget the last position and drop every part (new play, teleports). */
    reset(): void {
        this.hasLast = false;
        this.lastTrailTime = -Infinity;
        while (this.parts.length) this.pool.push(this.parts.pop()!);
        this.update();
    }

    /** AddTrail (positions in logical px). */
    addPosition(x: number, y: number): void {
        const first = !this.hasLast;
        if (first || this.skin.disjoint) {
            // The disjoint trail's OnMouseMove only records the position; tick() lays the parts.
            this.hasLast = true;
            this.lastX = x;
            this.lastY = y;
            return;
        }
        const x1 = this.lastX, y1 = this.lastY;
        const dx = x - x1, dy = y - y1;
        const distance = Math.hypot(dx, dy);
        if (distance <= 0) return;
        const multiplier = this.skin.legacy ? 1 / Math.max(this.userScale, 1) : 1;
        const interval = ((this.displayWidth * this.cursorScale) / 2.5) * multiplier * this.playfieldScale;
        if (!(interval > 0)) return;
        // AvoidDrawingNearCursor (legacy continuous trail).
        const stopAt = distance - (this.skin.legacy ? interval : 0);
        const ux = dx / distance, uy = dy / distance;
        for (let d = interval; d < stopAt; d += interval) {
            this.lastX = x1 + ux * d;
            this.lastY = y1 + uy * d;
            this.addPart(this.lastX, this.lastY);
        }
    }

    private addPart(x: number, y: number): void {
        if (this.parts.length >= MAX_PARTS) this.pool.push(this.parts.shift()!);
        const p = this.pool.pop() ??
            Object.assign(new Particle({ texture: this.skin.texture.texture, anchorX: this.anchor0, anchorY: this.anchor0 }), { born: 0 });
        const s = (this.skin.texture.scale / STABLE_MAGIC_SCALE) * this.partScale * this.cursorScale * this.playfieldScale;
        p.x = x;
        p.y = y;
        p.scaleX = s;
        p.scaleY = s;
        p.alpha = 1;
        p.born = this.now;
        this.parts.push(p);
        this.update();
    }

    tick(dt: number): void {
        this.now += dt;
        if (this.skin.disjoint && this.hasLast && this.now - this.lastTrailTime >= DISJOINT_SEPARATION) {
            // lazer's update thread runs far above 60Hz: keep a steady 60/s phase so a 60Hz
            // display's frame-time jitter doesn't drop every other part.
            const since = this.now - this.lastTrailTime;
            this.lastTrailTime = since < 2 * DISJOINT_SEPARATION ? this.now - (since % DISJOINT_SEPARATION) : this.now;
            this.addPart(this.lastX, this.lastY);
        }
        // Parts are in creation order and share one fade duration.
        let expired = 0;
        while (expired < this.parts.length && this.now - this.parts[expired].born >= this.fadeDuration) expired++;
        if (expired) {
            for (const p of this.parts.splice(0, expired)) this.pool.push(p);
            this.update();
        }
        const rotation = this.skin.rotate ? this.partRotation : 0;
        for (const p of this.parts) {
            p.alpha = Math.pow(1 - (this.now - p.born) / this.fadeDuration, this.fadeExponent);
            p.rotation = rotation;
        }
        this.renderable = this.parts.length > 0;
    }
}
