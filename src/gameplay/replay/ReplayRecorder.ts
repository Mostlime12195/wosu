import type { GameplayButton } from '../input/GameplayInput';
import { quantize, type ReplayEvent, type ReplayFrame, type ReplayPress, type ReplayResume } from './Replay';

/**
 * Gameplay ms between frames while only the cursor moves (lazer's
 * ReplayRecorder records at 60 per second; judgement steps on recorded
 * frames here, so twice that keeps it as fine as the 8 ms sub-steps).
 */
export const RECORD_INTERVAL = 1000 / 120;

/**
 * lazer's ReplayRecorder: records a frame whenever the held buttons change
 * and at most every RECORD_INTERVAL otherwise, plus every press and resume.
 * The Player judges exactly what was recorded (quantised, in the same
 * order), which is what makes replays reproduce the play.
 */
export class ReplayRecorder {
    readonly events: ReplayEvent[] = [];
    private lastTime = -Infinity;
    private lastButtons = -1;

    /** Offer this frame's input; returns the frame to judge when it was recorded, else null. */
    frame(time: number, x: number, y: number, buttons: number): ReplayFrame | null {
        if (buttons === this.lastButtons && time - this.lastTime < RECORD_INTERVAL) return null;
        const f: ReplayFrame = { kind: 'frame', time: quantize(time), x: quantize(x), y: quantize(y), buttons };
        this.lastTime = time;
        this.lastButtons = buttons;
        this.events.push(f);
        return f;
    }

    press(time: number, x: number, y: number, button: GameplayButton): ReplayPress {
        const p: ReplayPress = { kind: 'press', time: quantize(time), x: quantize(x), y: quantize(y), button };
        this.events.push(p);
        return p;
    }

    resume(time: number): ReplayResume {
        const r: ReplayResume = { kind: 'resume', time: quantize(time) };
        this.events.push(r);
        return r;
    }
}
