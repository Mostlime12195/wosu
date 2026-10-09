import { Container, Sprite, type Texture } from 'pixi.js';
import type { PlayableBeatmap, PlayableHitObject } from '../../beatmap/types';
import { Easing } from '../../core/easing';
import type { SliderResources } from '../../graphics/slider/SliderRenderer';
import type { Skin } from '../../skin/Skin';
import type { GameplayRules } from '../GameplayRules';

/**
 * Everything a drawable hit object needs, shared by the whole playfield.
 * Drawables are pure functions of (song time, judgement state): they
 * never animate on their own, so pausing, seeking and frame drops can't
 * desync them from the music.
 */
export interface DrawableContext {
    readonly skin: Skin;
    readonly beatmap: PlayableBeatmap;
    readonly rules: GameplayRules;
    readonly sliders: SliderResources;
    /** Approach circles render above every object (lazer's proxy layer). */
    readonly approachLayer: Container;
    readonly radius: number;
    readonly preempt: number;
    readonly fadeIn: number;
    readonly hidden: boolean;
    readonly hideNumbers: boolean;
    readonly snakingIn: boolean;
    readonly snakingOut: boolean;
    /** Device pixels per osu! pixel (slider coverage texture resolution). */
    pixelsPerUnit: number;
    /** "Kiai flashes on hit objects" (off by default; stable has no such effect). */
    kiaiFlashes: boolean;
    /** Opacity (0..KIAI_FLASH_OPACITY) of lazer's kiai flash at `time`; 0 outside kiai or when disabled. */
    kiaiFlash(time: number): number;
}

/** lazer's KiaiFlash: flash_opacity, fade_length (and EarlyActivationMilliseconds). */
export const KIAI_FLASH_OPACITY = 0.25;
const KIAI_FADE = 80;

/**
 * lazer's default-skin KiaiFlash (osu.Game.Rulesets.Osu/Skinning/Default/
 * KiaiFlash.cs) as a pure function of song time: a white additive layer
 * over the circle body that, on every beat of a kiai section, rises to
 * 25% over the 80 ms before the beat (OutQuint), then fades out over the
 * rest of the beat (max(80, beatLength − 80) ms, OutSine). Beats come
 * from the governing uninherited timing point; inherited points can sit
 * off-beat, so they're skipped.
 */
export function makeKiaiFlash(beatmap: PlayableBeatmap, enabled: () => boolean): (time: number) => number {
    const reds = beatmap.data.timingPoints.filter(p => p.uninherited && p.beatLength > 0).sort((a, b) => a.time - b.time);
    return (time: number) => {
        if (!reds.length || !enabled()) return 0;
        // The beat whose flash is running: the latest one at or before time + 80 ms (early activation).
        const probe = time + KIAI_FADE;
        let lo = 0, hi = reds.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (reds[mid].time <= probe) lo = mid; else hi = mid - 1;
        }
        const red = reds[lo];
        const beat = red.time + Math.floor((probe - red.time) / red.beatLength) * red.beatLength;
        // BeatSyncedContainer reads the effect point at the beat itself.
        if (!beatmap.controlPoints.at(beat).kiai) return 0;
        if (time < beat) return KIAI_FLASH_OPACITY * Easing.OutQuint(clamp01((time - (beat - KIAI_FADE)) / KIAI_FADE));
        const fade = Math.max(KIAI_FADE, red.beatLength - KIAI_FADE);
        return KIAI_FLASH_OPACITY * (1 - Easing.OutSine(clamp01((time - beat) / fade)));
    };
}

/** Atlas circles are 256px; this scale makes them (old WebOsu proportions) fit radius r. */
export const circleScale = (r: number): number => r / 120;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const ease = Easing;

export function comboColor(ctx: DrawableContext, h: PlayableHitObject): number {
    const c = ctx.beatmap.comboColors;
    return c[h.comboColorIndex % c.length] ?? 0xffffff;
}

/**
 * Visibility of an object's body before it is judged: fade in over
 * `fadeIn` from the start of the approach; with Hidden, fade back out
 * over 30% of the approach right after (lazer's OsuModHidden).
 */
export function approachAlpha(ctx: DrawableContext, time: number, start: number, hiddenApplies: boolean): number {
    const appear = start - ctx.preempt;
    const a = clamp01((time - appear) / ctx.fadeIn);
    if (!hiddenApplies) return a;
    const fadeOutStart = appear + ctx.fadeIn;
    return Math.min(a, 1 - clamp01((time - fadeOutStart) / (ctx.preempt * 0.3)));
}

export function sprite(tex: Texture, scale = 1, anchor = 0.5): Sprite {
    const s = new Sprite(tex);
    s.anchor.set(anchor);
    s.scale.set(scale);
    s.eventMode = 'none';
    return s;
}

/** Combo number from the score digit sprites, centred on (0, 0). */
export function comboNumber(skin: Skin, n: number, radius: number): Container {
    const c = new Container();
    const digits = String(n);
    const scale = circleScale(radius) * (digits.length === 1 ? 0.8 : digits.length === 2 ? 0.7 : 0.6);
    let x = 0;
    const overlap = 12;
    const parts: Sprite[] = [];
    for (const ch of digits) {
        const s = sprite(skin.get(`score-${ch}.png`), 1, 0);
        s.anchor.set(0, 0.5);
        s.x = x;
        x += s.texture.width - overlap;
        parts.push(s);
        c.addChild(s);
    }
    const width = x + overlap;
    for (const s of parts) s.x -= width / 2;
    c.scale.set(scale);
    c.y = radius * 0.02;
    return c;
}

/**
 * The visual hit circle (shared by circles and slider heads): tinted base,
 * white overlay ring, combo number and an additive glow ring, plus the
 * flash used by the hit explosion.
 */
export class CirclePiece extends Container {
    readonly base: Sprite;
    readonly overlay: Sprite;
    readonly glow: Sprite;
    readonly flash: Sprite;
    /** lazer's KiaiFlash layer: additive white over the body, under the ring and number. */
    readonly kiai: Sprite;
    readonly number: Container | null;

    constructor(ctx: DrawableContext, h: PlayableHitObject, withNumber: boolean) {
        super();
        const s = circleScale(ctx.radius);
        const color = comboColor(ctx, h);
        this.base = sprite(ctx.skin.get('disc.png'), s);
        this.base.tint = color;
        this.overlay = sprite(ctx.skin.get('hitcircleoverlay.png'), s);
        this.glow = sprite(ctx.skin.get('ring-glow.png'), s * 0.92);
        this.glow.tint = color;
        this.glow.blendMode = 'add';
        this.flash = sprite(ctx.skin.get('hitburst.png'), s);
        this.flash.alpha = 0;
        this.flash.blendMode = 'add';
        this.kiai = sprite(ctx.skin.get('hitburst.png'), s);
        this.kiai.blendMode = 'add';
        this.kiai.alpha = 0;
        this.kiai.visible = false;
        this.addChild(this.base, this.kiai, this.overlay);
        this.number = withNumber && !ctx.hideNumbers ? comboNumber(ctx.skin, h.comboNumber, ctx.radius) : null;
        if (this.number) this.addChild(this.number);
        this.addChild(this.glow, this.flash);
        this.eventMode = 'none';
    }

    /** Idle (approaching) look at opacity `a`; `kiai` is the kiai flash opacity (see makeKiaiFlash). */
    showIdle(a: number, kiai = 0): void {
        this.visible = a > 0.001;
        this.alpha = a;
        this.scale.set(1);
        this.base.visible = this.overlay.visible = true;
        if (this.number) this.number.visible = true;
        this.glow.alpha = 0.5;
        this.flash.alpha = 0;
        this.kiai.visible = kiai > 0.001;
        this.kiai.alpha = kiai;
    }

    /**
     * lazer's MainCirclePiece hit animation, `dt` ms after the hit: a white
     * flash, the piece swelling to 1.5×, the circle itself vanishing under
     * the flash and the glow fading out.
     */
    showHit(dt: number): boolean {
        if (dt >= 800) {
            this.visible = false;
            return false;
        }
        this.visible = true;
        this.alpha = 1 - clamp01(dt / 800);
        this.scale.set(1 + 0.5 * Easing.OutQuad(clamp01(dt / 400)));
        const solid = dt < 40;
        this.kiai.visible = false;
        this.base.visible = this.overlay.visible = solid;
        if (this.number) this.number.visible = solid;
        this.flash.alpha = dt < 40 ? 0.8 * (dt / 40) : 0.8 * (1 - clamp01((dt - 40) / 100));
        this.glow.alpha = 0.6 * (1 - clamp01(dt / 400));
        return true;
    }

    /** Miss: quick fade from the alpha it had. */
    showMiss(dt: number, from: number): boolean {
        const a = from * (1 - clamp01(dt / 100));
        this.visible = a > 0.001;
        this.alpha = a;
        this.scale.set(1);
        this.flash.alpha = 0;
        return this.visible;
    }
}

/** Approach circle: 4× → 1× over the preempt, fading in over 2× fade-in. */
export class ApproachCircle extends Sprite {
    constructor(ctx: DrawableContext, color: number) {
        super(ctx.skin.get('approachcircle.png'));
        this.anchor.set(0.5);
        this.tint = color;
        this.eventMode = 'none';
        this.visible = false;
    }

    showAt(ctx: DrawableContext, time: number, start: number, x: number, y: number): void {
        const appear = start - ctx.preempt;
        if (time < appear) {
            this.visible = false;
            return;
        }
        const t = clamp01((time - appear) / ctx.preempt);
        this.visible = true;
        this.position.set(x, y);
        this.alpha = 0.9 * clamp01((time - appear) / Math.min(ctx.fadeIn * 2, ctx.preempt));
        this.scale.set(circleScale(ctx.radius) * (4 - 3 * t));
    }
}
