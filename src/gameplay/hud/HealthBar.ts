import { Container, Graphics } from 'pixi.js';
import { damp, lerpColor } from '../../core/math';

const LOW = 0.25;

/**
 * Health bar (top-left): the fill eases to the current HP; a red trail
 * marks recent damage and drains after it; the bar flashes on gains and
 * turns red when health is low.
 */
export class HealthBar extends Container {
    private readonly bg = new Graphics();
    private readonly trail = new Graphics();
    private readonly fill = new Graphics();
    private readonly glow = new Graphics();
    private shown = 1;
    private trailValue = 1;
    private flash = 0;
    private last = 1;
    private w = 300;
    private h = 8;

    constructor() {
        super();
        this.glow.blendMode = 'add';
        this.addChild(this.bg, this.trail, this.fill, this.glow);
        this.eventMode = 'none';
    }

    layout(width: number, height: number): void {
        this.w = width;
        this.h = height;
        this.bg.clear().roundRect(0, 0, width, height, height / 2).fill({ color: 0x000000, alpha: 0.45 });
    }

    update(hp: number, dt: number): void {
        if (hp > this.last + 0.001) this.flash = Math.min(1, this.flash + (hp - this.last) * 12);
        this.last = hp;
        this.shown = damp(this.shown, hp, 40, dt);
        // The damage trail holds briefly, then drains toward the fill.
        if (hp > this.trailValue) this.trailValue = hp;
        else this.trailValue = damp(this.trailValue, this.shown, 250, dt);
        this.flash = Math.max(0, this.flash - dt / 300);

        const w = this.w, h = this.h;
        const fw = Math.max(0, Math.min(1, this.shown)) * w;
        const tw = Math.max(0, Math.min(1, this.trailValue)) * w;
        const low = this.shown < LOW ? 1 - this.shown / LOW : 0;
        const color = lerpColor(0xffffff, 0xff4444, low);
        this.trail.clear();
        if (tw > fw + 0.5) this.trail.roundRect(0, 0, tw, h, h / 2).fill({ color: 0xff3355, alpha: 0.6 });
        this.fill.clear();
        if (fw > 0.5) this.fill.roundRect(0, 0, Math.max(h, fw), h, h / 2).fill(color);
        this.glow.clear();
        if (fw > 0.5 && this.flash > 0.01) {
            this.glow.roundRect(-2, -2, Math.max(h, fw) + 4, h + 4, h / 2 + 2).fill({ color: 0x99eeff, alpha: 0.5 * this.flash });
        }
    }
}
