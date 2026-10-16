import { Container, Graphics, type Renderer } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { SliderResources } from '../../graphics/slider/SliderRenderer';
import type { SkinChain } from '../../skin/SkinChain';
import type { GameplayRules } from '../GameplayRules';
import { OBJECT_SIZE, cappedFrames, fromDefaultSkin, legacyScale, makeKiaiFlash, makeLegacyKiaiFlash, type DrawableContext } from './context';
import { DrawableHitCircle, type Drawable } from './DrawableHitCircle';
import { DrawableSlider } from './DrawableSlider';
import { DrawableSpinner } from './DrawableSpinner';
import { FollowPoints } from './FollowPoints';
import { Judgements } from './Judgements';

export interface PlayfieldOptions {
    renderer: Renderer;
    /** The skins in effect (beatmap → selected → default). */
    skin: SkinChain;
    beatmap: PlayableBeatmap;
    rules: GameplayRules;
    /** Hidden's object fading (off with HD's "Only fade approach circles"). */
    hidden: boolean;
    /** lazer's IHidesApproachCircles (Hidden); defaults to `hidden`. */
    hideApproachCircles?: boolean;
    hideNumbers: boolean;
    hideFollowPoints: boolean;
    snakingIn: boolean;
    snakingOut: boolean;
    /** Initial "Kiai flashes on hit objects" value (live via `kiaiFlashes`). */
    kiaiFlashes?: boolean;
}

/** osu!'s playfield size in osu! pixels. */
export const PLAYFIELD_W = 512;
export const PLAYFIELD_H = 384;

/**
 * The 512×384 osu! playfield. Objects are created shortly before they
 * appear and destroyed once their last animation ends, so a long map only
 * ever holds the handful of objects on screen. Earlier objects draw above
 * later ones; approach circles, lighting and judgements draw above all.
 */
export class Playfield extends Container {
    readonly ctx: DrawableContext;
    readonly judgements: Judgements;
    private readonly followPoints: FollowPoints | null;
    private readonly objectLayer = new Container();
    private readonly approachLayer = new Container();
    private readonly sliderResources: SliderResources;
    private readonly active: Drawable[] = [];
    /** Per-object fail state: random spin and the transform it started from. */
    private readonly failState = new Map<Drawable, { spin: number; x: number; y: number }>();
    private next = 0;
    private readonly offNested: () => void;
    /**
     * osu!stable's SpinnerFadePlayfield (skin.ini): the screen behind the
     * playfield goes black while a spinner shows, fading with the spinner.
     * The player puts it under everything else on the playfield's layer.
     */
    readonly spinnerFade = new Graphics();
    private readonly fadeForSpinners: boolean;

    constructor(private readonly o: PlayfieldOptions) {
        super();
        this.eventMode = 'none';
        const b = o.beatmap;
        const d = b.difficulty;
        this.sliderResources = new SliderResources(o.renderer, b.comboColors, b.data.sliderTrackOverride, b.data.sliderBorder);
        this.ctx = {
            skin: o.skin,
            beatmap: b,
            rules: o.rules,
            sliders: this.sliderResources,
            approachLayer: this.approachLayer,
            radius: d.circleRadius,
            preempt: d.preempt,
            fadeIn: d.fadeIn,
            hidden: o.hidden,
            hideApproachCircles: o.hideApproachCircles ?? o.hidden,
            hideNumbers: o.hideNumbers,
            snakingIn: o.snakingIn,
            snakingOut: o.snakingOut,
            pixelsPerUnit: 1,
            kiaiFlashes: o.kiaiFlashes ?? false,
            kiaiFlash: () => 0,
            legacyKiaiFlash: makeLegacyKiaiFlash(b),
        };
        const ctx = this.ctx;
        ctx.kiaiFlash = makeKiaiFlash(b, () => ctx.kiaiFlashes);
        // lazer's legacy follow point: an animation (followpoint-0…) at the skin's frame rate,
        // cropped to a circle diameter by a radius.
        const fpFrames = cappedFrames(o.skin.frames('followpoint'), OBJECT_SIZE, OBJECT_SIZE / 2);
        const fp = fpFrames[0] ?? null;
        this.followPoints = o.hideFollowPoints || !fp ? null
            : new FollowPoints(b, fpFrames, o.skin.frameDuration(fpFrames.length), d.preempt, d.fadeIn, d.circleRadius,
                legacyScale(d.circleRadius, fp), fromDefaultSkin(o.skin, 'followpoint', true));
        this.judgements = new Judgements(o.skin, d.circleRadius);
        this.fadeForSpinners = o.skin.config('spinnerFadePlayfield');
        // Far past any screen edge in playfield units.
        this.spinnerFade.rect(-PLAYFIELD_W * 8, -PLAYFIELD_H * 8, PLAYFIELD_W * 17, PLAYFIELD_H * 17).fill(0x000000);
        this.spinnerFade.eventMode = 'none';
        this.spinnerFade.visible = false;
        if (this.followPoints) this.addChild(this.followPoints);
        // New-style skin judgements (and their particles) sit under the objects, like lazer's.
        this.addChild(this.judgements.below, this.objectLayer, this.approachLayer, this.judgements);
        // Slider heads, ticks and repeats show slider point judgements when the skin has them.
        this.offNested = o.rules.nestedJudged.add((index, ev, hit) => {
            if (ev.kind === 'tail') return;
            // lazer judges the head like a hit circle (shown as the slider's judgement).
            if (ev.kind === 'head' && o.rules.mechanics === 'lazer') return;
            const s = o.rules.states[index];
            const time = ev.kind !== 'head' ? ev.time
                : hit && s.kind === 'slider' ? s.headAt : ev.time + o.rules.windows.w50;
            this.judgements.addNested(hit, ev.x, ev.y, time, ev.kind === 'tick');
        });
    }

    /** Device pixels per osu! pixel, for slider body texture resolution. */
    setPixelsPerUnit(v: number): void {
        this.ctx.pixelsPerUnit = v;
    }

    /** "Kiai flashes on hit objects", applied live. */
    set kiaiFlashes(v: boolean) {
        this.ctx.kiaiFlashes = v;
    }

    /**
     * Draw one object of each kind and every judgement once through
     * `render` (an offscreen render), then throw them away: textures,
     * glyph atlases, slider coverage targets and shader pipelines are all
     * created before gameplay is revealed instead of on the first object.
     */
    warmUp(render: () => void): void {
        const objs = this.o.beatmap.hitObjects;
        const seen = new Set<string>();
        const temp: Drawable[] = [];
        for (let i = 0; i < objs.length && seen.size < 3; i++) {
            const h = objs[i];
            if (seen.has(h.kind)) continue;
            seen.add(h.kind);
            const d = this.create(i);
            this.objectLayer.addChild(d);
            temp.push(d);
            d.updateAt(h.kind === 'circle' ? h.time - this.ctx.preempt / 2 : h.time + 1);
        }
        const first = objs[0];
        for (const r of ['great', 'ok', 'meh', 'miss'] as const) this.judgements.add(r, first.x, first.y, 0, 0xffffff);
        this.judgements.update(50);
        render();
        for (const d of temp) d.destroy();
        this.judgements.clear();
    }

    update(time: number): void {
        const objs = this.o.beatmap.hitObjects;
        const preempt = this.ctx.preempt;
        while (this.next < objs.length && objs[this.next].time - preempt <= time) {
            const d = this.create(this.next);
            // Later objects go underneath everything already on screen.
            this.objectLayer.addChildAt(d, 0);
            this.active.push(d);
            this.next++;
        }
        let spinnerFade = 0;
        for (let i = this.active.length - 1; i >= 0; i--) {
            const d = this.active[i];
            if (!d.updateAt(time)) {
                this.active.splice(i, 1);
                d.destroy();
            } else if (d instanceof DrawableSpinner) spinnerFade = Math.max(spinnerFade, d.fadeAlpha);
        }
        this.spinnerFade.visible = this.fadeForSpinners && spinnerFade > 0.001;
        this.spinnerFade.alpha = spinnerFade;
        this.followPoints?.update(time);
        this.judgements.update(time);
    }

    /**
     * lazer's fail animation (FailAnimationContainer.dropOffScreen), `t`
     * 0..1 over its 2.5s: every object on screen falls 400px, spins to a
     * random ±90° and halves in size, while the objects fade out in the
     * first half.
     */
    failDrop(t: number): void {
        for (const d of this.active) {
            const c = d as unknown as Container;
            let f = this.failState.get(d);
            if (!f) {
                // Spin around the object's own centre without moving it at t = 0.
                const b = c.getLocalBounds();
                const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
                c.pivot.set(cx, cy);
                f = { spin: ((Math.random() * 180 - 90) * Math.PI) / 180, x: c.x + cx, y: c.y + cy };
                this.failState.set(d, f);
            }
            c.position.set(f.x, f.y + 400 * t);
            c.rotation = f.spin * t;
            c.scale.set(1 - 0.5 * t);
        }
        const a = Math.max(0, 1 - t * 2);
        this.objectLayer.alpha = a;
        this.approachLayer.alpha = a;
        this.judgements.alpha = a;
        this.judgements.below.alpha = a;
        if (this.followPoints) this.followPoints.alpha = a;
    }

    private create(index: number): Drawable {
        const h = this.o.beatmap.hitObjects[index];
        // Hidden keeps the first object fully visible (lazer's IncreaseFirstObjectVisibility).
        const hiddenApplies = index > 0;
        switch (h.kind) {
            case 'circle': return new DrawableHitCircle(this.ctx, h, hiddenApplies);
            case 'slider': return new DrawableSlider(this.ctx, h, hiddenApplies);
            case 'spinner': return new DrawableSpinner(this.ctx, h);
        }
    }

    override destroy(): void {
        this.offNested();
        for (const d of this.active) d.destroy();
        this.active.length = 0;
        super.destroy({ children: true });
        if (!this.spinnerFade.destroyed) this.spinnerFade.destroy();
        this.sliderResources.destroy();
    }
}
