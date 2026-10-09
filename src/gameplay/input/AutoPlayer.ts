import type { PlayableBeatmap, PlayableHitObject } from '../../beatmap/types';
import { sliderBallPosition } from '../GameplayRules';

export interface AutoPress {
    time: number;
    x: number;
    y: number;
}

const SPIN_RADIUS = 50;
const SPIN_SPEED = 0.04; // rad/ms ≈ 380 RPM
const CENTER = { x: 256, y: 192 };

/**
 * Deterministic autoplay (lazer's OsuAutoGenerator, simplified): cursor
 * position and button state are pure functions of time, and presses land
 * exactly on object times — independent of frame rate. Autopilot uses the
 * same cursor path with the player's own clicks.
 */
export class AutoPlayer {
    readonly presses: AutoPress[] = [];
    private readonly objects: readonly PlayableHitObject[];
    private readonly preempt: number;

    constructor(beatmap: PlayableBeatmap) {
        this.objects = beatmap.hitObjects;
        this.preempt = beatmap.difficulty.preempt;
        for (const h of this.objects) {
            const p = this.startPosition(h);
            this.presses.push({ time: h.time, x: p.x, y: p.y });
        }
    }

    private startPosition(h: PlayableHitObject): { x: number; y: number } {
        if (h.kind === 'spinner') return { x: CENTER.x, y: CENTER.y - SPIN_RADIUS };
        return { x: h.x, y: h.y };
    }

    private endPosition(h: PlayableHitObject): { x: number; y: number } {
        if (h.kind === 'slider') return { x: h.endX, y: h.endY };
        if (h.kind === 'spinner') return this.spinnerPos(h, h.endTime);
        return { x: h.x, y: h.y };
    }

    private spinnerPos(h: PlayableHitObject, time: number): { x: number; y: number } {
        const a = -Math.PI / 2 + (time - h.time) * SPIN_SPEED;
        return { x: CENTER.x + Math.cos(a) * SPIN_RADIUS, y: CENTER.y + Math.sin(a) * SPIN_RADIUS };
    }

    /** Index of the last object starting at or before `time` (binary search). */
    private indexAt(time: number): number {
        let lo = 0, hi = this.objects.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.objects[mid].time <= time) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return ans;
    }

    cursorAt(time: number): { x: number; y: number; held: boolean } {
        const objs = this.objects;
        if (objs.length === 0) return { x: CENTER.x, y: CENTER.y, held: false };
        const i = this.indexAt(time);
        if (i >= 0) {
            const h = objs[i];
            const holdEnd = Math.max(h.endTime, h.time + 60);
            if (time <= holdEnd) {
                if (h.kind === 'slider') return { ...sliderBallPosition(h, time), held: true };
                if (h.kind === 'spinner') return { ...this.spinnerPos(h, time), held: true };
                return { x: h.x, y: h.y, held: true };
            }
        }
        // Moving toward the next object.
        const next = objs[i + 1];
        const from = i >= 0 ? this.endPosition(objs[i]) : CENTER;
        if (!next) return { x: from.x, y: from.y, held: false };
        const to = this.startPosition(next);
        const leaveAt = i >= 0 ? Math.max(objs[i].endTime, objs[i].time + 60) : next.time - this.preempt;
        const span = next.time - leaveAt;
        if (span <= 0) return { x: to.x, y: to.y, held: false };
        let t = Math.max(0, Math.min(1, (time - leaveAt) / span));
        // Ease like the original auto: quick start, gentle arrival.
        t = 0.5 - Math.sin((Math.pow(1 - t, 1.5) - 0.5) * Math.PI) / 2;
        return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, held: false };
    }
}
