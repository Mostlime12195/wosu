import type { PlayableBeatmap, PlayableHitObject, PlayableSlider, SliderEvent } from '../beatmap/types';
import { Signal } from '../core/Signal';
import type { ModSet } from './mods';
import type { HealthProcessor } from './scoring/HealthProcessor';
import {
    resultForError, sliderResult, spinnerResult, type HitResult, type NestedKind, type ScoreProcessor,
} from './scoring/ScoreProcessor';

/** Spin speed cap (stable: ~477 RPM). */
const MAX_SPIN_RAD_PER_MS = 0.05;
/** Spun Out's fixed spin speed (stable: 287 RPM). */
const SPUN_OUT_RAD_PER_MS = (287 / 60000) * Math.PI * 2;
/** Clicks this early (beyond the 50 window) shake instead of judging. */
const SHAKE_WINDOW = 400;
/** Follow area while tracking, in circle radii (stable/lazer 2.4). */
const FOLLOW_RADIUS_SCALE = 2.4;

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
    result: HitResult | null;
    judgedAt: number;
}

export interface SpinnerState {
    kind: 'spinner';
    /** Accumulated rotation (radians, signed) for the visual. */
    rotation: number;
    /** Absolute rotation counted toward clearing (radians). */
    progress: number;
    required: number;
    lastAngle: number | null;
    spinsAwarded: number;
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
}

/**
 * The osu!standard rules, separate from rendering so they can be tested
 * headlessly. The Player feeds it presses (with exact timestamps and
 * positions) and calls `update` every frame with the cursor state; it
 * judges objects, drives the score/health processors and emits events
 * the renderer and sound player react to.
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
    ) {
        const d = beatmap.difficulty;
        this.w300 = d.window300;
        this.w100 = d.window100;
        this.w50 = d.window50;
        this.radius = d.circleRadius;
        this.suddenDeath = mods.has('SD');
        this.perfect = mods.has('PF');
        this.relax = mods.has('RX');
        this.autoSpin = mods.has('SO') || mods.has('AT');
        this.autoSpinRate = mods.has('AT') ? MAX_SPIN_RAD_PER_MS : SPUN_OUT_RAD_PER_MS;
        this.states = beatmap.hitObjects.map(h => this.initialState(h, d.od));
        score.comboBroken.add(() => {
            if (this.suddenDeath || this.perfect) health.fail();
        });
    }

    private initialState(h: PlayableHitObject, od: number): ObjectState {
        if (h.kind === 'circle') return { kind: 'circle', result: null, judgedAt: 0, shakeAt: -Infinity };
        if (h.kind === 'slider') {
            return {
                kind: 'slider', headHit: null, headAt: 0, shakeAt: -Infinity, tracking: false, trackingChangedAt: -Infinity,
                nextEvent: 1, eventHit: h.events.map(() => null), partsHit: 0, result: null, judgedAt: 0,
            };
        }
        // Rotations per second needed (stable difficultyRange(OD, 3, 5, 7.5)),
        // eased by 0.7 like the original WebOsu so spinners stay friendly.
        const perSec = (od < 5 ? 3 + 0.4 * od : 2.5 + 0.5 * od) * 0.7;
        return {
            kind: 'spinner', rotation: 0, progress: 0, required: Math.PI * 2 * perSec * (h.duration / 1000),
            lastAngle: null, spinsAwarded: 0, rpm: 0, result: null, judgedAt: 0,
        };
    }

    get windows(): { w300: number; w100: number; w50: number } {
        return { w300: this.w300, w100: this.w100, w50: this.w50 };
    }

    /** Everything judged? */
    get finished(): boolean {
        return this.firstPending >= this.states.length;
    }

    /**
     * A key/button/touch went down at `time` with the cursor at (x, y).
     * Implements stable's note lock: only the earliest pending object can
     * be hit; clicking a later one (or clicking too early) shakes it.
     */
    press(time: number, x: number, y: number): void {
        const objs = this.beatmap.hitObjects;
        let earliestPending = -1;
        for (let i = this.firstPending; i < objs.length; i++) {
            const h = objs[i];
            if (h.time - SHAKE_WINDOW - this.w50 > time) break;
            if (h.kind === 'spinner') continue;
            if (!this.headPending(i)) continue;
            // Already past its window: it's a miss waiting to be swept by
            // update(), so it must not note-lock the next object.
            if (time > h.time + this.w50) continue;
            if (earliestPending === -1) earliestPending = i;
            if (!this.inside(h, x, y)) continue;
            if (i !== earliestPending) {
                this.shake(i, time);
                return;
            }
            const error = time - h.time;
            const result = resultForError(error, this.w300, this.w100, this.w50);
            if (result === null) {
                if (error < 0) this.shake(i, time);
                return;
            }
            this.judgeHead(i, time, error, result);
            return;
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

    private judgeHead(i: number, time: number, error: number, result: HitResult): void {
        const h = this.beatmap.hitObjects[i];
        const s = this.states[i];
        this.hitErrors.push(error);
        this.headHit.emit(i, time, error);
        if (s.kind === 'circle') {
            this.applyMain(i, result, time, h.x, h.y, error, true);
        } else if (s.kind === 'slider') {
            s.headHit = true;
            s.headAt = time;
            s.eventHit[0] = true;
            s.partsHit++;
            this.score.applyNested('head', true);
            this.health.applyNested('head', true);
            this.nestedJudged.emit(i, (h as PlayableSlider).events[0], true);
        }
    }

    private applyMain(i: number, result: HitResult, time: number, x: number, y: number, error: number | null, affectsCombo: boolean): void {
        const s = this.states[i];
        if (s.kind === 'circle' || s.kind === 'slider' || s.kind === 'spinner') {
            s.result = result;
            s.judgedAt = time;
        }
        this.score.applyMain(result, affectsCombo);
        this.health.applyMain(result);
        if (this.perfect && result !== 'great') this.health.fail();
        this.objectJudged.emit({ index: i, result, time, x, y, error });
    }

    /** Advance passive judgement to `time` (misses, slider events, spinners). */
    update(time: number, cursor: CursorState): void {
        const dt = this.lastTime === -Infinity ? 0 : Math.max(0, time - this.lastTime);
        this.lastTime = time;
        this.health.drain(time, dt);
        const objs = this.beatmap.hitObjects;
        for (let i = this.firstPending; i < objs.length; i++) {
            const h = objs[i];
            if (h.time - SHAKE_WINDOW - this.w50 > time) break;
            const s = this.states[i];
            if (s.kind === 'circle') this.updateCircle(i, s, time, cursor);
            else if (s.kind === 'slider') this.updateSlider(i, h as PlayableSlider, s, time, cursor);
            else this.updateSpinner(i, h, s, time, cursor, dt);
        }
        while (this.firstPending < objs.length && this.states[this.firstPending].result !== null) this.firstPending++;
    }

    private updateCircle(i: number, s: CircleState, time: number, cursor: CursorState): void {
        if (s.result !== null) return;
        const h = this.beatmap.hitObjects[i];
        if (this.relax && time >= h.time && this.inside(h, cursor.x, cursor.y) && i === this.earliestPendingHead()) {
            this.judgeHead(i, time, time - h.time, resultForError(time - h.time, this.w300, this.w100, this.w50) ?? 'meh');
            return;
        }
        if (time > h.time + this.w50) this.applyMain(i, 'miss', h.time + this.w50, h.x, h.y, null, true);
    }

    private earliestPendingHead(): number {
        for (let i = this.firstPending; i < this.states.length; i++) {
            const s = this.states[i];
            if (s.kind !== 'spinner' && this.headPending(i)) return i;
        }
        return -1;
    }

    private updateSlider(i: number, h: PlayableSlider, s: SliderState, time: number, cursor: CursorState): void {
        if (s.result !== null) return;
        // Head: relax auto-hit, or miss once its window passes.
        if (s.headHit === null) {
            if (this.relax && time >= h.time && this.inside(h, cursor.x, cursor.y) && i === this.earliestPendingHead()) {
                this.judgeHead(i, time, time - h.time, 'great');
            } else if (time > h.time + this.w50) {
                s.headHit = false;
                s.eventHit[0] = false;
                this.score.applyNested('head', false);
                this.health.applyNested('head', false);
                this.nestedJudged.emit(i, h.events[0], false);
            }
        }
        // Tracking during the slider's active time. A frame that lands past
        // the end judges the remaining events with the tracking state of the
        // last frame inside the slider (the cursor has moved on since).
        if (time >= h.time && time <= h.endTime) {
            const p = sliderBallPosition(h, time);
            const r = this.radius * (s.tracking ? FOLLOW_RADIUS_SCALE : 1);
            const dx = cursor.x - p.x, dy = cursor.y - p.y;
            const tracking = (cursor.held || this.relax) && dx * dx + dy * dy <= r * r;
            if (tracking !== s.tracking) {
                s.tracking = tracking;
                s.trackingChangedAt = time;
            }
        }
        // Nested events whose time has come.
        while (s.nextEvent < h.events.length && time >= h.events[s.nextEvent].time) {
            const ev = h.events[s.nextEvent];
            const hit = s.tracking;
            s.eventHit[s.nextEvent] = hit;
            if (hit) s.partsHit++;
            const kind = ev.kind as NestedKind;
            this.score.applyNested(kind, hit);
            this.health.applyNested(kind, hit);
            this.nestedJudged.emit(i, ev, hit);
            s.nextEvent++;
        }
        if (time > h.endTime && s.tracking) {
            s.tracking = false;
            s.trackingChangedAt = h.endTime;
        }
        if (time >= h.endTime && s.nextEvent >= h.events.length && s.headHit !== null) {
            const result = sliderResult(s.partsHit, h.events.length);
            this.applyMain(i, result, h.endTime, h.endX, h.endY, null, false);
        }
    }

    private updateSpinner(i: number, h: PlayableHitObject, s: SpinnerState, time: number, cursor: CursorState, dt: number): void {
        if (s.result !== null) return;
        if (time >= h.time && time <= h.endTime) {
            let delta = 0;
            if (this.autoSpin) {
                delta = this.autoSpinRate * dt;
                s.lastAngle = null;
            } else if (cursor.held || this.relax) {
                const angle = Math.atan2(cursor.y - h.y, cursor.x - h.x);
                if (s.lastAngle !== null) {
                    delta = angle - s.lastAngle;
                    if (delta > Math.PI) delta -= Math.PI * 2;
                    if (delta < -Math.PI) delta += Math.PI * 2;
                    const cap = MAX_SPIN_RAD_PER_MS * Math.max(dt, 1);
                    delta = Math.max(-cap, Math.min(cap, delta));
                }
                s.lastAngle = angle;
            } else {
                s.lastAngle = null;
            }
            s.rotation += delta;
            s.progress += Math.abs(delta);
            // Smoothed RPM for the counter.
            const instRpm = dt > 0 ? (Math.abs(delta) / dt) * (60000 / (Math.PI * 2)) : 0;
            s.rpm += (instRpm - s.rpm) * Math.min(1, dt / 200);
            const spins = Math.floor(s.progress / (Math.PI * 2));
            while (s.spinsAwarded < spins) {
                s.spinsAwarded++;
                const bonus = s.spinsAwarded * Math.PI * 2 > s.required + Math.PI * 2;
                this.score.applySpin(bonus);
                this.health.applySpin();
                this.spun.emit(i, bonus);
            }
        }
        if (time >= h.endTime) {
            const progress = s.required > 0 ? s.progress / s.required : 1;
            this.applyMain(i, spinnerResult(progress), h.endTime, h.x, h.y, null, true);
        }
    }

    /** Forget the last spinner angle (resume after pause shouldn't jump). */
    resetSpinnerTracking(): void {
        for (const s of this.states) if (s.kind === 'spinner') s.lastAngle = null;
    }
}

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
