import { Container, Sprite, Texture } from 'pixi.js';
import { STABLE_MAGIC_SCALE, type CursorSkin } from './CursorSkin';
import { CursorTrail } from './CursorTrail';
import { Anim, Ease } from './transforms';

/** LegacyCursor.REVOLUTION_DURATION: CursorRotate spins cursor.png once per 10 s, clockwise. */
const REVOLUTION_DURATION = 10000;

interface ExpandStyle {
    pressed: number;
    expandDuration: number;
    expandEase: Ease;
    contractDuration: number;
    contractEase: Ease;
}

/** SkinnableCursor (lazer's own cursor): 1 → 1.2 over 400ms OutElasticHalf, back over 400ms OutQuad. */
const DEFAULT_EXPAND: ExpandStyle = {
    pressed: 1.2, expandDuration: 400, expandEase: Ease.OutElasticHalf, contractDuration: 400, contractEase: Ease.OutQuad,
};
/** LegacyCursor: 1 → 1.3 over 100ms Out, back over 100ms Out. */
const LEGACY_EXPAND: ExpandStyle = {
    pressed: 1.3, expandDuration: 100, expandEase: Ease.OutQuad, contractDuration: 100, contractEase: Ease.OutQuad,
};

/**
 * The osu! gameplay cursor (lazer's OsuCursorContainer + OsuCursor + the
 * skin's cursor), drawn in screen space with sizes in playfield units.
 *
 * Skinned like lazer's LegacyCursor / LegacyCursorTrail (see CursorSkin):
 * cursor.png (the expand target, spinning with CursorRotate) under
 * cursormiddle.png, both anchored by CursorCentre and displayed at their
 * legacy size (pixels × 0.5 for @2x, / 1.6). wosu!'s own skin keeps
 * lazer's default cursor animation.
 *
 * - expand on each button press (when CursorExpand and the user setting
 *   allow it); contract when the last button is released;
 * - shown: container fades to 1 over 300ms OutQuint, cursor scales to 1
 *   over 400ms OutQuint; hidden (paused, touch): fades to 0.05 over
 *   450ms OutQuint and scales to 0.8;
 * - the trail fades over 200ms when toggled.
 */
export class GameplayCursor extends Container {
    trail: CursorTrail | null = null;
    private readonly sprite = new Sprite(Texture.EMPTY);
    private readonly middle = new Sprite(Texture.EMPTY);
    private readonly fadeAnim = new Anim(1);
    private readonly popScaleAnim = new Anim(1);
    private readonly expandAnim = new Anim(1);
    private readonly trailAnim = new Anim(1);
    private skin: CursorSkin | null = null;
    private style = DEFAULT_EXPAND;
    private spin = 0;
    private shown = true;
    private downCount = 0;
    private trailOn = true;
    private x0 = 0;
    private y0 = 0;

    /** OsuSetting "cursor expand on press" (on top of the skin's CursorExpand). */
    expandEnabled = true;
    /** OsuSetting.GameplayCursorSize. */
    userScale = 1;
    /** OsuSetting.AutoCursorSize. */
    autoSize = false;
    /** Beatmap circle size for the automatic size. */
    circleSize = 5;
    /** Logical px per playfield unit. */
    playfieldScale = 1;

    constructor() {
        super();
        this.eventMode = 'none';
        this.addChild(this.sprite, this.middle);
    }

    /** Use the skin's cursor, middle and trail (rebuilds the trail; keeps position and state). */
    setSkin(skin: CursorSkin): void {
        this.skin = skin;
        this.style = skin.legacy ? LEGACY_EXPAND : DEFAULT_EXPAND;
        const anchor = skin.centre ? 0.5 : 0;
        this.sprite.texture = skin.cursor?.texture ?? Texture.EMPTY;
        this.sprite.visible = !!skin.cursor;
        this.sprite.anchor.set(anchor);
        this.middle.texture = skin.middle?.texture ?? Texture.EMPTY;
        this.middle.visible = !!skin.middle;
        this.middle.anchor.set(anchor);
        if (!skin.rotate) this.spin = 0;
        if (this.expandAnim.end !== 1) this.expandAnim.set(this.downCount > 0 && this.canExpand ? this.style.pressed : 1);

        const old = this.trail;
        const same = old && skin.trail && old.skin.texture === skin.trail.texture &&
            old.skin.legacy === skin.trail.legacy && old.skin.disjoint === skin.trail.disjoint &&
            old.skin.centre === skin.trail.centre && old.skin.rotate === skin.trail.rotate;
        if (same) return;
        if (old) {
            old.destroy();
            this.trail = null;
        }
        if (skin.trail) {
            this.trail = new CursorTrail(skin.trail);
            this.addChildAt(this.trail, 0);
        }
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

    private get canExpand(): boolean {
        return this.expandEnabled && (this.skin?.expand ?? true);
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
        if (!this.canExpand) return;
        const s = this.style;
        this.expandAnim.set(1).to(s.pressed, s.expandDuration, s.expandEase);
    }

    private contract(): void {
        const s = this.style;
        this.expandAnim.to(1, s.contractDuration, s.contractEase);
    }

    /** Clear motion state when the cursor (re)appears for a new play. */
    reset(): void {
        this.downCount = 0;
        this.expandAnim.set(1);
        this.trail?.reset();
    }

    /** Position in logical px; every sample also extends the trail. */
    moveTo(x: number, y: number): void {
        this.x0 = x;
        this.y0 = y;
        this.trail?.addPosition(x, y);
    }

    /** Sync trail sizing with the cursor before adding samples (OsuCursorContainer.Update). */
    prepareTrail(): void {
        const t = this.trail;
        if (!t) return;
        t.playfieldScale = this.playfieldScale;
        t.cursorScale = this.cursorScale;
        t.userScale = this.userScale;
        t.partScale = this.expandAnim.value;
        t.partRotation = this.spin;
    }

    update(dt: number): void {
        this.alpha = this.fadeAnim.update(dt);
        const expand = this.expandAnim.update(dt);
        const pop = this.popScaleAnim.update(dt);
        if (this.skin?.rotate) this.spin = (this.spin + (dt / REVOLUTION_DURATION) * Math.PI * 2) % (Math.PI * 2);
        const unit = (this.playfieldScale * this.cursorScale * pop) / STABLE_MAGIC_SCALE;
        const c = this.skin?.cursor;
        if (c) {
            this.sprite.position.set(this.x0, this.y0);
            this.sprite.scale.set(c.scale * unit * expand);
            this.sprite.rotation = this.spin;
        }
        const m = this.skin?.middle;
        if (m) {
            this.middle.position.set(this.x0, this.y0);
            this.middle.scale.set(m.scale * unit);
        }
        const t = this.trail;
        if (t) {
            t.alpha = this.trailAnim.update(dt);
            t.partRotation = this.spin;
            t.tick(dt);
        }
    }
}
