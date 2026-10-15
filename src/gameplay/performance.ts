/**
 * osu!standard performance points: lazer's OsuPerformanceCalculator (the
 * 2025 formula: aim, speed, accuracy and flashlight values combined as a
 * 1.1-norm, with the effective miss count estimated from combo, the
 * difficult-slider nerf for dropped sliders and the speed nerf for a
 * high estimated tapping deviation).
 *
 * The attributes come from wosu!'s own difficulty calculation
 * (beatmap/difficulty), whose aim and speed skills are the classic strain
 * model rather than the current one, so results are an estimate: close
 * on typical maps, not the official figure.
 */
import type { OsuDifficultyAttributes } from '../beatmap/difficulty';

/** Scales the final value to stay around what it used to be as the formula changes. */
export const PERFORMANCE_BASE_MULTIPLIER = 1.15;

export interface PerformanceScore {
    /** 0..1, the score's accuracy (lazer's, or stable's with classic sliders). */
    accuracy: number;
    maxCombo: number;
    countGreat: number;
    countOk: number;
    countMeh: number;
    countMiss: number;
    /** Slider tails missed (non-classic scores; they drop combo-less judgements). */
    sliderEndsDropped?: number;
    /** Slider ticks / repeats missed (non-classic scores). */
    largeTickMisses?: number;
    /** osu!stable-style sliders (lazer's Classic "no slider head accuracy"): ends and ticks are unknown. */
    classicSliderAccuracy: boolean;
    /** Mod acronyms (NF, SO, RX, AP, HD, FL… matter). */
    mods: ReadonlySet<string>;
}

export interface PerformanceResult {
    total: number;
    aim: number;
    speed: number;
    accuracy: number;
    flashlight: number;
    effectiveMissCount: number;
    /** Estimated tapping deviation on speed notes (ms), null when nothing was hit. */
    speedDeviation: number | null;
}

/** lazer's OsuStrainSkill.DifficultyToPerformance. */
export function difficultyToPerformance(difficulty: number): number {
    return Math.pow(5 * Math.max(1, difficulty / 0.0675) - 4, 3) / 100000;
}

/** lazer's Flashlight.DifficultyToPerformance. */
export function flashlightToPerformance(difficulty: number): number {
    return 25 * Math.pow(difficulty, 2);
}

/** The error function (W. J. Cody's rational approximations, ~1e-15 relative). */
export function erf(x: number): number {
    if (Number.isNaN(x)) return NaN;
    if (x < 0) return -erf(-x);
    if (x === Infinity) return 1;
    if (x < 0.5) {
        const t = x * x;
        const p = [3.16112374387056560e00, 1.13864154151050156e02, 3.77485237685302021e02, 3.20937758913846947e03, 1.85777706184603153e-1];
        const q = [2.36012909523441209e01, 2.44024637934444173e02, 1.28261652607737228e03, 2.84423683343917062e03];
        let num = p[4] * t;
        let den = t;
        for (let i = 0; i < 3; i++) {
            num = (num + p[i]) * t;
            den = (den + q[i]) * t;
        }
        return (x * (num + p[3])) / (den + q[3]);
    }
    return 1 - erfc(x);
}

/** Complementary error function for x ≥ 0.5 (Cody). */
function erfc(x: number): number {
    let result: number;
    if (x <= 4) {
        const c = [5.64188496988670089e-1, 8.88314979438837594e00, 6.61191906371416295e01, 2.98635138197400131e02,
            8.81952221241769090e02, 1.71204761263407058e03, 2.05107837782607147e03, 1.23033935479799725e03, 2.15311535474403846e-8];
        const d = [1.57449261107098347e01, 1.17693950891312499e02, 5.37181101862009858e02, 1.62138957456669019e03,
            3.29079923573345963e03, 4.36261909014324716e03, 3.43936767414372164e03, 1.23033935480374942e03];
        let num = c[8] * x;
        let den = x;
        for (let i = 0; i < 7; i++) {
            num = (num + c[i]) * x;
            den = (den + d[i]) * x;
        }
        result = (num + c[7]) / (den + d[7]);
    } else {
        if (x >= 26.6) return 0;
        const p = [3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1, 1.60837851487422766e-2,
            6.58749161529837803e-4, 1.63153871373020978e-2];
        const q = [2.56852019228982242e00, 1.87295284992346725e00, 5.27905102951428412e-1, 6.05183413124413191e-2,
            2.33520497626869185e-3];
        const z = 1 / (x * x);
        let num = p[5] * z;
        let den = z;
        for (let i = 0; i < 4; i++) {
            num = (num + p[i]) * z;
            den = (den + q[i]) * z;
        }
        result = (z * (num + p[4])) / (den + q[4]);
        result = (1 / Math.sqrt(Math.PI) - result) / x;
    }
    const xsq = Math.trunc(x * 16) / 16;
    const del = (x - xsq) * (x + xsq);
    return Math.exp(-xsq * xsq) * Math.exp(-del) * result;
}

/** Inverse error function: Giles' approximation polished with Newton steps on erf. */
export function erfInv(y: number): number {
    if (y <= -1) return -Infinity;
    if (y >= 1) return Infinity;
    if (y === 0) return 0;
    let w = -Math.log((1 - y) * (1 + y));
    let x: number;
    if (w < 6.25) {
        w -= 3.125;
        let p = -3.6444120640178196996e-21;
        for (const c of [-1.685059138182016589e-19, 1.2858480715256400167e-18, 1.115787767802518096e-17, -1.333171662854620906e-16,
            2.0972767875968561637e-17, 6.6376381343583238325e-15, -4.0545662729752068639e-14, -8.1519341976054721522e-14,
            2.6335093153082322977e-12, -1.2975133253453532498e-11, -5.4154120542946279317e-11, 1.051212273321532285e-09,
            -4.1126339803469836976e-09, -2.9070369957882005086e-08, 4.2347877827932403518e-07, -1.3654692000834678645e-06,
            -1.3882523362786468719e-05, 0.0001867342080340571352, -0.00074070253416626697512, -0.0060336708714301490533,
            0.24015818242558961693, 1.6536545626831027356]) p = c + p * w;
        x = p * y;
    } else if (w < 16) {
        w = Math.sqrt(w) - 3.25;
        let p = 2.2137376921775787049e-09;
        for (const c of [9.0756561938885390979e-08, -2.7517406297064545428e-07, 1.8239629214389227755e-08, 1.5027403968909827627e-06,
            -4.013867526981545969e-06, 2.9234449089955446044e-06, 1.2475304481671778723e-05, -4.7318229009055733981e-05,
            6.8284851459573175448e-05, 2.4031110387097893999e-05, -0.0003550375203628474796, 0.00095328937973738049703,
            -0.0016882755560235047313, 0.0024914420961078508066, -0.0037512085075692412107, 0.005370914553590063617,
            1.0052589676941592334, 3.0838856104922207635]) p = c + p * w;
        x = p * y;
    } else {
        w = Math.sqrt(w) - 5;
        let p = -2.7109920616438573243e-11;
        for (const c of [-2.5556418169965252055e-10, 1.5076572693500548083e-09, -3.7894654401267369937e-09, 7.6157012080783393804e-09,
            -1.4960026627149240478e-08, 2.9147953450901080826e-08, -6.7711997758452339498e-08, 2.2900482228026654717e-07,
            -9.9298272942317002539e-07, 4.5260625972231537039e-06, -1.9681778105531670567e-05, 7.5995277030017761139e-05,
            -0.00021503011930044477347, -0.00013871931833623122026, 1.0103004648645343977, 4.8499064014085844221]) p = c + p * w;
        x = p * y;
    }
    // Newton on erf(x) = y.
    for (let i = 0; i < 2; i++) {
        const err = erf(x) - y;
        x -= err / ((2 / Math.sqrt(Math.PI)) * Math.exp(-x * x));
    }
    return x;
}

const reverseLerp = (x: number, start: number, end: number) => Math.max(0, Math.min(1, (x - start) / (end - start)));

/** pp for a (possibly partial) score against the attributes of the part of the map it covers. */
export function calculatePerformance(attr: OsuDifficultyAttributes, score: PerformanceScore): PerformanceResult {
    const mods = score.mods;
    const { countGreat, countOk, countMeh, countMiss } = score;
    const totalHits = countGreat + countOk + countMeh + countMiss;
    const totalSuccessfulHits = countGreat + countOk + countMeh;
    const totalImperfectHits = countOk + countMeh + countMiss;
    const classic = score.classicSliderAccuracy;
    const sliderEndsDropped = score.sliderEndsDropped ?? 0;
    const tickMisses = score.largeTickMisses ?? 0;
    const { overallDifficulty: od, approachRate: ar } = attr;
    const accuracy = score.accuracy;
    const scoreMaxCombo = score.maxCombo;
    const empty: PerformanceResult = { total: 0, aim: 0, speed: 0, accuracy: 0, flashlight: 0, effectiveMissCount: 0, speedDeviation: null };
    if (totalHits === 0) return empty;

    // Combo breaks: misses, or more when the combo says sliders were dropped too.
    let effectiveMissCount = countMiss;
    if (attr.sliderCount > 0) {
        if (classic) {
            // Unknown dropped slider ends: assume 10% of sliders.
            const fullComboThreshold = attr.maxCombo - 0.1 * attr.sliderCount;
            if (scoreMaxCombo < fullComboThreshold) effectiveMissCount = fullComboThreshold / Math.max(1, scoreMaxCombo);
            effectiveMissCount = Math.min(effectiveMissCount, totalImperfectHits);
        } else {
            const fullComboThreshold = attr.maxCombo - sliderEndsDropped;
            if (scoreMaxCombo < fullComboThreshold) effectiveMissCount = fullComboThreshold / Math.max(1, scoreMaxCombo);
            effectiveMissCount = Math.min(effectiveMissCount, tickMisses + countMiss);
        }
    }
    effectiveMissCount = Math.max(countMiss, effectiveMissCount);
    effectiveMissCount = Math.min(totalHits, effectiveMissCount);

    let multiplier = PERFORMANCE_BASE_MULTIPLIER;
    if (mods.has('NF')) multiplier *= Math.max(0.9, 1 - 0.02 * effectiveMissCount);
    if (mods.has('SO') && totalHits > 0) multiplier *= 1 - Math.pow(attr.spinnerCount / totalHits, 0.85);
    if (mods.has('RX')) {
        // OD 13.33 is where the great window closes.
        const okMultiplier = 0.75 * Math.max(0, od > 0 ? 1 - od / 13.33 : 1);
        const mehMultiplier = Math.max(0, od > 0 ? 1 - Math.pow(od / 13.33, 5) : 1);
        effectiveMissCount = Math.min(effectiveMissCount + countOk * okMultiplier + countMeh * mehMultiplier, totalHits);
    }

    const great = attr.greatHitWindow, ok = attr.okHitWindow, meh = attr.mehHitWindow;

    /**
     * The tapping deviation the hits imply, at 99% confidence, assuming a
     * mean error of 0: greats and oks normally distributed, mehs uniform.
     */
    const deviationOf = (g: number, o: number, m: number, x: number): number | null => {
        if (g + o + m <= 0) return null;
        const objectCount = g + o + m + x;
        const n = Math.max(1, objectCount - x - m);
        const z = 2.32634787404;
        const p = g / n;
        const pLower = (n * p + (z * z) / 2) / (n + z * z) - (z / (n + z * z)) * Math.sqrt(n * p * (1 - p) + (z * z) / 4);
        let deviation = great / (Math.SQRT2 * erfInv(pLower));
        const randomValue = (Math.sqrt(2 / Math.PI) * ok * Math.exp(-0.5 * Math.pow(ok / deviation, 2))) / (deviation * erf(ok / (Math.SQRT2 * deviation)));
        deviation *= Math.sqrt(1 - randomValue);
        const limitValue = ok / Math.sqrt(3);
        if (pLower === 0 || randomValue >= 1 || deviation > limitValue || !Number.isFinite(deviation)) deviation = limitValue;
        const mehVariance = (meh * meh + ok * meh + ok * ok) / 3;
        return Math.sqrt(((g + o) * deviation * deviation + m * mehVariance) / (g + o + m));
    };

    // Worst case for speed: every mistake was on a speed note.
    let speedDeviation: number | null = null;
    if (totalSuccessfulHits > 0) {
        const speedNotes = attr.speedNoteCount + (totalHits - attr.speedNoteCount) * 0.1;
        const relMiss = Math.min(countMiss, speedNotes);
        const relMeh = Math.min(countMeh, speedNotes - relMiss);
        const relOk = Math.min(countOk, speedNotes - relMiss - relMeh);
        const relGreat = Math.max(0, speedNotes - relMiss - relMeh - relOk);
        speedDeviation = deviationOf(relGreat, relOk, relMeh, relMiss);
    }

    const lengthBonus = 0.95 + 0.4 * Math.min(1, totalHits / 2000) + (totalHits > 2000 ? Math.log10(totalHits / 2000) * 0.5 : 0);
    const missPenalty = (strainCount: number) => 0.96 / (effectiveMissCount / (4 * Math.pow(Math.log(strainCount), 0.94)) + 1);

    // Aim.
    let aim = 0;
    if (!mods.has('AP')) {
        let aimDifficulty = attr.aimDifficulty;
        if (attr.sliderCount > 0 && attr.aimDifficultSliderCount > 0) {
            const improperlyFollowed = classic
                ? Math.max(0, Math.min(Math.min(totalImperfectHits, attr.maxCombo - scoreMaxCombo), attr.aimDifficultSliderCount))
                : Math.max(0, Math.min(sliderEndsDropped + tickMisses, attr.aimDifficultSliderCount));
            const sliderNerf = (1 - attr.sliderFactor) * Math.pow(1 - improperlyFollowed / attr.aimDifficultSliderCount, 3) + attr.sliderFactor;
            aimDifficulty *= sliderNerf;
        }
        aim = difficultyToPerformance(aimDifficulty) * lengthBonus;
        if (effectiveMissCount > 0) aim *= missPenalty(attr.aimDifficultStrainCount);
        let arFactor = 0;
        if (ar > 10.33) arFactor = 0.3 * (ar - 10.33);
        else if (ar < 8) arFactor = 0.05 * (8 - ar);
        if (mods.has('RX')) arFactor = 0;
        aim *= 1 + arFactor * lengthBonus;
        if (mods.has('HD')) aim *= 1 + 0.04 * (12 - ar);
        aim *= accuracy;
        aim *= 0.98 + Math.pow(Math.max(0, od), 2) / 2500;
    }

    // Speed.
    let speed = 0;
    if (!mods.has('RX') && speedDeviation !== null) {
        speed = difficultyToPerformance(attr.speedDifficulty) * lengthBonus;
        if (effectiveMissCount > 0) speed *= missPenalty(attr.speedDifficultStrainCount);
        let arFactor = ar > 10.33 ? 0.3 * (ar - 10.33) : 0;
        if (mods.has('AP')) arFactor = 0;
        speed *= 1 + arFactor * lengthBonus;
        if (mods.has('HD')) speed *= 1 + 0.04 * (12 - ar);
        // Speed above what the deviation says was tapped properly scales logarithmically.
        const raw = difficultyToPerformance(attr.speedDifficulty);
        const cutoff = 100 + 220 * Math.pow(22 / speedDeviation, 6.5);
        if (raw > cutoff) {
            const scale = 50;
            let adjusted = scale * (Math.log((raw - cutoff) / scale + 1) + cutoff / scale);
            const t = 1 - reverseLerp(speedDeviation, 22, 27);
            adjusted = adjusted + (raw - adjusted) * t;
            speed *= adjusted / raw;
        }
        const relevantTotalDiff = Math.max(0, totalHits - attr.speedNoteCount);
        const relGreat = Math.max(0, countGreat - relevantTotalDiff);
        const relOk = Math.max(0, countOk - Math.max(0, relevantTotalDiff - countGreat));
        const relMeh = Math.max(0, countMeh - Math.max(0, relevantTotalDiff - countGreat - countOk));
        const relevantAccuracy = attr.speedNoteCount === 0 ? 0 : (relGreat * 6 + relOk * 2 + relMeh) / (attr.speedNoteCount * 6);
        speed *= (0.95 + Math.pow(Math.max(0, od), 2) / 750) * Math.pow((accuracy + relevantAccuracy) / 2, (14.5 - od) / 2);
    }

    // Accuracy (timing on circles; and slider heads unless sliders are classic).
    let accuracyValue = 0;
    if (!mods.has('RX')) {
        let objectsWithAccuracy = attr.hitCircleCount;
        if (!classic) objectsWithAccuracy += attr.sliderCount;
        let better = objectsWithAccuracy > 0
            ? ((countGreat - Math.max(totalHits - objectsWithAccuracy, 0)) * 6 + countOk * 2 + countMeh) / (objectsWithAccuracy * 6)
            : 0;
        if (better < 0) better = 0;
        accuracyValue = Math.pow(1.52163, od) * Math.pow(better, 24) * 2.83;
        accuracyValue *= Math.min(1.15, Math.pow(objectsWithAccuracy / 1000, 0.3));
        if (mods.has('HD')) accuracyValue *= 1.08;
        if (mods.has('FL')) accuracyValue *= 1.02;
    }

    // Flashlight.
    let flashlight = 0;
    if (mods.has('FL')) {
        flashlight = flashlightToPerformance(attr.flashlightDifficulty);
        if (effectiveMissCount > 0) {
            flashlight *= 0.97 * Math.pow(1 - Math.pow(effectiveMissCount / totalHits, 0.775), Math.pow(effectiveMissCount, 0.875));
        }
        flashlight *= attr.maxCombo <= 0 ? 1 : Math.min(Math.pow(scoreMaxCombo, 0.8) / Math.pow(attr.maxCombo, 0.8), 1);
        flashlight *= 0.7 + 0.1 * Math.min(1, totalHits / 200) + (totalHits > 200 ? 0.2 * Math.min(1, (totalHits - 200) / 200) : 0);
        flashlight *= 0.5 + accuracy / 2;
        flashlight *= 0.98 + Math.pow(Math.max(0, od), 2) / 2500;
    }

    const total = Math.pow(
        Math.pow(aim, 1.1) + Math.pow(speed, 1.1) + Math.pow(accuracyValue, 1.1) + Math.pow(flashlight, 1.1),
        1 / 1.1,
    ) * multiplier;
    return { total: Number.isFinite(total) ? total : 0, aim, speed, accuracy: accuracyValue, flashlight, effectiveMissCount, speedDeviation };
}
