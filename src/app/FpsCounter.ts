import { Container, Graphics, type BitmapText } from 'pixi.js';
import { counterText } from '../ui/text';
import { Colors } from '../ui/theme';
import type { FrameStats } from './FrameLoop';

/**
 * lazer-style FPS display (bottom-right): frames drawn per second, then
 * updates per second (lazer's update rate; wosu! updates once per drawn
 * frame), how many frames reached the screen when fewer did, the CPU time
 * of an update + draw and the longest gap between frames. The rate is
 * coloured by how close it is to the limiter's target. Bitmap text, so
 * updating it costs nothing.
 */
export class FpsCounter extends Container {
    private readonly bg = new Graphics();
    private readonly fpsText: BitmapText;
    private readonly msText: BitmapText;
    private accum = 0;

    constructor(private readonly stats: Readonly<FrameStats>) {
        super();
        this.fpsText = counterText('60fps', { size: 15 });
        this.msText = counterText('60ups', { size: 11, light: true, color: Colors.grayC });
        this.fpsText.anchor.set(1, 1);
        this.msText.anchor.set(1, 1);
        this.addChild(this.bg, this.fpsText, this.msText);
        this.eventMode = 'none';
        this.visible = false;
    }

    update(dt: number): void {
        if (!this.visible) return;
        this.accum += dt;
        if (this.accum < 250) return;
        this.accum = 0;
        const s = this.stats;
        const draw = Math.round(s.drawHz);
        this.fpsText.text = `${draw}fps`;
        // Frames drawn outside rAF can be dropped before they're shown (browser flags with a cap).
        const shown = s.presentedHz < s.drawHz * 0.9 ? ` · ${Math.round(s.presentedHz)} shown` : '';
        this.msText.text = `${Math.round(s.updateHz)}ups${shown} · ${s.workMs.toFixed(1)}ms · ${s.worstGapMs.toFixed(0)}`;
        // Green while the loop keeps up with what the limiter asks for.
        const ratio = s.drawHz / Math.max(1, s.targetHz);
        const color = ratio > 0.9 ? Colors.lime : ratio > 0.45 ? Colors.yellow : Colors.red;
        this.fpsText.tint = color;
        this.msText.position.set(0, 0);
        this.fpsText.position.set(-this.msText.width - 8, 0);
        const w = this.fpsText.width + this.msText.width + 20;
        this.bg.clear().roundRect(-w + 6, -22, w, 24, 5).fill({ color: 0x000000, alpha: 0.6 });
    }
}
