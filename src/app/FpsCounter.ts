import { Container, Graphics, type BitmapText } from 'pixi.js';
import { counterText } from '../ui/text';
import { Colors } from '../ui/theme';

/**
 * lazer-style FPS display (bottom-right): smoothed frame rate plus frame
 * time, coloured by how close the frame time is to the 60 Hz budget.
 * Bitmap text, so updating it every frame costs nothing.
 */
export class FpsCounter extends Container {
    private readonly bg = new Graphics();
    private readonly fpsText: BitmapText;
    private readonly msText: BitmapText;
    private avgDt = 16.7;
    private accum = 0;
    private worst = 0;

    constructor() {
        super();
        this.fpsText = counterText('60', { size: 15 });
        this.msText = counterText('16.7ms', { size: 11, light: true, color: Colors.grayC });
        this.fpsText.anchor.set(1, 1);
        this.msText.anchor.set(1, 1);
        this.addChild(this.bg, this.fpsText, this.msText);
        this.eventMode = 'none';
        this.visible = false;
    }

    update(dt: number): void {
        if (!this.visible) return;
        this.avgDt += (dt - this.avgDt) * 0.1;
        this.worst = Math.max(this.worst, dt);
        this.accum += dt;
        if (this.accum < 250) return;
        this.accum = 0;
        const fps = Math.round(1000 / Math.max(1, this.avgDt));
        this.fpsText.text = `${fps}fps`;
        this.msText.text = `${this.avgDt.toFixed(1)}ms · ${this.worst.toFixed(0)}`;
        this.worst = 0;
        const color = this.avgDt < 18 ? Colors.lime : this.avgDt < 34 ? Colors.yellow : Colors.red;
        this.fpsText.tint = color;
        this.msText.position.set(0, 0);
        this.fpsText.position.set(-this.msText.width - 8, 0);
        const w = this.fpsText.width + this.msText.width + 20;
        this.bg.clear().roundRect(-w + 6, -22, w, 24, 5).fill({ color: 0x000000, alpha: 0.6 });
    }
}
