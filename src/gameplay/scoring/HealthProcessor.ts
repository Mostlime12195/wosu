import { Signal } from '../../core/Signal';
import { difficultyRange } from '../../core/math';
import type { BreakPeriod } from '../../beatmap/types';
import type { HitResult, NestedKind } from './ScoreProcessor';

export interface HealthOptions {
    hpDifficulty: number;
    breaks: readonly BreakPeriod[];
    /** Drain only between the first object and the last object's end. */
    drainStart: number;
    drainEnd: number;
    /** Extra lives (Easy mod gives 2 refills, like stable). */
    lives?: number;
    /** Never fail (No Fail / Autoplay). */
    noFail?: boolean;
}

/**
 * Health bar in the spirit of stable's HP: constant drain during play
 * time (not breaks), gains from hits scaled like stable's HP_HIT_* values
 * (300 → +6/200 …) and miss penalties interpolated from HP difficulty.
 */
export class HealthProcessor {
    hp = 1;
    failed = false;
    livesLeft: number;
    readonly failedSignal = new Signal<[]>();
    readonly lifeUsed = new Signal<[]>();
    private readonly drainPerMs: number;
    private readonly missPenalty: number;
    private readonly tickPenalty: number;

    constructor(private readonly o: HealthOptions) {
        const hp = o.hpDifficulty;
        this.drainPerMs = difficultyRange(hp, 0.006, 0.025, 0.05) / 1000;
        this.missPenalty = difficultyRange(hp, 0.03, 0.125, 0.2);
        this.tickPenalty = difficultyRange(hp, 0.01, 0.03, 0.05);
        this.livesLeft = o.lives ?? 0;
    }

    isDraining(time: number): boolean {
        if (time < this.o.drainStart || time > this.o.drainEnd) return false;
        for (const b of this.o.breaks) if (time >= b.startTime && time <= b.endTime) return false;
        return true;
    }

    /** Apply passive drain for the interval (time − dt, time]. */
    drain(time: number, dt: number): void {
        if (this.failed || dt <= 0 || !this.isDraining(time)) return;
        this.change(-this.drainPerMs * dt);
    }

    applyMain(result: HitResult): void {
        switch (result) {
            case 'great': this.change(0.03); break;
            case 'ok': this.change(0.011); break;
            case 'meh': this.change(0.002); break;
            case 'miss': this.change(-this.missPenalty); break;
        }
    }

    applyNested(kind: NestedKind, hit: boolean): void {
        if (hit) this.change(kind === 'tick' ? 0.015 : 0.02);
        else if (kind !== 'tail') this.change(-this.tickPenalty);
    }

    applySpin(): void {
        this.change(0.0085);
    }

    /** Force a failure (Sudden Death / Perfect). */
    fail(): void {
        if (this.failed || this.o.noFail) return;
        this.failed = true;
        this.hp = 0;
        this.failedSignal.emit();
    }

    private change(delta: number): void {
        if (this.failed) return;
        this.hp = Math.min(1, this.hp + delta);
        if (this.hp <= 0) {
            if (this.o.noFail) {
                this.hp = 0;
            } else if (this.livesLeft > 0) {
                this.livesLeft--;
                this.hp = 1;
                this.lifeUsed.emit();
            } else {
                this.hp = 0;
                this.failed = true;
                this.failedSignal.emit();
            }
        }
    }
}
