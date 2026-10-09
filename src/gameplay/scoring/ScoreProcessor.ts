import { Signal } from '../../core/Signal';
import type { Grade } from '../../storage/ScoreStore';

/** Main judgements (circles, slider ends, spinners). */
export type HitResult = 'great' | 'ok' | 'meh' | 'miss';
/** Judged parts of a slider (lazer's nested objects). */
export type NestedKind = 'head' | 'tick' | 'repeat' | 'tail';

export const RESULT_VALUE: Record<HitResult, number> = { great: 300, ok: 100, meh: 50, miss: 0 };

export interface ScoreOptions {
    /** Stable "difficulty points" multiplier (see difficultyMultiplier). */
    difficultyMultiplier: number;
    /** Product of the selected mods' score multipliers. */
    modMultiplier: number;
}

/**
 * osu!stable ScoreV1 rules:
 *  - main judgements add value × (1 + max(combo−1, 0) × diff × mods / 25),
 *    using the combo *before* the hit;
 *  - slider head/repeat/tail add 30, ticks 10, each also +1 combo; a
 *    missed head/tick/repeat breaks combo, a missed tail does not;
 *  - spinner spins add 100, bonus spins 1000.
 * Accuracy counts only main judgements.
 */
export class ScoreProcessor {
    score = 0;
    combo = 0;
    maxCombo = 0;
    count300 = 0;
    count100 = 0;
    count50 = 0;
    countMiss = 0;
    sliderTicksHit = 0;
    sliderTicksTotal = 0;
    readonly changed = new Signal<[]>();
    /** Emitted when a combo ≥ 1 breaks, with the combo that was lost. */
    readonly comboBroken = new Signal<[previous: number]>();
    readonly judged = new Signal<[result: HitResult]>();

    constructor(private readonly opts: ScoreOptions) {}

    get judgedCount(): number {
        return this.count300 + this.count100 + this.count50 + this.countMiss;
    }

    get accuracy(): number {
        const n = this.judgedCount;
        if (n === 0) return 1;
        return (300 * this.count300 + 100 * this.count100 + 50 * this.count50) / (300 * n);
    }

    /** Circle / slider final / spinner final judgement. */
    applyMain(result: HitResult, affectsCombo: boolean): void {
        const value = RESULT_VALUE[result];
        const comboBefore = this.combo;
        this.score += value + (value * Math.max(comboBefore - 1, 0) * this.opts.difficultyMultiplier * this.opts.modMultiplier) / 25;
        switch (result) {
            case 'great': this.count300++; break;
            case 'ok': this.count100++; break;
            case 'meh': this.count50++; break;
            case 'miss': this.countMiss++; break;
        }
        if (affectsCombo) {
            if (result === 'miss') this.breakCombo();
            else this.incrementCombo();
        }
        this.judged.emit(result);
        this.changed.emit();
    }

    /** Slider head / tick / repeat / tail. */
    applyNested(kind: NestedKind, hit: boolean): void {
        if (kind === 'tick') {
            this.sliderTicksTotal++;
            if (hit) this.sliderTicksHit++;
        }
        if (hit) {
            this.score += kind === 'tick' ? 10 : 30;
            this.incrementCombo();
        } else if (kind !== 'tail') {
            this.breakCombo();
        }
        this.changed.emit();
    }

    /** One full spinner rotation (bonus once the spinner is cleared). */
    applySpin(bonus: boolean): void {
        this.score += bonus ? 1000 : 100;
        this.changed.emit();
    }

    private incrementCombo(): void {
        this.combo++;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }

    private breakCombo(): void {
        const prev = this.combo;
        this.combo = 0;
        if (prev > 0) this.comboBroken.emit(prev);
    }

    /** osu!stable rank rules (silver ranks with HD/FL). */
    grade(silver: boolean, failed = false): Grade {
        if (failed) return 'F';
        const total = this.judgedCount;
        if (total === 0) return silver ? 'XH' : 'X';
        const r300 = this.count300 / total;
        const r50 = this.count50 / total;
        const noMiss = this.countMiss === 0;
        if (r300 === 1) return silver ? 'XH' : 'X';
        if (r300 > 0.9 && r50 < 0.01 && noMiss) return silver ? 'SH' : 'S';
        if ((r300 > 0.8 && noMiss) || r300 > 0.9) return 'A';
        if ((r300 > 0.7 && noMiss) || r300 > 0.8) return 'B';
        if (r300 > 0.6) return 'C';
        return 'D';
    }
}

/**
 * Stable's "difficulty points" score multiplier:
 * round((HP + CS + OD + clamp(objects / drainSeconds × 8, 0, 16)) / 38 × 5),
 * computed from the beatmap's unmodified values.
 */
export function difficultyMultiplier(
    d: { hp: number; cs: number; od: number },
    objectCount: number,
    drainMs: number,
): number {
    const drainSeconds = Math.max(1, drainMs / 1000);
    const density = Math.min(16, Math.max(0, (objectCount / drainSeconds) * 8));
    return Math.round(((d.hp + d.cs + d.od + density) / 38) * 5);
}

/** Map a slider's fraction of hit parts to its final judgement (stable). */
export function sliderResult(hitParts: number, totalParts: number): HitResult {
    if (totalParts <= 0) return 'great';
    if (hitParts >= totalParts) return 'great';
    if (hitParts * 2 >= totalParts) return 'ok';
    if (hitParts > 0) return 'meh';
    return 'miss';
}

/** Spinner judgement from progress (rotations / required). */
export function spinnerResult(progress: number): HitResult {
    if (progress >= 1) return 'great';
    if (progress >= 0.9) return 'ok';
    if (progress >= 0.75) return 'meh';
    return 'miss';
}

/** Judgement for a click at `error` ms from the object's time. */
export function resultForError(error: number, w300: number, w100: number, w50: number): HitResult | null {
    const e = Math.abs(error);
    if (e <= w300) return 'great';
    if (e <= w100) return 'ok';
    if (e <= w50) return 'meh';
    return null;
}
