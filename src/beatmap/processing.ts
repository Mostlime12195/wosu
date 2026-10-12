/**
 * BeatmapData + mods -> PlayableBeatmap.
 *
 * Mirrors lazer's playable-beatmap pipeline: difficulty mods first, then
 * Hard Rock's vertical flip (before paths, so the flipped control points
 * build the path), then paths and nested slider events, then stacking
 * with the modded AR/CS, and finally combo numbering. The input is never
 * mutated: retries reprocess the same decoded data.
 */
import type { Vec2 } from '../core/math';
import { adjustDifficulty, type ModSet } from '../gameplay/mods';
import type { GameplayMechanics } from '../gameplay/scoring/mechanics';
import { buildControlPointTimeline } from './controlPoints';
import { createSliderPath, offsetSliderPath } from './curves';
import type {
    BeatmapData,
    ControlPoint,
    DifficultyAttributes,
    HitObjectData,
    PlayableBeatmap,
    PlayableHitObject,
    PlayableSlider,
    SliderEvent,
    SliderEventKind,
    SliderPath,
} from './types';

export const PLAYFIELD_WIDTH = 512;
export const PLAYFIELD_HEIGHT = 384;

/** Legacy tail judgement happens this long before the slider's true end. */
export const LEGACY_LAST_TICK_OFFSET = 36;
/**
 * Where a slider's tail event sits:
 *  - `legacy`: stable's last tick, at max(start + duration / 2, end − 36 ms),
 *    judged once at that instant (osu!stable; also what difficulty uses);
 *  - `lazer`: the true end; lazer judges it from 36 ms before the end
 *    (DrawableSliderTail / SliderInputManager.TryJudgeNestedObject).
 */
export type SliderTailMode = 'legacy' | 'lazer';
const STACK_DISTANCE = 3;
const BASE_SCORING_DISTANCE = 100;
/** Event generation guard for edited/corrupt maps (lazer's max_length). */
const MAX_SLIDER_LENGTH = 100000;

export const DEFAULT_COMBO_COLORS: readonly number[] = [
    (96 << 16) | (159 << 8) | 159,
    (192 << 16) | (192 << 8) | 192,
    (128 << 16) | (255 << 8) | 255,
    (139 << 16) | (191 << 8) | 222,
];

export function preemptFor(ar: number): number {
    return ar < 5 ? 1200 + (600 * (5 - ar)) / 5 : 1200 - (750 * (ar - 5)) / 5;
}

export function difficultyAttributes(d: { cs: number; ar: number; od: number; hp: number }): DifficultyAttributes {
    const preempt = preemptFor(d.ar);
    const scale = (1 - (0.7 * (d.cs - 5)) / 5) / 2;
    return {
        cs: d.cs,
        ar: d.ar,
        od: d.od,
        hp: d.hp,
        circleRadius: 54.4 - 4.48 * d.cs,
        preempt,
        fadeIn: 400 * Math.min(1, preempt / 450),
        window300: 80 - 6 * d.od,
        window100: 140 - 8 * d.od,
        window50: 200 - 10 * d.od,
        stackOffset: -6.4 * scale,
    };
}

export interface SliderTiming {
    velocity: number;
    spanDuration: number;
    duration: number;
    tickDistance: number;
}

export function sliderTiming(data: BeatmapData, control: ControlPoint, length: number, slides: number, unclampedBeatLength = false): SliderTiming {
    const scoringDistance = BASE_SCORING_DISTANCE * data.difficulty.sliderMultiplier * control.sliderVelocity;
    const beatLength = unclampedBeatLength && control.rawBeatLength !== undefined ? control.rawBeatLength : control.beatLength;
    const velocity = scoringDistance / beatLength;
    // Before v8, stable computed tick spacing without slider velocity.
    const tickMultiplier = data.formatVersion < 8 ? 1 / control.sliderVelocity : 1;
    // A NaN inherited point turns ticks off (lazer: TickDistance = ∞).
    const tickDistance = control.generateTicks === false ? Infinity : (scoringDistance / data.difficulty.sliderTickRate) * tickMultiplier;
    const spanDuration = velocity > 0 ? length / velocity : 0;
    return { velocity, spanDuration, duration: spanDuration * slides, tickDistance };
}

export interface SliderEventDescriptor {
    kind: SliderEventKind;
    time: number;
    spanIndex: number;
    pathProgress: number;
}

/**
 * Port of lazer's SliderEventGenerator. The tail is either the legacy last
 * tick (stable) or lazer's tail at the true end (see SliderTailMode).
 */
export function generateSliderEvents(
    startTime: number,
    spanDuration: number,
    velocity: number,
    tickDistance: number,
    totalDistance: number,
    slides: number,
    tail: SliderTailMode = 'legacy',
): SliderEventDescriptor[] {
    const length = Math.min(MAX_SLIDER_LENGTH, totalDistance);
    const tickDist = Math.min(Math.max(tickDistance, 0), length);
    const minDistanceFromEnd = velocity * 10;
    const events: SliderEventDescriptor[] = [{ kind: 'head', time: startTime, spanIndex: 0, pathProgress: 0 }];

    for (let span = 0; span < slides; span++) {
        const spanStart = startTime + span * spanDuration;
        const reversed = span % 2 === 1;
        if (tickDist > 0) {
            const ticks: SliderEventDescriptor[] = [];
            for (let d = tickDist; d <= length; d += tickDist) {
                if (d >= length - minDistanceFromEnd) break;
                // Ticks are placed from the path start so repeat spans
                // mirror the first span exactly.
                const pathProgress = d / length;
                const timeProgress = reversed ? 1 - pathProgress : pathProgress;
                ticks.push({ kind: 'tick', time: spanStart + timeProgress * spanDuration, spanIndex: span, pathProgress });
            }
            if (reversed) ticks.reverse();
            for (const t of ticks) events.push(t);
        }
        if (span < slides - 1) {
            events.push({ kind: 'repeat', time: spanStart + spanDuration, spanIndex: span, pathProgress: (span + 1) % 2 });
        }
    }

    const totalDuration = slides * spanDuration;
    const finalSpanStart = startTime + (slides - 1) * spanDuration;
    const tailTime = tail === 'lazer'
        ? startTime + totalDuration
        : Math.max(startTime + totalDuration / 2, finalSpanStart + spanDuration - LEGACY_LAST_TICK_OFFSET);
    events.push({ kind: 'tail', time: tailTime, spanIndex: slides - 1, pathProgress: slides % 2 });

    // The tail precedes ticks in the last 36ms; keep a stable time order.
    events.sort((a, b) => a.time - b.time);
    return events;
}

/** Number of tick events for a slider (used by summaries without paths). */
export function countSliderTicks(length: number, velocity: number, tickDistance: number, slides: number): number {
    const len = Math.min(MAX_SLIDER_LENGTH, length);
    const tickDist = Math.min(Math.max(tickDistance, 0), len);
    if (!(tickDist > 0)) return 0;
    const minDistanceFromEnd = velocity * 10;
    let perSpan = 0;
    for (let d = tickDist; d <= len; d += tickDist) {
        if (d >= len - minDistanceFromEnd) break;
        perSpan++;
    }
    return perSpan * slides;
}

// ---------------------------------------------------------------------------
// Stacking
// ---------------------------------------------------------------------------

interface StackItem {
    kind: HitObjectData['kind'];
    time: number;
    endTime: number;
    x: number;
    y: number;
    endX: number;
    endY: number;
    stackHeight: number;
}

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

/** lazer OsuBeatmapProcessor.applyStacking (beatmap version >= 6). */
export function applyStacking(items: StackItem[], preempt: number, stackLeniency: number): void {
    const stackThreshold = preempt * stackLeniency;
    const startIndex = 0;
    let extendedStartIndex = startIndex;
    for (let i = items.length - 1; i > startIndex; i--) {
        let n = i;
        let objectI = items[i];
        if (objectI.stackHeight !== 0 || objectI.kind === 'spinner') continue;

        if (objectI.kind === 'circle') {
            while (--n >= 0) {
                const objectN = items[n];
                if (objectN.kind === 'spinner') continue;
                if (objectI.time - objectN.endTime > stackThreshold) break;
                if (n < extendedStartIndex) {
                    objectN.stackHeight = 0;
                    extendedStartIndex = n;
                }
                // Circles under the end of a slider stack down-right
                // (negative) so they stay visible below the slider end.
                if (objectN.kind === 'slider' && distance(objectN.endX, objectN.endY, objectI.x, objectI.y) < STACK_DISTANCE) {
                    const offset = objectI.stackHeight - objectN.stackHeight + 1;
                    for (let j = n + 1; j <= i; j++) {
                        const objectJ = items[j];
                        if (distance(objectN.endX, objectN.endY, objectJ.x, objectJ.y) < STACK_DISTANCE) objectJ.stackHeight -= offset;
                    }
                    break;
                }
                if (distance(objectN.x, objectN.y, objectI.x, objectI.y) < STACK_DISTANCE) {
                    objectN.stackHeight = objectI.stackHeight + 1;
                    objectI = objectN;
                }
            }
        } else if (objectI.kind === 'slider') {
            while (--n >= startIndex) {
                const objectN = items[n];
                if (objectN.kind === 'spinner') continue;
                if (objectI.time - objectN.time > stackThreshold) break;
                if (distance(objectN.endX, objectN.endY, objectI.x, objectI.y) < STACK_DISTANCE) {
                    objectN.stackHeight = objectI.stackHeight + 1;
                    objectI = objectN;
                }
            }
        }
    }
}

/** lazer OsuBeatmapProcessor.applyStackingOld (beatmap version < 6). */
export function applyStackingOld(items: StackItem[], preempt: number, stackLeniency: number): void {
    const stackThreshold = preempt * stackLeniency;
    for (let i = 0; i < items.length; i++) {
        const curr = items[i];
        if (curr.stackHeight !== 0 && curr.kind !== 'slider') continue;
        let startTime = curr.endTime;
        let sliderStack = 0;
        for (let j = i + 1; j < items.length; j++) {
            if (items[j].time - stackThreshold > startTime) break;
            // Stable used the inner object's start time here (its end time
            // was never computed), which lazer reproduces.
            if (distance(items[j].x, items[j].y, curr.x, curr.y) < STACK_DISTANCE) {
                curr.stackHeight++;
                startTime = items[j].time;
            } else if (distance(items[j].x, items[j].y, curr.endX, curr.endY) < STACK_DISTANCE) {
                sliderStack++;
                items[j].stackHeight -= sliderStack;
                startTime = items[j].time;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Combo numbering
// ---------------------------------------------------------------------------

export interface ComboInfo {
    newCombo: boolean;
    comboNumber: number;
    comboColorIndex: number;
    lastInCombo: boolean;
}

/**
 * Spinners never start a combo themselves (or advance the colour); their
 * new-combo flag and skip carry over to the next object, which always
 * starts a new combo. The first object always starts one.
 */
export function computeCombos(objects: readonly HitObjectData[]): ComboInfo[] {
    const out: ComboInfo[] = new Array(objects.length);
    let colorIndex = 0;
    let comboNumber = 0;
    let forceNewCombo = true;
    let pendingSkip = 0;
    for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        if (o.kind === 'spinner') {
            if (o.newCombo) pendingSkip += o.comboSkip;
            forceNewCombo = true;
            comboNumber++;
            out[i] = { newCombo: false, comboNumber, comboColorIndex: colorIndex, lastInCombo: false };
            continue;
        }
        const newCombo = o.newCombo || forceNewCombo;
        if (newCombo) {
            colorIndex += 1 + o.comboSkip + pendingSkip;
            comboNumber = 0;
        }
        forceNewCombo = false;
        pendingSkip = 0;
        comboNumber++;
        out[i] = { newCombo, comboNumber, comboColorIndex: colorIndex, lastInCombo: false };
    }
    for (let i = 0; i < out.length; i++) {
        out[i].lastInCombo = i === out.length - 1 || out[i + 1].newCombo;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface Geometry {
    head: Vec2;
    path: SliderPath | null;
    timing: { velocity: number; spanDuration: number; duration: number; tickDistance: number } | null;
    endTime: number;
    slides: number;
}

/**
 * lazer's ConvertHitObjectParser drops the repeats of zero-length sliders:
 * stable never judged them, so they'd be free combo (or a stream of misses).
 */
function effectiveSlides(slides: number, pathLength: number): number {
    return Math.abs(pathLength) <= 1e-7 ? 1 : slides;
}

/** Keep the first and last node's sounds when a slider's repeats are dropped. */
function edgeList<T>(list: readonly T[] | undefined, slides: number, rawSlides: number): T[] {
    const l = list ?? [];
    if (slides === rawSlides || l.length < 2) return l.slice();
    return [l[0], l[Math.min(l.length - 1, rawSlides)]];
}

export interface PlayableOptions {
    /** Slider tail placement (default `legacy`, which difficulty calculation expects). */
    sliderTail?: SliderTailMode;
    /**
     * Time sliders with the red line's unclamped beat length (stable).
     * lazer clamps beat lengths to 6 ms, which turns Aspire's 1E-298 "instant"
     * sliders into seconds-long ones flying off-screen with hundreds of ticks.
     */
    unclampedBeatLength?: boolean;
}

/** The processing options for a mechanics setting. */
export function playableOptions(mechanics: GameplayMechanics): PlayableOptions {
    return mechanics === 'lazer' ? { sliderTail: 'lazer' } : { sliderTail: 'legacy', unclampedBeatLength: true };
}

export function buildPlayableBeatmap(data: BeatmapData, mods: ModSet, options: PlayableOptions = {}): PlayableBeatmap {
    const raw = data.difficulty;
    const adjusted = adjustDifficulty(
        { cs: raw.circleSize, ar: raw.approachRate, od: raw.overallDifficulty, hp: raw.hpDrainRate },
        mods,
    );
    const difficulty = difficultyAttributes(adjusted);
    const timeline = buildControlPointTimeline(data.timingPoints, data.general.sampleSet);
    const flip = mods.has('HR');
    const flipY = (y: number): number => (flip ? PLAYFIELD_HEIGHT - y : y);

    const objects = data.hitObjects;
    const geometry: Geometry[] = new Array(objects.length);
    const items: StackItem[] = new Array(objects.length);

    for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        const head = { x: o.x, y: flipY(o.y) };
        const control = timeline.at(o.time);
        let path: SliderPath | null = null;
        let timing: Geometry['timing'] = null;
        let endTime = o.time;
        let endX = head.x;
        let endY = head.y;
        let slides = 1;
        if (o.kind === 'slider') {
            const cps = (o.controlPoints ?? []).map(p => ({ x: p.x, y: flipY(p.y) }));
            path = createSliderPath(head, o.curveType ?? 'B', cps, o.pixelLength ?? 0);
            slides = effectiveSlides(o.slides ?? 1, path.length);
            timing = sliderTiming(data, control, path.length, slides, options.unclampedBeatLength ?? false);
            endTime = o.time + timing.duration;
            const end = path.pointAt(slides % 2 === 1 ? 1 : 0);
            endX = end.x;
            endY = end.y;
        } else if (o.kind === 'spinner') {
            endTime = Math.max(o.endTime ?? o.time + 1, o.time + 1);
        }
        geometry[i] = { head, path, timing, endTime, slides };
        items[i] = { kind: o.kind, time: o.time, endTime, x: head.x, y: head.y, endX, endY, stackHeight: 0 };
    }

    if (data.formatVersion >= 6) applyStacking(items, difficulty.preempt, data.general.stackLeniency);
    else applyStackingOld(items, difficulty.preempt, data.general.stackLeniency);

    const combos = computeCombos(objects);
    const hitObjects: PlayableHitObject[] = new Array(objects.length);

    for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        const g = geometry[i];
        const combo = combos[i];
        // Spinners always sit at the playfield centre visually; never offset them.
        const stackHeight = o.kind === 'spinner' ? 0 : items[i].stackHeight;
        const offset = stackHeight * difficulty.stackOffset;
        const base = {
            index: i,
            x: g.head.x + offset,
            y: g.head.y + offset,
            time: o.time,
            endTime: g.endTime,
            stackHeight,
            newCombo: combo.newCombo,
            comboNumber: combo.comboNumber,
            comboColorIndex: combo.comboColorIndex,
            lastInCombo: combo.lastInCombo,
            hitSound: o.hitSound,
            hitSample: o.hitSample,
            control: timeline.at(o.time),
        };
        if (o.kind === 'slider' && g.path && g.timing) {
            const slides = g.slides;
            const path = offsetSliderPath(g.path, offset, offset);
            const descriptors = generateSliderEvents(
                o.time, g.timing.spanDuration, g.timing.velocity, g.timing.tickDistance, path.length, slides, options.sliderTail ?? 'legacy',
            );
            const events: SliderEvent[] = descriptors.map(d => {
                const p = path.pointAt(d.pathProgress);
                return { kind: d.kind, time: d.time, spanIndex: d.spanIndex, pathProgress: d.pathProgress, x: p.x, y: p.y };
            });
            const end = path.pointAt(slides % 2 === 1 ? 1 : 0);
            const slider: PlayableSlider = {
                ...base,
                kind: 'slider',
                path,
                slides,
                spanDuration: g.timing.spanDuration,
                duration: g.timing.duration,
                endX: end.x,
                endY: end.y,
                events,
                edgeSounds: edgeList(o.edgeSounds, slides, o.slides ?? 1),
                edgeSets: edgeList(o.edgeSets, slides, o.slides ?? 1),
                tickDistance: g.timing.tickDistance,
                velocity: g.timing.velocity,
            };
            hitObjects[i] = slider;
        } else if (o.kind === 'spinner') {
            hitObjects[i] = {
                ...base,
                kind: 'spinner',
                x: PLAYFIELD_WIDTH / 2,
                y: PLAYFIELD_HEIGHT / 2,
                duration: g.endTime - o.time,
            };
        } else {
            hitObjects[i] = { ...base, kind: 'circle' };
        }
    }

    let startTime = 0;
    let endTime = 0;
    if (hitObjects.length > 0) {
        startTime = hitObjects[0].time;
        for (const h of hitObjects) if (h.endTime > endTime) endTime = h.endTime;
    }

    return {
        data,
        difficulty,
        hitObjects,
        controlPoints: timeline,
        breaks: data.events.breaks.map(b => ({ startTime: b.startTime, endTime: b.endTime })),
        comboColors: data.comboColors.length > 0 ? data.comboColors.slice() : DEFAULT_COMBO_COLORS.slice(),
        startTime,
        endTime,
    };
}
