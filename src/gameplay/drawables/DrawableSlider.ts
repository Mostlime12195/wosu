import { Container, Texture, type Sprite } from 'pixi.js';
import type { PlayableSlider, SliderEvent } from '../../beatmap/types';
import { SliderBody } from '../../graphics/slider/SliderRenderer';
import type { SkinTexture } from '../../skin/LegacySkin';
import { sliderBallPosition, sliderProgress, sliderSpan, type SliderState } from '../GameplayRules';
import {
    ApproachCircle, CirclePiece, OBJECT_SIZE, SIXTY_FRAME_TIME, approachAlpha, capped, cappedFrames, clamp01, comboColor, ease,
    frameAt, fromDefaultSkin, legacyScale, legacyVersion, resolveCircle, sprite, type DrawableContext,
} from './context';
import { shakeOffset, type Drawable } from './DrawableHitCircle';

/** Follow area while tracking, in circle radii (matches the rules). */
const FOLLOW_SCALE = 2.4;
const FOLLOW_ANIM = 300;
const BODY_FADE_OUT = 300;
/** lazer's DrawableSlider fade_out_time: everything the slider owns fades once it's judged. */
const SLIDER_FADE_OUT = 240;
/** lazer's OsuLegacySkinTransformer.MAX_FOLLOW_CIRCLE_AREA_SIZE (ball and follow circle images). */
const FOLLOW_AREA_MAX = OBJECT_SIZE * 3;
/** lazer's LegacyReverseArrow: a 300ms idle loop, with a ±5.625° wobble for Version 1 skins. */
const ARROW_LOOP = 300;
const ARROW_WOBBLE = (5.625 * Math.PI) / 180;

interface Tick {
    sprite: Sprite;
    event: SliderEvent;
    eventIndex: number;
    appear: number;
}

/**
 * A slider end (lazer's SliderEndCircle): a repeat, with its reverse
 * arrow, or the tail. Legacy skins draw a circle at each one
 * (sliderendcircle, else the hit circle).
 */
interface SliderEnd {
    event: SliderEvent;
    eventIndex: number;
    /** lazer's RepeatIndex: the span this end closes (the tail closes the last). */
    repeatIndex: number;
    /** Sits at the path's end (true) or its start (false). */
    atEnd: boolean;
    /** When it appears: with the slider for the first end, else two spans ahead. */
    appear: number;
    /** With snaking in, the first end waits for the body to reach it. */
    delay: number;
    piece: CirclePiece | null;
    arrow: Sprite | null;
    isTail: boolean;
}

/** One tweened value: from → to over [start, start + duration] (a lazer transform). */
interface Tween {
    from: number;
    to: number;
    start: number;
    duration: number;
    easing: (t: number) => number;
}

const tweenAt = (w: Tween, time: number): number =>
    time >= w.start + w.duration ? w.to : time <= w.start ? w.from : w.from + (w.to - w.from) * w.easing((time - w.start) / w.duration);

/**
 * One slider: GPU body (snaking in/out), end circles, ticks, repeat
 * arrows, head circle, ball and follow circle. Like every drawable it is
 * a pure function of song time and the rules' state for this object.
 *
 * Arrows, ball and follow circle from wosu!'s default skin keep wosu!'s
 * own animations; other skins get lazer's legacy pieces
 * (LegacyReverseArrow, LegacySliderBall, LegacyFollowCircle).
 */
export class DrawableSlider extends Container implements Drawable {
    readonly index: number;
    private readonly body: SliderBody;
    private readonly head: CirclePiece;
    private readonly approach: ApproachCircle;
    /** The ball: optional sliderb-nd underlay, the (animated) sliderb, optional additive sliderb-spec. */
    private readonly ball = new Container();
    private readonly ballSprite: Sprite;
    private readonly follow: Sprite;
    private readonly ticks: Tick[] = [];
    private readonly ends: SliderEnd[] = [];
    /** The tail circle sits under the ticks and repeats (lazer proxies it there for legacy skins). */
    private readonly tailLayer = new Container();
    private readonly overlays = new Container();
    private readonly repeatLayer = new Container();
    private readonly arrowLayer = new Container();
    private headAlpha = 1;
    private readonly tickScale: number;
    private readonly arrowScale: number;
    private readonly ballScale: number;
    private readonly followBase: number;
    private readonly ballFrames: SkinTexture[];
    private readonly ballFrameLength: number;
    private readonly followFrames: SkinTexture[];
    private readonly ballFlip: boolean;
    private readonly hiddenOn: boolean;
    private readonly snakeDuration: number;
    /** lazer's legacy pieces (true) or wosu!'s default-skin animations (false). */
    private readonly legacyArrow: boolean;
    private readonly legacyBall: boolean;
    private readonly legacyFollow: boolean;
    /** Version 1 skins wobble the reverse arrow (LegacyReverseArrow.shouldRotate). */
    private readonly arrowWobble: boolean;
    /** Times tracking began (lazer's FollowCircle.OnSliderPress), as the rules reported them. */
    private readonly presses: number[] = [];

    constructor(private readonly ctx: DrawableContext, private readonly h: PlayableSlider, hiddenApplies: boolean) {
        super();
        this.index = h.index;
        this.hiddenOn = ctx.hidden && hiddenApplies;
        this.snakeDuration = ctx.preempt / 3;
        const color = comboColor(ctx, h);
        const rows = Math.max(1, ctx.beatmap.comboColors.length);
        this.body = new SliderBody(ctx.sliders, h.path.points, ctx.radius, h.comboColorIndex % rows);
        this.addChild(this.body);

        const chain = ctx.skin;
        const tick = capped(chain.texture('sliderscorepoint'), OBJECT_SIZE);
        const arrow = capped(chain.texture('reversearrow'), OBJECT_SIZE * 2);
        this.tickScale = legacyScale(ctx.radius, tick);
        this.arrowScale = legacyScale(ctx.radius, arrow);
        this.legacyArrow = !fromDefaultSkin(chain, 'reversearrow');
        this.arrowWobble = legacyVersion(chain) <= 1;
        // Slider end circles; none when the skin's sliderendcircle is a blank placeholder.
        const drawEnds = !resolveCircle(chain, 'sliderendcircle').blank;
        h.events.forEach((ev, i) => {
            if (ev.kind === 'tick') {
                const t = sprite(tick?.texture ?? Texture.EMPTY, this.tickScale);
                t.position.set(ev.x, ev.y);
                const spanStart = h.time + ev.spanIndex * h.spanDuration;
                const offset = ev.spanIndex > 0 ? 200 : ctx.preempt * 0.66;
                this.ticks.push({ sprite: t, event: ev, eventIndex: i, appear: ev.time - ((ev.time - spanStart) / 2 + offset) });
                this.overlays.addChild(t);
            } else if (ev.kind === 'repeat' || ev.kind === 'tail') {
                const isTail = ev.kind === 'tail';
                if (isTail && !drawEnds) return;
                const repeatIndex = isTail ? h.slides - 1 : ev.spanIndex;
                // The tail's own time is the slider's end (only its judgement uses the legacy offset).
                const at = isTail ? h.endTime : ev.time;
                const end: SliderEnd = {
                    event: ev, eventIndex: i, repeatIndex, isTail,
                    atEnd: repeatIndex % 2 === 0,
                    appear: repeatIndex === 0 ? h.time - ctx.preempt : at - h.spanDuration * 2,
                    delay: ctx.snakingIn && repeatIndex === 0 ? this.snakeDuration : 0,
                    piece: drawEnds ? new CirclePiece(ctx, h, false, 'sliderendcircle') : null,
                    arrow: isTail ? null : sprite(arrow?.texture ?? Texture.EMPTY, this.arrowScale),
                };
                if (end.piece) {
                    end.piece.visible = false;
                    (isTail ? this.tailLayer : this.repeatLayer).addChild(end.piece);
                }
                if (end.arrow) {
                    end.arrow.visible = false;
                    this.arrowLayer.addChild(end.arrow);
                }
                this.ends.push(end);
            }
        });
        this.addChild(this.tailLayer, this.overlays, this.repeatLayer, this.arrowLayer);

        this.followFrames = cappedFrames(chain.frames('sliderfollowcircle'), FOLLOW_AREA_MAX);
        const follow = this.followFrames[0] ?? null;
        this.follow = sprite(follow?.texture ?? Texture.EMPTY, 0);
        this.legacyFollow = !fromDefaultSkin(chain, 'sliderfollowcircle', true);
        // Fully tracking, the follow circle shows the image at circle scale. lazer's
        // LegacyFollowCircle gets there from half size (1× → 2× of a 0.5× image).
        this.followBase = legacyScale(ctx.radius, follow) / (this.legacyFollow ? 2 : FOLLOW_SCALE);
        this.follow.visible = false;
        // lazer's LegacySliderBall: an underlay, the ball (tinted only if the skin allows it) and a
        // specular layer.
        this.ballFrames = cappedFrames(chain.frames('sliderb'), FOLLOW_AREA_MAX);
        this.ballFrameLength = Math.max((0.15 / h.velocity) * SIXTY_FRAME_TIME, SIXTY_FRAME_TIME);
        this.legacyBall = !fromDefaultSkin(chain, 'sliderb', true);
        const first = this.ballFrames[0] ?? null;
        const nd = capped(chain.texture('sliderb-nd'), FOLLOW_AREA_MAX);
        const spec = capped(chain.texture('sliderb-spec'), FOLLOW_AREA_MAX);
        if (nd) {
            const under = sprite(nd.texture, legacyScale(ctx.radius, nd));
            under.tint = 0x050505;
            this.ball.addChild(under);
        }
        this.ballScale = legacyScale(ctx.radius, first);
        this.ballSprite = sprite(first?.texture ?? Texture.EMPTY, this.ballScale);
        this.ballSprite.tint = chain.config('allowSliderBallTint') ? color : chain.config('sliderBall') ?? 0xffffff;
        this.ball.addChild(this.ballSprite);
        if (spec) {
            const shine = sprite(spec.texture, legacyScale(ctx.radius, spec));
            shine.blendMode = 'add';
            this.ball.addChild(shine);
        }
        this.ballFlip = chain.config('sliderBallFlip');
        this.ball.visible = false;
        this.head = new CirclePiece(ctx, h, true, 'sliderstartcircle');
        this.head.position.set(h.x, h.y);
        this.addChild(this.follow, this.ball, this.head);

        this.approach = new ApproachCircle(ctx, color);
        if (!(ctx.hideApproachCircles && hiddenApplies)) ctx.approachLayer.addChild(this.approach);
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
        this.updateEnds(time, s, toT);
        if (!this.legacyArrow) this.updateDefaultArrows(time, s, toT, bodyAlpha);
        this.updateHead(time, s);
        this.updateBall(time, s);
        return true;
    }

    private headDone(time: number, s: SliderState): boolean {
        if (s.headHit === true) return time - s.headAt >= 800;
        return true;
    }

    /** Opacity of everything the slider owns once it has been judged (at its end). */
    private sliderFade(time: number): number {
        return 1 - clamp01((time - this.h.endTime) / SLIDER_FADE_OUT);
    }

    private updateTicks(time: number, s: SliderState): void {
        for (const t of this.ticks) {
            const sp = t.sprite;
            const hit = s.eventHit[t.eventIndex];
            const base = this.tickScale;
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

    /**
     * Slider ends (lazer's DrawableSliderRepeat / DrawableSliderTail with a
     * legacy skin). Each end's circle fades in when it appears (once the
     * snake reaches it, for the first) and bursts like a hit circle when
     * hit; a hit repeat also fades out over min(300ms, a span) while its
     * arrow swells to 1.4×, a missed one just fades; a missed tail fades in
     * 100ms. Hidden fades the circles like the head (arrows stay until
     * hit). Legacy arrows (LegacyReverseArrow) fade in over 150ms and loop
     * every 300ms from when they appear: 1.3× → 1× easing out, or linearly
     * with a ±5.625° wobble for Version 1 skins.
     */
    private updateEnds(time: number, s: SliderState, snakeT: number): void {
        const ctx = this.ctx, h = this.h;
        const fade = this.sliderFade(time);
        const tail = h.path.pointAt(snakeT);
        const pathEnd = h.path.pointAt(1);
        const tailDir = h.path.directionAt(snakeT);
        const headDir = h.path.directionAt(0);
        const hiddenFade = this.hiddenOn
            ? 1 - clamp01((time - (h.time - ctx.preempt + ctx.fadeIn)) / (ctx.preempt * 0.3))
            : 1;
        const anim = Math.min(300, h.spanDuration);
        for (const e of this.ends) {
            const result = s.eventHit[e.eventIndex];
            const judged = result !== null && time >= e.event.time;
            const hit = judged && result === true;
            const dt = time - e.event.time;
            const shown = time >= e.appear;
            const start = e.appear + e.delay;
            // Repeats follow the snaking end until hit; the tail stays at the path's end.
            const at = !e.atEnd ? h : hit || e.isTail ? pathEnd : tail;
            let whole: number;
            if (e.isTail) whole = !judged || hit ? 1 : 1 - clamp01(dt / 100);
            else if (!judged) whole = 1;
            else if (hit) whole = this.hiddenOn ? 0 : 1 - ease.OutQuad(clamp01(dt / anim));
            else whole = 1 - clamp01(dt / anim);
            whole *= fade;

            const p = e.piece;
            if (p) {
                p.position.set(at.x, at.y);
                if (hit) {
                    p.showHit(dt);
                    p.alpha = whole * hiddenFade;
                } else {
                    const fadeIn = e.repeatIndex === 0 ? ctx.fadeIn : 0;
                    const a = !shown ? 0 : fadeIn > 0 ? clamp01((time - start) / fadeIn) : time >= start ? 1 : 0;
                    p.showIdle(a * hiddenFade);
                    p.alpha *= whole;
                }
                p.visible = p.visible && p.alpha > 0.001;
            }
            const r = e.arrow;
            if (!r || !this.legacyArrow) continue;
            const arrowFade = e.repeatIndex === 0 ? 150 : Math.min(h.spanDuration, 150);
            const a = shown ? clamp01((time - start) / arrowFade) * whole : 0;
            r.visible = a > 0.001;
            if (!r.visible) continue;
            r.alpha = a;
            r.position.set(at.x, at.y);
            let rotation = e.atEnd ? Math.atan2(-tailDir.y, -tailDir.x) : Math.atan2(headDir.y, headDir.x);
            if (hit) {
                r.scale.set(this.arrowScale * (1 + 0.4 * ease.OutQuad(clamp01(dt / anim))));
            } else {
                const loop = ((((time - e.appear) % ARROW_LOOP) + ARROW_LOOP) % ARROW_LOOP) / ARROW_LOOP;
                if (this.arrowWobble) {
                    rotation += ARROW_WOBBLE * (1 - 2 * loop);
                    r.scale.set(this.arrowScale * (1.3 - 0.3 * loop));
                } else {
                    r.scale.set(this.arrowScale * (1.3 - 0.3 * ease.OutQuad(loop)));
                }
            }
            r.rotation = rotation;
        }
    }

    /** wosu!'s default-skin arrows: the next pending repeat at each end, pulsing on the beat. */
    private updateDefaultArrows(time: number, s: SliderState, snakeT: number, bodyAlpha: number): void {
        const h = this.h;
        const tail = h.path.pointAt(snakeT);
        const tailDir = h.path.directionAt(snakeT);
        const headDir = h.path.directionAt(0);
        let tailShown = false, headShown = false;
        const cp = this.ctx.beatmap.controlPoints.at(time);
        const beat = cp.beatLength > 0 ? ((time - h.time) % cp.beatLength + cp.beatLength) % cp.beatLength / cp.beatLength : 0;
        const pulse = 1 + 0.3 * (1 - ease.OutQuad(beat));
        const base = this.arrowScale;
        for (const e of this.ends) {
            const r = e.arrow;
            if (!r) continue;
            const done = s.eventHit[e.eventIndex] !== null && time >= e.event.time;
            const appear = e.repeatIndex === 0 ? -Infinity : e.event.time - h.spanDuration * 2;
            const already = e.atEnd ? tailShown : headShown;
            if (done || already || time < appear) {
                r.visible = false;
                continue;
            }
            if (e.atEnd) tailShown = true;
            else headShown = true;
            r.visible = true;
            if (e.atEnd) {
                r.position.set(tail.x, tail.y);
                r.rotation = Math.atan2(-tailDir.y, -tailDir.x);
            } else {
                r.position.set(h.x, h.y);
                r.rotation = Math.atan2(headDir.y, headDir.x);
            }
            r.alpha = (e.repeatIndex === 0 ? 1 : clamp01((time - appear) / 150)) * bodyAlpha;
            r.scale.set(base * (time >= h.time ? pulse : 1));
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
        if (s.tracking) {
            const at = Math.max(s.trackingChangedAt, h.time);
            if (!this.presses.length || this.presses[this.presses.length - 1] < at) this.presses.push(at);
        }
        if (time < h.time) {
            this.ball.visible = false;
            this.follow.visible = false;
            return;
        }
        const t = Math.min(time, h.endTime);
        const p = sliderBallPosition(h, t);
        this.ball.position.set(p.x, p.y);
        this.follow.position.set(p.x, p.y);
        // The ball faces its direction of travel (lazer's DrawableSliderBall); reversed spans
        // mirror it when the skin asks (stable's SliderBallFlip) instead of turning it upside
        // down. The underlay and specular layers don't turn (LegacySliderBall).
        const reversed = sliderSpan(h, t) % 2 === 1;
        const dir = h.path.directionAt(sliderProgress(h, t));
        this.ballSprite.rotation = Math.atan2(reversed ? -dir.y : dir.y, reversed ? -dir.x : dir.x);
        this.ballSprite.scale.set(this.ballScale, reversed && this.ballFlip ? -this.ballScale : this.ballScale);
        // Animations count from when the slider appears (lazer's AnimationStartTime).
        const animTime = time - (h.time - this.ctx.preempt);
        if (this.ballFrames.length > 1) {
            // LegacySliderBall: frames advance with the slider's speed, at most 60 a second.
            const f = frameAt(this.ballFrames, animTime, this.ballFrameLength, true);
            if (this.ballSprite.texture !== f.texture) this.ballSprite.texture = f.texture;
        }
        const fn = this.followFrames.length;
        if (fn > 1) {
            const f = frameAt(this.followFrames, animTime, this.ctx.skin.frameDuration(fn), true);
            if (this.follow.texture !== f.texture) this.follow.texture = f.texture;
        }
        if (this.legacyFollow) this.updateLegacyFollow(time, s);
        const after = time - h.endTime;
        if (after > 0) {
            // LegacySliderBall disappears the moment the slider is judged.
            this.ball.visible = !this.legacyBall && after < 100;
            this.ball.alpha = 1 - clamp01(after / 100);
            if (this.legacyFollow) return;
            // The follow circle lingers briefly after a tracked finish.
            const fa = s.tracking || s.trackingChangedAt >= h.endTime - 1 ? 1 - clamp01(after / 200) : 0;
            this.follow.visible = fa > 0;
            this.follow.alpha = fa;
            return;
        }
        this.ball.visible = true;
        this.ball.alpha = 1;
        if (this.legacyFollow) return;
        const since = clamp01((time - Math.max(h.time, s.trackingChangedAt)) / FOLLOW_ANIM);
        const k = ease.OutQuint(since);
        const scale = s.tracking ? 1 + (FOLLOW_SCALE - 1) * k : FOLLOW_SCALE - (FOLLOW_SCALE - 1) * k;
        // Never tracked yet: nothing to shrink away from.
        const alpha = s.tracking ? k : s.trackingChangedAt < h.time ? 0 : 1 - ease.OutQuint(clamp01(since * 2));
        this.follow.visible = alpha > 0.001;
        this.follow.alpha = alpha;
        this.follow.scale.set(this.followBase * scale);
    }

    /**
     * lazer's LegacyFollowCircle, replayed from the slider's history up to
     * `time`: tracking starts it at 1×, transparent, growing to 2× over
     * 180ms (ease out) while it fades in over 60ms; letting go does nothing
     * by itself. A hit tick or repeat at full size pops it to 2.2× and back
     * over 200ms; a missed tick, repeat or tail blows it up to 4× and out
     * in 100ms; a hit tail shrinks it to 1.6× (ease out) and fades it out
     * (ease in) over 200ms at the slider's end.
     */
    private updateLegacyFollow(time: number, s: SliderState): void {
        const h = this.h;
        const evs: { at: number; kind: 'press' | 'tick' | 'break' | 'end' }[] = [];
        for (const at of this.presses) if (at <= time) evs.push({ at, kind: 'press' });
        h.events.forEach((ev, i) => {
            const r = s.eventHit[i];
            if (ev.kind === 'head' || r === null || ev.time > time) return;
            if (!r) evs.push({ at: ev.time, kind: 'break' });
            else if (ev.kind !== 'tail') evs.push({ at: ev.time, kind: 'tick' });
            else if (time >= h.endTime) evs.push({ at: h.endTime, kind: 'end' });
        });
        evs.sort((a, b) => a.at - b.at);
        const linear = ease.None;
        let scale: Tween = { from: 1, to: 1, start: -Infinity, duration: 0, easing: linear };
        let alpha: Tween = { from: 0, to: 0, start: -Infinity, duration: 0, easing: linear };
        for (const e of evs) {
            const sc = tweenAt(scale, e.at), al = tweenAt(alpha, e.at);
            switch (e.kind) {
                case 'press': {
                    const remaining = Math.max(0, h.endTime - e.at);
                    scale = { from: 1, to: 2, start: e.at, duration: Math.min(180, remaining), easing: ease.OutQuad };
                    alpha = { from: 0, to: 1, start: e.at, duration: Math.min(60, remaining), easing: linear };
                    break;
                }
                case 'tick':
                    if (sc >= 2) scale = { from: 2.2, to: 2, start: e.at, duration: 200, easing: linear };
                    break;
                case 'break':
                    scale = { from: sc, to: 4, start: e.at, duration: 100, easing: linear };
                    alpha = { from: al, to: 0, start: e.at, duration: 100, easing: linear };
                    break;
                case 'end':
                    scale = { from: sc, to: 1.6, start: e.at, duration: 200, easing: ease.OutQuad };
                    alpha = { from: al, to: 0, start: e.at, duration: 200, easing: ease.InQuad };
                    break;
            }
        }
        const a = tweenAt(alpha, time) * this.sliderFade(time);
        this.follow.visible = a > 0.001;
        this.follow.alpha = a;
        this.follow.scale.set(this.followBase * tweenAt(scale, time));
    }

    override destroy(): void {
        this.approach.destroy();
        super.destroy({ children: true });
    }
}
