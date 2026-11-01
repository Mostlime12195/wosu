import {
    DEFAULT_REFRESH_HZ,
    FRAME_LIMIT_VSYNC,
    UNCAPPED_RAF_HZ,
    frameIntervalMs,
    isFrameLimit,
    planFrames,
    refreshFromIntervals,
    type FramePlan,
} from './frameLimit';

export interface FrameHooks {
    /** Advance the game by `dt` ms. */
    update(dt: number): void;
    /** Render the stage. */
    draw(): void;
    /** The GPU has finished earlier frames (the timer loop waits for it before drawing again). */
    ready?(): boolean;
}

/** Rates over the last measurement window (lazer's draw / update split). */
export interface FrameStats {
    /** Frames rendered per second. */
    drawHz: number;
    /** Updates per second (one per drawn frame, more above the refresh rate). */
    updateHz: number;
    /** Rendered frames that reached the screen per second. */
    presentedHz: number;
    /** The display's refresh rate (requestAnimationFrame's rate). */
    refreshHz: number;
    /** The draw rate the limiter is aiming for (the refresh rate when uncapped). */
    targetHz: number;
    /** Average CPU time of an update + draw (ms). */
    workMs: number;
    /** Longest gap between drawn frames in the window (ms). */
    worstGapMs: number;
    driver: FramePlan['driver'];
}

const STATS_WINDOW_MS = 500;
/** Below this wait the timer loop yields with messages instead of setTimeout (whose waits overshoot ~1 ms). */
const SPIN_MS = 1.5;
/**
 * The timer loop waits for the browser's own frame (rAF) when it's this
 * many refresh intervals late: drawing flat out can saturate the GPU
 * process and starve compositing and input (seen with WebGL at ~800 fps
 * on macOS).
 */
const STARVED_FRAMES = 2.5;
/** Clamp for update steps (tab switch, breakpoint) so animations don't jump. */
const MAX_STEP_MS = 100;

/**
 * Runs the game's update and draw. At VSync (and any rate the display
 * reaches) it's requestAnimationFrame, one update and draw per frame,
 * right before the browser composites. Above the refresh rate, which only
 * a low-latency (desynchronized) canvas can show (see planFrames), a
 * self-scheduled loop (MessageChannel, with setTimeout for longer waits)
 * updates and draws at the chosen rate and yields to the event loop every
 * iteration, so input, audio callbacks and the browser's own frames are
 * never starved.
 *
 * The timer loop stops while the tab is hidden (rAF does by itself) and
 * only runs during gameplay (unless chosen for menus) while the window has
 * focus. rAF keeps running to measure the refresh rate and to count the
 * frames a normal canvas actually presents.
 */
export class FrameLoop {
    private limit = FRAME_LIMIT_VSYNC;
    private gameplay = false;
    private uncappedInMenus = false;
    private lowLatency = false;
    private focused = true;
    private plan: FramePlan = { driver: 'raf', updateHz: Infinity, drawHz: Infinity };

    private running = false;
    private rafId = 0;
    private lastRaf = 0;
    private readonly rafIntervals: number[] = [];
    private refreshHz = 0;
    private rafUncapped = false;
    private lastRefreshCheck = 0;

    private lastUpdate = 0;
    private nextUpdate = 0;
    private nextDraw = 0;
    private drawnSinceRaf = false;

    private timerActive = false;
    private timerPending = false;
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    /** The timer loop is waiting for an overdue browser frame (see STARVED_FRAMES). */
    private awaitingRaf = false;
    /** Times it did, for diagnostics. */
    backoffs = 0;
    private readonly channel: MessageChannel | null = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;

    // Measurement window
    private windowStart = 0;
    private draws = 0;
    private updates = 0;
    private presented = 0;
    private workTotal = 0;
    private worstGap = 0;
    private lastDraw = 0;
    readonly stats: FrameStats = { drawHz: 0, updateHz: 0, presentedHz: 0, refreshHz: DEFAULT_REFRESH_HZ, targetHz: DEFAULT_REFRESH_HZ, workMs: 0, worstGapMs: 0, driver: 'raf' };

    constructor(private readonly hooks: FrameHooks) {
        if (this.channel) this.channel.port1.onmessage = () => this.onTimer();
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        document.addEventListener('visibilitychange', this.onVisibility);
        window.addEventListener('focus', this.onFocus);
        window.addEventListener('blur', this.onFocus);
        this.focused = document.hasFocus();
        const now = performance.now();
        this.lastUpdate = this.windowStart = this.lastDraw = now;
        this.replan();
        this.requestRaf();
    }

    stop(): void {
        this.running = false;
        document.removeEventListener('visibilitychange', this.onVisibility);
        window.removeEventListener('focus', this.onFocus);
        window.removeEventListener('blur', this.onFocus);
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        this.stopTimer();
    }

    /** Settings.frameLimit (see frameLimit.ts). */
    setLimit(limit: number): void {
        this.limit = isFrameLimit(limit) ? limit : FRAME_LIMIT_VSYNC;
        this.replan();
    }

    /** A gameplay screen is showing: rates above the refresh rate apply. */
    setGameplay(on: boolean): void {
        if (this.gameplay === on) return;
        this.gameplay = on;
        this.replan();
    }

    setUncappedInMenus(on: boolean): void {
        this.uncappedInMenus = on;
        this.replan();
    }

    /** The canvas is desynchronized: drawn frames are shown without waiting for the compositor. */
    setLowLatency(on: boolean): void {
        this.lowLatency = on;
        this.replan();
    }

    /** What the loop is doing now (for tests and the settings' notes). */
    get currentPlan(): Readonly<FramePlan> {
        return this.plan;
    }

    private replan(): void {
        this.plan = planFrames(this.limit, {
            refreshHz: this.refreshHz || DEFAULT_REFRESH_HZ,
            rafUncapped: this.rafUncapped,
            lowLatency: this.lowLatency,
            gameplay: this.gameplay,
            uncappedInMenus: this.uncappedInMenus,
            focused: this.focused,
        });
        this.stats.driver = this.plan.driver;
        this.stats.targetHz = Number.isFinite(this.plan.drawHz) ? this.plan.drawHz : this.stats.refreshHz;
        const now = performance.now();
        this.nextUpdate = this.nextDraw = now;
        if (this.running && this.plan.driver === 'timer' && !document.hidden) this.startTimer();
        else this.stopTimer();
    }

    private readonly onVisibility = (): void => {
        if (!this.running) return;
        if (document.hidden) {
            this.stopTimer();
            return;
        }
        // Don't count the hidden time as a refresh interval.
        this.lastRaf = 0;
        this.replan();
        this.requestRaf();
    };

    private readonly onFocus = (): void => {
        const f = document.hasFocus();
        if (f === this.focused) return;
        this.focused = f;
        this.replan();
    };

    private requestRaf(): void {
        if (!this.rafId && this.running) this.rafId = requestAnimationFrame(this.onRaf);
    }

    private readonly onRaf = (now: number): void => {
        this.rafId = 0;
        if (!this.running) return;
        this.measureRefresh(now);
        // A normal canvas shows at most the latest drawn frame per refresh (low latency counts its draws).
        if (this.drawnSinceRaf && !this.lowLatency) this.presented++;
        if (this.awaitingRaf) {
            this.awaitingRaf = false;
            if (this.timerActive) this.post();
        }
        this.drawnSinceRaf = false;
        if (this.plan.driver === 'raf') {
            // rAF's timestamp is the frame's start; work from the real time.
            const t = performance.now();
            const due = this.due(t, this.plan.updateHz, 'update');
            this.frame(t, due, due);
        }
        this.requestRaf();
    };

    /**
     * Whether a frame limited to `hz` is due at `now`, advancing the
     * schedule. A 1 ms tolerance keeps a cap equal to the refresh rate from
     * skipping frames over rAF's jitter.
     */
    private due(now: number, hz: number, which: 'update' | 'draw'): boolean {
        const interval = frameIntervalMs(hz);
        if (interval === 0) return true;
        const next = which === 'update' ? this.nextUpdate : this.nextDraw;
        const tolerance = this.plan.driver === 'raf' ? 1 : 0.05;
        if (now < next - tolerance) return false;
        // Keep the cadence, but don't try to catch up after a stall.
        const after = now - next > interval ? now + interval : next + interval;
        if (which === 'update') this.nextUpdate = after;
        else this.nextDraw = after;
        return true;
    }

    private frame(now: number, update: boolean, draw: boolean): void {
        if (!update && !draw) return;
        const start = performance.now();
        if (update) {
            const dt = Math.min(MAX_STEP_MS, Math.max(0, now - this.lastUpdate));
            this.lastUpdate = now;
            this.updates++;
            this.hooks.update(dt);
        }
        if (draw) {
            this.hooks.draw();
            this.draws++;
            if (this.lowLatency) this.presented++;
            this.drawnSinceRaf = true;
            const end = performance.now();
            this.worstGap = Math.max(this.worstGap, end - this.lastDraw);
            this.lastDraw = end;
        }
        this.workTotal += performance.now() - start;
        if (now - this.windowStart >= STATS_WINDOW_MS) this.flushStats(now);
    }

    private flushStats(now: number): void {
        const s = (now - this.windowStart) / 1000;
        const st = this.stats;
        st.drawHz = this.draws / s;
        st.updateHz = this.updates / s;
        st.presentedHz = Math.min(this.presented / s, this.lowLatency ? Infinity : st.refreshHz);
        st.workMs = this.workTotal / Math.max(1, Math.max(this.updates, this.draws));
        st.worstGapMs = this.worstGap;
        this.draws = this.updates = this.presented = 0;
        this.workTotal = this.worstGap = 0;
        this.windowStart = now;
    }

    private measureRefresh(now: number): void {
        if (this.lastRaf) {
            this.rafIntervals.push(now - this.lastRaf);
            if (this.rafIntervals.length > 120) this.rafIntervals.shift();
        }
        this.lastRaf = now;
        if (now - this.lastRefreshCheck < 500) return;
        this.lastRefreshCheck = now;
        const hz = refreshFromIntervals(this.rafIntervals);
        if (!hz) return;
        this.stats.refreshHz = hz;
        // Sticky: flags don't change in a session, and under load uncapped rAF can drop to any rate.
        const uncapped = this.rafUncapped || hz > UNCAPPED_RAF_HZ;
        // Re-plan when the display changes (another monitor, power saving) by more than a little.
        if (uncapped !== this.rafUncapped || Math.abs(hz - this.refreshHz) > Math.max(2, this.refreshHz * 0.05)) {
            this.refreshHz = hz;
            this.rafUncapped = uncapped;
            this.replan();
        }
    }

    // ---------------------------------------------------------------
    // Timer loop (above the refresh rate)
    // ---------------------------------------------------------------

    private startTimer(): void {
        if (this.timerActive) return;
        this.timerActive = true;
        this.post();
    }

    private stopTimer(): void {
        this.timerActive = false;
        this.awaitingRaf = false;
        // A cancelled timeout leaves nothing in flight; a posted message still arrives (and sees the loop stopped,
        // or carries it on if it was restarted meanwhile).
        if (this.timeoutId !== null) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
            this.timerPending = false;
        }
    }

    private post(): void {
        if (this.timerPending) return;
        this.timerPending = true;
        if (this.channel) this.channel.port2.postMessage(0);
        else this.timeoutId = setTimeout(() => this.onTimer(), 0);
    }

    private onTimer(): void {
        this.timerPending = false;
        this.timeoutId = null;
        if (!this.timerActive || !this.running) return;
        if (document.hidden) {
            this.stopTimer();
            return;
        }
        const now = performance.now();
        const refresh = this.rafUncapped || !this.refreshHz ? DEFAULT_REFRESH_HZ : this.refreshHz;
        if (this.lastRaf && now - this.lastRaf > STARVED_FRAMES * 1000 / refresh) {
            // Let the browser's frame through before drawing again (onRaf resumes the loop).
            this.backoffs++;
            this.awaitingRaf = true;
            return;
        }
        if (this.hooks.ready && !this.hooks.ready()) {
            // Yield and look again; updates wait too, so the next frame shows the latest state.
            this.post();
            return;
        }
        const plan = this.plan;
        const update = this.due(now, plan.updateHz, 'update');
        const draw = this.due(now, plan.drawHz, 'draw');
        this.frame(now, update, draw);
        if (!this.timerActive) return;
        // Every iteration is its own task, so input events and the browser's frames run in between.
        this.wait(Math.min(this.nextUpdate, this.nextDraw) - performance.now());
    }

    private wait(ms: number): void {
        if (ms <= SPIN_MS) {
            this.post();
            return;
        }
        // Scheduled from a message task, so the timer's nesting level never reaches the 4 ms clamp.
        this.timerPending = true;
        this.timeoutId = setTimeout(() => {
            this.timerPending = false;
            this.post();
        }, ms - 1);
    }
}
