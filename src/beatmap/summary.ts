/**
 * Cheap per-difficulty statistics for the library and song select.
 *
 * The counts avoid full processing (slider paths are only built when the
 * map states no pixel length); the offline star rating does process the
 * map once, which costs a few milliseconds per difficulty.
 */
import { NO_MODS } from '../gameplay/mods';
import { buildControlPointTimeline } from './controlPoints';
import { createSliderPath } from './curves';
import { calculateDifficulty } from './difficulty';
import { buildPlayableBeatmap, countSliderTicks, sliderTiming } from './processing';
import type { BeatmapData, DifficultySummary } from './types';

export function summarizeDifficulty(data: BeatmapData, file: string): DifficultySummary {
    const objects = data.hitObjects;
    const timeline = buildControlPointTimeline(data.timingPoints, data.general.sampleSet);

    let circles = 0;
    let sliders = 0;
    let spinners = 0;
    let maxCombo = 0;
    let firstTime = Infinity;
    let lastEnd = -Infinity;

    for (const o of objects) {
        if (o.time < firstTime) firstTime = o.time;
        let end = o.time;
        if (o.kind === 'circle') {
            circles++;
            maxCombo++;
        } else if (o.kind === 'spinner') {
            spinners++;
            maxCombo++;
            end = Math.max(o.endTime ?? o.time, o.time);
        } else {
            sliders++;
            const slides = o.slides ?? 1;
            let length = o.pixelLength ?? 0;
            if (!(length > 0)) {
                length = createSliderPath({ x: o.x, y: o.y }, o.curveType ?? 'B', o.controlPoints ?? [], 0).length;
            }
            const timing = sliderTiming(data, timeline.at(o.time), length, slides);
            end = o.time + timing.duration;
            // head + ticks + repeats + tail
            maxCombo += 1 + countSliderTicks(length, timing.velocity, timing.tickDistance, slides) + (slides - 1) + 1;
        }
        if (end > lastEnd) lastEnd = end;
    }
    if (!Number.isFinite(firstTime)) {
        firstTime = 0;
        lastEnd = 0;
    }

    const { main, min, max } = beatLengthStats(data, lastEnd);
    const d = data.difficulty;
    return {
        file,
        version: data.metadata.version,
        beatmapId: data.metadata.beatmapId,
        mode: data.general.mode,
        cs: d.circleSize,
        ar: d.approachRate,
        od: d.overallDifficulty,
        hp: d.hpDrainRate,
        bpm: bpmOf(main),
        bpmMin: bpmOf(max),
        bpmMax: bpmOf(min),
        length: Math.max(0, lastEnd - firstTime),
        circles,
        sliders,
        spinners,
        maxCombo,
        previewTime: data.general.previewTime,
        ...localStars(data),
    };
}

/** Offline estimate; a mirror's official rating replaces it when available. */
function localStars(data: BeatmapData): Pick<DifficultySummary, 'stars' | 'starSource'> {
    if (data.general.mode !== 0 || data.hitObjects.length === 0) return { stars: null };
    try {
        return { stars: calculateDifficulty(buildPlayableBeatmap(data, NO_MODS)).stars, starSource: 'local' };
    } catch (e) {
        console.warn('star rating failed', e);
        return { stars: null };
    }
}

const bpmOf = (beatLength: number): number => (beatLength > 0 ? 60000 / beatLength : 0);

/**
 * lazer GetMostCommonBeatLength: the uninherited beat length covering the
 * most time up to the last object (stable forced the first point to 0).
 */
function beatLengthStats(data: BeatmapData, lastTime: number): { main: number; min: number; max: number } {
    const reds = data.timingPoints.filter(p => p.uninherited).sort((a, b) => a.time - b.time);
    if (reds.length === 0) return { main: 500, min: 500, max: 500 };
    const durations = new Map<number, number>();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < reds.length; i++) {
        const p = reds[i];
        if (p.time > lastTime && i > 0) continue;
        if (p.beatLength < min) min = p.beatLength;
        if (p.beatLength > max) max = p.beatLength;
        const current = i === 0 ? 0 : p.time;
        const next = i === reds.length - 1 ? lastTime : reds[i + 1].time;
        const key = Math.round(p.beatLength * 1000) / 1000;
        durations.set(key, (durations.get(key) ?? 0) + Math.max(0, next - current));
    }
    let main = reds[0].beatLength;
    let best = -1;
    for (const [beatLength, duration] of durations) {
        if (duration > best) {
            best = duration;
            main = beatLength;
        }
    }
    if (!Number.isFinite(min)) min = max = main;
    return { main, min, max };
}
