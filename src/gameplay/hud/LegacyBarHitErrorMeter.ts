import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Easing } from '../../core/easing';
import { Colors } from '../../ui/theme';

/** lazer's LegacySkin.STABLE_MAGIC_SCALE_FACTOR. */
const MAGIC = 1.6;
const BAR_HEIGHT = 3;
const HEIGHT = BAR_HEIGHT * 4 * MAGIC;
const POOL = 50;
/** Judgement lines appear at 0.4 alpha and fade out over 10 s. */
const LINE_ALPHA = 0.4;
const LINE_LIFE = 10000;
const ARROW_DURATION = 800;

interface Line {
    sprite: Sprite;
    at: number;
}

/**
 * lazer's LegacyBarHitErrorMeter (stable's ScoreMeterError), the hit
 * error meter of the legacy HUD layout: a translucent black strip with
 * the 50/100/300 windows as centred bars (1.6 units per ms of window), a
 * centre line, an additive line per hit fading over 10 s, and an arrow
 * easing to a running average. Units are lazer's; the origin is the
 * meter's bottom centre (lazer anchors it at the screen's bottom centre).
 */
export class LegacyBarHitErrorMeter extends Container {
    private readonly lines: Line[] = [];
    private readonly arrow = new Graphics();
    private readonly halfWidth: number;
    private next = 0;
    private clock = 0;
    private floatingError = 0;
    private arrowFrom = 0;
    private arrowTo = 0;
    private arrowAt = -1e9;

    constructor(private readonly w300: number, private readonly w100: number, private readonly w50: number) {
        super();
        this.eventMode = 'none';
        const max = Math.max(1, w300, w100, w50);
        const width = max * MAGIC;
        this.halfWidth = width / 2;
        const g = new Graphics();
        g.rect(-width / 2, -HEIGHT, width, HEIGHT).fill({ color: 0x000000, alpha: 0.6 });
        // Widest first, so the narrower windows draw on top (lazer's window order).
        const barH = BAR_HEIGHT * MAGIC;
        for (const [w, colour] of [[w50, Colors.meh], [w100, Colors.ok], [w300, Colors.great]] as const) {
            g.rect((-w * MAGIC) / 2, -HEIGHT / 2 - barH / 2, w * MAGIC, barH).fill(colour);
        }
        g.rect(-0.75 * MAGIC, -HEIGHT, 1.5 * MAGIC, HEIGHT).fill(0xffffff);
        this.addChild(g);
        for (let i = 0; i < POOL; i++) {
            const s = new Sprite(Texture.WHITE);
            s.anchor.set(0.5);
            s.setSize(3, HEIGHT);
            s.y = -HEIGHT / 2;
            s.blendMode = 'add';
            s.visible = false;
            this.lines.push({ sprite: s, at: -1e9 });
            this.addChild(s);
        }
        // A downward triangle hanging from the top edge.
        const aw = 17 * 0.6;
        const ah = 8 * 0.6;
        this.arrow.poly([-aw / 2, 0, aw / 2, 0, 0, ah]).fill(0xffffff);
        this.arrow.y = -HEIGHT;
        this.addChild(this.arrow);
    }

    /** Its box in lazer units (origin bottom centre). */
    get box(): { x: number; y: number; w: number; h: number } {
        return { x: -this.halfWidth, y: -HEIGHT, w: this.halfWidth * 2, h: HEIGHT };
    }

    /** -0.5..0.5 across the meter (lazer's getRelativeJudgementPosition). */
    private relative(error: number): number {
        return Math.max(-0.5, Math.min(0.5, error / Math.max(1, this.w300, this.w100, this.w50) / 2));
    }

    add(error: number): void {
        const l = this.lines[this.next];
        this.next = (this.next + 1) % POOL;
        const abs = Math.abs(error);
        const rel = this.relative(error);
        l.sprite.tint = abs <= this.w300 ? Colors.great : abs <= this.w100 ? Colors.ok : Colors.meh;
        l.sprite.x = rel * this.halfWidth * 2;
        l.sprite.alpha = LINE_ALPHA;
        l.sprite.visible = true;
        l.at = this.clock;
        this.floatingError = this.floatingError * 0.8 + rel * 0.2;
        this.arrowFrom = this.arrow.x / (this.halfWidth * 2);
        this.arrowTo = this.floatingError;
        this.arrowAt = this.clock;
    }

    update(dt: number): void {
        this.clock += dt;
        for (const l of this.lines) {
            if (!l.sprite.visible) continue;
            const age = this.clock - l.at;
            if (age >= LINE_LIFE) l.sprite.visible = false;
            else l.sprite.alpha = LINE_ALPHA * (1 - age / LINE_LIFE);
        }
        const t = Math.min(1, (this.clock - this.arrowAt) / ARROW_DURATION);
        this.arrow.x = (this.arrowFrom + (this.arrowTo - this.arrowFrom) * Easing.Out(t)) * this.halfWidth * 2;
    }
}
