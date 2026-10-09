import { Container, Sprite, type Texture } from 'pixi.js';
import { Anim, Ease } from './transforms';

/** osu-framework TextureStore's default ScaleAdjust: textures display at half their pixel size. */
const TEXTURE_SCALE_ADJUST = 2;
/** MenuCursorContainer.Cursor.base_scale. */
const BASE_SCALE = 0.15;
/** OsuColour.Pink. */
const PINK = 0xff66aa;

const enum DragRotation {
    NotDragging,
    DragStarted,
    Rotating,
}

/**
 * osu!lazer's MenuCursor: the arrow cursor used everywhere outside active
 * gameplay. Ported from MenuCursorContainer, numbers unchanged:
 *
 * - press: scale 1 → 0.9 over 800ms OutQuint, pink additive layer fades in
 *   over 800ms OutQuint;
 * - release (no buttons left): additive layer fades out over 500ms
 *   OutQuint, scale back to 1 over 500ms OutElastic;
 * - dragging more than 80px rotates the arrow towards the drag direction
 *   (120ms OutQuint per move), snapping back on release with OutElasticQuarter;
 * - show: fade in 250ms OutQuint, scale to 1 over 400ms OutQuint;
 *   hide: fade out 250ms OutQuint, scale to 0.6 over 250ms In.
 *
 * The container's origin is the arrow's top-left corner (the hotspot), so
 * scale and rotation pivot there like lazer's top-left-origin cursor.
 */
export class MenuCursor extends Container {
    private readonly inner = new Container();
    private readonly additive: Sprite;
    private readonly scaleAnim = new Anim(1);
    private readonly alphaAnim = new Anim(0);
    private readonly additiveAnim = new Anim(0);
    /** Degrees, like Drawable.Rotation. */
    private readonly rotationAnim = new Anim(0);

    private drag = DragRotation.NotDragging;
    private downX = 0;
    private downY = 0;
    private lastMoveX = 0;
    private lastMoveY = 0;
    private shown = false;

    /** CursorContainer.State: whether the game currently wants the menu cursor. */
    stateVisible = false;
    /** OsuSetting.CursorRotation. */
    rotationEnabled = true;

    constructor(base: Texture, additive: Texture) {
        super();
        this.eventMode = 'none';
        const sprite = new Sprite(base);
        this.additive = new Sprite(additive);
        this.additive.blendMode = 'add';
        this.additive.tint = PINK;
        this.additive.alpha = 0;
        this.inner.addChild(sprite, this.additive);
        this.addChild(this.inner);
        this.alpha = 0;
        this.visible = false;
        this.setCursorSize(1);
    }

    /** OsuSetting.MenuCursorSize (0.5–2). */
    setCursorSize(size: number): void {
        this.inner.scale.set((size * BASE_SCALE) / TEXTURE_SCALE_ADJUST);
    }

    /** Combined visibility (state, idle, focus); animates like PopIn / PopOut. */
    setShown(shown: boolean): void {
        if (shown === this.shown) return;
        this.shown = shown;
        if (shown) {
            this.alphaAnim.to(1, 250, Ease.OutQuint);
            this.scaleAnim.to(1, 400, Ease.OutQuint);
        } else {
            this.alphaAnim.to(0, 250, Ease.OutQuint);
            this.scaleAnim.to(0.6, 250, Ease.In);
        }
        if (this.drag === DragRotation.NotDragging) this.rotationAnim.to(0, 400, Ease.OutQuint);
    }

    /** OnMouseMove (positions in the cursor layer's space). */
    pointerMove(x: number, y: number): void {
        if (this.drag === DragRotation.NotDragging) return;
        this.lastMoveX = x;
        this.lastMoveY = y;
        const distance = Math.hypot(x - this.downX, y - this.downY);
        // Don't start rotating until the pointer moved away from the press point.
        if (this.drag === DragRotation.DragStarted && distance > 80) this.drag = DragRotation.Rotating;
        if (this.drag === DragRotation.Rotating && distance > 0) {
            const dx = x - this.downX;
            const dy = y - this.downY;
            let degrees = (Math.atan2(-dx, dy) * 180) / Math.PI + 24.3;
            // Always rotate in the direction of least distance.
            const current = this.rotationAnim.value;
            let diff = (degrees - current) % 360;
            if (diff < -180) diff += 360;
            if (diff > 180) diff -= 360;
            degrees = current + diff;
            this.rotationAnim.to(degrees, 120, Ease.OutQuint);
        }
    }

    /** OnMouseDown (any mouse button). */
    pointerDown(x: number, y: number): void {
        if (!this.stateVisible) return;
        this.scaleAnim.set(1).to(0.9, 800, Ease.OutQuint);
        this.additiveAnim.set(0).to(1, 800, Ease.OutQuint);
        if (this.rotationEnabled && this.drag !== DragRotation.Rotating) {
            // If already rotating, keep the rotation origin.
            this.drag = DragRotation.DragStarted;
            this.downX = x;
            this.downY = y;
        }
    }

    /** OnMouseUp; lazer only reacts once no button is held any more. */
    pointerUp(anyButtonHeld: boolean): void {
        if (anyButtonHeld) return;
        this.additiveAnim.set(1).to(0, 500, Ease.OutQuint);
        this.scaleAnim.to(1, 500, Ease.OutElastic);
        if (this.drag !== DragRotation.NotDragging) {
            const r = this.rotationAnim.value;
            this.rotationAnim.to(0, 400 * (0.5 + Math.abs(r / 960)), Ease.OutElasticQuarter);
            this.drag = DragRotation.NotDragging;
        }
    }

    update(dt: number): void {
        if (this.drag !== DragRotation.NotDragging &&
            Math.hypot(this.lastMoveX - this.downX, this.lastMoveY - this.downY) > 60) {
            // Floating rotation centre: lazer's Interpolation.ValueAt(0.04, down, last, 0, elapsed).
            const t = dt > 0 ? Math.min(1, 0.04 / dt) : 0;
            this.downX += (this.lastMoveX - this.downX) * t;
            this.downY += (this.lastMoveY - this.downY) * t;
        }
        this.alpha = this.alphaAnim.update(dt);
        this.scale.set(this.scaleAnim.update(dt));
        this.rotation = (this.rotationAnim.update(dt) * Math.PI) / 180;
        this.additive.alpha = this.additiveAnim.update(dt);
        this.visible = this.alpha > 0.001;
    }
}
