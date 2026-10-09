import { Container, Graphics, Particle, ParticleContainer, Rectangle, type Texture } from 'pixi.js';
import { lerpColor, mulberry32 } from '../core/math';
import { UIComponent } from './UIComponent';
import { drawRoundedRect } from './Box';

export interface TrianglesOptions {
    colorLight: number;
    colorDark: number;
    /** Triangles per 100x100 px. */
    density?: number;
    /** Upward speed multiplier. */
    velocity?: number;
    /** Size multiplier. */
    scale?: number;
    /** Mask to a rounded rect of this radius (null = no mask). */
    maskRadius?: number | null;
    seed?: number;
    alpha?: number;
}

interface Tri {
    p: Particle;
    x: number; // 0..1 across width
    y: number; // px
    size: number;
}

/**
 * osu!lazer's drifting triangle backdrop. Triangles are particles in one
 * ParticleContainer (a single draw call) sharing a generated texture; the
 * optional rounded mask clips them to the owner's shape.
 */
export class Triangles extends UIComponent {
    private readonly particles: ParticleContainer;
    private readonly tris: Tri[] = [];
    private readonly maskG: Graphics | null = null;
    private readonly rand: () => number;
    private readonly content = new Container();
    paused = false;

    constructor(private readonly texture: Texture, private opts: TrianglesOptions) {
        super();
        this.rand = mulberry32(opts.seed ?? 1337);
        this.particles = new ParticleContainer({
            dynamicProperties: { position: true, vertex: false, rotation: false, uvs: false, color: false },
        });
        this.content.addChild(this.particles);
        this.addChild(this.content);
        if (opts.maskRadius !== null && opts.maskRadius !== undefined) {
            this.maskG = new Graphics();
            this.addChild(this.maskG);
            this.content.mask = this.maskG;
        }
        this.eventMode = 'none';
        this.onFrame(dt => this.update(dt));
        this.alpha = opts.alpha ?? 1;
    }

    setColors(light: number, dark: number): void {
        this.opts.colorLight = light;
        this.opts.colorDark = dark;
        for (const t of this.tris) t.p.tint = lerpColor(dark, light, this.rand());
    }

    protected override onResize(w: number, h: number): void {
        this.particles.boundsArea = new Rectangle(0, 0, w, h);
        if (this.maskG) {
            this.maskG.clear();
            drawRoundedRect(this.maskG, 0, 0, w, h, this.opts.maskRadius ?? 0).fill(0xffffff);
        }
        const density = this.opts.density ?? 1;
        const target = Math.max(4, Math.min(200, Math.round((w * h) / 10000 * density * 0.8)));
        while (this.tris.length < target) this.spawn(true);
        while (this.tris.length > target) {
            const t = this.tris.pop()!;
            this.particles.removeParticle(t.p);
        }
        for (const t of this.tris) t.p.x = t.x * w;
    }

    private spawn(randomY: boolean): void {
        const scale = this.opts.scale ?? 1;
        // Size distribution skewed toward small triangles, like lazer.
        const size = (0.1 + 0.9 * Math.pow(this.rand(), 2.5)) * 60 * scale + 6;
        const p = new Particle({
            texture: this.texture,
            anchorX: 0.5,
            anchorY: 0.5,
            scaleX: size / this.texture.width,
            scaleY: size / this.texture.width,
            tint: lerpColor(this.opts.colorDark, this.opts.colorLight, this.rand()),
            alpha: 1,
        });
        const t: Tri = { p, x: this.rand(), y: 0, size };
        t.y = randomY ? this.rand() * (this._h + size) : this._h + size;
        p.x = t.x * this._w;
        p.y = t.y;
        this.particles.addParticle(p);
        this.tris.push(t);
    }

    update(dt: number): void {
        if (this.paused) return;
        const v = (this.opts.velocity ?? 1) * dt * 0.012;
        const h = this._h;
        for (const t of this.tris) {
            // Bigger triangles move faster (parallax-ish depth cue).
            t.y -= v * (0.5 + t.size / 40);
            if (t.y < -t.size) {
                t.y = h + t.size;
                t.x = this.rand();
                t.p.x = t.x * this._w;
                t.p.tint = lerpColor(this.opts.colorDark, this.opts.colorLight, this.rand());
            }
            t.p.y = t.y;
        }
    }
}
