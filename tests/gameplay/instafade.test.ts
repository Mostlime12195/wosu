import { describe, expect, it, vi } from 'vitest';
import { Container, Texture, TextureSource } from 'pixi.js';
import type { PlayableCircle, PlayableSlider, SliderEvent } from '../../src/beatmap/types';
import { CIRCLE_HIT_FADE, hitAnimationShown, sliderShown, type DrawableContext } from '../../src/gameplay/drawables/context';
import { DrawableHitCircle } from '../../src/gameplay/drawables/DrawableHitCircle';
import { DrawableSlider } from '../../src/gameplay/drawables/DrawableSlider';
import type { CircleState, SliderState } from '../../src/gameplay/GameplayRules';
import type { LegacySkin } from '../../src/skin/LegacySkin';
import { SkinChain } from '../../src/skin/SkinChain';

// The slider body draws through the GPU; a plain container stands in for it.
vi.mock('../../src/graphics/slider/SliderRenderer', async () => {
    const { Container: C } = await import('pixi.js');
    class SliderBody extends C {
        setRange(): void { /* drawn by the GPU */ }
        sync(): void { /* drawn by the GPU */ }
    }
    return { SliderBody, SliderResources: class {} };
});

/** A skin with just a hit circle (slider ends and heads use it too). */
const circleTex = { texture: new Texture({ source: new TextureSource({ width: 128, height: 128 }) }), scale: 1 };
const skin = {
    config: {}, texture: (n: string) => (n === 'hitcircle' ? circleTex : null), frames: () => [], sample: () => undefined, glyph: () => null,
} as unknown as LegacySkin;

function makeCtx(states: (CircleState | SliderState)[]): DrawableContext {
    return {
        skin: new SkinChain([{ skin }]),
        beatmap: { comboColors: [0xff0000], controlPoints: { at: () => ({ beatLength: 500, kiai: false }) } } as never,
        rules: { states, windows: { w50: 150 } } as never,
        sliders: {} as never,
        approachLayer: new Container(),
        radius: 32, preempt: 1200, fadeIn: 800,
        hidden: false, hideApproachCircles: false, hideNumbers: true, snakingIn: false, snakingOut: false,
        pixelsPerUnit: 1, kiaiFlashes: false, kiaiFlash: () => 0, legacyKiaiFlash: () => 0,
        instafadeCircles: false, instafadeSliders: false,
    };
}

const circle = { kind: 'circle', index: 0, x: 100, y: 100, time: 1000, comboColorIndex: 0, comboNumber: 1 } as PlayableCircle;

/** A straight 100 px slider from 1000 to 1500 with one repeat (two 250 ms spans). */
function makeSlider(): PlayableSlider {
    const path = {
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        pointAt: (t: number) => ({ x: 100 * t, y: 0 }),
        directionAt: () => ({ x: 1, y: 0 }),
    };
    const ev = (kind: SliderEvent['kind'], time: number, spanIndex: number, p: number): SliderEvent =>
        ({ kind, time, spanIndex, pathProgress: p, x: 100 * p, y: 0 });
    return {
        kind: 'slider', index: 0, x: 0, y: 0, time: 1000, endTime: 1500, comboColorIndex: 0, comboNumber: 1,
        path, slides: 2, spanDuration: 250, duration: 500, velocity: 0.4,
        events: [ev('head', 1000, 0, 0), ev('repeat', 1250, 0, 1), ev('tail', 1464, 1, 0)],
    } as unknown as PlayableSlider;
}

function sliderState(over: Partial<SliderState> = {}): SliderState {
    return {
        kind: 'slider', headHit: true, headResult: 'great', headAt: 1000, shakeAt: -Infinity, tracking: true, trackingChangedAt: 1000,
        nextEvent: 3, eventHit: [true, true, true], partsHit: 3, result: 'great', judgedAt: 1500, ...over,
    };
}

/** Whether a display object draws anything at the moment. */
const shown = (c: Container): boolean => c.visible && c.alpha > 0.001;

describe('instafade timing', () => {
    it('drops the hit animation from the moment of the hit', () => {
        expect(hitAnimationShown(999, 1000, true)).toBe(true);
        expect(hitAnimationShown(1000, 1000, true)).toBe(false);
        expect(hitAnimationShown(1000 + CIRCLE_HIT_FADE / 2, 1000, false)).toBe(true);
    });

    it('drops the whole slider once it ends', () => {
        expect(sliderShown(1500, 1500, true)).toBe(true);
        expect(sliderShown(1501, 1500, true)).toBe(false);
        expect(sliderShown(1700, 1500, false)).toBe(true);
    });
});

describe('instafade hit circles', () => {
    it('removes a hit circle the moment it is hit', () => {
        const s: CircleState = { kind: 'circle', result: 'great', judgedAt: 990, shakeAt: -Infinity };
        const ctx = makeCtx([s]);
        ctx.instafadeCircles = true;
        const d = new DrawableHitCircle(ctx, circle, true);
        expect(d.updateAt(980)).toBe(true); // before the hit: still approaching
        expect(d.updateAt(990)).toBe(false);
        expect(d.children[0].visible).toBe(false);
    });

    it('keeps the expand-and-fade without it, and applies live', () => {
        const s: CircleState = { kind: 'circle', result: 'great', judgedAt: 990, shakeAt: -Infinity };
        const ctx = makeCtx([s]);
        const d = new DrawableHitCircle(ctx, circle, true);
        expect(d.updateAt(1050)).toBe(true);
        expect(d.children[0].visible).toBe(true);
        ctx.instafadeCircles = true;
        expect(d.updateAt(1060)).toBe(false);
    });

    it('still fades misses out', () => {
        const s: CircleState = { kind: 'circle', result: 'miss', judgedAt: 1150, shakeAt: -Infinity };
        const ctx = makeCtx([s]);
        ctx.instafadeCircles = true;
        const d = new DrawableHitCircle(ctx, circle, true);
        expect(d.updateAt(1200)).toBe(true);
    });

    it('works with Hidden', () => {
        const s: CircleState = { kind: 'circle', result: 'ok', judgedAt: 1040, shakeAt: -Infinity };
        const ctx = { ...makeCtx([s]), hidden: true, hideApproachCircles: true, instafadeCircles: true };
        const d = new DrawableHitCircle(ctx, circle, true);
        expect(d.updateAt(1030)).toBe(true);
        expect(d.updateAt(1040)).toBe(false);
    });

    it('hides a hit slider head, repeat and tail at once', () => {
        const ctx = makeCtx([sliderState()]);
        ctx.instafadeCircles = true;
        const d = new DrawableSlider(ctx, makeSlider(), true);
        const head = d.children[d.children.length - 1];
        d.updateAt(1001);
        expect(head.visible).toBe(false);
        d.updateAt(1260);
        const repeat = (d.children[3] as Container).children[0];
        expect(repeat.visible).toBe(false);
        d.updateAt(1470);
        const tail = (d.children[1] as Container).children[0];
        expect(tail.visible).toBe(false);
        // The body still fades out after the end.
        expect(d.updateAt(1600)).toBe(true);
        expect(shown(d.children[0] as Container)).toBe(true);
    });

    it('lets slider ends burst without it', () => {
        const ctx = makeCtx([sliderState()]);
        const d = new DrawableSlider(ctx, makeSlider(), true);
        d.updateAt(1260);
        expect(shown((d.children[3] as Container).children[0])).toBe(true);
        d.updateAt(1050);
        expect(shown(d.children[d.children.length - 1])).toBe(true);
    });
});

describe('instafade sliders', () => {
    it('removes the whole slider the moment it ends', () => {
        const ctx = makeCtx([sliderState()]);
        ctx.instafadeSliders = true;
        const d = new DrawableSlider(ctx, makeSlider(), true);
        expect(d.updateAt(1500)).toBe(true);
        expect(d.visible).toBe(true);
        expect(d.updateAt(1501)).toBe(false);
        expect(d.visible).toBe(false);
    });

    it('fades the body out without it, and applies live', () => {
        const ctx = makeCtx([sliderState()]);
        const d = new DrawableSlider(ctx, makeSlider(), true);
        expect(d.updateAt(1600)).toBe(true);
        expect(d.children[0].alpha).toBeGreaterThan(0);
        expect(d.children[0].alpha).toBeLessThan(1);
        ctx.instafadeSliders = true;
        expect(d.updateAt(1610)).toBe(false);
    });

    it('waits for a pending head before removing the slider', () => {
        const ctx = makeCtx([sliderState({ headHit: null })]);
        ctx.instafadeSliders = true;
        const d = new DrawableSlider(ctx, makeSlider(), true);
        expect(d.updateAt(1501)).toBe(true);
        expect(d.visible).toBe(false);
    });

    it('works with Hidden', () => {
        const ctx = { ...makeCtx([sliderState()]), hidden: true, hideApproachCircles: true, instafadeSliders: true };
        const d = new DrawableSlider(ctx, makeSlider(), true);
        expect(d.updateAt(1400)).toBe(true);
        expect(d.updateAt(1501)).toBe(false);
    });
});
