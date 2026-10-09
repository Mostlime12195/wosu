/**
 * Beatmap domain types.
 *
 * Two stages:
 *  - BeatmapData: a faithful decode of one .osu file (no derived data).
 *  - PlayableBeatmap: BeatmapData with mods applied and everything the
 *    game needs precomputed (slider paths, nested slider events, stacking,
 *    combo numbering, timing lookups).
 *
 * Coordinates are osu! pixels (playfield 512x384), times are ms in the
 * song's own timeline (rate mods change the clock, never these values).
 */
import type { Vec2 } from '../core/math';

export type SampleSet = 0 | 1 | 2 | 3; // 0 = inherit, 1 = normal, 2 = soft, 3 = drum

export interface HitSampleInfo {
    normalSet: SampleSet;
    additionSet: SampleSet;
    index: number;
    volume: number;   // 0 = inherit from timing point
    filename: string; // custom sample filename (unsupported, kept for completeness)
}

/** Raw [TimingPoints] row, normalized. */
export interface TimingPoint {
    time: number;
    /** Raw beat length column: ms per beat if uninherited, negative SV percent otherwise. */
    beatLength: number;
    meter: number;
    sampleSet: SampleSet;
    sampleIndex: number;
    volume: number;
    uninherited: boolean;
    kiai: boolean;
    omitFirstBarLine: boolean;
}

/**
 * Effective control state at a moment of the song: what the uninherited
 * point says about tempo, combined with the latest inherited point's
 * slider velocity and sample settings.
 */
export interface ControlPoint {
    time: number;
    /** ms per beat from the governing uninherited point (true tempo). */
    beatLength: number;
    /** Slider velocity multiplier (1 = no change), from inherited points. */
    sliderVelocity: number;
    meter: number;
    sampleSet: SampleSet;
    sampleIndex: number;
    volume: number;
    kiai: boolean;
}

export type CurveType = 'B' | 'L' | 'P' | 'C';

export type HitObjectKind = 'circle' | 'slider' | 'spinner';

/** Raw [HitObjects] row, decoded but not processed. */
export interface HitObjectData {
    kind: HitObjectKind;
    x: number;
    y: number;
    time: number;
    newCombo: boolean;
    comboSkip: number;
    hitSound: number; // bitmask: 1 normal, 2 whistle, 4 finish, 8 clap
    hitSample: HitSampleInfo;
    // slider
    curveType?: CurveType;
    /** Control points after the head (the head is x/y). */
    controlPoints?: Vec2[];
    /** osu! "slides": 1 = no repeat. */
    slides?: number;
    pixelLength?: number;
    edgeSounds?: number[];
    edgeSets?: { normalSet: SampleSet; additionSet: SampleSet }[];
    // spinner
    endTime?: number;
}

export interface BeatmapGeneral {
    audioFilename: string;
    audioLeadIn: number;
    previewTime: number; // ms, -1 when unset
    countdown: number;
    sampleSet: SampleSet; // default sample set for the map (1 normal unless specified)
    stackLeniency: number;
    mode: number;
    letterboxInBreaks: boolean;
    widescreenStoryboard: boolean;
}

export interface BeatmapMetadata {
    title: string;
    titleUnicode: string;
    artist: string;
    artistUnicode: string;
    creator: string;
    version: string;
    source: string;
    tags: string;
    beatmapId: number; // 0 when unknown
    beatmapSetId: number; // 0 or -1 when unknown
}

export interface BeatmapDifficulty {
    hpDrainRate: number;
    circleSize: number;
    overallDifficulty: number;
    approachRate: number;
    sliderMultiplier: number;
    sliderTickRate: number;
}

export interface BreakPeriod {
    startTime: number;
    endTime: number;
}

export interface BeatmapEvents {
    backgroundFile: string | null;
    video: { filename: string; offset: number } | null;
    breaks: BreakPeriod[];
}

export interface BeatmapData {
    formatVersion: number;
    general: BeatmapGeneral;
    metadata: BeatmapMetadata;
    difficulty: BeatmapDifficulty;
    events: BeatmapEvents;
    timingPoints: TimingPoint[];
    /** Combo colours (0xRRGGBB); empty if the map defines none. */
    comboColors: number[];
    sliderTrackOverride: number | null;
    sliderBorder: number | null;
    hitObjects: HitObjectData[];
}

// ---------------------------------------------------------------------------
// Playable (processed) beatmap
// ---------------------------------------------------------------------------

/**
 * Polyline approximation of a slider path, truncated/extended to the
 * expected pixel length. `points[i].t` is the normalized arc-length
 * parameter (0 at head, 1 at tail), strictly non-decreasing.
 */
export interface SliderPath {
    readonly points: readonly PathPoint[];
    /** Arc length in osu! px (equals the slider's pixelLength). */
    readonly length: number;
    /** Position at normalized progress t in [0, 1] (clamped). */
    pointAt(t: number): Vec2;
    /** Unit tangent direction at t (pointing toward the tail). */
    directionAt(t: number): Vec2;
}

export interface PathPoint {
    x: number;
    y: number;
    t: number;
}

export type SliderEventKind = 'head' | 'tick' | 'repeat' | 'tail';

/** A judged point along a slider (lazer's nested hit objects). */
export interface SliderEvent {
    kind: SliderEventKind;
    /** Absolute time the event is judged. Tail uses the legacy -36ms offset. */
    time: number;
    /** Span the event belongs to (0-based). */
    spanIndex: number;
    /** Normalized path progress of the event's position. */
    pathProgress: number;
    x: number;
    y: number;
}

interface PlayableHitObjectBase {
    /** Index within the beatmap's object list. */
    index: number;
    /** Stacked position (stack offset already applied; HR flip applied). */
    x: number;
    y: number;
    time: number;
    endTime: number;
    stackHeight: number;
    newCombo: boolean;
    /** 1-based number shown on the circle. */
    comboNumber: number;
    /** Index into the combo colour list (includes combo skips). */
    comboColorIndex: number;
    /** The object is the last of its combo (used for combo-end hitsounds/geki). */
    lastInCombo: boolean;
    hitSound: number;
    hitSample: HitSampleInfo;
    /** Control state at the object's start time. */
    control: ControlPoint;
}

export interface PlayableCircle extends PlayableHitObjectBase {
    kind: 'circle';
}

export interface PlayableSlider extends PlayableHitObjectBase {
    kind: 'slider';
    path: SliderPath;
    slides: number;
    /** Duration of one pass over the path. */
    spanDuration: number;
    duration: number;
    /** Stacked tail position after the last span. */
    endX: number;
    endY: number;
    /** Nested events in time order: head, ticks/repeats interleaved, tail. */
    events: SliderEvent[];
    edgeSounds: number[];
    edgeSets: { normalSet: SampleSet; additionSet: SampleSet }[];
    /** Distance between ticks in osu! px (for rendering hints). */
    tickDistance: number;
    velocity: number; // osu! px per ms
}

export interface PlayableSpinner extends PlayableHitObjectBase {
    kind: 'spinner';
    duration: number;
}

export type PlayableHitObject = PlayableCircle | PlayableSlider | PlayableSpinner;

/** Difficulty after mod adjustment plus the derived timing windows. */
export interface DifficultyAttributes {
    cs: number;
    ar: number;
    od: number;
    hp: number;
    /** Circle radius in osu! px. */
    circleRadius: number;
    /** Approach (preempt) time in ms. */
    preempt: number;
    /** Fade-in duration in ms. */
    fadeIn: number;
    /** Hit windows (half-widths) in ms. */
    window300: number;
    window100: number;
    window50: number;
    /** Stack offset scale (stackHeight * this = px offset). */
    stackOffset: number;
}

export interface PlayableBeatmap {
    data: BeatmapData;
    difficulty: DifficultyAttributes;
    hitObjects: PlayableHitObject[];
    controlPoints: ControlPointTimeline;
    breaks: BreakPeriod[];
    comboColors: number[];
    /** Time of the first hit object and end time of the last one. */
    startTime: number;
    endTime: number;
}

/** Fast time-ordered control point lookup. */
export interface ControlPointTimeline {
    readonly points: readonly ControlPoint[];
    /** Effective control state at `time` (binary search). */
    at(time: number): ControlPoint;
}

/** Summary used by the library / song select without full processing. */
export interface DifficultySummary {
    file: string;
    version: string;
    beatmapId: number;
    mode: number;
    cs: number;
    ar: number;
    od: number;
    hp: number;
    bpm: number;
    bpmMin: number;
    bpmMax: number;
    /** Length from first object to last object end (ms). */
    length: number;
    circles: number;
    sliders: number;
    spinners: number;
    maxCombo: number;
    previewTime: number;
    /** Star rating if known (online lookup or estimate); null when unknown. */
    stars: number | null;
    /** Where `stars` came from: computed locally, or the mirror's official value. */
    starSource?: 'local' | 'online';
}
