import { Container, type Renderer } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { SliderResources } from '../../graphics/slider/SliderRenderer';
import type { Skin } from '../../skin/Skin';
import type { GameplayRules } from '../GameplayRules';
import { makeKiaiFlash, type DrawableContext } from './context';
import { DrawableHitCircle, type Drawable } from './DrawableHitCircle';
import { DrawableSlider } from './DrawableSlider';
import { DrawableSpinner } from './DrawableSpinner';
import { FollowPoints } from './FollowPoints';
import { Judgements } from './Judgements';

export interface PlayfieldOptions {
    renderer: Renderer;
    skin: Skin;
    beatmap: PlayableBeatmap;
    rules: GameplayRules;
    hidden: boolean;
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
    private next = 0;

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
            hideNumbers: o.hideNumbers,
            snakingIn: o.snakingIn,
            snakingOut: o.snakingOut,
            pixelsPerUnit: 1,
            kiaiFlashes: o.kiaiFlashes ?? false,
            kiaiFlash: () => 0,
        };
        const ctx = this.ctx;
        ctx.kiaiFlash = makeKiaiFlash(b, () => ctx.kiaiFlashes);
        this.followPoints = o.hideFollowPoints ? null : new FollowPoints(b, o.skin.get('followpoint.png'), d.preempt, d.fadeIn, d.circleRadius);
        this.judgements = new Judgements(o.skin.tex('glow'), d.circleRadius);
        if (this.followPoints) this.addChild(this.followPoints);
        this.addChild(this.objectLayer, this.approachLayer, this.judgements);
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
        for (let i = this.active.length - 1; i >= 0; i--) {
            const d = this.active[i];
            if (!d.updateAt(time)) {
                this.active.splice(i, 1);
                d.destroy();
            }
        }
        this.followPoints?.update(time);
        this.judgements.update(time);
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
        for (const d of this.active) d.destroy();
        this.active.length = 0;
        super.destroy({ children: true });
        this.sliderResources.destroy();
    }
}
