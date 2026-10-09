import { Container } from 'pixi.js';
import { damp } from '../../core/math';
import { Easing } from '../../core/easing';
import type { Skin } from '../../skin/Skin';
import { SpriteText } from './SpriteText';

/** A counter that rolls toward its target (stable's score roll-up). */
class Rolling {
    value = 0;
    target = 0;
    step(dt: number, halfLife: number): number {
        this.value = Math.abs(this.target - this.value) < 0.5 ? this.target : damp(this.value, this.target, halfLife, dt);
        return this.value;
    }
}

/** Score (8 digits) with accuracy below it, anchored top-right. */
export class ScoreCounter extends Container {
    private readonly score: SpriteText;
    private readonly accuracy: SpriteText;
    private readonly rollScore = new Rolling();
    private readonly rollAcc = new Rolling();

    constructor(skin: Skin) {
        super();
        this.score = new SpriteText(skin, 14, 1);
        this.accuracy = new SpriteText(skin, 14, 1);
        this.addChild(this.score, this.accuracy);
        this.rollAcc.value = this.rollAcc.target = 1;
        this.score.text = '00000000';
        this.accuracy.text = '100.00%';
    }

    /** Element toggles; accuracy moves up into the score's place when that is hidden. */
    setShown(score: boolean, accuracy: boolean): void {
        this.score.visible = score;
        this.accuracy.visible = accuracy;
    }

    set(score: number, accuracy: number): void {
        this.rollScore.target = score;
        this.rollAcc.target = accuracy;
    }

    /** `unit` is the HUD scale (1 at 720p). */
    update(dt: number, unit: number): void {
        const s = Math.round(this.rollScore.step(dt, 60));
        this.score.text = String(s).padStart(8, '0');
        this.accuracy.text = `${(this.rollAcc.step(dt, 60) * 100).toFixed(2)}%`;
        this.score.scale.set(0.5 * unit);
        this.accuracy.scale.set(0.3 * unit);
        this.score.y = (this.score.glyphHeight / 2) * 0.5 * unit;
        const below = this.score.visible ? this.score.y * 2 + 2 * unit : 0;
        this.accuracy.y = below + (this.accuracy.glyphHeight / 2) * 0.3 * unit;
    }
}

/**
 * Stable's combo counter (bottom-left): the number bumps when it rises,
 * with a larger additive "ghost" bursting out behind it.
 */
export class ComboCounter extends Container {
    private readonly main: SpriteText;
    private readonly ghost: SpriteText;
    private combo = 0;
    private popAt = -1e9;
    private clock = 0;

    constructor(skin: Skin) {
        super();
        this.main = new SpriteText(skin, 12, 0);
        this.ghost = new SpriteText(skin, 12, 0);
        this.ghost.blendMode = 'add';
        this.ghost.alpha = 0;
        this.addChild(this.ghost, this.main);
        this.main.text = '0x';
    }

    set(combo: number): void {
        if (combo === this.combo) return;
        if (combo > this.combo) this.popAt = this.clock;
        this.combo = combo;
        this.ghost.text = `${combo}x`;
        this.main.text = `${combo}x`;
    }

    update(dt: number, unit: number): void {
        this.clock += dt;
        const since = this.clock - this.popAt;
        const base = 0.55 * unit;
        const mainPop = 1 + 0.12 * (1 - Easing.OutQuad(Math.min(1, since / 150)));
        this.main.scale.set(base * mainPop);
        const g = Math.min(1, since / 300);
        this.ghost.scale.set(base * (1 + 0.5 * Easing.OutQuint(g)));
        this.ghost.alpha = 0.6 * (1 - g);
        const lift = (this.main.glyphHeight / 2) * base;
        this.main.y = -lift * mainPop;
        this.ghost.y = -lift * (1 + 0.5 * Easing.OutQuint(g));
    }
}
