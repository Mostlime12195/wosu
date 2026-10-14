import type { PlayableBeatmap, PlayableHitObject, PlayableSlider, SliderEvent } from '../beatmap/types';
import { Signal } from '../core/Signal';
import type { ModSet } from './mods';
import type { HealthProcessor } from './scoring/HealthProcessor';
import { ComboEndTracker, type ComboEndVariant } from './scoring/comboEnd';
import {
    DEFAULT_MECHANICS, MISS_WINDOW, TAIL_LENIENCY, BONUS_SPINS_GAP, MAX_SPIN_RAD_PER_MS,
    lazerSpinnerSpins, spinnerClearRpm, stableHalfSpinAward, stableSpinnerHalfSpins, type GameplayMechanics,
} from './scoring/mechanics';
import {
    resultForError, sliderResult, spinnerResult, type HitResult, type NestedKind, type ScoreProcessor,
} from './scoring/ScoreProcessor';

/** Spun Out's fixed spin speed (stable: 287 RPM). */
const SPUN_OUT_RAD_PER_MS = (287 / 60000) * Math.PI * 2;
/** Follow area while tracking, in circle radii (lazer DrawableSliderBall.FOLLOW_AREA). */
const FOLLOW_RADIUS_SCALE = 2.4;
const TWO_PI = Math.PI * 2;

export interface CircleState {
    kind: 'circle';
    result: HitResult | null;
    judgedAt: number;
    /** Time of the last notelock/early-click shake (−∞ if none). */
    shakeAt: number;
}

export interface SliderState {
    kind: 'slider';
    /** Head judged? null = pending, true = hit, false = missed. */
    headHit: boolean | null;
    /** The head's timing judgement (lazer: the slider's accuracy judgement); null while pending. */
    headResult: HitResult | null;
    headAt: number;
    shakeAt: number;
    tracking: boolean;
    /** Time tracking last changed (for the follow circle animation). */
    trackingChangedAt: number;
    /** Next nested event (index into slider.events) to judge. */
    nextEvent: number;
    /** Result per nested event (null until judged). */
    eventHit: (boolean | null)[];
    partsHit: number;
    /**
     * The slider's own judgement, set at its end: stable's result by the
     * parts hit; lazer's unscored hit (any part hit) or miss.
     */
    result: HitResult | null;
    judgedAt: number;
}

export interface SpinnerState {
    kind: 'spinner';
    /** Accumulated rotation (radians, signed) for the visual. */
    rotation: number;
    /** Rotation counted toward clearing (radians). */
    progress: number;
    /** Rotation needed to clear (radians); 0 = cleared without spinning. */
    required: number;
    lastAngle: number | null;
    /** Full spins counted so far. */
    spinsAwarded: number;
    /** Spins that scored as bonus. */
    bonusSpins: number;
    rpm: number;
    result: HitResult | null;
    judgedAt: number;
}

export type ObjectState = CircleState | SliderState | SpinnerState;

export interface CursorState {
    x: number;
    y: number;
    /** Any gameplay key/button/touch held. */
    held: boolean;
}

export interface HitEventInfo {
    index: number;
    result: HitResult;
    time: number;
    /** Position for the judgement text. */
    x: number;
    y: number;
    /** Hit error in ms for timed hits (circle/slider head), else null. */
    error: number | null;
    /** stable's geki / katu, when this object ends its combo (see comboEnd). */
    variant: ComboEndVariant | null;
}

/** Per-spinner counting state (not shown to drawables). */
interface SpinCounter {
    // lazer (Spinner + SpinnerSpinHistory)
    spinsRequired: number;
    maxBonusSpins: number;
    accumulated: number;
    atLastCompletion: number;
    currentSpinMax: number;
    completed: number;
    // stable
    halfSpinsRequired: number;
    halfSpins: number;
}

type ClickAction = 'hit' | 'shake' | 'ignore';

/**
 * The osu!standard rules, separate from rendering so they can be tested
 * headlessly. The Player feeds it presses (with exact timestamps and
 * positions) and calls `update` every frame with the cursor state; it
 * judges objects, drives the score/health processors and emits events
 * the renderer and sound player react to.
 *
 * `mechanics` picks whose rules apply (see GameplayMechanics):
 *  - note lock: lazer's StartTimeOrderedHitPolicy or stable's
 *    LegacyHitPolicy (+ OsuModClassic's slider-head input blocking);
 *  - sliders: lazer waits for the head before judging ticks, credits the
 *    passed ticks on a late head hit, and hits the tail any time in its
 *    last 36 ms; stable judges every tick at its time and the legacy last
 *    tick once;
 *  - slider judgement: lazer judges the head like a hit circle (its timing
 *    result is the slider's accuracy judgement, emitted as the slider's
 *    `objectJudged` when the head is judged; the slider's end is unscored),
 *    stable judges the head as a tick and the whole slider at its end by
 *    the parts hit (OsuModClassic's "No slider head accuracy");
 *  - spinners: lazer's whole spins of net rotation or stable's half spins
 *    of absolute rotation, both at wosu!'s spinnerClearRpm and under the
 *    477 RPM cap.
 * Early clicks inside the 400 ms miss window miss in both, as in the clients.
 */
export class GameplayRules {
    readonly states: ObjectState[];
    readonly objectJudged = new Signal<[HitEventInfo]>();
    readonly nestedJudged = new Signal<[index: number, event: SliderEvent, hit: boolean]>();
    readonly headHit = new Signal<[index: number, time: number, error: number]>();
    readonly shaken = new Signal<[index: number]>();
    readonly spun = new Signal<[index: number, bonus: boolean]>();
    readonly hitErrors: number[] = [];

    private readonly w300: number;
    private readonly w100: number;
    private readonly w50: number;
    private readonly radius: number;
    private readonly preempt: number;
    /** stable: clicks must land within this of the object (LegacyHitPolicy hittableRange). */
    private readonly hittableRange: number;
    private readonly spinCounters: (SpinCounter | null)[];
    private readonly comboEnds: ComboEndTracker;
    /** First object that may still need judging (all before are done). */
    private firstPending = 0;
    autoSpin = false;
    /** Rad/ms when spinning automatically: Autoplay at the speed cap, Spun Out at its fixed 287 RPM. */
    private autoSpinRate = SPUN_OUT_RAD_PER_MS;
    relax = false;
    private readonly suddenDeath: boolean;
    private readonly perfect: boolean;
    private lastTime = -Infinity;

    constructor(
        readonly beatmap: PlayableBeatmap,
        mods: ModSet,
        readonly score: ScoreProcessor,
        readonly health: HealthProcessor,
        readonly mechanics: GameplayMechanics = DEFAULT_MECHANICS,
    ) {
        const d = beatmap.difficulty;
        this.w300 = d.window300;
        this.w100 = d.window100;
        this.w50 = d.window50;
        this.radius = d.circleRadius;
        this.preempt = d.preempt;
        // OsuModClassic: autopilot narrows the classic hittable range by 200 ms.
        this.hittableRange = MISS_WINDOW - (mods.has('AP') ? 200 : 0);
        this.suddenDeath = mods.has('SD');
        this.perfect = mods.has('PF');
        this.relax = mods.has('RX');
        this.autoSpin = mods.has('SO') || mods.has('AT');
        // Spun Out must still clear past OD 10 (Difficulty Adjust's extended limits ask more than 287 RPM).
        const clearRate = (spinnerClearRpm(d.od) / 60000) * TWO_PI * 1.01;
        this.autoSpinRate = mods.has('AT') ? MAX_SPIN_RAD_PER_MS : Math.max(SPUN_OUT_RAD_PER_MS, clearRate);
        this.spinCounters = beatmap.hitObjects.map(h => (h.kind === 'spinner' ? this.spinCounter(h, d.od) : null));
        this.states = beatmap.hitObjects.map((h, i) => this.initialState(h, i));
        this.comboEnds = ComboEndTracker.forObjects(beatmap.hitObjects);
        score.comboBroken.add(() => {
            if (this.suddenDeath || this.perfect) health.fail();
        });
    }

    private spinCounter(h: PlayableHitObject, od: number): SpinCounter {
        const duration = h.endTime - h.time;
        const rpm = spinnerClearRpm(od);
        const lazer = lazerSpinnerSpins(od, duration, rpm);
        return {
            spinsRequired: lazer.spinsRequired,
            maxBonusSpins: lazer.maxBonusSpins,
            accumulated: 0,
            atLastCompletion: 0,
            currentSpinMax: 0,
            completed: 0,
            halfSpinsRequired: stableSpinnerHalfSpins(od, duration, rpm),
            halfSpins: 0,
        };
    }

    private initialState(h: PlayableHitObject, i: number): ObjectState {
        if (h.kind === 'circle') return { kind: 'circle', result: null, judgedAt: 0, shakeAt: -Infinity };
        if (h.kind === 'slider') {
            return {
                kind: 'slider', headHit: null, headResult: null, headAt: 0, shakeAt: -Infinity, tracking: false, trackingChangedAt: -Infinity,
                nextEvent: 1, eventHit: h.events.map(() => null), partsHit: 0, result: null, judgedAt: 0,
            };
        }
        const c = this.spinCounters[i]!;
        const required = this.mechanics === 'lazer' ? c.spinsRequired * TWO_PI : c.halfSpinsRequired * Math.PI;
        return {
            kind: 'spinner', rotation: 0, progress: 0, required,
            lastAngle: null, spinsAwarded: 0, bonusSpins: 0, rpm: 0, result: null, judgedAt: 0,
        };
    }

    get windows(): { w300: number; w100: number; w50: number } {
        return { w300: this.w300, w100: this.w100, w50: this.w50 };
    }

    /** Everything judged? */
    get finished(): boolean {
        return this.firstPending >= this.states.length;
    }

    // -----------------------------------------------------------------------
    // Clicks and note lock
    // -----------------------------------------------------------------------

    /**
     * A key/button/touch went down at `time` with the cursor at (x, y). The
     * earliest visible, unjudged circle or slider head under the cursor
     * takes the click; the hit policy decides whether it hits or shakes.
     */
    press(time: number, x: number, y: number): void {
        // Judge whatever ended before this click first (a frame may not have reached it yet).
        this.settle(time);
        const objs = this.beatmap.hitObjects;
        for (let i = this.firstPending; i < objs.length; i++) {
            const h = objs[i];
            if (h.time - this.preempt > time) break;
            if (h.kind === 'spinner') continue;
            const s = this.states[i];
            if (s.kind === 'slider' && s.headHit !== null) {
                // OsuModClassic: a judged slider head keeps taking clicks over
                // it until the slider is fully judged (stable behaviour).
                if (this.mechanics === 'stable' && s.result === null && this.inside(h, x, y)) return;
                continue;
            }
            if (!this.headPending(i)) continue;
            // Already past its window: a miss waiting to be swept.
            if (time > h.time + this.w50) continue;
            if (!this.inside(h, x, y)) continue;
            this.receivePress(i, time, x, y);
            return;
        }
    }

    private receivePress(i: number, time: number, x: number, y: number): void {
        const h = this.beatmap.hitObjects[i];
        const error = time - h.time;
        const result = this.resultFor(error);
        const action = this.mechanics === 'lazer' ? this.lazerHittable(i, time, result) : this.stableHittable(i, time, result);
        if (action === 'shake') this.shake(i, time);
        if (result === null || action !== 'hit') return;
        this.judgeHead(i, time, error, result, x, y);
        // StartTimeOrderedHitPolicy.HandleHit: every earlier circle/head still pending misses.
        if (this.mechanics === 'lazer') this.missEarlierHeads(i, time);
    }

    /** Timing judgement for a click, with osu!'s 400 ms miss window for early clicks. */
    private resultFor(error: number): HitResult | null {
        const r = resultForError(error, this.w300, this.w100, this.w50);
        if (r !== null) return r;
        return Math.abs(error) <= MISS_WINDOW ? 'miss' : null;
    }

    /**
     * lazer's StartTimeOrderedHitPolicy: the latest circle/slider head that
     * starts before this one blocks it only until that object's start time.
     */
    private lazerHittable(i: number, time: number, result: HitResult | null): ClickAction {
        const objs = this.beatmap.hitObjects;
        const h = objs[i];
        for (let j = i - 1; j >= 0; j--) {
            const b = objs[j];
            if (b.kind === 'spinner' || b.time >= h.time) continue;
            if (this.headPending(j) && time < b.time) return 'shake';
            break;
        }
        return result === null ? 'shake' : 'hit';
    }

    /**
     * stable's note lock (lazer's LegacyHitPolicy): any earlier object not
     * fully judged that ends (+3 ms) before this one starts blocks it, and
     * a click under a pending stacked object does nothing.
     */
    private stableHittable(i: number, time: number, result: HitResult | null): ClickAction {
        const objs = this.beatmap.hitObjects;
        const h = objs[i];
        if (i > 0 && objs[i - 1].stackHeight > 0 && this.states[i - 1].result === null) return 'ignore';
        if (result === null) return 'shake';
        for (let j = this.firstPending; j < i; j++) {
            if (this.states[j].result !== null) continue;
            if (objs[j].endTime + 3 < h.time) return 'shake';
        }
        return Math.abs(h.time - time) < this.hittableRange ? 'hit' : 'shake';
    }

    private missEarlierHeads(i: number, time: number): void {
        const objs = this.beatmap.hitObjects;
        for (let j = this.firstPending; j < i; j++) {
            const b = objs[j];
            if (b.kind === 'spinner' || b.time >= objs[i].time || !this.headPending(j)) continue;
            if (b.kind === 'circle') this.applyMain(j, 'miss', time, b.x, b.y, null, true);
            else this.missHead(j, time);
        }
    }

    private headPending(i: number): boolean {
        const s = this.states[i];
        if (s.kind === 'circle') return s.result === null;
        if (s.kind === 'slider') return s.headHit === null;
        return false;
    }

    private inside(h: PlayableHitObject, x: number, y: number): boolean {
        const dx = x - h.x, dy = y - h.y;
        return dx * dx + dy * dy <= this.radius * this.radius;
    }

    private shake(i: number, time: number): void {
        const s = this.states[i];
        if (s.kind !== 'spinner') s.shakeAt = time;
        this.shaken.emit(i);
    }

    private judgeHead(i: number, time: number, error: number, result: HitResult, x: number, y: number): void {
        const h = this.beatmap.hitObjects[i];
        const s = this.states[i];
        if (result === 'miss') {
            // An early click inside the miss window.
            if (s.kind === 'circle') this.applyMain(i, 'miss', time, h.x, h.y, null, true);
            else this.missHead(i, time);
            return;
        }
        this.hitErrors.push(error);
        this.headHit.emit(i, time, error);
        if (s.kind === 'circle') {
            this.applyMain(i, result, time, h.x, h.y, error, true);
        } else if (s.kind === 'slider') {
            const slider = h as PlayableSlider;
            s.headHit = true;
            s.headResult = result;
            s.headAt = time;
            s.eventHit[0] = true;
            s.partsHit++;
            if (this.mechanics === 'lazer') this.applyLazerHead(i, result, time, error);
            else {
                this.score.applyNested('head', true);
                this.health.applyNested('head', true, result);
            }
            this.nestedJudged.emit(i, slider.events[0], true);
            if (this.mechanics === 'lazer') this.postProcessHead(i, slider, s, time, x, y);
        }
    }

    private missHead(i: number, time: number): void {
        const s = this.states[i];
        if (s.kind !== 'slider' || s.headHit !== null) return;
        s.headHit = false;
        s.headResult = 'miss';
        s.headAt = time;
        s.eventHit[0] = false;
        if (this.mechanics === 'lazer') this.applyLazerHead(i, 'miss', time, null);
        else {
            this.score.applyNested('head', false);
            this.health.applyNested('head', false);
        }
        this.nestedJudged.emit(i, (this.beatmap.hitObjects[i] as PlayableSlider).events[0], false);
    }

    /**
     * lazer's non-classic slider head (SliderHeadCircle without
     * ClassicSliderBehaviour): a hit circle judgement by timing, which is
     * the slider's accuracy judgement (counts, combo, score value, Perfect)
     * and is shown at the head. The slider itself is OsuIgnoreJudgement.
     */
    private applyLazerHead(i: number, result: HitResult, time: number, error: number | null): void {
        const h = this.beatmap.hitObjects[i];
        const variant = this.comboEnds.apply(i, result);
        this.score.applyMain(result, true, variant);
        this.health.applyNested('head', result !== 'miss', result);
        if (this.perfect && result !== 'great') this.health.fail();
        this.objectJudged.emit({ index: i, result, time, x: h.x, y: h.y, error, variant });
    }

    /**
     * lazer SliderInputManager.PostProcessHeadJudgement: after a late head
     * hit, the ticks already passed are all hit if the cursor is within the
     * follow area of every one of them, otherwise all missed.
     */
    private postProcessHead(i: number, h: PlayableSlider, s: SliderState, time: number, x: number, y: number): void {
        const far = this.radius * FOLLOW_RADIUS_SCALE;
        const ball = sliderBallPosition(h, time);
        if (dist2(ball.x - x, ball.y - y) > far * far) return;
        let allInRange = true;
        for (let k = s.nextEvent; k < h.events.length; k++) {
            const ev = h.events[k];
            if (ev.time > time) break;
            const p = sliderBallPosition(h, ev.time);
            if (dist2(p.x - x, p.y - y) > far * far) {
                allInRange = false;
                break;
            }
        }
        while (s.nextEvent < h.events.length && h.events[s.nextEvent].time <= time) this.judgeNextEvent(i, h, s, allInRange);
        this.setTracking(s, allInRange || dist2(ball.x - x, ball.y - y) <= this.radius * this.radius, time);
    }

    private applyMain(i: number, result: HitResult, time: number, x: number, y: number, error: number | null, affectsCombo: boolean): void {
        const s = this.states[i];
        s.result = result;
        s.judgedAt = time;
        const variant = this.comboEnds.apply(i, result);
        this.score.applyMain(result, affectsCombo, variant);
        this.health.applyMain(result, i);
        if (this.perfect && result !== 'great') this.health.fail();
        this.objectJudged.emit({ index: i, result, time, x, y, error, variant });
    }

    // -----------------------------------------------------------------------
    // Per-frame input and passive judgement
    // -----------------------------------------------------------------------

    /** Advance to `time` with the cursor state: drain, tracking, spinning, then passive judgement. */
    update(time: number, cursor: CursorState): void {
        const dt = this.lastTime === -Infinity ? 0 : Math.max(0, time - this.lastTime);
        this.lastTime = time;
        this.health.drain(time, dt);
        const objs = this.beatmap.hitObjects;
        for (let i = this.firstPending; i < objs.length; i++) {
            const h = objs[i];
            if (h.time > time) break;
            const s = this.states[i];
            if (s.result !== null) continue;
            if (s.kind === 'circle') this.relaxCircle(i, h, time, cursor);
            else if (s.kind === 'slider') this.inputSlider(i, h as PlayableSlider, s, time, cursor);
            else this.inputSpinner(i, h, s, time, cursor, dt);
        }
        this.settle(time);
    }

    private relaxCircle(i: number, h: PlayableHitObject, time: number, cursor: CursorState): void {
        if (this.relax && this.inside(h, cursor.x, cursor.y) && i === this.earliestPendingHead() && time <= h.time + this.w50) {
            this.judgeHead(i, time, time - h.time, resultForError(time - h.time, this.w300, this.w100, this.w50) ?? 'meh', cursor.x, cursor.y);
        }
    }

    private earliestPendingHead(): number {
        for (let i = this.firstPending; i < this.states.length; i++) {
            const s = this.states[i];
            if (s.kind !== 'spinner' && this.headPending(i)) return i;
        }
        return -1;
    }

    private inputSlider(i: number, h: PlayableSlider, s: SliderState, time: number, cursor: CursorState): void {
        if (s.headHit === null && this.relax && time <= h.time + this.w50 && this.inside(h, cursor.x, cursor.y) && i === this.earliestPendingHead()) {
            this.judgeHead(i, time, time - h.time, resultForError(time - h.time, this.w300, this.w100, this.w50) ?? 'meh', cursor.x, cursor.y);
        }
        // Tracking during the slider's active time (the follow area grows
        // to 2.4 radii once tracking). Past the end the last state stays, so
        // a frame landing late judges the tail with the tracking at the end.
        if (time <= h.endTime) {
            const p = sliderBallPosition(h, time);
            const r = this.radius * (s.tracking ? FOLLOW_RADIUS_SCALE : 1);
            const tracking = (cursor.held || this.relax) && dist2(cursor.x - p.x, cursor.y - p.y) <= r * r;
            this.setTracking(s, tracking, time);
        }
    }

    private setTracking(s: SliderState, tracking: boolean, time: number): void {
        if (tracking === s.tracking) return;
        s.tracking = tracking;
        s.trackingChangedAt = time;
    }

    private inputSpinner(i: number, h: PlayableHitObject, s: SpinnerState, time: number, cursor: CursorState, dt: number): void {
        if (time >= h.endTime) return;
        const stable = this.mechanics === 'stable';
        let delta = 0;
        if (this.autoSpin) {
            delta = this.autoSpinRate * dt;
            s.lastAngle = null;
        } else if (cursor.held || this.relax) {
            const angle = Math.atan2(cursor.y - h.y, cursor.x - h.x);
            if (s.lastAngle !== null) {
                delta = angle - s.lastAngle;
                if (delta > Math.PI) delta -= TWO_PI;
                if (delta < -Math.PI) delta += TWO_PI;
                // stable's ~477 RPM cap, in both mechanics (see MAX_SPIN_RAD_PER_MS).
                const cap = MAX_SPIN_RAD_PER_MS * Math.max(dt, 1);
                delta = Math.max(-cap, Math.min(cap, delta));
            }
            s.lastAngle = angle;
        } else {
            s.lastAngle = null;
        }
        s.rotation += delta;
        // Smoothed RPM for the counter.
        const instRpm = dt > 0 ? (Math.abs(delta) / dt) * (60000 / TWO_PI) : 0;
        s.rpm += (instRpm - s.rpm) * Math.min(1, dt / 200);
        if (delta === 0) return;
        const c = this.spinCounters[i]!;
        if (stable) this.spinStable(i, s, c, delta);
        else this.spinLazer(i, s, c, delta);
    }

    /** stable: absolute rotation, scored per half spin (OsuLegacyScoreSimulator). */
    private spinStable(i: number, s: SpinnerState, c: SpinCounter, delta: number): void {
        s.progress += Math.abs(delta);
        const halfSpins = Math.floor(s.progress / Math.PI);
        while (c.halfSpins < halfSpins) {
            c.halfSpins++;
            const award = stableHalfSpinAward(c.halfSpins, c.halfSpinsRequired);
            if (award === null) continue;
            const bonus = award === 'bonus';
            if (bonus) s.bonusSpins++;
            this.score.applySpin(bonus);
            this.health.applySpin(bonus);
            this.spun.emit(i, bonus);
        }
        s.spinsAwarded = Math.floor(s.progress / TWO_PI);
    }

    /**
     * lazer: SpinnerSpinHistory counts a spin only once the net rotation
     * within it reaches 360° (wiggling back and forth doesn't count); the
     * first SpinsRequired + 2 spins are normal ticks, then up to
     * MaximumBonusSpins bonus ticks, then nothing.
     */
    private spinLazer(i: number, s: SpinnerState, c: SpinCounter, delta: number): void {
        c.accumulated += delta;
        c.currentSpinMax = Math.max(c.currentSpinMax, Math.abs(c.accumulated - c.atLastCompletion));
        while (c.currentSpinMax >= TWO_PI) {
            const direction = Math.sign(c.accumulated - c.atLastCompletion) || 1;
            c.completed++;
            c.atLastCompletion += direction * TWO_PI;
            c.currentSpinMax = Math.abs(c.accumulated - c.atLastCompletion);
        }
        s.progress = c.completed * TWO_PI + c.currentSpinMax;
        while (s.spinsAwarded < c.completed) {
            s.spinsAwarded++;
            const normalTicks = c.spinsRequired + BONUS_SPINS_GAP;
            if (s.spinsAwarded <= normalTicks) {
                this.score.applySpin(false);
                this.health.applySpin(false);
                this.spun.emit(i, false);
            } else if (s.spinsAwarded <= normalTicks + c.maxBonusSpins) {
                s.bonusSpins++;
                this.score.applySpin(true);
                this.health.applySpin(true);
                this.spun.emit(i, true);
            } else {
                // Past the bonus limit: lazer only plays the max-bonus sound.
                this.spun.emit(i, true);
            }
        }
    }

    /**
     * Passive judgement up to `time` without new input: missed circles and
     * heads, slider ticks/repeats/tails, slider and spinner ends.
     */
    private settle(time: number): void {
        const objs = this.beatmap.hitObjects;
        for (let i = this.firstPending; i < objs.length; i++) {
            const h = objs[i];
            if (h.time > time) break;
            const s = this.states[i];
            if (s.result !== null) continue;
            if (s.kind === 'circle') {
                if (time > h.time + this.w50) this.applyMain(i, 'miss', h.time + this.w50, h.x, h.y, null, true);
            } else if (s.kind === 'slider') {
                this.settleSlider(i, h as PlayableSlider, s, time);
            } else if (time >= h.endTime) {
                // Spinners too short to need a spin are cleared outright.
                const progress = s.required > 0 ? s.progress / s.required : 1;
                this.applyMain(i, spinnerResult(progress), h.endTime, h.x, h.y, null, true);
            }
        }
        while (this.firstPending < objs.length && this.states[this.firstPending].result !== null) this.firstPending++;
    }

    private settleSlider(i: number, h: PlayableSlider, s: SliderState, time: number): void {
        if (s.headHit === null && time > h.time + this.w50) this.missHead(i, h.time + this.w50);
        // lazer judges nothing nested before the head (SliderInputManager.TryJudgeNestedObject).
        if (this.mechanics === 'stable' || s.headHit !== null) {
            while (s.nextEvent < h.events.length) {
                const ev = h.events[s.nextEvent];
                if (this.mechanics === 'lazer' && ev.kind === 'tail') {
                    // lazer's tail: hit while tracking from 36 ms before the end
                    // (DrawableSliderTail leniency), otherwise judged at the end.
                    if (time >= ev.time - TAIL_LENIENCY && s.tracking) this.judgeNextEvent(i, h, s, true);
                    else if (time >= ev.time) this.judgeNextEvent(i, h, s, s.tracking);
                    else break;
                } else if (time >= ev.time) {
                    this.judgeNextEvent(i, h, s, s.tracking);
                } else {
                    break;
                }
            }
        }
        const allJudged = s.nextEvent >= h.events.length && s.headHit !== null;
        if (time > h.endTime && allJudged) this.setTracking(s, false, h.endTime);
        if (time >= h.endTime && allJudged) {
            if (this.mechanics === 'lazer') this.endLazerSlider(i, s, h.endTime);
            else this.applyMain(i, sliderResult(s.partsHit, h.events.length), h.endTime, h.endX, h.endY, null, false);
        }
    }

    /**
     * lazer's non-classic DrawableSlider.CheckForResult: the slider's own
     * judgement is IgnoreHit when any part was hit, else IgnoreMiss. It
     * scores nothing and isn't shown (its accuracy judgement was the
     * head's); health only takes the combo-end bonus from it.
     */
    private endLazerSlider(i: number, s: SliderState, time: number): void {
        const result: HitResult = s.partsHit > 0 ? 'great' : 'miss';
        s.result = result;
        s.judgedAt = time;
        this.health.applyMain(result, i);
    }

    private judgeNextEvent(i: number, h: PlayableSlider, s: SliderState, hit: boolean): void {
        const ev = h.events[s.nextEvent];
        s.eventHit[s.nextEvent] = hit;
        if (hit) s.partsHit++;
        const kind = ev.kind as NestedKind;
        this.score.applyNested(kind, hit);
        this.health.applyNested(kind, hit);
        // lazer's Perfect fails on any accuracy-affecting miss (a missed tail
        // doesn't break combo); stable's shows up as a non-300 slider.
        if (this.perfect && !hit && this.mechanics === 'lazer') this.health.fail();
        this.nestedJudged.emit(i, ev, hit);
        s.nextEvent++;
    }

    /** Forget the last spinner angle (resume after pause shouldn't jump). */
    resetSpinnerTracking(): void {
        for (const s of this.states) if (s.kind === 'spinner') s.lastAngle = null;
    }
}

const dist2 = (dx: number, dy: number): number => dx * dx + dy * dy;

/** Ball position on a slider at `time` (accounts for repeats). */
export function sliderBallPosition(h: PlayableSlider, time: number): { x: number; y: number } {
    const p = sliderProgress(h, time);
    return h.path.pointAt(p);
}

/** Path progress (0..1) of the ball at `time`, folding repeats. */
export function sliderProgress(h: PlayableSlider, time: number): number {
    if (h.spanDuration <= 0) return 0;
    const t = Math.max(0, Math.min(h.slides, (time - h.time) / h.spanDuration));
    const span = Math.min(Math.floor(t), h.slides - 1);
    const local = t - span;
    return span % 2 === 0 ? local : 1 - local;
}

/** Current span index at `time`. */
export function sliderSpan(h: PlayableSlider, time: number): number {
    if (h.spanDuration <= 0) return 0;
    return Math.max(0, Math.min(h.slides - 1, Math.floor((time - h.time) / h.spanDuration)));
}
