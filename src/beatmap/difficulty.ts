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
    spinner: boolean;
    startTime: number;
    deltaTime: number;
    strainTime: number;
    jumpDistance: number;
    travelDistance: number;
    angle: number | null;
}

interface LazySlider {
    end: Vec;
    travel: number;
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
    r = { end, travel };
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
        out.push({
            spinner: cur.kind === 'spinner',
            startTime: cur.time / rate,
            deltaTime,
            strainTime: Math.max(MIN_DELTA_TIME, deltaTime),
            jumpDistance: cur.kind === 'spinner' ? 0 : jumpDistance,
            travelDistance,
            angle,
        });
    }
    return out;
}

const diminish = (v: number): number => Math.pow(v, 0.99);

function aimStrain(cur: DiffObject, prev: DiffObject | null): number {
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
    const travel = diminish(cur.travelDistance);
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
