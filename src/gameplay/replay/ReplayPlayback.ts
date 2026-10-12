import type { GameplayButton } from '../input/GameplayInput';
import { BUTTON_BITS, type ReplayEvent } from './Replay';

/**
 * lazer's FramedReplayInputHandler: hands the recorded events to gameplay
 * in their recorded order as the clock passes them (never out of order,
 * whatever the frame rate), and reports the replay's cursor and keys for
 * display. The viewer's own input plays no part.
 */
export class ReplayPlayback {
    readonly down: Record<GameplayButton, boolean> = { K1: false, K2: false, M1: false, M2: false };
    /** Presses per button (key overlay). */
    readonly counts: Record<GameplayButton, number> = { K1: 0, K2: 0, M1: 0, M2: 0 };
    private index = 0;
    /** Last applied event with a position. */
    private last: { time: number; x: number; y: number } = { time: -Infinity, x: 256, y: 192 };

    constructor(readonly events: readonly ReplayEvent[]) {}

    /** Every event has been applied. */
    get done(): boolean {
        return this.index >= this.events.length;
    }

    /** Apply every event up to `time`, in order. */
    advance(time: number, apply: (e: ReplayEvent) => void): void {
        const ev = this.events;
        while (this.index < ev.length && ev[this.index].time <= time) {
            const e = ev[this.index++];
            if (e.kind === 'frame') {
                for (const b of Object.keys(BUTTON_BITS) as GameplayButton[]) this.down[b] = (e.buttons & BUTTON_BITS[b]) !== 0;
                this.last = e;
            } else if (e.kind === 'press') {
                this.down[e.button] = true;
                this.counts[e.button]++;
                this.last = e;
            }
            apply(e);
        }
    }

    /** Displayed cursor at `time`: the last applied position eased toward the next recorded one. */
    cursorAt(time: number): { x: number; y: number } {
        const from = this.last;
        for (let i = this.index; i < this.events.length; i++) {
            const e = this.events[i];
            if (e.kind === 'resume') continue;
            const span = e.time - from.time;
            if (!(span > 0) || time <= from.time) return { x: from.x, y: from.y };
            const t = Math.min(1, (time - from.time) / span);
            return { x: from.x + (e.x - from.x) * t, y: from.y + (e.y - from.y) * t };
        }
        return { x: from.x, y: from.y };
    }
}
