/**
 * The frame limiter (lazer's FrameSync plus fixed rates) and the choice of
 * how the App's loop runs for it. Kept free of DOM so it can be tested.
 *
 * Settings.frameLimit stores a number: 0 is VSync, a positive value is a
 * fixed rate in fps, and negative values are the special modes below
 * (older saves only ever held 0 or a fixed rate, so they still load).
 */
export const FRAME_LIMIT_VSYNC = 0;
export const FRAME_LIMIT_UNLIMITED = -1;
/** -n: n × the display's refresh rate (lazer's Limit2x / 4x / 8x). */
export const FRAME_LIMIT_2X = -2;
export const FRAME_LIMIT_4X = -4;
export const FRAME_LIMIT_8X = -8;

/** Assumed refresh rate when it can't be measured (lazer assumes 60 Hz too). */
export const DEFAULT_REFRESH_HZ = 60;
/**
 * requestAnimationFrame faster than this (above any display's refresh rate)
 * means the browser's frame cap is off (Chrome's --disable-frame-rate-limit /
 * --disable-gpu-vsync), so it's no longer the display's refresh rate.
 */
export const UNCAPPED_RAF_HZ = 600;

/** Fixed-rate choices offered next to the modes. */
export const FIXED_FRAME_LIMITS = [30, 60, 120, 144, 165, 240, 360, 480, 1000] as const;

/** True for a value Settings.frameLimit may hold. */
export function isFrameLimit(v: number): boolean {
    return v === FRAME_LIMIT_VSYNC || v === FRAME_LIMIT_UNLIMITED || v === FRAME_LIMIT_2X
        || v === FRAME_LIMIT_4X || v === FRAME_LIMIT_8X || (Number.isFinite(v) && v >= 10 && v <= 2000);
}

/**
 * Most frames per second the limiter allows on a display refreshing at
 * `refreshHz` (Infinity = no limit). VSync is one frame per refresh.
 */
export function limitHz(limit: number, refreshHz: number): number {
    if (limit === FRAME_LIMIT_VSYNC) return refreshHz;
    if (limit === FRAME_LIMIT_UNLIMITED) return Infinity;
    if (limit < 0) return refreshHz * -limit;
    return limit;
}

export interface FrameEnvironment {
    /** The display's refresh rate (requestAnimationFrame's rate), measured. */
    refreshHz: number;
    /** requestAnimationFrame runs uncapped (browser flags): it can drive any rate itself. */
    rafUncapped: boolean;
    /** The canvas is desynchronized (low latency): frames reach the screen as soon as they're drawn. */
    lowLatency: boolean;
    /** A gameplay screen is showing. */
    gameplay: boolean;
    /** The player wants the limiter above the refresh rate in menus too. */
    uncappedInMenus: boolean;
    /** The window has focus (lazer drops to its inactive rate otherwise). */
    focused: boolean;
}

export interface FramePlan {
    /**
     * 'raf': one update and draw per animation frame (in step with the
     * display), skipping frames for a cap below its rate. 'timer': a
     * self-scheduled loop that yields to the event loop every iteration,
     * for rates requestAnimationFrame can't reach.
     */
    driver: 'raf' | 'timer';
    /** Most updates per second (Infinity = as fast as possible). */
    updateHz: number;
    /** Most draws per second (Infinity = as fast as possible). */
    drawHz: number;
}

const UNCAPPED: FramePlan = { driver: 'raf', updateHz: Infinity, drawHz: Infinity };

/**
 * How the loop runs for `limit` right now. Rates the display reaches run
 * on requestAnimationFrame. Rates above it need a low-latency canvas: a
 * normal canvas is composited once per refresh, so frames drawn between
 * refreshes are thrown away, and drawing outside rAF even costs a frame
 * of latency (pointer moves arrive at the start of a frame, right before
 * rAF). Updating between frames buys nothing either: presses are judged
 * at their event's time and pointer positions only change once a frame.
 * So without one, every limit above the refresh rate is VSync. With one,
 * rates above the refresh rate apply during gameplay (unless the player
 * asks for them in menus) while the window has focus.
 */
export function planFrames(limit: number, env: FrameEnvironment): FramePlan {
    if (limit === FRAME_LIMIT_VSYNC) return UNCAPPED;
    const refresh = env.refreshHz > 0 ? env.refreshHz : DEFAULT_REFRESH_HZ;
    // Browser flags removed the cap: rAF runs flat out while every frame draws, but slows to
    // ~100 Hz once frames are skipped, so a cap needs the timer loop (whose frames Chrome then
    // commits ~120 times a second, measured headless). The refresh rate can't be measured then;
    // multiples assume 60 Hz.
    if (env.rafUncapped) {
        const hz = limitHz(limit, DEFAULT_REFRESH_HZ);
        return Number.isFinite(hz) ? { driver: 'timer', updateHz: hz, drawHz: hz } : UNCAPPED;
    }
    const hz = limitHz(limit, refresh);
    if (hz <= refresh * 1.05) return { driver: 'raf', updateHz: hz, drawHz: hz };
    if (!env.lowLatency || !env.focused || (!env.gameplay && !env.uncappedInMenus)) return UNCAPPED;
    return { driver: 'timer', updateHz: hz, drawHz: hz };
}

/** Milliseconds between frames for a rate (0 = no wait). */
export function frameIntervalMs(hz: number): number {
    return Number.isFinite(hz) && hz > 0 ? 1000 / hz : 0;
}

/** Refresh rate from requestAnimationFrame intervals (ms): the median, rounded. */
export function refreshFromIntervals(intervals: readonly number[]): number {
    const sane = intervals.filter(i => i > 0.2 && i < 100);
    if (sane.length < 5) return 0;
    const sorted = [...sane].sort((a, b) => a - b);
    const mid = sorted[sorted.length >> 1];
    return Math.round(1000 / mid);
}

/** Display names for the limiter's choices, in menu order. */
export function frameLimitOptions(): { value: number; label: string }[] {
    return [
        { value: FRAME_LIMIT_VSYNC, label: 'VSync' },
        { value: FRAME_LIMIT_2X, label: '2× refresh rate' },
        { value: FRAME_LIMIT_4X, label: '4× refresh rate' },
        { value: FRAME_LIMIT_8X, label: '8× refresh rate' },
        { value: FRAME_LIMIT_UNLIMITED, label: 'Unlimited' },
        ...FIXED_FRAME_LIMITS.map(v => ({ value: v, label: `${v} fps` })),
    ];
}
