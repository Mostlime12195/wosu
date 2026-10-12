import type { CursorState, GameplayRules } from './GameplayRules';
import type { AutoPlayer } from './input/AutoPlayer';
import type { InputMode } from './mods';
import type { ReplayEvent } from './replay/Replay';

/**
 * Judgement runs in steps of at most this many ms whatever the frame rate
 * (lazer's frame-stable gameplay), with the cursor interpolated between
 * frames, so a hitch never skips a slider tick or tail.
 */
const SUBSTEP_MS = 8;
const MAX_SUBSTEPS = 40;

/**
 * Feeds GameplayRules the way the Player does: input frames (sub-stepped),
 * presses (through the input mode's rules: Autoplay and Relax ignore
 * them, Autopilot aims for you) and resumes. Live play and replays both
 * go through here, so the same input sequence judges the same way.
 */
export class RulesDriver {
    /** Called before every judgement step (Autoplay feeds its presses here). */
    beforeStep: ((time: number) => void) | null = null;
    private time = -Infinity;
    private prev: CursorState = { x: 256, y: 192, held: false };

    constructor(
        private readonly rules: GameplayRules,
        private readonly mode: InputMode,
        /** Autoplay / Autopilot's cursor path. */
        private readonly auto: AutoPlayer | null = null,
    ) {}

    /** Advance judgement to `time` with this frame's cursor. */
    step(time: number, cursor: CursorState): void {
        const from = this.time === -Infinity ? time : this.time;
        const span = time - from;
        const steps = span > 0 ? Math.min(MAX_SUBSTEPS, Math.ceil(span / SUBSTEP_MS)) : 1;
        const prev = this.prev;
        for (let k = 1; k <= steps; k++) {
            const t = k === steps ? time : from + (span * k) / steps;
            let c = cursor;
            if (k < steps) {
                if (this.auto) {
                    const a = this.auto.cursorAt(t);
                    c = { x: a.x, y: a.y, held: this.mode === 'autoplay' ? a.held : cursor.held };
                } else {
                    const f = k / steps;
                    c = { x: prev.x + (cursor.x - prev.x) * f, y: prev.y + (cursor.y - prev.y) * f, held: cursor.held };
                }
            }
            this.beforeStep?.(t);
            this.rules.update(t, c);
        }
        this.time = Math.max(this.time, time);
        this.prev = cursor;
    }

    /** A gameplay button went down at `time` with the cursor at (x, y). */
    press(time: number, x: number, y: number): void {
        // Autoplay and Relax hit for you; like lazer (AllowUserPresses = false), your own clicks
        // must not reach the rules (they'd early-click, shake and notelock the auto-hits).
        if (this.mode === 'autoplay' || this.mode === 'relax') return;
        if (this.mode === 'autopilot' && this.auto) {
            // Autopilot moves the cursor; the player only taps.
            const c = this.auto.cursorAt(time);
            this.rules.press(time, c.x, c.y);
        } else {
            this.rules.press(time, x, y);
        }
    }

    /** Gameplay resumed after a pause. */
    resume(): void {
        this.rules.resetSpinnerTracking();
    }

    apply(e: ReplayEvent): void {
        if (e.kind === 'frame') this.step(e.time, { x: e.x, y: e.y, held: e.buttons !== 0 });
        else if (e.kind === 'press') this.press(e.time, e.x, e.y);
        else this.resume();
    }
}
