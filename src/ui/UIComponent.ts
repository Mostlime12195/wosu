import { Container, Rectangle, type DestroyOptions, type FederatedPointerEvent } from 'pixi.js';
import { Disposer } from '../core/Signal';
import { tweener, type TweenOptions, type Tween } from '../core/Tweener';
import { lerpColor } from '../core/math';
import { gesture, ui, uiSounds } from './UIContext';
import { frame, scene } from '../core/frame';

export interface InteractiveOptions {
    /** Play hover/click UI sounds (default true). */
    sounds?: boolean;
    /** Use a rectangular hit area matching the logical size (default true). */
    rectHitArea?: boolean;
}

/**
 * Base for every UI element.
 *
 * Layout is explicit: a component owns a logical size (`w`/`h`) and lays
 * out its children in `onResize`. Pixi's own width/height setters scale a
 * container, so they are never used for layout.
 */
export class UIComponent extends Container {
    protected _w = 0;
    protected _h = 0;
    protected readonly disposer = new Disposer();

    hovered = false;
    pressed = false;
    private _enabled = true;
    private _tooltip: string | null = null;
    private interactiveOpts: InteractiveOptions | null = null;

    /** Called on activation (click/tap or keyboard). */
    onActivate: (() => void) | null = null;

    get w(): number {
        return this._w;
    }

    get h(): number {
        return this._h;
    }

    resize(w: number, h: number = this._h): this {
        w = Math.max(0, w);
        h = Math.max(0, h);
        if (w === this._w && h === this._h) return this;
        this._w = w;
        this._h = h;
        if (this.interactiveOpts?.rectHitArea !== false && this.interactiveOpts) this.updateHitArea();
        this.onResize(w, h);
        return this;
    }

    /** Re-run layout with the current size. */
    relayout(): void {
        this.onResize(this._w, this._h);
    }

    protected onResize(_w: number, _h: number): void {}

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    protected makeInteractive(opts: InteractiveOptions = {}): void {
        this.interactiveOpts = opts;
        this.eventMode = 'static';
        if (opts.rectHitArea !== false) this.updateHitArea();
        this.on('pointerover', this.handleOver, this);
        this.on('pointerout', this.handleOut, this);
        this.on('pointerdown', this.handleDown, this);
        this.on('pointerup', this.handleUp, this);
        this.on('pointerupoutside', this.handleUpOutside, this);
        this.on('pointertap', this.handleTap, this);
    }

    protected updateHitArea(): void {
        if (this.hitArea instanceof Rectangle) {
            this.hitArea.width = this._w;
            this.hitArea.height = this._h;
        } else {
            this.hitArea = new Rectangle(0, 0, this._w, this._h);
        }
    }

    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(v: boolean) {
        if (v === this._enabled) return;
        this._enabled = v;
        if (!v && this.hovered) this.handleOut();
        this.onEnabledChange(v);
    }

    protected onEnabledChange(_enabled: boolean): void {}

    set tooltip(text: string | null) {
        this._tooltip = text;
    }

    get tooltip(): string | null {
        return this._tooltip;
    }

    private handleOver(): void {
        if (!this._enabled) return;
        this.hovered = true;
        if (this.interactiveOpts?.sounds !== false) uiSounds()?.hover();
        if (this._tooltip) ui().tooltips.show(this._tooltip, this);
        this.onHoverChange(true);
    }

    private handleOut(): void {
        if (this._tooltip) ui().tooltips.hide(this);
        if (!this.hovered && !this.pressed) return;
        this.hovered = false;
        this.onHoverChange(false);
    }

    private handleDown(e: FederatedPointerEvent): void {
        if (!this._enabled || e.button > 0) return;
        this.pressed = true;
        this.onPressChange(true, e);
    }

    private handleUp(): void {
        if (!this.pressed) return;
        this.pressed = false;
        this.onPressChange(false);
    }

    private handleUpOutside(): void {
        this.handleUp();
        // Touch has no hover state: leaving without a tap clears it.
        if (this.hovered) this.handleOut();
    }

    private handleTap(e: FederatedPointerEvent): void {
        if (!this._enabled || e.button > 0) return;
        if (gesture.suppressClicks) return;
        this.activate();
    }

    /** Programmatic activation (also used by keyboard navigation). */
    activate(): void {
        if (!this._enabled) return;
        if (this.interactiveOpts?.sounds !== false) uiSounds()?.click();
        this.onClick();
        this.onActivate?.();
    }

    protected onHoverChange(_hovered: boolean): void {}
    protected onPressChange(_pressed: boolean, _e?: FederatedPointerEvent): void {}
    protected onClick(): void {}

    /**
     * Run `fn` every frame while this component is on screen; skipped while
     * it (or an ancestor) is hidden or detached. Unsubscribes on destroy.
     */
    protected onFrame(fn: (dt: number) => void): void {
        this.disposer.add(frame.add(dt => {
            if (this.isOnScreen()) fn(dt);
        }));
    }

    /** Visible, non-transparent and attached all the way up the tree. */
    isOnScreen(): boolean {
        let c: Container | null = this;
        let last: Container = this;
        while (c) {
            if (!c.visible || c.alpha <= 0) return false;
            last = c;
            c = c.parent;
        }
        return last === scene.stage;
    }

    // ------------------------------------------------------------------
    // Animation helpers
    // ------------------------------------------------------------------

    fadeTo(alpha: number, duration = 200, opts: TweenOptions = {}): Tween {
        return tweener.to(this, { alpha }, { duration, ...opts });
    }

    fadeIn(duration = 200, opts: TweenOptions = {}): Tween {
        this.visible = true;
        return this.fadeTo(1, duration, opts);
    }

    /** Fade out, then hide (so hidden subtrees cost nothing to render). */
    fadeOut(duration = 200, opts: TweenOptions = {}): Tween {
        const t = this.fadeTo(0, duration, opts);
        t.finished.then(() => {
            if (!t.cancelled && !this.destroyed) this.visible = false;
        });
        return t;
    }

    override destroy(options?: DestroyOptions | boolean): void {
        if (this.destroyed) return;
        if (this._tooltip) ui().tooltips.hide(this);
        this.disposer.dispose();
        tweener.kill(this);
        super.destroy(options ?? { children: true });
    }
}

/** Animate a display object's tint between colours (channel-wise lerp). */
export function tweenTint(
    target: { tint: number; destroyed?: boolean },
    to: number,
    duration: number,
    opts: TweenOptions = {},
): Tween {
    const from = Number(target.tint) & 0xffffff;
    const proxy = tintProxies.get(target) ?? { t: 0 };
    tintProxies.set(target, proxy);
    proxy.t = 0;
    return tweener.to(proxy, { t: 1 }, {
        duration,
        ...opts,
        onUpdate: p => {
            if (!target.destroyed) target.tint = lerpColor(from, to, Math.min(1, proxy.t));
            opts.onUpdate?.(p);
        },
    });
}

const tintProxies = new WeakMap<object, { t: number }>();
