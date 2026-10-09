import { Container, Graphics, type Text } from 'pixi.js';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';

/**
 * lazer's OsuResumeOverlay: after "continue", gameplay waits until the
 * player puts the cursor back on the orange circle (where it was when
 * they paused) and clicks or presses a gameplay key, so resuming never
 * costs a miss.
 */
export class ResumeOverlay extends Container {
    private readonly ring = new Graphics();
    private readonly text: Text;
    private clock = 0;
    private radius = 30;
    active = false;
    /** Target position in logical px. */
    targetX = 0;
    targetY = 0;

    constructor() {
        super();
        this.eventMode = 'none';
        this.text = label('Click the orange cursor to resume', { size: 22, weight: '600', shadow: true });
        this.text.anchor.set(0.5);
        this.addChild(this.ring, this.text);
        this.visible = false;
    }

    show(x: number, y: number, radius: number): void {
        this.active = true;
        this.visible = true;
        this.targetX = x;
        this.targetY = y;
        this.radius = Math.max(24, radius);
        this.clock = 0;
    }

    hide(): void {
        this.active = false;
        this.visible = false;
    }

    /** True when a press at (x, y) should resume. */
    hits(x: number, y: number): boolean {
        return this.active && Math.hypot(x - this.targetX, y - this.targetY) <= this.radius * 1.2;
    }

    update(dt: number, viewW: number, viewH: number, cursorX: number, cursorY: number): void {
        if (!this.active) return;
        this.clock += dt;
        const over = this.hits(cursorX, cursorY);
        const pulse = 1 + 0.08 * Math.sin(this.clock / 150);
        const r = this.radius * (over ? 1.15 : pulse);
        this.ring.clear()
            .circle(this.targetX, this.targetY, r).fill({ color: Colors.orange, alpha: over ? 0.55 : 0.35 })
            .circle(this.targetX, this.targetY, r).stroke({ width: 4, color: Colors.orange });
        this.text.position.set(viewW / 2, viewH * 0.25);
    }
}
