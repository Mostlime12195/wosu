import { Container, Graphics, Rectangle, type FederatedPointerEvent, type FederatedWheelEvent } from 'pixi.js';
import { Signal } from '../core/Signal';
import { clamp, damp } from '../core/math';
import { tween } from '../core/Tweener';
import { UIComponent } from './UIComponent';
import { gesture } from './UIContext';

const DRAG_THRESHOLD = 6;

export interface ScrollContainerOptions {
    /**
     * Lean of a parallelogram viewport (horizontal offset per pixel of
     * height, e.g. lazer's 0.2 SHEAR): the mask and the scrollbar follow
     * the slanted edges. 0 (default) is a plain rectangle.
     */
    shear?: number;
}

/**
 * Vertical scroller modelled on osu-framework's ScrollContainer:
 * eased wheel scrolling, 1:1 dragging (mouse or touch) with fling
 * momentum, elastic overscroll and a thin auto-hiding scrollbar.
 *
 * Owners put children in `content` and set `contentHeight`.
 */
export class ScrollContainer extends UIComponent {
    readonly content = new Container();
    readonly scrolled = new Signal<[y: number]>();
    private readonly maskG = new Graphics();
    private readonly bar = new Graphics();

    private _contentHeight = 0;
    private current = 0;
    private target = 0;
    private velocity = 0;
    private dragging = false;
    private dragArmed = false;
    private dragStartY = 0;
    private dragStartScroll = 0;
    private lastMoveY = 0;
    private lastMoveTime = 0;
    private barVisibleUntil = 0;
    private clock = 0;
    /** Extra space past the content end (e.g. footer clearance). */
    padBottom = 0;
    /** Pixels per wheel notch. */
    wheelStep = 80;
    private readonly shear: number;

    constructor(opts: ScrollContainerOptions = {}) {
        super();
        this.shear = opts.shear ?? 0;
        this.addChild(this.content, this.maskG, this.bar);
        this.content.mask = this.maskG;
        this.bar.alpha = 0;
        this.eventMode = 'static';
        this.hitArea = new Rectangle(0, 0, 0, 0);
        this.on('wheel', this.onWheel, this);
        this.on('pointerdown', this.onDown, this);
        this.onFrame(dt => this.update(dt));
    }

    get contentHeight(): number {
        return this._contentHeight;
    }

    set contentHeight(h: number) {
        this._contentHeight = h;
        this.target = clamp(this.target, 0, this.maxScroll);
    }

    get scrollY(): number {
        return this.current;
    }

    get maxScroll(): number {
        return Math.max(0, this._contentHeight + this.padBottom - this._h);
    }

    get isDragging(): boolean {
        return this.dragging;
    }

    /** Visible content range in content coordinates. */
    visibleRange(): { top: number; bottom: number } {
        return { top: this.current, bottom: this.current + this._h };
    }

    scrollTo(y: number, animated = true): void {
        this.target = clamp(y, 0, this.maxScroll);
        this.velocity = 0;
        if (!animated) this.current = this.target;
        this.showBar();
    }

    /** Bring [top, bottom] into view with optional margin. */
    scrollIntoView(top: number, bottom: number, margin = 0, animated = true): void {
        if (top - margin < this.target) this.scrollTo(top - margin, animated);
        else if (bottom + margin > this.target + this._h) this.scrollTo(bottom + margin - this._h, animated);
    }

    /** Centre content position `y` in the viewport. */
    scrollToCenter(y: number, animated = true): void {
        this.scrollTo(y - this._h / 2, animated);
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        if (this.shear > 0) {
            // Top edge spans [h·shear, w], bottom edge [0, w − h·shear].
            const s = h * this.shear;
            this.maskG.clear().poly([s, 0, w, 0, w - s, h, 0, h]).fill(0xffffff);
        } else {
            this.maskG.clear().rect(0, 0, w, h).fill(0xffffff);
        }
        this.target = clamp(this.target, 0, this.maxScroll);
    }

    private onWheel(e: FederatedWheelEvent): void {
        if (e.ctrlKey || e.altKey) return; // reserved for volume / browser zoom
        const max = this.maxScroll;
        if (max <= 0) return;
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 40;
        else if (e.deltaMode === 2) dy *= this._h;
        // Trackpads send many small deltas; mouse wheels send ~100 per notch.
        if (Math.abs(dy) >= 50) dy = Math.sign(dy) * this.wheelStep * Math.min(3, Math.abs(dy) / 100);
        const before = this.target;
        this.target = clamp(this.target + dy, 0, max);
        this.velocity = 0;
        if (this.target !== before) e.stopPropagation();
        this.showBar();
    }

    private onDown(e: FederatedPointerEvent): void {
        if (e.button > 0) return;
        this.dragArmed = true;
        this.dragging = false;
        this.dragStartY = e.global.y;
        this.dragStartScroll = this.current;
        this.lastMoveY = e.global.y;
        this.lastMoveTime = performance.now();
        this.velocity = 0;
        this.target = this.current;
        this.on('globalpointermove', this.onMove, this);
        this.once('pointerup', this.onUp, this);
        this.once('pointerupoutside', this.onUp, this);
    }

    private onMove(e: FederatedPointerEvent): void {
        if (!this.dragArmed) return;
        const scale = this.worldTransform.d || 1;
        const dy = (e.global.y - this.dragStartY) / scale;
        if (!this.dragging) {
            if (Math.abs(dy) < DRAG_THRESHOLD) return;
            this.dragging = true;
            gesture.suppressClicks = true;
        }
        const now = performance.now();
        const dt = Math.max(1, now - this.lastMoveTime);
        const instV = -((e.global.y - this.lastMoveY) / scale) / dt;
        this.velocity = this.velocity * 0.6 + instV * 0.4;
        this.lastMoveY = e.global.y;
        this.lastMoveTime = now;
        let y = this.dragStartScroll - dy;
        // Elastic overscroll: resistance grows with distance past the edge.
        const max = this.maxScroll;
        if (y < 0) y = -rubber(-y, this._h);
        else if (y > max) y = max + rubber(y - max, this._h);
        this.current = this.target = y;
        this.showBar();
    }

    private onUp(): void {
        this.off('globalpointermove', this.onMove, this);
        this.off('pointerup', this.onUp, this);
        this.off('pointerupoutside', this.onUp, this);
        this.dragArmed = false;
        if (this.dragging) {
            this.dragging = false;
            // Stale velocity (finger rested before lifting) shouldn't fling.
            if (performance.now() - this.lastMoveTime > 80) this.velocity = 0;
            // Let the tap that ends this drag be ignored, then re-enable.
            setTimeout(() => (gesture.suppressClicks = false), 0);
        }
    }

    private showBar(): void {
        this.barVisibleUntil = this.clock + 900;
    }

    update(dt: number): void {
        this.clock += dt;
        const max = this.maxScroll;
        if (!this.dragging) {
            if (Math.abs(this.velocity) > 0.01) {
                this.target += this.velocity * dt;
                this.velocity *= Math.exp(-dt / 325);
                if (this.target < 0 || this.target > max) {
                    // Hitting an edge mid-fling: stop and spring back.
                    this.velocity = 0;
                }
            } else {
                this.velocity = 0;
            }
            this.target = clamp(this.target, 0, max);
            this.current = Math.abs(this.current - this.target) < 0.05 ? this.target : damp(this.current, this.target, 45, dt);
        }
        const y = Math.round(this.current * 2) / 2;
        if (this.content.y !== -y) {
            this.content.y = -y;
            this.scrolled.emit(this.current);
        }
        this.drawBar();
    }

    private drawBar(): void {
        const max = this.maxScroll;
        const visible = max > 0 && (this.clock < this.barVisibleUntil || this.hovered || this.dragging);
        const want = visible ? 0.5 : 0;
        if (Math.abs(this.bar.alpha - want) > 0.01) this.bar.alpha = damp(this.bar.alpha, want, 60, 16);
        if (max <= 0) return;
        const h = this._h;
        const total = this._contentHeight + this.padBottom;
        const barH = Math.max(30, (h * h) / total);
        const t = clamp(this.current / max, 0, 1);
        const y = t * (h - barH);
        if (this.shear > 0) {
            // Slanted bar hugging the leaning right edge (x = w − y·shear).
            const k = this.shear, w = this._w;
            const y0 = y + 2, y1 = y + barH - 2;
            const pts = [
                { x: w - y0 * k - 6, y: y0 }, { x: w - y0 * k - 2, y: y0 },
                { x: w - y1 * k - 2, y: y1 }, { x: w - y1 * k - 6, y: y1 },
            ];
            this.bar.clear().roundShape(pts, 2).fill(0xffffff);
        } else {
            this.bar.clear().roundRect(this._w - 6, y + 2, 4, barH - 4, 2).fill(0xffffff);
        }
    }

    protected override onHoverChange(): void {
        /* scrollbar visibility reads `hovered` each frame */
    }

    /** Briefly flash content (used when a list is refreshed). */
    flash(): void {
        this.content.alpha = 0.6;
        tween(this.content, { alpha: 1 }, { duration: 300 });
    }
}

function rubber(distance: number, size: number): number {
    // Diminishing returns: approaches size/2 asymptotically.
    const c = 0.55;
    return (1 - 1 / ((distance * c) / size + 1)) * size * 0.5;
}
