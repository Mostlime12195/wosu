import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Colors } from '../../ui/theme';

const POOL = 40;
const TICK_LIFE = 3000;

interface Tick {
    sprite: Sprite;
    at: number;
}

/**
 * Horizontal hit error meter (bottom centre, stable style): the 50/100/300
 * windows as coloured bands, one tick per hit at its offset (early left,
 * late right) fading over a few seconds, and an arrow tracking the
 * running average.
 */
export class HitErrorMeter extends Container {
    private readonly bands = new Graphics();
    private readonly arrow = new Graphics();
    private readonly ticks: Tick[] = [];
    private next = 0;
    private average = 0;
    private hasAverage = false;
    private pxPerMs = 1;
    private clock = 0;

    constructor(private readonly w300: number, private readonly w100: number, private readonly w50: number) {
        super();
        this.eventMode = 'none';
        this.addChild(this.bands);
        for (let i = 0; i < POOL; i++) {
            const s = new Sprite(Texture.WHITE);
            s.anchor.set(0.5);
            s.visible = false;
            this.ticks.push({ sprite: s, at: -1e9 });
            this.addChild(s);
        }
        this.addChild(this.arrow);
    }

    /** `width` spans the 50 window; origin is the meter's centre. */
    layout(width: number, unit: number): void {
        this.pxPerMs = width / 2 / this.w50;
        const g = this.bands;
        const h = 4 * unit;
        g.clear();
        g.rect(-this.w50 * this.pxPerMs, -h / 2, this.w50 * 2 * this.pxPerMs, h).fill({ color: Colors.meh, alpha: 0.8 });
        g.rect(-this.w100 * this.pxPerMs, -h / 2, this.w100 * 2 * this.pxPerMs, h).fill({ color: Colors.ok, alpha: 0.9 });
        g.rect(-this.w300 * this.pxPerMs, -h / 2, this.w300 * 2 * this.pxPerMs, h).fill({ color: Colors.great });
        g.rect(-1 * unit, -9 * unit, 2 * unit, 18 * unit).fill(0xffffff);
        for (const t of this.ticks) t.sprite.setSize(2 * unit, 16 * unit);
        this.arrow.clear().poly([0, -10 * unit, -5 * unit, -17 * unit, 5 * unit, -17 * unit]).fill(0xffffff);
    }

    add(error: number): void {
        const t = this.ticks[this.next];
        this.next = (this.next + 1) % POOL;
        const e = Math.max(-this.w50, Math.min(this.w50, error));
        const abs = Math.abs(error);
        t.sprite.tint = abs <= this.w300 ? Colors.great : abs <= this.w100 ? Colors.ok : Colors.meh;
        t.sprite.x = e * this.pxPerMs;
        t.at = this.clock;
        t.sprite.visible = true;
        this.average = this.hasAverage ? this.average * 0.85 + e * 0.15 : e;
        this.hasAverage = true;
    }

    update(dt: number): void {
        this.clock += dt;
        for (const t of this.ticks) {
            if (!t.sprite.visible) continue;
            const age = this.clock - t.at;
            if (age > TICK_LIFE) t.sprite.visible = false;
            else t.sprite.alpha = 0.8 * (1 - age / TICK_LIFE);
        }
        this.arrow.visible = this.hasAverage;
        this.arrow.x += (this.average * this.pxPerMs - this.arrow.x) * Math.min(1, dt / 120);
    }
}
