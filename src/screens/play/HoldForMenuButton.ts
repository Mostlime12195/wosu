import { Graphics, type Text } from 'pixi.js';
import { damp } from '../../core/math';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';

const SIZE = 44;

/**
 * lazer's HoldForMenuButton (bottom-right): hold it to pause. It's the
 * only way to reach the pause menu on touch screens, and it's harmless
 * with a mouse: a stray click never pauses, it has to be held.
 */
export class HoldForMenuButton extends UIComponent {
    private readonly ring = new Graphics();
    private readonly caption: Text;
    private readonly glyph: Text;
    private held = 0;
    /** Hold time before it pauses (Settings → Gameplay → hold-to-confirm). */
    holdMs = 200;
    private holding = false;
    private fired = false;
    /** Faint until the pointer comes near (or always shown on touch). */
    private shown = 0.25;
    /** Hold progress the ring was last drawn at (-1: never drawn). */
    private drawnProgress = -1;
    onHeld: (() => void) | null = null;

    constructor() {
        super();
        this.caption = label('hold for menu', { size: 13, weight: '600' });
        this.caption.anchor.set(1, 0.5);
        this.glyph = icon('pause', 16, 0xffffff);
        this.addChild(this.caption, this.ring, this.glyph);
        this.makeInteractive({ sounds: false, rectHitArea: false });
        this.on('pointerdown', () => this.beginHold());
        const stop = () => (this.holding = false);
        this.on('pointerup', stop);
        this.on('pointerupoutside', stop);
        this.resize(SIZE, SIZE);
    }

    /**
     * Start holding. Gameplay calls this directly while the pointer is
     * locked (Pixi can't hit-test a locked pointer); any release ends it.
     */
    beginHold(): void {
        this.holding = true;
        this.fired = false;
        if (typeof window !== 'undefined') {
            window.addEventListener('pointerup', () => (this.holding = false), { once: true, passive: true });
        }
    }

    protected override onResize(w: number, h: number): void {
        this.glyph.position.set(w / 2, h / 2);
        this.caption.position.set(-8, h / 2);
        this.hitArea = { contains: (x: number, y: number) => x >= -120 && x <= w && y >= 0 && y <= h };
    }

    /** True when a logical-space point is over the button (gameplay ignores those presses). */
    containsPoint(x: number, y: number): boolean {
        return this.visible && x >= this.x - 120 && x <= this.x + this._w && y >= this.y && y <= this.y + this._h;
    }

    update(dt: number, pointer: { x: number; y: number }, touch: boolean): void {
        if (this.holding && !this.fired) {
            this.held += dt;
            if (this.held >= this.holdMs) {
                this.fired = true;
                this.held = 0;
                this.onHeld?.();
            }
        } else {
            this.held = Math.max(0, this.held - dt * 3);
        }
        const near = Math.hypot(pointer.x - (this.x + this._w / 2), pointer.y - (this.y + this._h / 2)) < 160;
        this.shown = damp(this.shown, touch || near || this.held > 0 ? 1 : 0.25, 80, dt);
        this.alpha = this.shown;
        this.caption.alpha = Math.max(0, (this.shown - 0.4) / 0.6);
        const p = this.holdMs > 0 ? Math.min(1, this.held / this.holdMs) : 0;
        // Rebuilding the ring's geometry allocates (stroke triangulation), so only redraw when it changes.
        if (p === this.drawnProgress) return;
        this.drawnProgress = p;
        const r = SIZE / 2 - 3;
        this.ring.clear()
            .circle(SIZE / 2, SIZE / 2, r).fill({ color: 0x000000, alpha: 0.4 })
            .circle(SIZE / 2, SIZE / 2, r).stroke({ width: 2, color: 0xffffff, alpha: 0.35 });
        if (p > 0) {
            this.ring.arc(SIZE / 2, SIZE / 2, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2).stroke({ width: 3, color: 0xffffff });
        }
    }
}
