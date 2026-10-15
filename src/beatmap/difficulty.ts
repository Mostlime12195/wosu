/**
 * Offline star rating: osu!'s classic strain model (lazer's osu! difficulty
 * calculator before the 2021 rework). Aim and speed each accumulate a
 * decaying "strain" per object; the peak strain of every 400 ms section,
 * weighted 0.9ⁿ from the hardest down, becomes the skill's difficulty.
 *
 * Mirrors give the current official ratings for submitted maps and those
 * win when available; this fills in local and offline imports, and is
 * close enough (usually within a few tenths) to rank difficulties.
 */
import type { PlayableBeatmap, PlayableHitObject, PlayableSlider } from './types';

const DIFFICULTY_MULTIPLIER = 0.0675;
const SECTION_LENGTH = 400;
const DECAY_WEIGHT = 0.9;
const NORMALIZED_RADIUS = 52;
const MIN_DELTA_TIME = 50;

interface Vec {
    x: number;
    y: number;
}

/** One object as the skills see it (lazer's OsuDifficultyHitObject). */
interface DiffObject {
    /** The hit object itself (lazer's BaseObject). */
    base: PlayableHitObject;
    spinner: boolean;
    startTime: number;
    deltaTime: number;
    strainTime: number;
    jumpDistance: number;
    travelDistance: number;
    angle: number | null;
    /** This object's own lazy slider travel in osu! px (0 unless a slider; flashlight's slider bonus). */
    selfTravel: number;
    /** lazer's TravelTime: how long the lazy cursor follows this slider (rate-adjusted, at least 25 ms). */
    travelTime: number;
}

interface LazySlider {
    end: Vec;
    travel: number;
    /** Time from the head to the last nested event (lazer's LazyTravelTime). */
    time: number;
}

/**
 * Where a lazy player's cursor leaves a slider: it only follows the ball
 * when the ball would escape a follow radius of 3 circle radii.
 */
function lazySlider(s: PlayableSlider, radius: number, cache: Map<PlayableSlider, LazySlider>): LazySlider {
    let r = cache.get(s);
    if (r) return r;
    const follow = radius * 3;
    let end = { x: s.x, y: s.y };
    let travel = 0;
    for (let i = 1; i < s.events.length; i++) {
        const t = s.events[i].time;
        let progress = (t - s.time) / Math.max(1e-6, s.spanDuration);
        progress = progress % 2 >= 1 ? 1 - (progress % 1) : progress % 1;
        const p = s.path.pointAt(progress);
        const dx = p.x - end.x, dy = p.y - end.y;
        const dist = Math.hypot(dx, dy);
        if (dist > follow) {
            const move = dist - follow;
            end = { x: end.x + (dx / dist) * move, y: end.y + (dy / dist) * move };
            travel += move;
        }
    }
    r = { end, travel, time: s.events.length ? s.events[s.events.length - 1].time - s.time : 0 };
    cache.set(s, r);
    return r;
}

function buildObjects(beatmap: PlayableBeatmap, rate: number): DiffObject[] {
    const objs = beatmap.hitObjects;
    const radius = beatmap.difficulty.circleRadius;
    let scale = NORMALIZED_RADIUS / radius;
    if (radius < 30) scale *= 1 + Math.min(30 - radius, 5) / 50;
    const cache = new Map<PlayableSlider, LazySlider>();
    const endPos = (h: PlayableHitObject): Vec => (h.kind === 'slider' ? lazySlider(h, radius, cache).end : { x: h.x, y: h.y });
    const out: DiffObject[] = [];
    for (let i = 1; i < objs.length; i++) {
        const cur = objs[i], last = objs[i - 1], lastLast = i > 1 ? objs[i - 2] : null;
        const deltaTime = (cur.time - last.time) / rate;
        const lastEnd = endPos(last);
        const travelDistance = last.kind === 'slider' ? lazySlider(last, radius, cache).travel * scale : 0;
        const jumpDistance = Math.hypot((cur.x - lastEnd.x) * scale, (cur.y - lastEnd.y) * scale);
        let angle: number | null = null;
        if (lastLast) {
            const ll = endPos(lastLast);
            const v1 = { x: ll.x - last.x, y: ll.y - last.y };
            const v2 = { x: cur.x - lastEnd.x, y: cur.y - lastEnd.y };
            const dot = v1.x * v2.x + v1.y * v2.y;
            const det = v1.x * v2.y - v1.y * v2.x;
            angle = Math.abs(Math.atan2(det, dot));
        }
        const own = cur.kind === 'slider' ? lazySlider(cur, radius, cache) : null;
        out.push({
            base: cur,
            spinner: cur.kind === 'spinner',
            startTime: cur.time / rate,
            deltaTime,
            strainTime: Math.max(MIN_DELTA_TIME, deltaTime),
            jumpDistance: cur.kind === 'spinner' ? 0 : jumpDistance,
            travelDistance,
            angle,
            selfTravel: own ? own.travel : 0,
            travelTime: own ? Math.max(own.time / rate, 25) : 0,
        });
    }
    return out;
}

const diminish = (v: number): number => Math.pow(v, 0.99);

function aimStrain(cur: DiffObject, prev: DiffObject | null, withSliders = true): number {
    if (cur.spinner) return 0;
    const ANGLE_BONUS_BEGIN = Math.PI / 3;
    const TIMING_THRESHOLD = 107;
    let result = 0;
    if (prev && cur.angle !== null && cur.angle > ANGLE_BONUS_BEGIN) {
        const scale = 90;
        const angleBonus = Math.sqrt(
            Math.max(prev.jumpDistance - scale, 0) *
            Math.pow(Math.sin(cur.angle - ANGLE_BONUS_BEGIN), 2) *
            Math.max(cur.jumpDistance - scale, 0),
        );
        result = (1.5 * diminish(Math.max(0, angleBonus))) / Math.max(TIMING_THRESHOLD, prev.strainTime);
    }
    const jump = diminish(cur.jumpDistance);
    const travel = withSliders ? diminish(cur.travelDistance) : 0;
    const combined = jump + travel + Math.sqrt(travel * jump);
    return Math.max(result + combined / Math.max(cur.strainTime, TIMING_THRESHOLD), combined / cur.strainTime);
}

function speedStrain(cur: DiffObject): number {
    if (cur.spinner) return 0;
    const SINGLE_SPACING = 125;
    const ANGLE_BONUS_BEGIN = (5 * Math.PI) / 6;
    const MIN_SPEED_BONUS = 75;
    const MAX_SPEED_BONUS = 45;
    const BALANCING = 40;
    const distance = Math.min(SINGLE_SPACING, cur.travelDistance + cur.jumpDistance);
    const deltaTime = Math.max(MAX_SPEED_BONUS, cur.deltaTime);
    let speedBonus = 1;
    if (deltaTime < MIN_SPEED_BONUS) speedBonus = 1 + Math.pow((MIN_SPEED_BONUS - deltaTime) / BALANCING, 2);
    let angleBonus = 1;
    if (cur.angle !== null && cur.angle < ANGLE_BONUS_BEGIN) {
        angleBonus = 1 + Math.pow(Math.sin(1.5 * (ANGLE_BONUS_BEGIN - cur.angle)), 2) / 3.57;
        if (cur.angle < Math.PI / 2) {
            angleBonus = 1.28;
            if (distance < 90 && cur.angle < Math.PI / 4) angleBonus += (1 - angleBonus) * Math.min((90 - distance) / 10, 1);
            else if (distance < 90) angleBonus += (1 - angleBonus) * Math.min((90 - distance) / 10, 1) * Math.sin((Math.PI / 2 - cur.angle) / (Math.PI / 4));
        }
    }
    return ((1 + (speedBonus - 1) * 0.75) * angleBonus * (0.95 + speedBonus * Math.pow(distance / SINGLE_SPACING, 3.5))) / cur.strainTime;
}

/** Strain skill: peaks per 400 ms section, weighted hardest first. */
function skillValue(objects: DiffObject[], multiplier: number, decayBase: number, strainOf: (cur: DiffObject, prev: DiffObject | null) => number): number {
    if (!objects.length) return 0;
    const decay = (ms: number) => Math.pow(decayBase, ms / 1000);
    const peaks: number[] = [];
    let strain = 0;
    let peak = 0;
    let sectionEnd = Math.ceil(objects[0].startTime / SECTION_LENGTH) * SECTION_LENGTH;
    let prev: DiffObject | null = null;
    for (const cur of objects) {
        while (cur.startTime > sectionEnd) {
            peaks.push(peak);
            // The new section starts from the strain as it decayed up to its start.
            peak = prev ? strain * decay(sectionEnd - prev.startTime) : 0;
            sectionEnd += SECTION_LENGTH;
        }
        strain *= decay(cur.deltaTime);
        strain += strainOf(cur, prev) * multiplier;
        if (strain > peak) peak = strain;
        prev = cur;
    }
    peaks.push(peak);
    peaks.sort((a, b) => b - a);
    let total = 0, weight = 1;
    for (const p of peaks) {
        total += p * weight;
        weight *= DECAY_WEIGHT;
    }
    return total;
}

export interface StarRating {
    stars: number;
    aim: number;
    speed: number;
}

/** Star rating of a processed beatmap (mods already applied) at a playback rate. */
export function calculateDifficulty(beatmap: PlayableBeatmap, rate = 1): StarRating {
    const objects = buildObjects(beatmap, rate);
    const aim = Math.sqrt(skillValue(objects, 26.25, 0.15, aimStrain)) * DIFFICULTY_MULTIPLIER;
    const speed = Math.sqrt(skillValue(objects, 1400, 0.3, cur => speedStrain(cur))) * DIFFICULTY_MULTIPLIER;
    const stars = aim + speed + Math.abs(aim - speed) / 2;
    return { stars: Math.round(stars * 100) / 100, aim, speed };
}

// ----------------------------------------------------------------------
// Difficulty attributes (what the pp formula needs)
// ----------------------------------------------------------------------

/**
 * lazer's OsuDifficultyAttributes, from the same strain model as the star
 * rating above (wosu!'s classic aim/speed skills plus lazer's flashlight
 * skill), with the counts and slider measures the current performance
 * formula reads. Times and windows are rate-adjusted.
 */
export interface OsuDifficultyAttributes {
    starRating: number;
    aimDifficulty: number;
    speedDifficulty: number;
    flashlightDifficulty: number;
    /** Aim rating without slider travel ÷ aim rating (1 when sliders add nothing). */
    sliderFactor: number;
    /** Speed objects weighted by how close their strain is to the hardest (lazer's RelevantNoteCount). */
    speedNoteCount: number;
    /** Sliders weighted by how hard they are to aim (lazer's GetDifficultSliders). */
    aimDifficultSliderCount: number;
    /** lazer's CountTopWeightedStrains for aim and speed (miss penalty). */
    aimDifficultStrainCount: number;
    speedDifficultStrainCount: number;
    approachRate: number;
    overallDifficulty: number;
    drainRate: number;
    greatHitWindow: number;
    okHitWindow: number;
    mehHitWindow: number;
    maxCombo: number;
    hitCircleCount: number;
    sliderCount: number;
    spinnerCount: number;
}

export interface AttributeOptions {
    /** Playback rate (DT/HT/NC/DC). */
    rate?: number;
    hidden?: boolean;
    flashlight?: boolean;
    relax?: boolean;
    autopilot?: boolean;
}

const FL_MAX_OPACITY_BONUS = 0.4;
const FL_HIDDEN_BONUS = 0.2;
const FL_MIN_VELOCITY = 0.5;
const FL_SLIDER_MULTIPLIER = 1.3;
const FL_MIN_ANGLE_MULTIPLIER = 0.2;

/** lazer's OsuDifficultyHitObject.OpacityAt: how visible `obj` is at `time` (Hidden fades it out early). */
function opacityAt(obj: PlayableHitObject, time: number, hidden: boolean, preempt: number, fadeIn: number): number {
    if (time > obj.time) return 0;
    const fadeInStart = obj.time - preempt;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const fadedIn = clamp01((time - fadeInStart) / fadeIn);
    if (!hidden) return fadedIn;
    const fadeOutStart = obj.time - preempt + fadeIn;
    return Math.min(fadedIn, 1 - clamp01((time - fadeOutStart) / (preempt * 0.3)));
}

const endOf = (h: PlayableHitObject): Vec => (h.kind === 'slider' ? { x: h.endX, y: h.endY } : { x: h.x, y: h.y });

/** lazer's FlashlightEvaluator: memorising distant, faded and long-slider patterns. */
function flashlightStrain(objects: readonly DiffObject[], k: number, hidden: boolean, radius: number, preempt: number, fadeIn: number): number {
    const cur = objects[k];
    if (cur.spinner) return 0;
    const scaling = 52 / radius;
    let smallDistNerf = 1;
    let cumulative = 0;
    let result = 0;
    let angleRepeat = 0;
    let last = cur;
    for (let i = 0; i < Math.min(k, 10); i++) {
        const prev = objects[k - 1 - i];
        cumulative += last.strainTime;
        if (!prev.spinner) {
            const end = endOf(prev.base);
            const jump = Math.hypot(cur.base.x - end.x, cur.base.y - end.y);
            if (i === 0) smallDistNerf = Math.min(1, jump / 75);
            const stackNerf = Math.min(1, prev.jumpDistance / scaling / 25);
            const opacityBonus = 1 + FL_MAX_OPACITY_BONUS * (1 - opacityAt(cur.base, prev.base.time, hidden, preempt, fadeIn));
            result += (stackNerf * opacityBonus * scaling * jump) / cumulative;
            if (prev.angle !== null && cur.angle !== null && Math.abs(prev.angle - cur.angle) < 0.02) angleRepeat += Math.max(1 - 0.1 * i, 0);
        }
        last = prev;
    }
    result = Math.pow(smallDistNerf * result, 2);
    if (hidden) result *= 1 + FL_HIDDEN_BONUS;
    result *= FL_MIN_ANGLE_MULTIPLIER + (1 - FL_MIN_ANGLE_MULTIPLIER) / (angleRepeat + 1);
    let sliderBonus = 0;
    if (cur.base.kind === 'slider') {
        const travel = cur.selfTravel;
        sliderBonus = Math.pow(Math.max(0, travel / cur.travelTime - FL_MIN_VELOCITY), 0.5) * travel;
        if (cur.base.slides > 1) sliderBonus /= cur.base.slides;
    }
    return result + sliderBonus * FL_SLIDER_MULTIPLIER;
}

/** Insert into a descending array. */
function insertDescending(a: number[], v: number): void {
    let lo = 0, hi = a.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] >= v) lo = mid + 1;
        else hi = mid;
    }
    a.splice(lo, 0, v);
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * One strain skill fed an object at a time (the same maths as skillValue,
 * so any prefix of the map can be valued: lazer's timed attributes).
 */
class IncrementalSkill {
    readonly strains: number[] = [];
    maxStrain = 0;
    private strain = 0;
    private peak = 0;
    private sectionEnd = NaN;
    private prevTime = NaN;
    private readonly peaks: number[] = [];

    constructor(private readonly multiplier: number, private readonly decayBase: number, private readonly weighted = true) {}

    private decay(ms: number): number {
        return Math.pow(this.decayBase, ms / 1000);
    }

    process(cur: DiffObject, value: number): number {
        if (Number.isNaN(this.sectionEnd)) this.sectionEnd = Math.ceil(cur.startTime / SECTION_LENGTH) * SECTION_LENGTH;
        while (cur.startTime > this.sectionEnd) {
            insertDescending(this.peaks, this.peak);
            this.peak = Number.isNaN(this.prevTime) ? 0 : this.strain * this.decay(this.sectionEnd - this.prevTime);
            this.sectionEnd += SECTION_LENGTH;
        }
        this.strain *= this.decay(cur.deltaTime);
        this.strain += value * this.multiplier;
        if (this.strain > this.peak) this.peak = this.strain;
        this.prevTime = cur.startTime;
        this.strains.push(this.strain);
        if (this.strain > this.maxStrain) this.maxStrain = this.strain;
        return this.strain;
    }

    /** Section peaks hardest first, weighted 0.9ⁿ (flashlight: summed unweighted). */
    difficultyValue(): number {
        if (!this.strains.length) return 0;
        let total = 0;
        let weight = 1;
        let merged = false;
        const add = (p: number) => {
            total += this.weighted ? p * weight : p;
            weight *= DECAY_WEIGHT;
        };
        for (const p of this.peaks) {
            if (!merged && this.peak >= p) {
                add(this.peak);
                merged = true;
            }
            add(p);
        }
        if (!merged) add(this.peak);
        return total;
    }

    /** lazer's OsuStrainSkill.CountTopWeightedStrains. */
    countTopWeighted(difficulty: number): number {
        if (!this.strains.length) return 0;
        const consistentTop = difficulty / 10;
        if (consistentTop === 0) return this.strains.length;
        let sum = 0;
        for (const s of this.strains) sum += 1.1 / (1 + Math.exp(-10 * (s / consistentTop - 0.88)));
        return sum;
    }
}

/** lazer's RelevantNoteCount / GetDifficultSliders: strains near the hardest count fully. */
function relevantCount(strains: readonly number[], max: number): number {
    if (!strains.length || max === 0) return 0;
    let sum = 0;
    for (const s of strains) sum += logistic((s / max) * 12 - 6);
    return sum;
}

function comboOf(h: PlayableHitObject): number {
    return h.kind === 'slider' ? h.events.length : 1;
}

/**
 * Difficulty attributes after each object (lazer's timed difficulty
 * attributes): `[i]` describes the map cut off after object i, which is
 * what the live pp counter values the judged part of a play against.
 * The aggregate counts (strain counts, speed note and difficult slider
 * counts) are recomputed every `ceil(n / 250)` objects and at the end,
 * which keeps long maps fast; the last entry is the full map's.
 */
export function calculateTimedAttributes(beatmap: PlayableBeatmap, opts: AttributeOptions = {}): OsuDifficultyAttributes[] {
    const rate = opts.rate ?? 1;
    const hidden = !!opts.hidden;
    const flashlight = !!opts.flashlight;
    const objs = beatmap.hitObjects;
    const d = beatmap.difficulty;
    const objects = buildObjects(beatmap, rate);
    const aim = new IncrementalSkill(26.25, 0.15);
    const aimNoSliders = new IncrementalSkill(26.25, 0.15);
    const speed = new IncrementalSkill(1400, 0.3);
    const fl = new IncrementalSkill(0.05, 0.15, false);
    const sliderStrains: number[] = [];
    let maxSliderStrain = 0;

    const great = d.window300 / rate;
    const preempt = d.preempt / rate;
    const base = {
        approachRate: preempt > 1200 ? (1800 - preempt) / 120 : (1200 - preempt) / 150 + 5,
        overallDifficulty: (80 - great) / 6,
        drainRate: d.hp,
        greatHitWindow: great,
        okHitWindow: d.window100 / rate,
        mehHitWindow: d.window50 / rate,
    };
    const out: OsuDifficultyAttributes[] = [];
    const stride = Math.max(1, Math.ceil(objs.length / 250));
    let counts = { circles: 0, sliders: 0, spinners: 0, combo: 0 };
    let aggregates = { speedNotes: 0, difficultSliders: 0, aimStrains: 0, speedStrains: 0 };
    for (let i = 0; i < objs.length; i++) {
        const h = objs[i];
        counts = {
            circles: counts.circles + (h.kind === 'circle' ? 1 : 0),
            sliders: counts.sliders + (h.kind === 'slider' ? 1 : 0),
            spinners: counts.spinners + (h.kind === 'spinner' ? 1 : 0),
            combo: counts.combo + comboOf(h),
        };
        if (i > 0) {
            const k = i - 1;
            const cur = objects[k];
            const prev = k > 0 ? objects[k - 1] : null;
            const a = aim.process(cur, aimStrain(cur, prev));
            if (cur.base.kind === 'slider') {
                sliderStrains.push(a);
                if (a > maxSliderStrain) maxSliderStrain = a;
            }
            aimNoSliders.process(cur, aimStrain(cur, prev, false));
            speed.process(cur, speedStrain(cur));
            if (flashlight) fl.process(cur, flashlightStrain(objects, k, hidden, d.circleRadius, d.preempt, d.fadeIn));
        }
        const aimValue = aim.difficultyValue();
        const speedValue = speed.difficultyValue();
        if (i % stride === 0 || i === objs.length - 1) {
            aggregates = {
                speedNotes: relevantCount(speed.strains, speed.maxStrain),
                difficultSliders: relevantCount(sliderStrains, maxSliderStrain),
                aimStrains: aim.countTopWeighted(aimValue),
                speedStrains: speed.countTopWeighted(speedValue),
            };
        }
        let aimRating = Math.sqrt(aimValue) * DIFFICULTY_MULTIPLIER;
        const aimNoSlidersRating = Math.sqrt(aimNoSliders.difficultyValue()) * DIFFICULTY_MULTIPLIER;
        let speedRating = Math.sqrt(speedValue) * DIFFICULTY_MULTIPLIER;
        let flRating = flashlight ? Math.sqrt(fl.difficultyValue()) * DIFFICULTY_MULTIPLIER : 0;
        const sliderFactor = aimRating > 0 ? aimNoSlidersRating / aimRating : 1;
        // Classic star rating, before the mod adjustments (as calculateDifficulty).
        const stars = aimRating + speedRating + Math.abs(aimRating - speedRating) / 2;
        if (opts.relax) {
            aimRating *= 0.9;
            speedRating = 0;
            flRating *= 0.7;
        } else if (opts.autopilot) {
            speedRating *= 0.5;
            aimRating = 0;
            flRating *= 0.4;
        }
        out.push({
            starRating: Math.round(stars * 100) / 100,
            aimDifficulty: aimRating,
            speedDifficulty: speedRating,
            flashlightDifficulty: flRating,
            sliderFactor,
            speedNoteCount: aggregates.speedNotes,
            aimDifficultSliderCount: aggregates.difficultSliders,
            aimDifficultStrainCount: aggregates.aimStrains,
            speedDifficultStrainCount: aggregates.speedStrains,
            ...base,
            maxCombo: counts.combo,
            hitCircleCount: counts.circles,
            sliderCount: counts.sliders,
            spinnerCount: counts.spinners,
        });
    }
    return out;
}

/** The whole map's attributes (the last timed entry). */
export function calculateDifficultyAttributes(beatmap: PlayableBeatmap, opts: AttributeOptions = {}): OsuDifficultyAttributes | null {
    const timed = calculateTimedAttributes(beatmap, opts);
    return timed.length ? timed[timed.length - 1] : null;
}
