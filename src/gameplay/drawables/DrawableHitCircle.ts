import { Container } from 'pixi.js';
import type { PlayableCircle } from '../../beatmap/types';
import type { CircleState } from '../GameplayRules';
import { ApproachCircle, CirclePiece, approachAlpha, comboColor, type DrawableContext } from './context';

/** Shake on note lock / early clicks (lazer: 8 px, 3 swings over 80 ms). */
export function shakeOffset(time: number, shakeAt: number): number {
    const dt = time - shakeAt;
    if (dt < 0 || dt > 120) return 0;
    return Math.sin((dt / 120) * Math.PI * 6) * 8 * (1 - dt / 120);
}

export interface Drawable extends Container {
    readonly index: number;
    /** Update for song time; returns false once it can be removed. */
    updateAt(time: number): boolean;
}

export class DrawableHitCircle extends Container implements Drawable {
    readonly index: number;
    private readonly piece: CirclePiece;
    private readonly approach: ApproachCircle;
    private lastAlpha = 1;

    constructor(private readonly ctx: DrawableContext, private readonly h: PlayableCircle, private readonly hiddenApplies: boolean) {
        super();
        this.index = h.index;
        this.position.set(h.x, h.y);
        this.piece = new CirclePiece(ctx, h, true);
        this.addChild(this.piece);
        this.approach = new ApproachCircle(ctx, comboColor(ctx, h));
        if (!(ctx.hidden && hiddenApplies)) ctx.approachLayer.addChild(this.approach);
        this.eventMode = 'none';
    }

    updateAt(time: number): boolean {
        const ctx = this.ctx, h = this.h;
        const s = ctx.rules.states[h.index] as CircleState;
        this.x = h.x + shakeOffset(time, s.shakeAt);
        if (s.result === null || time < s.judgedAt) {
            const a = approachAlpha(ctx, time, h.time, ctx.hidden && this.hiddenApplies);
            this.lastAlpha = a;
            this.piece.showIdle(a, ctx.kiaiFlash(time));
            this.approach.showAt(ctx, time, h.time, this.x, h.y);
            return true;
        }
        const dt = time - s.judgedAt;
        this.approach.visible = false;
        if (s.result === 'miss') return this.piece.showMiss(dt, this.lastAlpha) || dt < 100;
        return this.piece.showHit(dt);
    }

    override destroy(): void {
        this.approach.destroy();
        super.destroy({ children: true });
    }
}
