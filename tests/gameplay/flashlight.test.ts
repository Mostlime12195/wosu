import { describe, expect, it } from 'vitest';
import {
    BREAK_TIME_SCALE,
    comboScaleFor,
    FLASHLIGHT_DEFAULT_SIZE,
    FlashlightState,
    flashlightTargetSize,
    SLIDER_DIM,
} from '../../src/gameplay/FlashlightState';
import type { FlashlightSettings } from '../../src/gameplay/mods';

const DEFAULTS: FlashlightSettings = { sizeMultiplier: 1, comboBasedSize: true, followDelay: 120 };
const frame = (o: Partial<{ cursorX: number; cursorY: number; combo: number; inBreak: boolean; sliderTracking: boolean }> = {}) =>
    ({ cursorX: 0, cursorY: 0, combo: 0, inBreak: false, sliderTracking: false, ...o });

describe('flashlight (lazer ModFlashlight / OsuModFlashlight)', () => {
    it('GetComboScaleFor steps at 100 and 200 combo', () => {
        expect(comboScaleFor(0)).toBe(1);
        expect(comboScaleFor(99)).toBe(1);
        expect(comboScaleFor(100)).toBe(0.8125);
        expect(comboScaleFor(199)).toBe(0.8125);
        expect(comboScaleFor(200)).toBe(0.625);
        expect(comboScaleFor(5000)).toBe(0.625);
    });

    it('GetSize applies multiplier, combo and break scale', () => {
        expect(flashlightTargetSize(DEFAULTS, 0, false)).toBe(125);
        expect(flashlightTargetSize(DEFAULTS, 250, false)).toBe(125 * 0.625);
        expect(flashlightTargetSize(DEFAULTS, 250, true)).toBe(125 * BREAK_TIME_SCALE);
        expect(flashlightTargetSize({ ...DEFAULTS, comboBasedSize: false }, 250, false)).toBe(125);
        expect(flashlightTargetSize({ ...DEFAULTS, sizeMultiplier: 2 }, 100, false)).toBe(250 * 0.8125);
    });

    it('size transitions at stable speed (0.1 units per 60 fps frame)', () => {
        const s = new FlashlightState(DEFAULTS);
        expect(s.size).toBe(FLASHLIGHT_DEFAULT_SIZE);
        // 125 -> 101.5625 is 0.1875 of the default size: 100 ms.
        s.update(50, frame({ combo: 100 }));
        expect(s.size).toBeCloseTo(125 - 23.4375 / 2);
        s.update(50, frame({ combo: 101 }));
        expect(s.size).toBeCloseTo(101.5625);
        // Breaking combo grows it back over the same speed.
        s.update(1000, frame({ combo: 0 }));
        expect(s.size).toBe(125);
        // Break: 125 -> 312.5 takes 800 ms.
        s.update(400, frame({ inBreak: true }));
        expect(s.size).toBeCloseTo(125 + 187.5 / 2);
        s.update(400, frame({ inBreak: true }));
        expect(s.size).toBeCloseTo(312.5);
    });

    it('follows the cursor with Easing.Out over the follow delay', () => {
        const s = new FlashlightState(DEFAULTS);
        s.update(0, frame({ cursorX: 0, cursorY: 0 }));
        s.update(60, frame({ cursorX: 100, cursorY: 0 }));
        // t = 0.5 -> OutQuad 0.75 of the way.
        expect(s.x).toBeCloseTo(75);
        s.update(500, frame({ cursorX: 100, cursorY: 50 }));
        expect([s.x, s.y]).toEqual([100, 50]);
        const slow = new FlashlightState({ ...DEFAULTS, followDelay: 1200 });
        slow.update(0, frame());
        slow.update(60, frame({ cursorX: 100 }));
        expect(slow.x).toBeCloseTo(100 * (0.05 * 1.95));
        // Paused (no gameplay time): it holds still.
        const x = slow.x;
        slow.update(0, frame({ cursorX: 300 }));
        expect(slow.x).toBe(x);
    });

    it('dims by 0.8 while a slider is tracked', () => {
        const s = new FlashlightState(DEFAULTS);
        s.update(16, frame({ sliderTracking: true }));
        expect(s.dim).toBe(SLIDER_DIM);
        expect(SLIDER_DIM).toBe(0.8);
        s.update(16, frame());
        expect(s.dim).toBe(0);
    });
});
