import { Signal } from '../../core/Signal';
import { difficultyRange } from '../../core/math';
import type { BreakPeriod, PlayableHitObject } from '../../beatmap/types';
import { BONUS_SPINS_GAP, DEFAULT_MECHANICS, lazerSpinnerSpins, type GameplayMechanics } from './mechanics';
import type { HitResult, NestedKind } from './ScoreProcessor';

export interface HealthOptions {
    /** HP drain rate, after mods. */
    hpDifficulty: number;
    breaks: readonly BreakPeriod[];
    /** Drain only between the first object and the last object's end. */
    drainStart: number;
    drainEnd: number;
    /** Extra lives (Easy mod gives 2 refills, like stable and lazer). */
    lives?: number;
    /** Never fail (No Fail / Autoplay). */
    noFail?: boolean;
    /** Which client's health rules to use (default lazer). */
    mechanics?: GameplayMechanics;
    /**
     * The playable objects. Both clients derive the drain rate from a
     * simulated perfect play of the map; lazer also needs combo info for
     * its end-of-combo bonus and object times for its no-drain periods.
     */
    objects?: readonly PlayableHitObject[];
    /** OD after mods (stable's drain simulation counts spinner ticks with it). */
    od?: number;
    /** Drain per ms, overriding the simulated rate (tests). Without objects it defaults to 0. */
    drainRate?: number;
}

/** lazer's OsuHealthProcessor.ComboResult (higher is worse). */
const COMBO_PERFECT = 0;
const COMBO_GOOD = 1;
const COMBO_NONE = 2;

interface Period { start: number; end: number }

/**
 * Health in the two clients' rules (lazer's ports are the reference for both):
 *
 * lazer (OsuHealthProcessor : DrainingHealthProcessor)
 *  - drain rate: binary search so a perfect play bottoms out at
 *    DifficultyRange(HP, 99%, 90%, 40%) health;
 *  - circle / slider head / spinner: +0.03 / +0.011 / +0.002, miss
 *    −DifficultyRange(HP, 0.03, 0.125, 0.2); tick +0.015, repeat and tail
 *    +0.02, tick/repeat miss −DifficultyRange(HP, 0.02, 0.075, 0.14), a
 *    missed tail costs nothing; spins +0.0085 (bonus spins +0.01);
 *  - the last object of a combo adds +0.07 / +0.05 / +0.03 (all perfect /
 *    no 50s or misses / otherwise) when hit;
 *  - you fail only when a judgement leaves health at zero (drain alone
 *    can't fail you).
 *
 * stable (OsuLegacyHealthProcessor : LegacyDrainingHealthProcessor)
 *  - drain rate: stable's iterative search (start at 0.00025/ms, shrink
 *    until a perfect play never drops below DifficultyRange(HP, 97.5%,
 *    80%, 30%), ends above 99/90/40% and recovers enough); gains are scaled
 *    by the HP multiplier that search settles on;
 *  - circle / slider / spinner: +0.03 / +0.011 / +0.002, miss as lazer;
 *    slider head, repeat and end +0.02, tick +0.015, and a missed head,
 *    tick, repeat *or end* costs DifficultyRange(HP, 0.02, 0.075, 0.14);
 *  - no combo bonus; reaching zero health fails at once, drain included.
 */
export class HealthProcessor {
    hp = 1;
    failed = false;
    livesLeft: number;
    readonly failedSignal = new Signal<[]>();
    readonly lifeUsed = new Signal<[]>();
    readonly mechanics: GameplayMechanics;
    /** Health drained per ms of play time. */
    readonly drainRate: number;
    /** stable's HpMultiplierNormal (scales every gain); 1 in lazer. */
    readonly hpMultiplier: number;
    private readonly missPenalty: number;
    private readonly tickPenalty: number;
    private readonly noDrain: Period[];
    private readonly drainStart: number;
    private readonly drainEnd: number;
    /** lazer: per object, starts a combo / ends a combo (OsuHitObject.NewCombo / LastInCombo). */
    private readonly newCombo: boolean[] = [];
    private readonly lastInCombo: boolean[] = [];
    private comboResult = COMBO_PERFECT;

    constructor(private readonly o: HealthOptions) {
        const hp = o.hpDifficulty;
        this.mechanics = o.mechanics ?? DEFAULT_MECHANICS;
        this.missPenalty = difficultyRange(hp, 0.03, 0.125, 0.2);
        this.tickPenalty = difficultyRange(hp, 0.02, 0.075, 0.14);
        this.livesLeft = o.lives ?? 0;
        const objects = o.objects ?? [];
        this.drainStart = o.drainStart;
        this.drainEnd = objects.length > 0 ? objects[objects.length - 1].endTime : o.drainEnd;
        this.noDrain = noDrainPeriods(o.breaks, objects);

        for (let i = 0; i < objects.length; i++) {
            const h = objects[i];
            const next = objects[i + 1];
            // lazer's UpdateComboInformation: spinners never start a combo,
            // and an object starting one marks its predecessor last in combo.
            this.newCombo.push(h.kind !== 'spinner' && h.newCombo);
            this.lastInCombo.push(!!next && next.kind !== 'spinner' && (next.newCombo || h.kind === 'spinner'));
        }

        if (this.mechanics === 'stable') {
            const r = objects.length > 0
                ? computeLegacyDrain(objects, o.breaks, o.drainStart, hp, o.od ?? 5)
                : { drop: 0, multiplier: 1 };
            this.drainRate = o.drainRate ?? r.drop;
            this.hpMultiplier = r.multiplier;
        } else {
            this.drainRate = o.drainRate ?? (objects.length > 0 ? computeLazerDrain(objects, o.breaks, o.drainStart, hp) : 0);
            this.hpMultiplier = 1;
        }
    }

    isDraining(time: number): boolean {
        if (time < this.drainStart || time > this.drainEnd) return false;
        return !this.noDrain.some(p => time >= p.start && time <= p.end);
    }

    /** Apply passive drain for the interval (time − dt, time] (lazer's DrainingHealthProcessor.Update). */
    drain(time: number, dt: number): void {
        if (this.failed || dt <= 0) return;
        if (this.noDrain.some(p => time >= p.start && time <= p.end)) return;
        const last = Math.min(this.drainEnd, Math.max(this.drainStart, time - dt));
        const current = Math.min(this.drainEnd, Math.max(this.drainStart, time));
        if (current <= last) return;
        // lazer only fails on a judgement; stable fails the moment health runs out.
        this.change(-this.drainRate * (current - last), this.mechanics === 'stable');
    }

    /**
     * A top-level judgement: a circle, a slider's final judgement or a
     * spinner. `index` is the object's index (for lazer's combo bonus).
     */
    applyMain(result: HitResult, index = -1): void {
        if (this.mechanics === 'stable') {
            this.change(this.mainIncrease(result));
            return;
        }
        // lazer: a slider's own judgement is IgnoreHit / IgnoreMiss (no health
        // of its own, can't fail you when hit), but it carries the combo bonus.
        const isSlider = index >= 0 && this.o.objects?.[index]?.kind === 'slider';
        if (index >= 0 && this.newCombo[index]) this.comboResult = COMBO_PERFECT;
        if (!isSlider) this.trackCombo(result);
        let delta = isSlider ? 0 : this.mainIncrease(result);
        if (index >= 0 && this.lastInCombo[index] && result !== 'miss') {
            delta += this.comboResult === COMBO_PERFECT ? 0.07 : this.comboResult === COMBO_GOOD ? 0.05 : 0.03;
        }
        this.change(delta, !(isSlider && result !== 'miss'));
    }

    /**
     * A slider part. For the head, `headResult` is its timing judgement:
     * lazer judges the head like a hit circle; stable like a tick.
     */
    applyNested(kind: NestedKind, hit: boolean, headResult?: HitResult): void {
        if (this.mechanics === 'lazer') {
            if (kind === 'head') {
                const r: HitResult = hit ? headResult ?? 'great' : 'miss';
                this.trackCombo(r);
                this.change(this.mainIncrease(r));
                return;
            }
            if (!hit) {
                // Tick/repeat: LargeTickMiss. Tail: IgnoreMiss (no health), but it spoils the combo bonus.
                this.comboResult = Math.max(this.comboResult, COMBO_GOOD);
                this.change(kind === 'tail' ? 0 : -this.tickPenalty);
                return;
            }
            this.change(kind === 'tick' ? 0.015 : 0.02);
            return;
        }
        if (hit) this.change((kind === 'tick' ? 0.015 : 0.02) * this.hpMultiplier);
        else this.change(-this.tickPenalty);
    }

    /** A spinner spin (SmallBonus) or bonus spin (LargeBonus). Bonus results never fail you. */
    applySpin(bonus = false): void {
        this.change((bonus ? 0.01 : 0.0085) * this.hpMultiplier, false);
    }

    /** Force a failure (Sudden Death / Perfect). */
    fail(): void {
        if (this.failed || this.o.noFail) return;
        this.failed = true;
        this.hp = 0;
        this.failedSignal.emit();
    }

    private mainIncrease(result: HitResult): number {
        switch (result) {
            case 'great': return 0.03 * this.hpMultiplier;
            case 'ok': return 0.011 * this.hpMultiplier;
            case 'meh': return 0.002 * this.hpMultiplier;
            case 'miss': return -this.missPenalty;
        }
    }

    /** lazer's setComboResult for a judgement's type. */
    private trackCombo(result: HitResult): void {
        if (result === 'ok') this.comboResult = Math.max(this.comboResult, COMBO_GOOD);
        else if (result === 'meh' || result === 'miss') this.comboResult = COMBO_NONE;
    }

    private change(delta: number, canFail = true): void {
        if (this.failed) return;
        this.hp = Math.max(0, Math.min(1, this.hp + delta));
        if (!canFail || this.hp > 0 || this.o.noFail) return;
        if (this.livesLeft > 0) {
            // ModEasyWithExtraLives: refill instead of failing.
            this.livesLeft--;
            this.hp = 1;
            this.lifeUsed.emit();
            return;
        }
        this.failed = true;
        this.failedSignal.emit();
    }
}

/**
 * lazer's no-drain periods: each break, widened back to the end of the
 * last object before it and on to the start of the first object after it.
 */
function noDrainPeriods(breaks: readonly BreakPeriod[], objects: readonly PlayableHitObject[]): Period[] {
    if (objects.length === 0) return breaks.map(b => ({ start: b.startTime, end: b.endTime }));
    return breaks.map(b => {
        let start = -Infinity;
        for (const h of objects) if (h.endTime <= b.startTime) start = h.endTime;
        let end = Infinity;
        for (const h of objects) {
            if (h.time >= b.endTime) {
                end = h.time;
                break;
            }
        }
        return { start, end };
    });
}

/**
 * lazer DrainingHealthProcessor.ComputeDrainRate over a simulated perfect
 * play (OsuHealthProcessor's increases; bonus results are left out).
 */
export function computeLazerDrain(objects: readonly PlayableHitObject[], breaks: readonly BreakPeriod[], drainStart: number, hp: number): number {
    const increases: { time: number; amount: number }[] = [];
    for (const h of objects) {
        if (h.kind === 'slider') {
            for (const ev of h.events) increases.push({ time: ev.time, amount: ev.kind === 'head' ? 0.03 : ev.kind === 'tick' ? 0.015 : 0.02 });
            // The slider itself: IgnoreHit, recorded at its end with no health.
            increases.push({ time: h.endTime, amount: 0 });
        } else {
            increases.push({ time: h.endTime, amount: 0.03 });
        }
    }
    if (increases.length <= 1) return 0;
    const target = difficultyRange(hp, 0.99, 0.9, 0.4);
    let adjustment = 1;
    let result = 1;
    // lazer's loop ends when its int adjustment overflows (31 doublings).
    for (let iteration = 0; iteration < 31; iteration++) {
        let health = 1;
        let lowest = 1;
        let currentBreak = 0;
        for (let i = 0; i < increases.length; i++) {
            const time = increases[i].time;
            let lastTime = i > 0 ? increases[i - 1].time : drainStart;
            while (currentBreak < breaks.length && breaks[currentBreak].endTime <= time) {
                // No drain across a break between two objects.
                lastTime = time;
                currentBreak++;
            }
            health -= (time - lastTime) * result;
            lowest = Math.min(lowest, health);
            health = Math.min(1, health + increases[i].amount);
            if (lowest < 0) break;
        }
        if (Math.abs(lowest - target) <= 0.01) break;
        adjustment *= 2;
        result += (1 / adjustment) * Math.sign(lowest - target);
    }
    return result;
}

/**
 * lazer LegacyDrainingHealthProcessor.ComputeDrainRate with
 * OsuLegacyHealthProcessor's increases: stable's drain search. Returns the
 * drain per ms and the HP multiplier applied to every gain.
 */
export function computeLegacyDrain(
    objects: readonly PlayableHitObject[],
    breaks: readonly BreakPeriod[],
    drainStart: number,
    hp: number,
    od: number,
): { drop: number; multiplier: number } {
    const lowestHpEver = difficultyRange(hp, 0.975, 0.8, 0.3);
    const lowestHpEnd = difficultyRange(hp, 0.99, 0.9, 0.4);
    const hpRecoveryAvailable = difficultyRange(hp, 0.04, 0.02, 0);
    // Nested increases per object, before the multiplier: slider parts, and
    // a spinner's non-bonus spins (lazer's SpinsRequired + the bonus gap).
    const nested = objects.map(h => {
        if (h.kind === 'slider') return h.events.map(ev => (ev.kind === 'tick' ? 0.015 : 0.02));
        if (h.kind === 'spinner') {
            const n = lazerSpinnerSpins(od, h.endTime - h.time).spinsRequired + BONUS_SPINS_GAP;
            return new Array<number>(n).fill(0.0085);
        }
        return [];
    });

    let testDrop = 0.00025;
    let multiplier = 1;
    for (let guard = 0; guard < 5000; guard++) {
        let currentHp = 1;
        let currentHpUncapped = 1;
        let lastTime = drainStart;
        let currentBreak = 0;
        let fail = false;
        const reduce = (amount: number): void => {
            currentHpUncapped = Math.max(0, currentHpUncapped - amount);
            currentHp = Math.max(0, currentHp - amount);
        };
        const increase = (amount: number): void => {
            const a = amount * multiplier;
            currentHpUncapped += a;
            currentHp = Math.max(0, Math.min(1, currentHp + a));
        };
        for (let i = 0; i < objects.length; i++) {
            const h = objects[i];
            while (currentBreak < breaks.length && breaks[currentBreak].endTime <= h.time) {
                lastTime = h.time;
                currentBreak++;
            }
            reduce(testDrop * (h.time - lastTime));
            lastTime = h.endTime;
            if (currentHp <= lowestHpEver) {
                fail = true;
                testDrop *= 0.96;
                break;
            }
            const hpReduction = testDrop * (h.endTime - h.time);
            const hpOverkill = Math.max(0, hpReduction - currentHp);
            reduce(hpReduction);
            for (const a of nested[i]) increase(a);
            if (hpOverkill > 0 && currentHp - hpOverkill <= lowestHpEver) {
                fail = true;
                testDrop *= 0.96;
                break;
            }
            increase(0.03);
        }
        if (!fail && currentHp < lowestHpEnd) {
            fail = true;
            testDrop *= 0.94;
            multiplier *= 1.01;
        }
        const recovery = (currentHpUncapped - 1) / Math.max(1, objects.length);
        if (!fail && recovery < hpRecoveryAvailable) {
            fail = true;
            testDrop *= 0.96;
            multiplier *= 1.01;
        }
        if (!fail && !Number.isFinite(multiplier)) return { drop: 0, multiplier: 1 };
        if (!fail) return { drop: testDrop, multiplier };
    }
    return { drop: testDrop, multiplier };
}
