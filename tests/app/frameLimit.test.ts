import { describe, expect, it } from 'vitest';
import {
    FRAME_LIMIT_2X,
    FRAME_LIMIT_4X,
    FRAME_LIMIT_8X,
    FRAME_LIMIT_UNLIMITED,
    FRAME_LIMIT_VSYNC,
    frameIntervalMs,
    frameLimitOptions,
    isFrameLimit,
    limitHz,
    planFrames,
    refreshFromIntervals,
    type FrameEnvironment,
} from '../../src/app/frameLimit';

const env = (o: Partial<FrameEnvironment> = {}): FrameEnvironment => ({
    refreshHz: 60,
    rafUncapped: false,
    lowLatency: true,
    gameplay: true,
    uncappedInMenus: false,
    focused: true,
    ...o,
});

describe('limitHz', () => {
    it('maps the limiter modes to rates on the display', () => {
        expect(limitHz(FRAME_LIMIT_VSYNC, 144)).toBe(144);
        expect(limitHz(FRAME_LIMIT_2X, 144)).toBe(288);
        expect(limitHz(FRAME_LIMIT_4X, 60)).toBe(240);
        expect(limitHz(FRAME_LIMIT_8X, 60)).toBe(480);
        expect(limitHz(FRAME_LIMIT_UNLIMITED, 60)).toBe(Infinity);
        expect(limitHz(240, 60)).toBe(240);
    });
});

describe('planFrames', () => {
    it('runs VSync on requestAnimationFrame without a cap', () => {
        expect(planFrames(FRAME_LIMIT_VSYNC, env())).toEqual({ driver: 'raf', updateHz: Infinity, drawHz: Infinity });
    });

    it('caps rates the display reaches on requestAnimationFrame', () => {
        expect(planFrames(30, env())).toEqual({ driver: 'raf', updateHz: 30, drawHz: 30 });
        expect(planFrames(60, env())).toEqual({ driver: 'raf', updateHz: 60, drawHz: 60 });
        // A 144 Hz display reaches 120 and 144.
        expect(planFrames(144, env({ refreshHz: 144 })).driver).toBe('raf');
        // Caps below the refresh rate apply in menus too.
        expect(planFrames(30, env({ gameplay: false })).drawHz).toBe(30);
    });

    it('goes above the refresh rate with a timer loop on a low latency canvas', () => {
        expect(planFrames(FRAME_LIMIT_2X, env())).toEqual({ driver: 'timer', updateHz: 120, drawHz: 120 });
        expect(planFrames(FRAME_LIMIT_8X, env({ refreshHz: 144 }))).toEqual({ driver: 'timer', updateHz: 1152, drawHz: 1152 });
        expect(planFrames(FRAME_LIMIT_UNLIMITED, env())).toEqual({ driver: 'timer', updateHz: Infinity, drawHz: Infinity });
        expect(planFrames(240, env()).driver).toBe('timer');
    });

    it('stays at VSync above the refresh rate on a normal canvas', () => {
        // A composited canvas shows one frame per refresh: drawing more is wasted.
        for (const limit of [FRAME_LIMIT_2X, FRAME_LIMIT_UNLIMITED, 240]) {
            expect(planFrames(limit, env({ lowLatency: false }))).toEqual({ driver: 'raf', updateHz: Infinity, drawHz: Infinity });
        }
    });

    it('only uncaps in menus when asked, and never for an unfocused window', () => {
        expect(planFrames(FRAME_LIMIT_UNLIMITED, env({ gameplay: false })).driver).toBe('raf');
        expect(planFrames(FRAME_LIMIT_UNLIMITED, env({ gameplay: false, uncappedInMenus: true })).driver).toBe('timer');
        expect(planFrames(FRAME_LIMIT_UNLIMITED, env({ focused: false })).driver).toBe('raf');
    });

    it('runs flat out on rAF, and caps with the timer loop, when browser flags uncap rAF', () => {
        const flags = env({ refreshHz: 2000, rafUncapped: true, lowLatency: false, gameplay: false });
        expect(planFrames(FRAME_LIMIT_VSYNC, flags)).toEqual({ driver: 'raf', updateHz: Infinity, drawHz: Infinity });
        expect(planFrames(FRAME_LIMIT_UNLIMITED, flags)).toEqual({ driver: 'raf', updateHz: Infinity, drawHz: Infinity });
        expect(planFrames(240, flags)).toEqual({ driver: 'timer', updateHz: 240, drawHz: 240 });
        // The refresh rate is unknown then; multiples assume 60 Hz.
        expect(planFrames(FRAME_LIMIT_4X, flags)).toEqual({ driver: 'timer', updateHz: 240, drawHz: 240 });
    });

    it('assumes 60 Hz before the refresh rate is measured', () => {
        expect(planFrames(FRAME_LIMIT_2X, env({ refreshHz: 0 })).drawHz).toBe(120);
    });
});

describe('frame limiter helpers', () => {
    it('turns rates into loop intervals', () => {
        expect(frameIntervalMs(250)).toBe(4);
        expect(frameIntervalMs(Infinity)).toBe(0);
        expect(frameIntervalMs(0)).toBe(0);
    });

    it('measures the refresh rate from rAF intervals, ignoring outliers', () => {
        const at144 = [6.9, 6.95, 6.94, 6.96, 6.93, 13.9, 6.94, 400];
        expect(refreshFromIntervals(at144)).toBe(144);
        expect(refreshFromIntervals([16.7, 16.6])).toBe(0);
    });

    it('offers every value it accepts', () => {
        const opts = frameLimitOptions();
        expect(opts[0].label).toBe('VSync');
        for (const o of opts) expect(isFrameLimit(o.value)).toBe(true);
        expect(isFrameLimit(-3)).toBe(false);
        expect(isFrameLimit(120)).toBe(true);
    });
});
