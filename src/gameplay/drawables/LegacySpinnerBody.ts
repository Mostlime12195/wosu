import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { clamp01, ease, sprite } from './context';

/**
 * The two osu! spinner bodies, ported from lazer's LegacyNewStyleSpinner
 * and LegacyOldStyleSpinner (osu.Game.Rulesets.Osu/Skinning/Legacy). Both
 * draw in osu!stable's 640×480 window space centred on the spinner, which
 * matches osu! pixels: local (0, 0) is the spinner centre, and stable's
 * window y maps to `y + WINDOW_TOP`.
 */

/** lazer LegacySpinner.SPRITE_SCALE. */
export const SPRITE_SCALE = 0.625;
/** stable gamefield → window shift (45 − 16) for the spinner's top. */
export const SPINNER_TOP_OFFSET = 45 - 16;
/** Spinner centre in stable window space (SPINNER_TOP_OFFSET + 219). */
export const SPINNER_Y_CENTRE = SPINNER_TOP_OFFSET + 219;
/** Local y of the window-space area's top edge (the area sits 8px above the spinner centre). */
export const WINDOW_TOP = -SPINNER_Y_CENTRE;

export type SpinnerStyle = 'new' | 'old';

/** What a body draws from at one song time (all derived from rules state). */
export interface SpinnerFrame {
    time: number;
    start: number;
    end: number;
    /** Clamped completion 0..1 (lazer's DrawableSpinner.Progress). */
    progress: number;
    /** Accumulated rotation in radians, clockwise positive (lazer's RotationTracker.Rotation). */
    rotation: number;
    /** When the latest bonus spin was awarded (−∞ if none). */
    bonusAt: number;
}

export interface SpinnerBody extends Container {
    /** lazer's IHasApproachCircle (driven by the shared spinner; hidden by HD). */
    readonly approachCircle: SpinnerApproachCircle | null;
    update(f: SpinnerFrame): void;
}

/**
 * lazer's OsuLegacySkinTransformer choice, per skin in the chain (the first
 * skin that has spinner art decides): spinner-background → old style;
 * spinner-top (and no background) → new style. Additionally, as in
 * osu!stable, a skin.ini Version below 2 with old-style art
 * (spinner-circle) is old style. Null if no skin has spinner art.
 */
export function spinnerStyle(chain: SkinChain): SpinnerStyle | null {
    for (const l of chain.layers) {
        if (!l.skin || l.textures === false) continue;
        const s = l.skin;
        if (s.texture('spinner-background')) return 'old';
        const version = s.config.version;
        if (version !== undefined && version < 2 && s.texture('spinner-circle')) return 'old';
        if (s.texture('spinner-top')) return 'new';
    }
    return null;
}

function skinSprite(t: SkinTexture | null, scale = 1): Sprite {
    return sprite(t?.texture ?? Texture.EMPTY, scale * (t?.scale ?? 1));
}

/** lazer's spinner approach circle: 1.86 × SPRITE_SCALE until the start, then down to 0.1 × over the duration. */
export class SpinnerApproachCircle extends Sprite {
    private readonly base: number;

    constructor(chain: SkinChain) {
        const t = chain.texture('spinner-approachcircle');
        super(t?.texture ?? Texture.EMPTY);
        this.base = t?.scale ?? 1;
        this.anchor.set(0.5);
        this.eventMode = 'none';
    }

    update(f: SpinnerFrame): void {
        const k = f.time < f.start ? 0 : clamp01((f.time - f.start) / Math.max(1, f.end - f.start));
        this.scale.set(this.base * SPRITE_SCALE * (1.86 + (0.1 - 1.86) * k));
    }
}

const GLOW_COLOUR = { r: 3, g: 151, b: 255 };
const rgb = (r: number, g: number, b: number): number => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

/**
 * lazer's LegacyNewStyleSpinner: glow (additive, blue, opacity = progress),
 * bottom (turns at a third of the top), top (half the cursor's rotation
 * when the skin has spinner-middle2, else all of it), middle2 (the full
 * rotation) and a fixed middle that fades white → red over the spinner.
 * The whole disc grows from 0.8 to 1 × SPRITE_SCALE with progress (Out).
 */
export class LegacyNewStyleSpinner extends Container implements SpinnerBody {
    readonly approachCircle: SpinnerApproachCircle;
    private readonly scaleContainer = new Container();
    private readonly glow: Sprite;
    private readonly bottom: Sprite;
    private readonly top: Sprite;
    private readonly middle2: Sprite;
    private readonly middle: Sprite;
    private readonly turnRatio: number;

    constructor(chain: SkinChain) {
        super();
        this.eventMode = 'none';
        this.glow = skinSprite(chain.texture('spinner-glow'));
        this.glow.blendMode = 'add';
        this.glow.tint = rgb(GLOW_COLOUR.r, GLOW_COLOUR.g, GLOW_COLOUR.b);
        this.bottom = skinSprite(chain.texture('spinner-bottom'));
        this.top = skinSprite(chain.texture('spinner-top'));
        const middle2 = chain.texture('spinner-middle2');
        this.middle2 = skinSprite(middle2);
        this.middle = skinSprite(chain.texture('spinner-middle'));
        this.turnRatio = middle2 ? 0.5 : 1;
        this.scaleContainer.addChild(this.glow, this.bottom, this.top, this.middle2, this.middle);
        // lazer adds this only when spinner-top comes from a user skin rather than
        // its built-in classic skin; wosu!'s default skin has its own ring, so always.
        this.approachCircle = new SpinnerApproachCircle(chain);
        this.addChild(this.scaleContainer, this.approachCircle);
    }

    update(f: SpinnerFrame): void {
        this.top.rotation = f.rotation * this.turnRatio;
        this.middle2.rotation = f.rotation;
        this.bottom.rotation = this.top.rotation / 3;

        // Update() overrides the hit FadeOut(300) every frame, so the glow is simply the progress.
        this.glow.alpha = f.progress;
        // Bonus ticks flash the glow white, fading back over 200ms (FlashColour).
        const flash = 1 - clamp01((f.time - f.bonusAt) / 200);
        const c = GLOW_COLOUR;
        this.glow.tint = f.time >= f.bonusAt && flash > 0
            ? rgb(c.r + (255 - c.r) * flash, c.g + (255 - c.g) * flash, c.b + (255 - c.b) * flash)
            : rgb(c.r, c.g, c.b);

        // Fixed middle: white until the start, then white → red over the duration.
        const red = f.time < f.start ? 0 : clamp01((f.time - f.start) / Math.max(1, f.end - f.start));
        this.middle.tint = rgb(255, 255 * (1 - red), 255 * (1 - red));

        this.scaleContainer.scale.set(SPRITE_SCALE * (0.8 + ease.Out(f.progress) * 0.2));
    }
}

/** stable's metre height in window space (692px art at SPRITE_SCALE). */
const FINAL_METRE_HEIGHT = 692 * SPRITE_SCALE;
const TOTAL_BARS = 10;

/** First metre texture row (texture px at `k` osu! px each) shown with `bars` bars lit. */
const metreTop = (bars: number, k: number): number =>
    Math.max(0, Math.floor((FINAL_METRE_HEIGHT * (1 - bars / TOTAL_BARS)) / k));

/** Deterministic stand-in for stable's per-frame RNG (~60 draws a second), so the drawable stays a function of time. */
function frameRandom(time: number): number {
    let x = Math.floor(time / 16) | 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
}

/**
 * lazer's LegacyOldStyleSpinner: a fixed background tinted with skin.ini's
 * SpinnerBackground (default 100,100,100), the spinner-circle turning with
 * the cursor, and spinner-metre revealed from the bottom in ten bars, the
 * top bar blinking with the progress into it unless SpinnerNoBlink.
 */
export class LegacyOldStyleSpinner extends Container implements SpinnerBody {
    readonly approachCircle: SpinnerApproachCircle;
    private readonly disc: Sprite;
    private readonly metre: Sprite;
    private readonly metreTexture: SkinTexture | null;
    /** Cropped metre textures by bar count. */
    private readonly metreFrames = new Map<number, Texture | null>();
    private readonly blink: boolean;

    constructor(chain: SkinChain) {
        super();
        this.eventMode = 'none';
        this.blink = !chain.config('spinnerNoBlink');
        const background = skinSprite(chain.texture('spinner-background'), SPRITE_SCALE);
        background.tint = chain.config('spinnerBackground') ?? rgb(100, 100, 100);
        this.disc = skinSprite(chain.texture('spinner-circle'), SPRITE_SCALE);
        this.metreTexture = chain.texture('spinner-metre');
        this.metre = sprite(Texture.EMPTY, SPRITE_SCALE * (this.metreTexture?.scale ?? 1), 0);
        // "this anchor makes no sense, but that's what stable uses": the window area's top-left.
        this.metre.x = -320;
        this.approachCircle = new SpinnerApproachCircle(chain);
        this.addChild(background, this.disc, this.metre, this.approachCircle);
    }

    update(f: SpinnerFrame): void {
        this.disc.rotation = f.rotation;
        let progress = f.progress * 100;
        // The spinner should still blink at 100% progress.
        if (this.blink) progress = Math.min(99, progress);
        let bars = Math.floor(progress / 10);
        if (this.blink && frameRandom(f.time) < (Math.floor(progress) % 10) / 10) bars++;
        const frame = this.metreFrame(bars);
        this.metre.visible = !!frame;
        if (frame) {
            this.metre.texture = frame;
            // The masked window's bottom edge stays at the metre's full height.
            const k = SPRITE_SCALE * (this.metreTexture?.scale ?? 1);
            this.metre.y = WINDOW_TOP + SPINNER_TOP_OFFSET + metreTop(bars, k) * k;
        }
    }

    /** The part of spinner-metre visible with `bars` bars lit (lazer masks a container instead). */
    private metreFrame(bars: number): Texture | null {
        if (this.metreFrames.has(bars)) return this.metreFrames.get(bars) ?? null;
        let out: Texture | null = null;
        const t = this.metreTexture;
        if (t && bars > 0) {
            const k = SPRITE_SCALE * t.scale;
            const fr = t.texture.frame;
            const top = metreTop(bars, k);
            const bottom = Math.min(fr.height, FINAL_METRE_HEIGHT / k);
            if (bottom - top >= 1) {
                out = new Texture({
                    source: t.texture.source,
                    frame: new Rectangle(fr.x, fr.y + top, fr.width, Math.floor(bottom - top)),
                });
            }
        }
        this.metreFrames.set(bars, out);
        return out;
    }

    override destroy(options?: Parameters<Container['destroy']>[0]): void {
        for (const t of this.metreFrames.values()) t?.destroy(false);
        this.metreFrames.clear();
        super.destroy(options);
    }
}
