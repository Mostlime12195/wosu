import { Particle, ParticleContainer, Rectangle, type Texture } from 'pixi.js';

/** CursorTrail.max_sprites. */
const MAX_PARTS = 2048;
/** CursorTrail.FadeDuration. */
const FADE_DURATION = 300;
/** CursorTrail.FadeExponent. */
const FADE_EXPONENT = 1.7;
/**
 * Displayed size of one part in playfield units: cursortrail.png is 10px,
 * shown at 5 units (TextureStore ScaleAdjust 2), and DefaultCursorTrail
 * scales the whole trail by 1 / ScaleAdjust again.
 */
const PART_SIZE = 2.5;
/** Spacing between parts in playfield units: DisplayWidth / 2.5, halved by the same trail scale. */
const PART_INTERVAL = 1;

type TrailPart = Particle & { born: number };

/**
 * osu!lazer's CursorTrail (the default skin's DefaultCursorTrail): each
 * pointer movement is subdivided into parts spaced one playfield unit
 * apart, which then fade as (1 - age / 300ms)^1.7. Parts are pooled
 * particles in one ParticleContainer, so the whole trail is a single
 * additive draw call however fast the cursor moves.
 */
export class CursorTrail extends ParticleContainer {
    private readonly parts: TrailPart[] = [];
    private readonly pool: TrailPart[] = [];
    private readonly texture0: Texture;
    private now = 0;
    private lastX = 0;
    private lastY = 0;
    private hasLast = false;

    /** Logical px per playfield unit. */
    playfieldScale = 1;
    /** OsuCursor.CursorScale (user size × beatmap auto size). */
    cursorScale = 1;
    /** NewPartScale: the cursor's current expand scale. */
    partScale = 1;

    constructor(texture: Texture) {
        super({
            texture,
            dynamicProperties: { position: true, vertex: true, rotation: false, uvs: false, color: true },
        });
        this.texture0 = texture;
        this.blendMode = 'add';
        this.eventMode = 'none';
        // Particles are in screen space; skip bounds walking entirely.
        this.boundsArea = new Rectangle(-1e6, -1e6, 2e6, 2e6);
        this.particleChildren = this.parts;
    }

    /** Forget the last position and drop every part (new play, teleports). */
    reset(): void {
        this.hasLast = false;
        while (this.parts.length) this.pool.push(this.parts.pop()!);
        this.update();
    }

    /** AddTrail with interpolated movements (positions in logical px). */
    addPosition(x: number, y: number): void {
        if (!this.hasLast) {
            this.hasLast = true;
            this.lastX = x;
            this.lastY = y;
            return;
        }
        const x1 = this.lastX, y1 = this.lastY;
        const dx = x - x1, dy = y - y1;
        const distance = Math.hypot(dx, dy);
        if (distance <= 0) return;
        const interval = PART_INTERVAL * this.cursorScale * this.playfieldScale;
        if (!(interval > 0)) return;
        const ux = dx / distance, uy = dy / distance;
        for (let d = interval; d < distance; d += interval) {
            this.lastX = x1 + ux * d;
            this.lastY = y1 + uy * d;
            this.addPart(this.lastX, this.lastY);
        }
    }

    private addPart(x: number, y: number): void {
        if (this.parts.length >= MAX_PARTS) this.pool.push(this.parts.shift()!);
        const p = this.pool.pop() ?? Object.assign(new Particle({ texture: this.texture0, anchorX: 0.5, anchorY: 0.5 }), { born: 0 });
        const s = (PART_SIZE * this.partScale * this.cursorScale * this.playfieldScale) / this.texture0.width;
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
        // Parts are in creation order and share one fade duration.
        let expired = 0;
        while (expired < this.parts.length && this.now - this.parts[expired].born >= FADE_DURATION) expired++;
        if (expired) {
            for (const p of this.parts.splice(0, expired)) this.pool.push(p);
            this.update();
        }
        for (const p of this.parts) {
            p.alpha = Math.pow(1 - (this.now - p.born) / FADE_DURATION, FADE_EXPONENT);
        }
        this.renderable = this.parts.length > 0;
    }
}
