/**
 * .osu file decoder.
 *
 * Produces a faithful BeatmapData: every field is normalized to a sane
 * value (osu! defaults for missing data, clamped ranges, NaN rows
 * dropped) but nothing is derived — slider paths, stacking and combo
 * numbering live in processing.ts so they can be recomputed per mod set.
 */
import type { Vec2 } from '../core/math';
import type {
    BeatmapData,
    BeatmapDifficulty,
    BeatmapEvents,
    BeatmapGeneral,
    BeatmapMetadata,
    BreakPeriod,
    CurveType,
    HitObjectData,
    HitSampleInfo,
    SampleSet,
    TimingPoint,
} from './types';

const LATEST_FORMAT = 14;

/** Coordinates beyond this are treated as corrupt (lazer's MAX_COORDINATE_VALUE). */
const MAX_COORDINATE = 131072;

export function parseOsu(text: string): BeatmapData {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r\n|\r|\n/);

    let formatVersion = LATEST_FORMAT;
    let section = '';
    const general: Record<string, string> = {};
    const metadata: Record<string, string> = {};
    const difficulty: Record<string, string> = {};
    const eventRows: string[] = [];
    const timingRows: string[] = [];
    const colourRows: [string, string][] = [];
    const objectRows: string[] = [];

    let sawHeader = false;
    for (const raw of lines) {
        // Storyboard commands are indented; trimming the start would turn
        // them into events, but they never match the rows we care about.
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;
        if (!sawHeader) {
            sawHeader = true;
            const m = /^osu file format v(\d+)/i.exec(line);
            if (m) {
                formatVersion = Number(m[1]);
                continue;
            }
        }
        if (line.startsWith('[') && line.endsWith(']')) {
            section = line.slice(1, -1);
            continue;
        }
        switch (section) {
            case 'General':
                readKeyValue(line, general);
                break;
            case 'Metadata':
                readKeyValue(line, metadata);
                break;
            case 'Difficulty':
                readKeyValue(line, difficulty);
                break;
            case 'Events':
                eventRows.push(line);
                break;
            case 'TimingPoints':
                timingRows.push(line);
                break;
            case 'Colours': {
                const i = line.indexOf(':');
                if (i > 0) colourRows.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
                break;
            }
            case 'HitObjects':
                objectRows.push(line);
                break;
            default:
                break; // [Editor] and unknown sections
        }
    }

    const gen = parseGeneral(general);
    const colours = parseColours(colourRows);
    const timingPoints: TimingPoint[] = [];
    for (const row of timingRows) {
        const tp = parseTimingPoint(row);
        if (tp) timingPoints.push(tp);
    }
    const hitObjects: HitObjectData[] = [];
    for (const row of objectRows) {
        const ho = parseHitObject(row);
        if (ho) hitObjects.push(ho);
    }
    // Some editors emit objects out of order; gameplay assumes sorted.
    if (!isSortedByTime(hitObjects)) hitObjects.sort((a, b) => a.time - b.time);

    return {
        formatVersion,
        general: gen,
        metadata: parseMetadata(metadata),
        difficulty: parseDifficulty(difficulty),
        events: parseEvents(eventRows),
        timingPoints,
        comboColors: colours.combo,
        sliderTrackOverride: colours.trackOverride,
        sliderBorder: colours.border,
        hitObjects,
    };
}

function readKeyValue(line: string, into: Record<string, string>): void {
    const i = line.indexOf(':');
    if (i <= 0) return;
    into[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

function num(v: string | undefined, fallback: number): number {
    if (v === undefined || v.trim() === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function toSampleSet(n: number): SampleSet {
    return n >= 0 && n <= 3 ? (Math.trunc(n) as SampleSet) : 0;
}

function parseGeneral(g: Record<string, string>): BeatmapGeneral {
    const set = (g.SampleSet ?? '').toLowerCase();
    const sampleSet: SampleSet = set === 'soft' ? 2 : set === 'drum' ? 3 : 1;
    const leniency = num(g.StackLeniency, 0.7);
    return {
        audioFilename: g.AudioFilename ?? '',
        audioLeadIn: Math.max(0, num(g.AudioLeadIn, 0)),
        previewTime: num(g.PreviewTime, -1),
        countdown: num(g.Countdown, 1),
        sampleSet,
        stackLeniency: clamp(leniency, 0, 1),
        mode: Math.trunc(num(g.Mode, 0)),
        letterboxInBreaks: g.LetterboxInBreaks === '1',
        widescreenStoryboard: g.WidescreenStoryboard === '1',
    };
}

function parseMetadata(m: Record<string, string>): BeatmapMetadata {
    const title = m.Title ?? '';
    const artist = m.Artist ?? '';
    return {
        title,
        titleUnicode: m.TitleUnicode || title,
        artist,
        artistUnicode: m.ArtistUnicode || artist,
        creator: m.Creator ?? '',
        version: m.Version ?? '',
        source: m.Source ?? '',
        tags: m.Tags ?? '',
        beatmapId: Math.trunc(num(m.BeatmapID, 0)),
        beatmapSetId: Math.trunc(num(m.BeatmapSetID, -1)),
    };
}

function parseDifficulty(d: Record<string, string>): BeatmapDifficulty {
    const od = clamp(num(d.OverallDifficulty, 5), 0, 10);
    // Very old maps only define OD; stable derived the rest from it.
    const hasOd = d.OverallDifficulty !== undefined;
    return {
        overallDifficulty: od,
        approachRate: clamp(num(d.ApproachRate, od), 0, 10),
        hpDrainRate: clamp(num(d.HPDrainRate, hasOd ? od : 5), 0, 10),
        circleSize: clamp(num(d.CircleSize, hasOd ? od : 5), 0, 10),
        sliderMultiplier: clamp(num(d.SliderMultiplier, 1.4) || 1.4, 0.4, 3.6),
        sliderTickRate: clamp(num(d.SliderTickRate, 1) || 1, 0.5, 8),
    };
}

/** CSV split that keeps quoted fields (event filenames may hold commas). */
function splitCsv(line: string): string[] {
    if (line.indexOf('"') === -1) return line.split(',');
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            quoted = !quoted;
            cur += ch;
        } else if (ch === ',' && !quoted) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function unquote(s: string): string {
    s = s.trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1);
    return s.replace(/\\/g, '/');
}

function parseEvents(rows: string[]): BeatmapEvents {
    let backgroundFile: string | null = null;
    let video: { filename: string; offset: number } | null = null;
    const breaks: BreakPeriod[] = [];
    for (const row of rows) {
        const f = splitCsv(row);
        const type = f[0].trim();
        if ((type === '0' || type === 'Background') && backgroundFile === null && f.length >= 3) {
            const file = unquote(f[2]);
            if (file) backgroundFile = file;
        } else if ((type === '1' || type === 'Video') && video === null && f.length >= 3) {
            const file = unquote(f[2]);
            if (file) video = { filename: file, offset: num(f[1], 0) };
        } else if ((type === '2' || type === 'Break') && f.length >= 3) {
            const start = Number(f[1]);
            const end = Number(f[2]);
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                breaks.push({ startTime: start, endTime: end });
            }
        }
    }
    breaks.sort((a, b) => a.startTime - b.startTime);
    return { backgroundFile, video, breaks };
}

function parseColour(v: string): number | null {
    const p = v.split(',').map(s => Number(s.trim()));
    if (p.length < 3 || p.slice(0, 3).some(n => !Number.isFinite(n))) return null;
    const c = (i: number) => clamp(Math.round(p[i]), 0, 255);
    return (c(0) << 16) | (c(1) << 8) | c(2);
}

function parseColours(rows: [string, string][]): {
    combo: number[];
    trackOverride: number | null;
    border: number | null;
} {
    const combos: { n: number; color: number }[] = [];
    let trackOverride: number | null = null;
    let border: number | null = null;
    for (const [key, value] of rows) {
        const color = parseColour(value);
        if (color === null) continue;
        if (key === 'SliderTrackOverride') trackOverride = color;
        else if (key === 'SliderBorder') border = color;
        else {
            const m = /^Combo(\d+)$/i.exec(key);
            if (m) combos.push({ n: Number(m[1]), color });
        }
    }
    combos.sort((a, b) => a.n - b.n);
    return { combo: combos.map(c => c.color), trackOverride, border };
}

function parseTimingPoint(row: string): TimingPoint | null {
    const p = row.split(',');
    if (p.length < 2) return null;
    const time = Number(p[0]);
    const beatLength = Number(p[1]);
    if (!Number.isFinite(time) || !Number.isFinite(beatLength)) return null;
    // Column 7 decides; old two-column maps are always uninherited. A
    // negative beat length can only mean an inherited (SV) point.
    let uninherited = p.length >= 7 ? p[6].trim() !== '0' : true;
    if (beatLength < 0) uninherited = false;
    const effects = Math.trunc(num(p[7], 0));
    return {
        time,
        beatLength: uninherited ? clamp(beatLength, 6, 60000) : beatLength,
        meter: Math.max(1, Math.trunc(num(p[2], 4)) || 4),
        sampleSet: toSampleSet(num(p[3], 0)),
        sampleIndex: Math.trunc(num(p[4], 0)),
        volume: clamp(num(p[5], 100), 0, 100),
        uninherited,
        kiai: (effects & 1) !== 0,
        omitFirstBarLine: (effects & 8) !== 0,
    };
}

function parseHitSample(s: string | undefined): HitSampleInfo {
    const p = (s ?? '').split(':');
    return {
        normalSet: toSampleSet(num(p[0], 0)),
        additionSet: toSampleSet(num(p[1], 0)),
        index: Math.trunc(num(p[2], 0)),
        volume: clamp(num(p[3], 0), 0, 100),
        filename: (p[4] ?? '').trim(),
    };
}

const TYPE_CIRCLE = 1;
const TYPE_SLIDER = 2;
const TYPE_NEW_COMBO = 4;
const TYPE_SPINNER = 8;
const TYPE_HOLD = 128;

function parseHitObject(row: string): HitObjectData | null {
    const p = row.split(',');
    if (p.length < 4) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    const time = Number(p[2]);
    const type = Math.trunc(num(p[3], 0));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time)) {
        console.warn('[parse] dropping hit object with non-finite x/y/time:', row);
        return null;
    }
    if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) {
        console.warn('[parse] dropping hit object with out-of-range position:', row);
        return null;
    }
    const base = {
        x,
        y,
        time,
        newCombo: (type & TYPE_NEW_COMBO) !== 0,
        comboSkip: (type >> 4) & 7,
        hitSound: Math.trunc(num(p[4], 0)) & 15,
    };

    if (type & TYPE_CIRCLE) {
        return { kind: 'circle', ...base, hitSample: parseHitSample(p[5]) };
    }

    if (type & TYPE_SLIDER) {
        if (p.length < 6) return null;
        const pathParts = (p[5] ?? '').split('|');
        let curveType: CurveType = 'B';
        const controlPoints: Vec2[] = [];
        for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i].trim();
            if (!part) continue;
            if (i === 0 && /^[BLPC]$/i.test(part)) {
                curveType = part.toUpperCase() as CurveType;
                continue;
            }
            const xy = part.split(':');
            const px = Number(xy[0]);
            const py = Number(xy[1]);
            if (Number.isFinite(px) && Number.isFinite(py)) controlPoints.push({ x: px, y: py });
        }
        let slides = Math.trunc(num(p[6], 1));
        if (!(slides >= 1)) {
            console.warn('[parse] clamping bad slider repeat:', row);
            slides = 1;
        }
        // Absurd repeat counts freeze event generation; stable caps too.
        slides = Math.min(slides, 9000);
        let pixelLength = num(p[7], 0);
        if (!(pixelLength >= 0)) {
            console.warn('[parse] clamping bad slider length:', row);
            pixelLength = 0;
        }
        const hitSample = parseHitSample(p[10]);
        const nodes = slides + 1;
        const edgeSounds: number[] = [];
        const soundParts = p[8] ? p[8].split('|') : [];
        for (let i = 0; i < nodes; i++) {
            edgeSounds.push(i < soundParts.length ? Math.trunc(num(soundParts[i], 0)) & 15 : base.hitSound);
        }
        const edgeSets: { normalSet: SampleSet; additionSet: SampleSet }[] = [];
        const setParts = p[9] ? p[9].split('|') : [];
        for (let i = 0; i < nodes; i++) {
            if (i < setParts.length) {
                const s = setParts[i].split(':');
                edgeSets.push({ normalSet: toSampleSet(num(s[0], 0)), additionSet: toSampleSet(num(s[1], 0)) });
            } else {
                edgeSets.push({ normalSet: hitSample.normalSet, additionSet: hitSample.additionSet });
            }
        }
        return {
            kind: 'slider',
            ...base,
            hitSample,
            curveType,
            controlPoints,
            slides,
            pixelLength,
            edgeSounds,
            edgeSets,
        };
    }

    if (type & TYPE_SPINNER) {
        let endTime = Number(p[5]);
        if (!Number.isFinite(endTime)) {
            console.warn('[parse] dropping spinner with bad endTime:', row);
            return null;
        }
        if (endTime < time) endTime = time + 1;
        return { kind: 'spinner', ...base, endTime, hitSample: parseHitSample(p[6]) };
    }

    if (!(type & TYPE_HOLD)) console.warn('[parse] unknown hit object type', type, row);
    return null;
}

function isSortedByTime(list: HitObjectData[]): boolean {
    for (let i = 1; i < list.length; i++) if (list[i].time < list[i - 1].time) return false;
    return true;
}
