import { BitmapText, Container, type Sprite } from 'pixi.js';
import type { PlayableSpinner } from '../../beatmap/types';
import { Fonts } from '../../ui/theme';
import { counterText } from '../../ui/text';
import type { SpinnerState } from '../GameplayRules';
import { clamp01, ease, sprite, type DrawableContext } from './context';
import type { Drawable } from './DrawableHitCircle';

/** Spinner disc diameter in osu! px (fills the playfield height). */
const DIAMETER = 380;
const FADE_OUT = 250;

/**
 * Spinner: dark disc whose bright core grows with progress, a spinning
 * hub, a shrinking approach ring that shows the time left, "spin!" /
 * "clear!" prompts, bonus counter and an RPM readout.
 */
export class DrawableSpinner extends Container implements Drawable {
    readonly index: number;
    private readonly base: Sprite;
    private readonly fill: Sprite;
    private readonly top: Sprite;
    private readonly ring: Sprite;
    private readonly prompt: BitmapText;
    private readonly bonus: BitmapText;
    private readonly rpm: BitmapText;
    private readonly content = new Container();
    private lastBonus = 0;
    private bonusAt = -Infinity;
    private clearedAt = Infinity;

    constructor(private readonly ctx: DrawableContext, private readonly h: PlayableSpinner) {
        super();
        this.index = h.index;
        const skin = ctx.skin;
        this.position.set(256, 192);
        this.base = sprite(skin.get('spinnerbase.png'), DIAMETER / 963);
        this.fill = sprite(skin.get('spinnerprogress.png'), 0);
        this.top = sprite(skin.get('spinnertop.png'), (DIAMETER * 0.3) / 295);
        this.ring = sprite(skin.get('approachcircle.png'), DIAMETER / 252);
        this.ring.alpha = 0.75;
        this.prompt = new BitmapText({ text: 'spin!', style: { fontFamily: Fonts.venera, fontSize: 34 } });
        this.prompt.anchor.set(0.5);
        this.prompt.y = 120;
        this.bonus = new BitmapText({ text: '', style: { fontFamily: Fonts.venera, fontSize: 40 } });
        this.bonus.anchor.set(0.5);
        this.bonus.y = -110;
        this.rpm = counterText('', { size: 15 });
        this.rpm.anchor.set(0.5, 0);
        this.rpm.position.set(0, 150);
        this.content.addChild(this.base, this.fill, this.ring, this.top, this.prompt, this.bonus);
        this.addChild(this.content, this.rpm);
        this.eventMode = 'none';
    }

    updateAt(time: number): boolean {
        const ctx = this.ctx, h = this.h;
        const s = ctx.rules.states[h.index] as SpinnerState;
        const appear = h.time - ctx.preempt;
        if (time > h.endTime + FADE_OUT) return false;
        let alpha = clamp01((time - appear) / Math.max(1, ctx.fadeIn));
        if (time > h.endTime) alpha *= 1 - clamp01((time - h.endTime) / FADE_OUT);
        this.visible = alpha > 0.001;
        this.alpha = alpha;
        if (!this.visible) return true;

        const progress = s.required > 0 ? s.progress / s.required : 1;
        const p = clamp01(progress);
        this.base.rotation = s.rotation / 2;
        this.top.rotation = s.rotation;
        this.fill.rotation = s.rotation / 2;
        this.fill.scale.set((DIAMETER / 963) * (0.13 + 0.87 * p));
        const zoomIn = ease.OutQuint(clamp01((time - appear) / 300));
        this.content.scale.set(0.8 + 0.2 * zoomIn + (time > h.endTime ? 0.15 * clamp01((time - h.endTime) / FADE_OUT) : 0));

        // Approach ring shrinks to nothing at the spinner's end.
        const remaining = time < h.time ? 1 : 1 - clamp01((time - h.time) / Math.max(1, h.duration));
        this.ring.visible = remaining > 0.01;
        this.ring.scale.set((DIAMETER / 252) * remaining);

        if (progress >= 1 && this.clearedAt === Infinity) this.clearedAt = time;
        if (progress < 1) this.clearedAt = Infinity;
        if (this.clearedAt !== Infinity) {
            this.prompt.text = 'clear!';
            const d = time - this.clearedAt;
            this.prompt.alpha = 1;
            this.prompt.scale.set(1 + 0.4 * (1 - ease.OutElastic(clamp01(d / 600))));
        } else {
            this.prompt.text = 'spin!';
            const d = time - h.time;
            this.prompt.alpha = d < 0 ? clamp01((time - appear) / 300) : 1 - clamp01((d - 600) / 400);
            this.prompt.scale.set(1);
        }

        // Same rule as GameplayRules: spins beyond required + 1 are bonus.
        const bonusSpins = Math.max(0, s.spinsAwarded - Math.floor(s.required / (Math.PI * 2) + 1));
        if (bonusSpins !== this.lastBonus) {
            if (bonusSpins > this.lastBonus) this.bonusAt = time;
            this.lastBonus = bonusSpins;
        }
        this.bonus.visible = bonusSpins > 0;
        if (this.bonus.visible) {
            this.bonus.text = String(bonusSpins * 1000);
            const d = clamp01((time - this.bonusAt) / 300);
            this.bonus.scale.set(1.3 - 0.3 * ease.OutQuint(d));
            this.bonus.alpha = 1 - 0.3 * d;
        }

        this.rpm.visible = time >= h.time;
        this.rpm.text = `${Math.round(s.rpm)} RPM`;
        return true;
    }
}
