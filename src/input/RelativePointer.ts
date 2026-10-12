/** lazer's cursor sensitivity range (osu-framework's MouseHandler.Sensitivity). */
export const SENSITIVITY_MIN = 0.1;
export const SENSITIVITY_MAX = 10;

export interface Delta {
    x: number;
    y: number;
}

/**
 * A virtual cursor moved by relative mouse deltas (osu-framework's
 * MousePositionRelativeInput while in relative mode): each delta is
 * scaled and added, and the position is clamped to the screen so the
 * cursor stops at the edge and comes straight back, with no leftover
 * "debt" from pushing past it.
 *
 * Positions and bounds are logical (UI) pixels; deltas are whatever unit
 * the caller scales from (pointer lock reports CSS pixels).
 */
export class RelativePointer {
    x = 0;
    y = 0;
    width = 0;
    height = 0;

    /** Start from an absolute position (the OS cursor's when the lock engaged). */
    reset(x: number, y: number): void {
        this.x = x;
        this.y = y;
        this.clamp();
    }

    setBounds(width: number, height: number): void {
        this.width = Math.max(0, width);
        this.height = Math.max(0, height);
        this.clamp();
    }

    /** Add a delta times `scale` (sensitivity ÷ UI scale). */
    move(dx: number, dy: number, scale = 1): void {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        this.x += dx * scale;
        this.y += dy * scale;
        this.clamp();
    }

    private clamp(): void {
        this.x = Math.min(this.width, Math.max(0, this.x));
        this.y = Math.min(this.height, Math.max(0, this.y));
    }
}

/**
 * The deltas to apply for one pointermove: its coalesced samples when they
 * add up to the event's own movement (smooth trail at the mouse's polling
 * rate), otherwise just the event's total (some browsers report coalesced
 * movement as zero or repeat the parent's).
 */
export function movementSteps(total: Delta, coalesced: readonly Delta[]): Delta[] {
    if (coalesced.length > 1) {
        let sx = 0, sy = 0;
        for (const c of coalesced) {
            sx += c.x;
            sy += c.y;
        }
        if (Math.abs(sx - total.x) <= 1 && Math.abs(sy - total.y) <= 1) return coalesced.slice();
    }
    return [total];
}

/**
 * Chrome occasionally reports a bogus huge movement (most often right
 * after the lock engages, or with accelerated input on Windows). A real
 * sample between two mouse polls never crosses the whole screen, so
 * anything that does is dropped.
 */
export function isMovementSpike(d: Delta, screenW: number, screenH: number): boolean {
    const limit = Math.max(screenW, screenH, 200);
    return Math.abs(d.x) > limit || Math.abs(d.y) > limit;
}
