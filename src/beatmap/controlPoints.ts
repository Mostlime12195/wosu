/**
 * Effective timing state over the song.
 *
 * .osu timing rows come in two flavours: uninherited ("red") points set
 * tempo and meter and reset slider velocity to 1x; inherited ("green")
 * points change slider velocity. Both carry sample settings and kiai.
 * This folds them into one flat, time-ordered list of ControlPoints so
 * every lookup is a single binary search.
 */
import type { ControlPoint, ControlPointTimeline, SampleSet, TimingPoint } from './types';

const DEFAULT_BEAT_LENGTH = 500; // 120 BPM

class Timeline implements ControlPointTimeline {
    constructor(readonly points: readonly ControlPoint[]) {}

    at(time: number): ControlPoint {
        const pts = this.points;
        if (time < pts[0].time) return pts[0];
        let lo = 0;
        let hi = pts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (pts[mid].time <= time) lo = mid;
            else hi = mid - 1;
        }
        return pts[lo];
    }
}

export function sliderVelocityOf(beatLength: number): number {
    if (!Number.isFinite(beatLength) || beatLength >= 0) return 1;
    const sv = -100 / beatLength;
    return sv < 0.1 ? 0.1 : sv > 10 ? 10 : sv;
}

export function buildControlPointTimeline(points: readonly TimingPoint[], defaultSampleSet: SampleSet): ControlPointTimeline {
    const fallbackSet: SampleSet = defaultSampleSet || 1;
    if (points.length === 0) {
        return new Timeline([{
            time: 0,
            beatLength: DEFAULT_BEAT_LENGTH,
            sliderVelocity: 1,
            meter: 4,
            sampleSet: fallbackSet,
            sampleIndex: 0,
            volume: 100,
            kiai: false,
        }]);
    }

    // Stable sort by time; at equal times the red line applies first so a
    // green line on the same tick can override its (reset) velocity.
    const sorted = points
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.time - b.p.time || Number(b.p.uninherited) - Number(a.p.uninherited) || a.i - b.i)
        .map(e => e.p);

    // Before the first red line, use its tempo (lazer's TimingPointAt).
    const firstRed = sorted.find(p => p.uninherited);
    let beatLength = firstRed ? firstRed.beatLength : DEFAULT_BEAT_LENGTH;
    let meter = firstRed ? firstRed.meter : 4;
    let sliderVelocity = 1;

    const out: ControlPoint[] = [];
    for (const p of sorted) {
        if (p.uninherited) {
            beatLength = p.beatLength;
            meter = p.meter;
            sliderVelocity = 1;
        } else {
            sliderVelocity = sliderVelocityOf(p.beatLength);
        }
        const cp: ControlPoint = {
            time: p.time,
            beatLength,
            sliderVelocity,
            meter,
            sampleSet: p.sampleSet || fallbackSet,
            sampleIndex: p.sampleIndex,
            volume: p.volume,
            kiai: p.kiai,
        };
        // Points sharing a timestamp collapse into the last one.
        if (out.length > 0 && out[out.length - 1].time === p.time) out[out.length - 1] = cp;
        else out.push(cp);
    }
    return new Timeline(out);
}
