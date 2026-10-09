import { Container, Sprite, Texture } from 'pixi.js';
import type { PlayableBeatmap, PlayableHitObject } from '../../beatmap/types';
import { Easing } from '../../core/easing';
import type { SliderResources } from '../../graphics/slider/SliderRenderer';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import type { GameplayRules } from '../GameplayRules';

/**
 * Everything a drawable hit object needs, shared by the whole playfield.
 * Drawables are pure functions of (song time, judgement state): they
 * never animate on their own, so pausing, seeking and frame drops can't
 * desync them from the music.
 */
export interface DrawableContext {
    /** The skins in effect (beatmap → selected → default); every element comes from here. */
    readonly skin: SkinChain;
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

/** osu! skin scale: at 1x a 128px hit circle spans one diameter (@2x textures carry 0.5). */
export const legacyScale = (radius: number, t: SkinTexture | null): number => (radius / 64) * (t?.scale ?? 1);

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

/** A combo number in the skin's hit circle font, centred on (0, 0), at osu!'s 0.8 circle scale. */
export function comboNumber(chain: SkinChain, n: number, radius: number): Container | null {
    const digits = String(n).split('').map(ch => chain.glyph('hitCirclePrefix', ch));
    if (digits.some(d => !d)) return null;
    const overlap = chain.config('hitCircleOverlap');
    const c = new Container();
    let x = 0;
    const parts: Sprite[] = [];
    for (const d of digits as SkinTexture[]) {
        const s = sprite(d.texture, d.scale, 0);
        s.anchor.set(0, 0.5);
        s.x = x;
        x += d.texture.width * d.scale - overlap;
        parts.push(s);
        c.addChild(s);
    }
    const width = x + overlap;
    for (const s of parts) s.x -= width / 2;
    c.scale.set((radius / 64) * 0.8);
    return c;
}

/**
 * The visual hit circle shared by circles and slider heads, drawn from
 * the skin like lazer's LegacyMainCirclePiece: the body (hitcircle, or
 * sliderstartcircle for slider heads) tinted with the combo colour, its
 * overlay, and the combo number above or below the overlay (skin.ini).
 */
export class CirclePiece extends Container {
    readonly base: Sprite;
    readonly overlay: Sprite | null;
    /** lazer's KiaiFlash (an opt-in extra): additive white over the body. */
    readonly kiai: Sprite;
    readonly number: Container | null;

    constructor(ctx: DrawableContext, h: PlayableHitObject, withNumber: boolean, sliderHead = false) {
        super();
        const chain = ctx.skin;
        const color = comboColor(ctx, h);
        // Slider heads use sliderstartcircle(+overlay) when the skin has it, else the hit circle.
        const start = sliderHead ? chain.texture('sliderstartcircle') : null;
        const body = start ?? chain.texture('hitcircle');
        const ring = start ? chain.texture('sliderstartcircleoverlay') : chain.frames('hitcircleoverlay')[0] ?? null;
        this.base = sprite(body?.texture ?? Texture.EMPTY, legacyScale(ctx.radius, body));
        this.base.tint = color;
        this.kiai = sprite(body?.texture ?? Texture.EMPTY, legacyScale(ctx.radius, body));
        this.kiai.blendMode = 'add';
        this.kiai.visible = false;
        this.overlay = ring ? sprite(ring.texture, legacyScale(ctx.radius, ring)) : null;
        this.number = withNumber && !ctx.hideNumbers ? comboNumber(chain, h.comboNumber, ctx.radius) : null;
        this.addChild(this.base, this.kiai);
        const parts = [this.overlay, this.number].filter((p): p is Container => !!p);
        if (!chain.config('hitCircleOverlayAboveNumber')) parts.reverse();
        if (parts.length) this.addChild(...parts);
        this.eventMode = 'none';
    }

    /** Idle (approaching) look at opacity `a`; `kiai` is the kiai flash opacity (see makeKiaiFlash). */
    showIdle(a: number, kiai = 0): void {
        this.visible = a > 0.001;
        this.alpha = a;
        this.scale.set(1);
        this.base.visible = true;
        if (this.overlay) this.overlay.visible = true;
        if (this.number) this.number.visible = true;
        this.kiai.visible = kiai > 0.001;
        this.kiai.alpha = kiai;
    }

    /**
     * osu!'s hit animation (lazer's LegacyMainCirclePiece), `dt` ms after
     * the hit: the circle swells to 1.4× and fades out over 240ms; the
     * number disappears at once.
     */
    showHit(dt: number): boolean {
        if (dt >= 240) {
            this.visible = false;
            return false;
        }
        const k = clamp01(dt / 240);
        this.visible = true;
        this.alpha = 1 - k;
        this.scale.set(1 + 0.4 * Easing.OutQuad(k));
        this.base.visible = true;
        if (this.overlay) this.overlay.visible = true;
        if (this.number) this.number.visible = false;
        this.kiai.visible = false;
        return true;
    }

    /** Miss: quick fade from the alpha it had. */
    showMiss(dt: number, from: number): boolean {
        const a = from * (1 - clamp01(dt / 100));
        this.visible = a > 0.001;
        this.alpha = a;
        this.scale.set(1);
        this.kiai.visible = false;
        return this.visible;
    }
}

/** Approach circle: 4× → 1× over the preempt, fading in over 2× fade-in, tinted with the combo colour. */
export class ApproachCircle extends Sprite {
    private readonly baseScale: number;

    constructor(ctx: DrawableContext, color: number) {
        const t = ctx.skin.texture('approachcircle');
        super(t?.texture ?? Texture.EMPTY);
        this.baseScale = legacyScale(ctx.radius, t);
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
        this.scale.set(this.baseScale * (4 - 3 * t));
    }
}
