import { BitmapText, Container, Graphics, type Text } from 'pixi.js';
import type { BreakPeriod } from '../../beatmap/types';
import { Easing } from '../../core/easing';
import { label } from '../../ui/text';
import { Colors, Fonts, gradeColor, gradeLabel } from '../../ui/theme';
import type { Grade } from '../../storage/ScoreStore';

/** Breaks shorter than this show nothing (stable's 650 ms threshold). */
const MIN_BREAK = 650;
const FADE = 300;

/**
 * lazer's break overlay: a countdown in the middle, a bar that shrinks
 * toward the centre as the break runs out, and the accuracy / grade so far.
 */
export class BreakOverlay extends Container {
    private readonly bar = new Graphics();
    private readonly counter: BitmapText;
    private readonly accText: Text;
    private readonly gradeText: Text;
    private readonly accCaption: Text;
    private readonly gradeCaption: Text;
    private w = 800;
    private shownSecond = -1;
    private shownGrade = '';
    /** "Break overlay" setting; break detection keeps working without it. */
    enabled = true;

    constructor(private readonly breaks: readonly BreakPeriod[]) {
        super();
        this.eventMode = 'none';
        this.counter = new BitmapText({ text: '', style: { fontFamily: Fonts.venera, fontSize: 48 } });
        this.counter.anchor.set(0.5);
        this.accCaption = label('accuracy', { size: 14, weight: '600', color: Colors.grayC });
        this.gradeCaption = label('rank', { size: 14, weight: '600', color: Colors.grayC });
        this.accText = label('', { size: 22, weight: '700' });
        this.gradeText = label('', { size: 22, weight: '800' });
        for (const t of [this.accCaption, this.gradeCaption, this.accText, this.gradeText]) t.anchor.set(0.5, 0);
        this.addChild(this.bar, this.counter, this.accCaption, this.gradeCaption, this.accText, this.gradeText);
        this.visible = false;
    }

    /** Break containing `time` (long enough to show), or null. */
    breakAt(time: number): BreakPeriod | null {
        for (const b of this.breaks) {
            if (b.endTime - b.startTime < MIN_BREAK) continue;
            if (time >= b.startTime && time <= b.endTime) return b;
        }
        return null;
    }

    layout(width: number): void {
        this.w = width;
        this.accCaption.position.set(-90, 56);
        this.gradeCaption.position.set(90, 56);
        this.accText.position.set(-90, 74);
        this.gradeText.position.set(90, 74);
    }

    update(time: number, accuracy: number, grade: Grade): void {
        const b = this.enabled ? this.breakAt(time) : null;
        if (!b) {
            this.visible = false;
            return;
        }
        const fadeIn = Math.min(1, (time - b.startTime) / FADE);
        const fadeOut = Math.min(1, (b.endTime - time) / FADE);
        this.alpha = Math.max(0, Math.min(fadeIn, fadeOut));
        this.visible = this.alpha > 0.001;
        const remaining = b.endTime - time;
        const frac = Math.max(0, remaining / (b.endTime - b.startTime));
        const half = (this.w * 0.35) * Easing.OutQuad(frac);
        this.bar.clear().roundRect(-half, -3, half * 2, 6, 3).fill({ color: 0xffffff, alpha: 0.85 });
        const second = Math.ceil(remaining / 1000);
        if (second !== this.shownSecond) {
            this.shownSecond = second;
            this.counter.text = String(Math.max(0, second));
        }
        this.counter.y = -42;
        this.accText.text = `${(accuracy * 100).toFixed(2)}%`;
        if (grade !== this.shownGrade) {
            this.shownGrade = grade;
            this.gradeText.text = gradeLabel(grade);
            this.gradeText.tint = gradeColor(grade);
        }
    }
}
