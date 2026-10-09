import { Container, type Text } from 'pixi.js';
import { tween } from '../core/Tweener';
import { Box } from './Box';
import { label } from './text';
import type { TooltipHost } from './UIContext';

/**
 * Single shared tooltip (lazer's TooltipContainer): appears after a short
 * hover delay, follows the pointer and stays inside the viewport.
 */
export class TooltipLayer extends Container implements TooltipHost {
    private readonly bg = new Box({ color: 0x111111, alpha: 0.92, radius: 5 });
    private readonly text: Text;
    private owner: object | null = null;
    private showAt = 0;
    private clock = 0;
    private shown = false;

    constructor(private readonly pointer: () => { x: number; y: number }, private readonly viewport: () => { width: number; height: number }) {
        super();
        this.text = label('', { size: 13, weight: '600' });
        this.addChild(this.bg, this.text);
        this.alpha = 0;
        this.visible = false;
        this.eventMode = 'none';
    }

    show(content: string, owner: object): void {
        this.text.text = content;
        this.bg.resize(this.text.width + 16, this.text.height + 10);
        this.text.position.set(8, 5);
        if (this.owner !== owner) this.showAt = this.clock + (this.shown ? 0 : 400);
        this.owner = owner;
        this.visible = true;
    }

    hide(owner: object): void {
        if (this.owner !== owner) return;
        this.owner = null;
        this.shown = false;
        tween(this, { alpha: 0 }, { duration: 150 });
    }

    update(dt: number): void {
        this.clock += dt;
        if (!this.owner) {
            if (this.alpha <= 0) this.visible = false;
            return;
        }
        // The owner was hidden without a pointer-out (its overlay closed).
        const o = this.owner as { isOnScreen?: () => boolean };
        if (typeof o.isOnScreen === 'function' && !o.isOnScreen()) {
            this.hide(this.owner);
            return;
        }
        if (this.clock >= this.showAt && !this.shown) {
            this.shown = true;
            tween(this, { alpha: 1 }, { duration: 150 });
        }
        const p = this.pointer();
        const vp = this.viewport();
        const w = this.bg.w, h = this.bg.h;
        let x = p.x + 14, y = p.y + 22;
        if (x + w > vp.width - 4) x = vp.width - w - 4;
        if (y + h > vp.height - 4) y = p.y - h - 10;
        this.position.set(Math.round(x), Math.round(y));
    }
}
