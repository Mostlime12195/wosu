import { Container, Texture, type Sprite } from 'pixi.js';
import type { PlayableSpinner } from '../../beatmap/types';
import type { SpinnerState } from '../GameplayRules';
import { clamp01, ease, sprite, type DrawableContext } from './context';
import type { Drawable } from './DrawableHitCircle';
import {
    LegacyNewStyleSpinner, LegacyOldStyleSpinner, SPINNER_TOP_OFFSET, SPRITE_SCALE, spinnerStyle, WINDOW_TOP,
    type SpinnerBody, type SpinnerFrame,
} from './LegacySpinnerBody';
import { LegacySpriteText } from './LegacySpriteText';

/** lazer DrawableSpinner.fade_out_duration, from the judgement. */
const FADE_OUT = 240;
/** LegacySpinner.spm_hide_offset: the RPM counter slides up this far while fading in. */
const SPM_HIDE_OFFSET = 50;

/**
 * A spinner skinned like osu! (lazer's LegacySpinner and its two
 * subclasses): a new-style (spinner-glow/bottom/top/middle/middle2) or
 * old-style (spinner-background/circle/metre) body, chosen per skin like
 * lazer's OsuLegacySkinTransformer, plus the shared spinner-approachcircle,
 * spinner-spin and spinner-clear prompts, the spinner-rpm counter and
 * the bonus counter in the skin's score font.
 *
 * Everything is a function of song time and the rules' SpinnerState; the
 * only memory is when the spinner was completed, first spun and last gave
 * bonus (the rules keep totals only), which is forgotten on rewind.
 */
export class DrawableSpinner extends Container implements Drawable {
    readonly index: number;
    private readonly body: SpinnerBody;
    private readonly spin: Sprite;
    private readonly clear: Sprite;
    private readonly clearScale: number;
    private readonly bonusCounter: LegacySpriteText;
    private readonly spmBackground: Sprite;
    private readonly spmCounter: LegacySpriteText;
    private readonly frame: SpinnerFrame;
    private completedAt = Infinity;
    private firstSpinAt = Infinity;
    private lastBonus = 0;
    private bonusAt = -Infinity;

    constructor(private readonly ctx: DrawableContext, private readonly h: PlayableSpinner) {
        super();
        this.index = h.index;
        this.eventMode = 'none';
        this.position.set(h.x, h.y);
        const chain = ctx.skin;
        this.body = spinnerStyle(chain) === 'old' ? new LegacyOldStyleSpinner(chain) : new LegacyNewStyleSpinner(chain);
        // HD hides the spinner's approach circle (lazer OsuModHidden.hideSpinner).
        if (this.body.approachCircle && ctx.hidden) this.body.approachCircle.visible = false;

        const skinSprite = (name: string, anchor = 0.5): Sprite => {
            const t = chain.texture(name);
            return sprite(t?.texture ?? Texture.EMPTY, SPRITE_SCALE * (t?.scale ?? 1), anchor);
        };
        // stable window-space y (below the spinner's top offset) → local y.
        const y = (stableY: number) => WINDOW_TOP + SPINNER_TOP_OFFSET + stableY;

        this.bonusCounter = new LegacySpriteText(chain, 'scorePrefix');
        this.bonusCounter.y = y(299);
        this.bonusCounter.alpha = 0;
        this.spmBackground = skinSprite('spinner-rpm', 0);
        this.spmBackground.x = -87;
        this.spmCounter = new LegacySpriteText(chain, 'scorePrefix', 1, 0);
        this.spmCounter.scale.set(SPRITE_SCALE * 0.9);
        this.spmCounter.x = 80;
        this.spin = skinSprite('spinner-spin');
        this.spin.y = y(335);
        this.clear = skinSprite('spinner-clear');
        this.clear.y = y(115);
        this.clearScale = this.clear.scale.x;
        // The shared parts sit in front of the body (Depth = float.MinValue).
        const front = new Container();
        front.addChild(this.bonusCounter, this.spmBackground, this.spmCounter, this.spin, this.clear);
        this.addChild(this.body, front);

        this.frame = { time: 0, start: h.time, end: h.endTime, progress: 0, rotation: 0, bonusAt: -Infinity };
    }

    updateAt(time: number): boolean {
        const ctx = this.ctx, h = this.h;
        const s = ctx.rules.states[h.index] as SpinnerState;
        const fadeIn = Math.max(1, ctx.fadeIn);
        // lazer's HitStateUpdateTime: the judgement, or the end time until then.
        const judged = s.result !== null ? s.judgedAt : h.endTime;
        if (time > judged + FADE_OUT) return false;
        this.observe(time, s);

        // The body fades in over TimeFadeIn before the start (LegacyNew/OldStyleSpinner);
        // the whole spinner fades out over 240ms from the judgement (DrawableSpinner).
        let alpha = clamp01((time - (h.time - fadeIn)) / fadeIn);
        if (time > judged) alpha *= 1 - clamp01((time - judged) / FADE_OUT);
        this.visible = alpha > 0.001;
        this.alpha = alpha;
        if (!this.visible) return true;

        const f = this.frame;
        f.time = time;
        f.progress = s.required > 0 ? clamp01(s.progress / s.required) : 1;
        f.rotation = s.rotation;
        f.bonusAt = this.bonusAt;
        this.body.update(f);
        this.body.approachCircle?.update(f);

        this.updateSpm(time, s, fadeIn);
        this.updateSpin(time, judged, fadeIn);
        this.updateClear(time, judged);
        this.updateBonus(time);
        return true;
    }

    /** Remember when things happened (the rules only keep totals); forget them on rewind. */
    private observe(time: number, s: SpinnerState): void {
        const progress = s.required > 0 ? s.progress / s.required : 1;
        // lazer's Result.TimeCompleted (only checked from the start time on).
        if (progress >= 1 && time >= this.h.time) this.completedAt = Math.min(this.completedAt, time);
        else this.completedAt = Infinity;
        if (s.spinsAwarded > 0) this.firstSpinAt = Math.min(this.firstSpinAt, time);
        else this.firstSpinAt = Infinity;
        // Spins beyond required + 1 are bonus (GameplayRules.updateSpinner).
        const bonus = Math.max(0, s.spinsAwarded - Math.floor(s.required / (Math.PI * 2) + 1));
        if (bonus > this.lastBonus) this.bonusAt = time;
        else if (bonus < this.lastBonus) this.bonusAt = -Infinity;
        this.lastBonus = bonus;
    }

    /** spinner-rpm and its counter slide up 50px over TimeFadeIn before the start (Out). */
    private updateSpm(time: number, s: SpinnerState, fadeIn: number): void {
        const offset = SPM_HIDE_OFFSET * (1 - ease.Out(clamp01((time - (this.h.time - fadeIn)) / fadeIn)));
        this.spmBackground.y = WINDOW_TOP + 445 + offset;
        this.spmCounter.y = WINDOW_TOP + 448 + offset;
        this.spmCounter.text = String(Math.trunc(s.rpm));
    }

    /**
     * spinner-spin fades in over the last half of TimeFadeIn and out over
     * the last min(400, duration) ms; the first full spin (lazer's first
     * spinner tick) fades it out over 300ms instead, replacing the later
     * fade (osu-framework drops transforms that start after a new one).
     */
    private updateSpin(time: number, judged: number, fadeIn: number): void {
        const h = this.h;
        const fadeOutLength = Math.min(400, h.duration);
        const base = (t: number): number =>
            t < judged - fadeOutLength
                ? clamp01((t - (h.time - fadeIn / 2)) / (fadeIn / 2))
                : 1 - clamp01((t - (judged - fadeOutLength)) / Math.max(1, fadeOutLength));
        const tick = this.firstSpinAt;
        this.spin.alpha = time >= tick ? base(tick) * (1 - clamp01((time - tick) / 300)) : base(time);
    }

    /**
     * spinner-clear on completion: fades in over 400ms (Out) while scaling
     * 2 → 0.8 (240ms, Out) → 1 (160ms), started early enough to finish
     * 400ms before the end, then fades out over the last 50ms.
     */
    private updateClear(time: number, judged: number): void {
        if (time < this.completedAt) {
            this.clear.alpha = 0;
            return;
        }
        const start = Math.min(this.completedAt, judged - 400);
        const fade = (t: number) => ease.Out(clamp01((t - start) / 400));
        const d = time - start;
        const scale = d < 240 ? 2 + (0.8 - 2) * ease.Out(clamp01(d / 240)) : 0.8 + 0.2 * clamp01((d - 240) / 160);
        this.clear.scale.set(this.clearScale * scale);
        const fadeOutAt = judged - 50;
        this.clear.alpha = time < fadeOutAt ? fade(time) : fade(fadeOutAt) * (1 - clamp01((time - fadeOutAt) / 50));
    }

    /** Each bonus spin: the counter shows the bonus score, fading out (800ms, Out) as it shrinks 2 → 1.28 × SPRITE_SCALE. */
    private updateBonus(time: number): void {
        const c = this.bonusCounter;
        if (this.lastBonus <= 0 || time < this.bonusAt) {
            c.alpha = 0;
            return;
        }
        c.text = String(this.lastBonus * 1000);
        const k = ease.Out(clamp01((time - this.bonusAt) / 800));
        c.alpha = 1 - k;
        c.scale.set(SPRITE_SCALE * (2 + (1.28 - 2) * k));
    }
}
