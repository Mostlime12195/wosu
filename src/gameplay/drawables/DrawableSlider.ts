import { Container, type Sprite } from 'pixi.js';
import type { PlayableSlider, SliderEvent } from '../../beatmap/types';
import { SliderBody } from '../../graphics/slider/SliderRenderer';
import { sliderBallPosition, sliderProgress, sliderSpan, type SliderState } from '../GameplayRules';
import {
    ApproachCircle, CirclePiece, approachAlpha, circleScale, clamp01, comboColor, ease, sprite, type DrawableContext,
} from './context';
import { shakeOffset, type Drawable } from './DrawableHitCircle';

/** Follow area while tracking, in circle radii (matches the rules). */
const FOLLOW_SCALE = 2.4;
const FOLLOW_ANIM = 300;
const BODY_FADE_OUT = 300;

interface Tick {
    sprite: Sprite;
    event: SliderEvent;
    eventIndex: number;
    appear: number;
}

interface Repeat {
    sprite: Sprite;
    event: SliderEvent;
    eventIndex: number;
    /** Arrow sits at the tail (true) or head (false). */
    atTail: boolean;
    order: number;
}

/**
 * One slider: GPU body (snaking in/out), ticks, repeat arrows, head
 * circle, ball and follow circle. Like every drawable it is a pure
 * function of song time and the rules' state for this object.
 */
export class DrawableSlider extends Container implements Drawable {
    readonly index: number;
    private readonly body: SliderBody;
    private readonly head: CirclePiece;
    private readonly approach: ApproachCircle;
    private readonly ball: Sprite;
    private readonly follow: Sprite;
    private readonly ticks: Tick[] = [];
    private readonly repeats: Repeat[] = [];
    private readonly overlays = new Container();
    private headAlpha = 1;
    private readonly hiddenOn: boolean;
    private readonly snakeDuration: number;

    constructor(private readonly ctx: DrawableContext, private readonly h: PlayableSlider, hiddenApplies: boolean) {
        super();
        this.index = h.index;
        this.hiddenOn = ctx.hidden && hiddenApplies;
        this.snakeDuration = ctx.preempt / 3;
        const color = comboColor(ctx, h);
        const rows = Math.max(1, ctx.beatmap.comboColors.length);
        this.body = new SliderBody(ctx.sliders, h.path.points, ctx.radius, h.comboColorIndex % rows);
        this.addChild(this.body);

        const s = circleScale(ctx.radius);
        h.events.forEach((ev, i) => {
            if (ev.kind === 'tick') {
                const t = sprite(ctx.skin.get('sliderscorepoint.png'), s);
                t.position.set(ev.x, ev.y);
                const spanStart = h.time + ev.spanIndex * h.spanDuration;
                const offset = ev.spanIndex > 0 ? 200 : ctx.preempt * 0.66;
                this.ticks.push({ sprite: t, event: ev, eventIndex: i, appear: ev.time - ((ev.time - spanStart) / 2 + offset) });
                this.overlays.addChild(t);
            } else if (ev.kind === 'repeat') {
                const r = sprite(ctx.skin.get('reversearrow.png'), s * 0.75);
                const atTail = ev.spanIndex % 2 === 0;
                this.repeats.push({ sprite: r, event: ev, eventIndex: i, atTail, order: ev.spanIndex });
                this.overlays.addChild(r);
            }
        });
        this.addChild(this.overlays);

        this.follow = sprite(ctx.skin.get('sliderfollowcircle.png'), 0);
        this.follow.visible = false;
        this.ball = sprite(ctx.skin.get('sliderb.png'), s * 0.98);
        this.ball.visible = false;
        this.head = new CirclePiece(ctx, h, true);
        this.head.position.set(h.x, h.y);
        this.addChild(this.follow, this.ball, this.head);

        this.approach = new ApproachCircle(ctx, color);
        if (!this.hiddenOn) ctx.approachLayer.addChild(this.approach);
        this.eventMode = 'none';
    }

    private get state(): SliderState {
        return this.ctx.rules.states[this.h.index] as SliderState;
    }

    updateAt(time: number): boolean {
        const ctx = this.ctx, h = this.h, s = this.state;
        const ended = time > h.endTime;
        if (ended && time > h.endTime + BODY_FADE_OUT + 50 && s.headHit !== null && this.headDone(time, s)) return false;

        // Body opacity: fade in with the approach, hidden mode fades it over the whole slider.
        let bodyAlpha = approachAlpha(ctx, time, h.time, false);
        if (this.hiddenOn) {
            const start = h.time - ctx.preempt + ctx.fadeIn;
            bodyAlpha = Math.min(bodyAlpha, 1 - clamp01((time - start) / Math.max(1, h.endTime - start)));
        }
        if (ended) bodyAlpha *= 1 - clamp01((time - h.endTime) / BODY_FADE_OUT);

        // Snaking.
        let fromT = 0, toT = 1;
        if (ctx.snakingIn && time < h.time) toT = clamp01((time - (h.time - ctx.preempt)) / this.snakeDuration);
        const progress = sliderProgress(h, time);
        if (ctx.snakingOut && time >= h.time && sliderSpan(h, time) === h.slides - 1) {
            if (h.slides % 2 === 1) fromT = progress;
            else toT = progress;
        }
        this.body.alpha = bodyAlpha;
        this.body.setRange(fromT, toT);
        this.body.sync(ctx.pixelsPerUnit);
        this.overlays.alpha = bodyAlpha;

        this.updateTicks(time, s);
        this.updateRepeats(time, s, toT);
        this.updateHead(time, s);
        this.updateBall(time, s);
        return true;
    }

    private headDone(time: number, s: SliderState): boolean {
        if (s.headHit === true) return time - s.headAt >= 800;
        return true;
    }

    private updateTicks(time: number, s: SliderState): void {
        for (const t of this.ticks) {
            const sp = t.sprite;
            const hit = s.eventHit[t.eventIndex];
            const base = circleScale(this.ctx.radius);
            if (time < t.appear) {
                sp.visible = false;
                continue;
            }
            sp.visible = true;
            const since = time - t.appear;
            if (hit === null || time < t.event.time) {
                sp.alpha = clamp01(since / 150);
                sp.scale.set(base * (0.5 + 0.5 * ease.OutElasticHalf(clamp01(since / 600))));
                sp.tint = 0xffffff;
                continue;
            }
            const dt = time - t.event.time;
            if (hit) {
                sp.alpha = 1 - clamp01(dt / 150);
                sp.scale.set(base * (1 + 0.5 * ease.OutQuad(clamp01(dt / 150))));
            } else {
                sp.alpha = 1 - clamp01(dt / 150);
                sp.tint = 0xff3333;
            }
            if (sp.alpha <= 0) sp.visible = false;
        }
    }

    private updateRepeats(time: number, s: SliderState, snakeT: number): void {
        const h = this.h;
        const tail = h.path.pointAt(snakeT);
        const tailDir = h.path.directionAt(snakeT);
        const headDir = h.path.directionAt(0);
        // Only the next pending repeat at each end is shown, pulsing on the beat.
        let tailShown = false, headShown = false;
        const cp = this.ctx.beatmap.controlPoints.at(time);
        const beat = cp.beatLength > 0 ? ((time - h.time) % cp.beatLength + cp.beatLength) % cp.beatLength / cp.beatLength : 0;
        const pulse = 1 + 0.3 * (1 - ease.OutQuad(beat));
        const base = circleScale(this.ctx.radius) * 0.75;
        for (const r of this.repeats) {
            const done = s.eventHit[r.eventIndex] !== null && time >= r.event.time;
            const appear = r.order === 0 ? -Infinity : r.event.time - h.spanDuration * 2;
            const already = r.atTail ? tailShown : headShown;
            if (done || already || time < appear) {
                r.sprite.visible = false;
                continue;
            }
            if (r.atTail) tailShown = true;
            else headShown = true;
            r.sprite.visible = true;
            if (r.atTail) {
                r.sprite.position.set(tail.x, tail.y);
                r.sprite.rotation = Math.atan2(-tailDir.y, -tailDir.x);
            } else {
                r.sprite.position.set(h.x, h.y);
                r.sprite.rotation = Math.atan2(headDir.y, headDir.x);
            }
            r.sprite.alpha = r.order === 0 ? 1 : clamp01((time - appear) / 150);
            r.sprite.scale.set(base * (time >= h.time ? pulse : 1));
        }
    }

    private updateHead(time: number, s: SliderState): void {
        const ctx = this.ctx, h = this.h;
        const w50 = ctx.rules.windows.w50;
        if (s.headHit === null) {
            // Unhit heads ride along with the ball, like stable.
            const p = time > h.time ? sliderBallPosition(h, time) : { x: h.x, y: h.y };
            const x = p.x + shakeOffset(time, s.shakeAt);
            this.head.position.set(x, p.y);
            const a = approachAlpha(ctx, time, h.time, this.hiddenOn);
            this.headAlpha = a;
            this.head.showIdle(a, ctx.kiaiFlash(time));
            this.approach.showAt(ctx, time, h.time, x, p.y);
            return;
        }
        this.approach.visible = false;
        if (s.headHit) {
            if (time < s.headAt) this.head.showIdle(this.headAlpha);
            else this.head.showHit(time - s.headAt);
        } else {
            this.head.showMiss(time - (h.time + w50), this.headAlpha);
        }
    }

    private updateBall(time: number, s: SliderState): void {
        const h = this.h;
        const r = this.ctx.radius;
        const followBase = (2 * r) / this.follow.texture.width;
        if (time < h.time) {
            this.ball.visible = false;
            this.follow.visible = false;
            return;
        }
        const p = sliderBallPosition(h, Math.min(time, h.endTime));
        this.ball.position.set(p.x, p.y);
        this.follow.position.set(p.x, p.y);
        const after = time - h.endTime;
        if (after > 0) {
            this.ball.visible = after < 100;
            this.ball.alpha = 1 - clamp01(after / 100);
            // The follow circle lingers briefly after a tracked finish.
            const fa = s.tracking || s.trackingChangedAt >= h.endTime - 1 ? 1 - clamp01(after / 200) : 0;
            this.follow.visible = fa > 0;
            this.follow.alpha = fa;
            return;
        }
        this.ball.visible = true;
        this.ball.alpha = 1;
        const since = clamp01((time - Math.max(h.time, s.trackingChangedAt)) / FOLLOW_ANIM);
        const k = ease.OutQuint(since);
        const scale = s.tracking ? 1 + (FOLLOW_SCALE - 1) * k : FOLLOW_SCALE - (FOLLOW_SCALE - 1) * k;
        // Never tracked yet: nothing to shrink away from.
        const alpha = s.tracking ? k : s.trackingChangedAt < h.time ? 0 : 1 - ease.OutQuint(clamp01(since * 2));
        this.follow.visible = alpha > 0.001;
        this.follow.alpha = alpha;
        this.follow.scale.set(followBase * scale);
    }

    override destroy(): void {
        this.approach.destroy();
        super.destroy({ children: true });
    }
}
