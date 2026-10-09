import { Container } from 'pixi.js';
import { Easing, type EasingFn } from '../../core/easing';
import type { SkinChain } from '../../skin/SkinChain';
import { LegacyFont, LegacySpriteText } from './SpriteText';

/**
 * lazer's RollingCounter: every new value starts a transform from the
 * value shown now to the new one, over a fixed duration.
 */
class Rolling {
    shown: number;
    private from: number;
    private to: number;
    private elapsed = 0;

    constructor(initial: number, private readonly duration: number, private readonly easing: EasingFn) {
        this.shown = this.from = this.to = initial;
    }

    set(target: number): void {
        if (target === this.to) return;
        this.from = this.shown;
        this.to = target;
        this.elapsed = 0;
    }

    step(dt: number): number {
        this.elapsed += dt;
        const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
        this.shown = this.from + (this.to - this.from) * this.easing(t);
        return this.shown;
    }
}

/** lazer's FormatAccuracy: floored (never rounded up) to 0.01%. */
function formatAccuracy(acc: number): string {
    return `${(Math.floor(acc * 10000 + 1e-6) / 100).toFixed(2)}%`;
}

/**
 * lazer's LegacyScoreCounter + LegacyAccuracyCounter, in the skin's score
 * font: the score (8 digits, rolling over 1 s with Easing.Out) at scale
 * 0.96, 10 units from the right edge; accuracy (rolling over 375 ms) at
 * 0.6 × 0.96, 17 units in and 9 below the score. Positions are in lazer's
 * 1024×768 HUD units; the owner scales this container to the screen.
 * The origin is the screen's top-right corner.
 */
export class ScoreCounter extends Container {
    private readonly score: LegacySpriteText;
    private readonly accuracy: LegacySpriteText;
    private readonly rollScore = new Rolling(0, 1000, Easing.Out);
    private readonly rollAcc = new Rolling(1, 375, Easing.OutQuad);

    constructor(chain: SkinChain) {
        super();
        const font = new LegacyFont(chain, 'score');
        this.score = new LegacySpriteText(font, { fixedWidth: true, alignRight: true });
        this.accuracy = new LegacySpriteText(font, { fixedWidth: true, alignRight: true });
        this.score.scale.set(0.96);
        this.accuracy.scale.set(0.6 * 0.96);
        this.score.x = -10;
        this.accuracy.x = -17;
        this.addChild(this.score, this.accuracy);
        this.score.text = '00000000';
        this.accuracy.text = formatAccuracy(1);
        this.place();
    }

    /** Element toggles; accuracy moves up into the score's place when that is hidden. */
    setShown(score: boolean, accuracy: boolean): void {
        this.score.visible = score;
        this.accuracy.visible = accuracy;
        this.place();
    }

    set(score: number, accuracy: number): void {
        this.rollScore.set(score);
        this.rollAcc.set(accuracy);
    }

    update(dt: number): void {
        this.score.text = String(Math.round(this.rollScore.step(dt))).padStart(8, '0');
        this.accuracy.text = formatAccuracy(this.rollAcc.step(dt));
    }

    /** lazer's default legacy layout: accuracy.Y = the score's bottom edge (plus its 9-unit margin). */
    private place(): void {
        const below = this.score.visible ? this.score.textHeight * this.score.scale.y : 0;
        this.accuracy.y = below + 9;
    }
}

const BIG_POP_OUT = 300;
const SMALL_POP_OUT = 100;
const FADE_OUT = 100;
/** ms per combo step when rolling back to 0. */
const ROLLING_DURATION = 20;
const FONT_HEIGHT_RATIO = 0.625;
const VERTICAL_OFFSET = 9;

interface Fade { from: number; to: number; start: number; duration: number }

/**
 * lazer's LegacyDefaultComboCounter (stable's combo counter), bottom-left
 * in the skin's combo font with the "x" suffix. On each +1 a larger
 * additive copy pops out (1.56× → 1 and 0.6 → 0 alpha over 300 ms) with
 * the new number; 160 ms later the main number catches up with a small
 * 1.1× bump. A break rolls the number back to 0 at 20 ms per step and
 * fades it out. Units are lazer's (the owner applies the 1.28 scale and
 * the screen scale); the origin is the counter's bottom-left corner.
 */
export class ComboCounter extends Container {
    private readonly main: LegacySpriteText;
    private readonly pop: LegacySpriteText;
    private clock = 0;
    private previous = 0;
    private current = 0;
    private displayed = 0;
    private rolling = false;
    private roll: { from: number; to: number; start: number; duration: number } | null = null;
    private popOutId = 0;
    private scheduled: { id: number; at: number } | null = null;
    private mainFade: Fade = { from: 0, to: 0, start: 0, duration: 0 };
    private smallPopAt = -1e9;
    private bigPopAt = -1e9;

    constructor(chain: SkinChain) {
        super();
        const font = new LegacyFont(chain, 'combo');
        this.main = new LegacySpriteText(font);
        this.pop = new LegacySpriteText(font);
        this.pop.blendMode = 'add';
        this.pop.alpha = 0;
        this.main.alpha = 0;
        this.addChild(this.pop, this.main);
        this.main.text = this.pop.text = '0x';
        // lazer's updateLayout: both scale about a point 0.625 of the way down the text (+9);
        // the pop-out's origin is 3 units further right, so it grows a little to the left.
        const h = this.main.textHeight;
        this.main.pivot.set(0, FONT_HEIGHT_RATIO * h + VERTICAL_OFFSET);
        this.pop.pivot.set(3, FONT_HEIGHT_RATIO * h + VERTICAL_OFFSET);
        this.main.position.set(0, -(1 - FONT_HEIGHT_RATIO) * h + VERTICAL_OFFSET);
        this.pop.position.set(0, -(1 - FONT_HEIGHT_RATIO) * h + VERTICAL_OFFSET);
    }

    /** Height of the counter in lazer units (before the 1.28 scale). */
    get textHeight(): number {
        return this.main.textHeight;
    }

    set(combo: number): void {
        if (combo === this.current) return;
        this.current = combo;
        this.updateCount(combo === 0);
    }

    private updateCount(rolling: boolean): void {
        const prev = this.previous;
        this.previous = this.current;
        if (!rolling) {
            this.finishRoll();
            this.rolling = false;
            this.setDisplayed(prev);
            if (prev + 1 === this.current) this.onCountIncrement(prev, this.current);
            else this.onCountChange(this.current);
        } else {
            this.onCountRolling(this.displayed, this.current);
            this.rolling = true;
        }
    }

    private finishRoll(): void {
        if (!this.roll) return;
        const to = this.roll.to;
        this.roll = null;
        this.setDisplayed(to);
    }

    /** lazer's DisplayedCount setter. */
    private setDisplayed(v: number): void {
        if (v === this.displayed) return;
        if (this.rolling) this.onDisplayedCountRolling(v);
        else if (this.displayed + 1 === v) this.onDisplayedCountIncrement(v);
        else this.onDisplayedCountChange(v);
        this.displayed = v;
    }

    private onCountIncrement(current: number, next: number): void {
        this.popOutId++;
        if (this.displayed < current) this.setDisplayed(this.displayed + 1);
        this.fadeMain(1, 0);
        // transformPopOut
        this.pop.text = `${next}x`;
        this.bigPopAt = this.clock;
        this.scheduled = { id: this.popOutId, at: this.clock + BIG_POP_OUT - 140 };
    }

    private onCountRolling(current: number, next: number): void {
        this.popOutId++;
        if (current === 0 && next === 0) this.fadeMain(0, FADE_OUT);
        this.roll = { from: current, to: next, start: this.clock, duration: Math.abs(current - next) * ROLLING_DURATION };
    }

    private onCountChange(next: number): void {
        this.popOutId++;
        if (next === 0) this.fadeMain(0, 0);
        this.setDisplayed(next);
    }

    private onDisplayedCountRolling(v: number): void {
        if (v === 0) this.fadeMain(0, FADE_OUT);
        else this.fadeMain(1, 0);
        this.noPopOut(v);
    }

    private onDisplayedCountChange(v: number): void {
        this.fadeMain(v === 0 ? 0 : 1, 0);
        this.noPopOut(v);
    }

    private onDisplayedCountIncrement(v: number): void {
        this.fadeMain(1, 0);
        this.main.text = `${v}x`;
        this.smallPopAt = this.clock;
    }

    private noPopOut(v: number): void {
        this.main.text = `${v}x`;
        this.smallPopAt = -1e9;
    }

    private fadeMain(to: number, duration: number): void {
        this.mainFade = { from: this.main.alpha, to, start: this.clock, duration };
        if (duration <= 0) this.main.alpha = to;
    }

    update(dt: number): void {
        this.clock += dt;
        const now = this.clock;
        if (this.scheduled && now >= this.scheduled.at) {
            const { id } = this.scheduled;
            this.scheduled = null;
            // Too late: a newer change invalidated it.
            if (id === this.popOutId) this.setDisplayed(this.displayed + 1);
        }
        if (this.roll) {
            const r = this.roll;
            const t = r.duration > 0 ? Math.min(1, (now - r.start) / r.duration) : 1;
            const v = Math.round(r.from + (r.to - r.from) * t);
            if (t >= 1) this.roll = null;
            this.setDisplayed(v);
        }
        const f = this.mainFade;
        this.main.alpha = f.duration > 0 ? f.from + (f.to - f.from) * Math.min(1, (now - f.start) / f.duration) : f.to;
        // Small pop: 1 → 1.1 (In) → 1 (Out) over 100 ms.
        const s = now - this.smallPopAt;
        const half = SMALL_POP_OUT / 2;
        this.main.scale.set(s < half ? 1 + 0.1 * Easing.In(s / half) : s < SMALL_POP_OUT ? 1.1 - 0.1 * Easing.Out((s - half) / half) : 1);
        // Big pop-out: 1.56 → 1 and 0.6 → 0 alpha over 300 ms (linear).
        const b = Math.min(1, (now - this.bigPopAt) / BIG_POP_OUT);
        this.pop.scale.set(1.56 + (1 - 1.56) * b);
        this.pop.alpha = 0.6 * (1 - b);
        this.pop.visible = b < 1;
    }
}
