import { Container, Sprite, type Texture } from 'pixi.js';
import { CursorTrail } from './CursorTrail';
import { Anim, Ease } from './transforms';

/** OsuCursor.SIZE in playfield units. */
const SIZE = 28;
/** Outer diameter of the white ring in cursor.png (250px texture, ring edge 32px in). */
const RING_DIAMETER_PX = 186;
/** SkinnableCursor pressed / released scales. */
const PRESSED_SCALE = 1.2;
const RELEASED_SCALE = 1;

/**
 * The osu! gameplay cursor (lazer's OsuCursorContainer + OsuCursor +
 * the default SkinnableCursor), drawn in screen space with sizes in
 * playfield units:
 *
 * - expand on each button press: scale 1 → 1.2 over 400ms OutElasticHalf;
 *   contract when the last button is released: 1 over 400ms OutQuad;
 * - shown: container fades to 1 over 300ms OutQuint, cursor scales to 1
 *   over 400ms OutQuint; hidden (paused, touch): fades to 0.05 over
 *   450ms OutQuint and scales to 0.8;
 * - the trail fades over 200ms when toggled.
 */
export class GameplayCursor extends Container {
    readonly trail: CursorTrail;
    private readonly sprite: Sprite;
    private readonly fadeAnim = new Anim(1);
    private readonly popScaleAnim = new Anim(1);
    private readonly expandAnim = new Anim(RELEASED_SCALE);
    private readonly trailAnim = new Anim(1);
    private shown = true;
    private downCount = 0;
    private trailOn = true;
    private x0 = 0;
    private y0 = 0;

    /** Skin CursorExpand (user setting here). */
    expandEnabled = true;
    /** OsuSetting.GameplayCursorSize. */
    userScale = 1;
    /** OsuSetting.AutoCursorSize. */
    autoSize = false;
    /** Beatmap circle size for the automatic size. */
    circleSize = 5;
    /** Logical px per playfield unit. */
    playfieldScale = 1;

    constructor(cursorTexture: Texture, trailTexture: Texture) {
        super();
        this.eventMode = 'none';
        this.trail = new CursorTrail(trailTexture);
        this.sprite = new Sprite(cursorTexture);
        this.sprite.anchor.set(0.5);
        this.addChild(this.trail, this.sprite);
    }

    /** OsuCursor.CalculateCursorScale. */
    get cursorScale(): number {
        let scale = this.userScale;
        if (this.autoSize) scale *= 1 - (0.7 * (1 + this.circleSize - 5)) / 5;
        return scale;
    }

    get pressedCount(): number {
        return this.downCount;
    }

    setTrailEnabled(on: boolean): void {
        if (on === this.trailOn) return;
        this.trailOn = on;
        this.trailAnim.to(on ? 1 : 0, 200);
    }

    /** PopIn / PopOut of the cursor container. */
    setShown(shown: boolean, instant = false): void {
        if (shown === this.shown && !instant) return;
        this.shown = shown;
        const d = instant ? 0 : 1;
        if (shown) {
            this.fadeAnim.to(1, 300 * d, Ease.OutQuint);
            this.popScaleAnim.to(1, 400 * d, Ease.OutQuint);
        } else {
            this.fadeAnim.to(0.05, 450 * d, Ease.OutQuint);
            this.popScaleAnim.to(0.8, 450 * d, Ease.OutQuint);
        }
    }

    /** Number of gameplay buttons held; each new press expands like OsuCursorContainer.OnPressed. */
    setDownCount(count: number): void {
        const prev = this.downCount;
        this.downCount = count;
        if (count > prev) this.expand();
        else if (count === 0 && prev > 0) this.contract();
    }

    private expand(): void {
        if (!this.expandEnabled) return;
        this.expandAnim.set(RELEASED_SCALE).to(PRESSED_SCALE, 400, Ease.OutElasticHalf);
    }

    private contract(): void {
        this.expandAnim.to(RELEASED_SCALE, 400, Ease.OutQuad);
    }

    /** Clear motion state when the cursor (re)appears for a new play. */
    reset(): void {
        this.downCount = 0;
        this.expandAnim.set(RELEASED_SCALE);
        this.trail.reset();
    }

    /** Position in logical px; every sample also extends the trail. */
    moveTo(x: number, y: number): void {
        this.x0 = x;
        this.y0 = y;
        this.trail.addPosition(x, y);
    }

    /** Sync trail sizing with the cursor before adding samples. */
    prepareTrail(): void {
        this.trail.playfieldScale = this.playfieldScale;
        this.trail.cursorScale = this.cursorScale;
        this.trail.partScale = this.expandAnim.value;
    }

    update(dt: number): void {
        this.alpha = this.fadeAnim.update(dt);
        const expand = this.expandAnim.update(dt);
        const pop = this.popScaleAnim.update(dt);
        this.sprite.position.set(this.x0, this.y0);
        this.sprite.scale.set((SIZE / RING_DIAMETER_PX) * this.playfieldScale * this.cursorScale * pop * expand);
        this.trail.alpha = this.trailAnim.update(dt);
        this.trail.tick(dt);
    }
}
