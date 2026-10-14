import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { PlayableBeatmap, PlayableHitObject } from '../../beatmap/types';
import { Easing } from '../../core/easing';
import type { SliderResources } from '../../graphics/slider/SliderRenderer';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import type { SkinConfig } from '../../skin/SkinIni';
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
    /** Hidden fades objects out (lazer's OsuModHidden, unless "Only fade approach circles"). */
    readonly hidden: boolean;
    /** Hidden hides approach circles (lazer's IHidesApproachCircles), also with "Only fade approach circles". */
    readonly hideApproachCircles: boolean;
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

/** lazer's OsuHitObject.OBJECT_DIMENSIONS (one circle diameter, in osu! units at circle scale 1). */
export const OBJECT_SIZE = 128;
/** lazer's LegacySkinExtensions.SIXTY_FRAME_TIME: the default legacy animation frame length. */
export const SIXTY_FRAME_TIME = 1000 / 60;

const cropped = new WeakMap<Texture, Map<string, Texture>>();

/**
 * lazer's Texture.WithMaximumSize: an image whose display size (pixels at
 * its @2x/1x scale) exceeds `maxW`×`maxH` osu! units is cropped around its
 * centre to that size (not scaled), so oversized skin art can't cover the
 * playfield. Smaller images are returned as they are.
 */
export function capped(t: SkinTexture | null, maxW: number, maxH = maxW): SkinTexture | null {
    if (!t) return null;
    const tex = t.texture;
    if (tex.width * t.scale <= maxW && tex.height * t.scale <= maxH) return t;
    const key = `${maxW}x${maxH}`;
    let byKey = cropped.get(tex);
    if (!byKey) cropped.set(tex, (byKey = new Map()));
    let out = byKey.get(key);
    if (!out) {
        const w = Math.min(tex.width, Math.floor(maxW / t.scale));
        const h = Math.min(tex.height, Math.floor(maxH / t.scale));
        const f = tex.frame;
        out = new Texture({
            source: tex.source,
            frame: new Rectangle(f.x + Math.floor((f.width - w) / 2), f.y + Math.floor((f.height - h) / 2), w, h),
        });
        byKey.set(key, out);
    }
    return { texture: out, scale: t.scale };
}

/** Every frame of an animation through `capped`. */
export const cappedFrames = (frames: SkinTexture[], maxW: number, maxH = maxW): SkinTexture[] =>
    frames.map(f => capped(f, maxW, maxH) as SkinTexture);

/**
 * Index of the first layer of the chain that provides `name` (as a still
 * or, when `animatable`, as frames), or -1: lazer's ISkinSource.FindProvider.
 */
export function providerOf(chain: SkinChain, name: string, animatable = false): number {
    for (let i = 0; i < chain.layers.length; i++) {
        const l = chain.layers[i];
        if (!l.skin || l.textures === false) continue;
        if (animatable ? l.skin.frames(name).length : l.skin.texture(name)) return i;
    }
    return -1;
}

/**
 * Whether `name` comes from wosu!'s own default skin (the chain's last
 * layer). The default skin is drawn with wosu!'s own animations (modelled
 * on lazer's default skin), so it keeps its look; every other skin's
 * elements animate like lazer's legacy-skin pieces.
 */
export function fromDefaultSkin(chain: SkinChain, name: string, animatable = false): boolean {
    const i = providerOf(chain, name, animatable);
    return i >= 0 && i === chain.layers.length - 1;
}

/**
 * skin.ini Version as lazer's legacy pieces read it: from the first skin
 * that isn't a beatmap skin (beatmap skins use the version of the skin
 * below them). No skin.ini at all means "latest"; a skin.ini without a
 * Version line means 1.0.
 */
export function legacyVersion(chain: SkinChain): number {
    for (const l of chain.layers) {
        if (!l.skin || l.config !== undefined) continue;
        return layerVersion(l.skin.config);
    }
    return 2.7;
}

export const layerVersion = (cfg: SkinConfig): number => cfg.version ?? (Object.keys(cfg).length ? 1 : 2.7);

/** The frame of an animation `elapsed` ms in, `frameLength` ms per frame; looping, or holding the last frame. */
export function frameAt<T>(frames: T[], elapsed: number, frameLength: number, loop: boolean): T {
    const n = frames.length;
    if (n <= 1) return frames[0];
    const i = Math.floor(Math.max(0, elapsed) / frameLength);
    return frames[loop ? i % n : Math.min(n - 1, i)];
}

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

/** lazer's LegacyMainCirclePiece maximum size for circle sprites: two circle diameters. */
const CIRCLE_MAX = OBJECT_SIZE * 2;
/** LegacyMainCirclePiece's legacy_fade_duration. */
const CIRCLE_HIT_FADE = 240;

/**
 * LegacyMainCirclePiece's lookup (see CirclePiece). `blank`: the body is a
 * 1-2px placeholder with no overlay (a skin hiding slider end circles).
 */
export function resolveCircle(chain: SkinChain, prefix: string | null): {
    body: SkinTexture | null; ring: SkinTexture | null; providerIndex: number; blank: boolean;
} {
    const base = 'hitcircle';
    const providerIndex = providerOf(chain, base);
    const provider = providerIndex >= 0 ? chain.layers[providerIndex].skin : null;
    const hasPrefix = prefix !== null && !!(provider ? provider.texture(prefix) : chain.texture(prefix));
    const name = hasPrefix ? (prefix as string) : base;
    const body = capped(chain.texture(name), CIRCLE_MAX);
    const ring = capped(chain.texture(`${name}overlay`), CIRCLE_MAX);
    const blank = !ring && (!body || body.texture.width * body.scale <= 2);
    return { body, ring, providerIndex, blank };
}

/**
 * The visual hit circle shared by circles, slider heads and slider ends,
 * drawn from the skin like lazer's LegacyMainCirclePiece: the body tinted
 * with the combo colour, its overlay, and the combo number above or below
 * the overlay (skin.ini).
 *
 * Lookup (LegacyMainCirclePiece): `prefix` (sliderstartcircle for slider
 * heads, sliderendcircle for slider ends) is used only if the skin that
 * provides "hitcircle" also has it, else plain hitcircle; then the body
 * and `<name>overlay` are looked up through the whole chain. A skin with
 * sliderendcircle but no sliderendcircleoverlay gets no overlay (not
 * hitcircleoverlay). Images bigger than two circle diameters are cropped.
 */
export class CirclePiece extends Container {
    readonly base: Sprite;
    readonly overlay: Sprite | null;
    /** lazer's KiaiFlash (an opt-in extra): additive white over the body. */
    readonly kiai: Sprite;
    readonly number: Container | null;
    /** The body image is a placeholder (a blank sliderendcircle): nothing would be drawn. */
    readonly blank: boolean;
    private readonly baseScale: number;
    private readonly overlayScale: number;
    private readonly numberScale: number;
    /**
     * How the number leaves on a hit: wosu!'s default skin hides it at once;
     * legacy skins of Version 2.0+ fade it over 60ms, older ones swell and
     * fade it with the circle.
     */
    private readonly numberHit: 'hide' | 'short' | 'full';

    constructor(ctx: DrawableContext, h: PlayableHitObject, withNumber: boolean, prefix: string | null = null) {
        super();
        const chain = ctx.skin;
        const color = comboColor(ctx, h);
        const { body, ring, providerIndex, blank } = resolveCircle(chain, prefix);
        this.baseScale = legacyScale(ctx.radius, body);
        this.overlayScale = legacyScale(ctx.radius, ring);
        this.base = sprite(body?.texture ?? Texture.EMPTY, this.baseScale);
        this.base.tint = color;
        this.kiai = sprite(body?.texture ?? Texture.EMPTY, this.baseScale);
        this.kiai.blendMode = 'add';
        this.kiai.visible = false;
        this.overlay = ring ? sprite(ring.texture, this.overlayScale) : null;
        this.number = withNumber && !ctx.hideNumbers ? comboNumber(chain, h.comboNumber, ctx.radius) : null;
        this.numberScale = this.number?.scale.x ?? 1;
        this.blank = blank;
        this.numberHit = providerIndex === chain.layers.length - 1 ? 'hide' : legacyVersion(chain) > 1 ? 'short' : 'full';
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
        this.setParts(1, 1, 1, 1);
        this.kiai.visible = kiai > 0.001;
        this.kiai.alpha = kiai;
    }

    /**
     * lazer's LegacyMainCirclePiece hit animation, `dt` ms after the hit:
     * the body and overlay swell to 1.4× (ease out) and fade out over
     * 240ms; the number goes as `numberHit` says.
     */
    showHit(dt: number): boolean {
        if (dt >= CIRCLE_HIT_FADE) {
            this.visible = false;
            return false;
        }
        const k = clamp01(dt / CIRCLE_HIT_FADE);
        this.visible = true;
        this.alpha = 1;
        const a = 1 - k, s = 1 + 0.4 * Easing.OutQuad(k);
        const numberAlpha = this.numberHit === 'hide' ? 0 : this.numberHit === 'short' ? 1 - clamp01(dt / (CIRCLE_HIT_FADE / 4)) : a;
        this.setParts(a, s, numberAlpha, this.numberHit === 'full' ? s : 1);
        this.kiai.visible = false;
        return true;
    }

    /** Miss: quick fade from the alpha it had. */
    showMiss(dt: number, from: number): boolean {
        const a = from * (1 - clamp01(dt / 100));
        this.visible = a > 0.001;
        this.alpha = a;
        this.setParts(1, 1, 1, 1);
        this.kiai.visible = false;
        return this.visible;
    }

    private setParts(alpha: number, scale: number, numberAlpha: number, numberScale: number): void {
        this.scale.set(1);
        this.base.alpha = alpha;
        this.base.scale.set(this.baseScale * scale);
        if (this.overlay) {
            this.overlay.alpha = alpha;
            this.overlay.scale.set(this.overlayScale * scale);
        }
        if (this.number) {
            this.number.visible = numberAlpha > 0.001;
            this.number.alpha = numberAlpha;
            this.number.scale.set(this.numberScale * numberScale);
        }
    }
}

/** Approach circle: 4× → 1× over the preempt, fading in over 2× fade-in, tinted with the combo colour. */
export class ApproachCircle extends Sprite {
    private readonly baseScale: number;

    constructor(ctx: DrawableContext, color: number) {
        // lazer's LegacyApproachCircle crops the image to two circle diameters.
        const t = capped(ctx.skin.texture('approachcircle'), CIRCLE_MAX);
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
