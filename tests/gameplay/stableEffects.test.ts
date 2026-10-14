import { describe, expect, it } from 'vitest';
import type { PlayableHitObject, TimingPoint } from '../../src/beatmap/types';
import { ComboBurstSchedule, burstFrame, isComboMilestone, milestoneOrdinal } from '../../src/gameplay/comboBurst';
import { NightcoreBeats, nightcoreBeatAt, nightcorePlaysHats, nightcoreSamples, redLines, type NightcoreSample } from '../../src/gameplay/NightcoreBeats';
import { ComboEndTracker, comboEndKind, comboEndVariant } from '../../src/gameplay/scoring/comboEnd';
import { ScoreProcessor, type HitResult } from '../../src/gameplay/scoring/ScoreProcessor';
import { parseSkinIni } from '../../src/skin/SkinIni';

/** Objects with only the combo flags ComboEndTracker reads. */
function combos(...sizes: number[]): PlayableHitObject[] {
    const out: PlayableHitObject[] = [];
    for (const n of sizes) {
        for (let i = 0; i < n; i++) out.push({ newCombo: i === 0, lastInCombo: i === n - 1 } as PlayableHitObject);
    }
    return out;
}

describe('geki / katu (stable combo-end judgements)', () => {
    it('classifies a combo by its worst judgement and its last one', () => {
        expect(comboEndVariant('great', 'great')).toBe('geki');
        expect(comboEndVariant('ok', 'great')).toBe('katu');
        expect(comboEndVariant('ok', 'ok')).toBe('katu');
        expect(comboEndVariant('meh', 'great')).toBeNull();
        expect(comboEndVariant('miss', 'great')).toBeNull();
        expect(comboEndVariant('meh', 'meh')).toBeNull();
    });

    it('picks hit300g / hit300k / hit100k for the last object', () => {
        expect(comboEndKind('great', 'geki')).toBe('geki');
        expect(comboEndKind('great', 'katu')).toBe('katuGreat');
        expect(comboEndKind('ok', 'katu')).toBe('katuOk');
        expect(comboEndKind('great', null)).toBeNull();
        expect(comboEndKind('meh', 'katu')).toBeNull();
    });

    it('tracks each combo separately, even when a long object ends its combo late', () => {
        const t = ComboEndTracker.forObjects(combos(3, 2, 2));
        const r: (HitResult)[] = ['great', 'ok', 'great', 'great', 'great', 'great', 'meh'];
        // Combo 2's last object (index 4) is judged after combo 3 started (index 5).
        expect([0, 1, 2].map(i => t.apply(i, r[i]))).toEqual([null, null, 'katu']);
        expect(t.apply(3, r[3])).toBeNull();
        expect(t.apply(5, r[5])).toBeNull();
        expect(t.apply(4, r[4])).toBe('geki');
        expect(t.apply(6, r[6])).toBeNull();
    });

    it('a miss anywhere in the combo spoils it', () => {
        const t = ComboEndTracker.forObjects(combos(3));
        t.apply(0, 'miss');
        t.apply(1, 'great');
        expect(t.apply(2, 'great')).toBeNull();
    });

    it('counts gekis and katus on the score', () => {
        const s = new ScoreProcessor({ difficultyMultiplier: 1, modMultiplier: 1 });
        s.applyMain('great', true, 'geki');
        s.applyMain('great', true, 'katu');
        s.applyMain('ok', true, 'katu');
        s.applyMain('great', true, null);
        expect([s.countGeki, s.countKatu, s.count300, s.count100]).toEqual([1, 2, 3, 1]);
    });
});

describe('combo bursts', () => {
    it('fires at 30, 60, 100 and every 50 after', () => {
        const hits = Array.from({ length: 400 }, (_, i) => i + 1).filter(isComboMilestone);
        expect(hits).toEqual([30, 60, 100, 150, 200, 250, 300, 350, 400]);
        expect([30, 60, 100, 150, 250].map(milestoneOrdinal)).toEqual([0, 1, 2, 3, 5]);
        expect(milestoneOrdinal(31)).toBe(-1);
    });

    it('goes through the images in turn and alternates sides, starting on the right', () => {
        const s = new ComboBurstSchedule({ images: 2, sounds: 0 });
        expect(s.image(29)).toBeNull();
        expect(s.image(30)).toEqual({ image: 0, side: 'right' });
        expect(s.image(60)).toEqual({ image: 1, side: 'left' });
        expect(s.image(100)).toEqual({ image: 0, side: 'right' });
        // After a combo break the set starts over; the sides keep alternating.
        expect(s.image(30)).toEqual({ image: 0, side: 'left' });
    });

    it('shows nothing without comboburst images', () => {
        expect(new ComboBurstSchedule({ images: 0, sounds: 1 }).image(30)).toBeNull();
    });

    it('picks random images with ComboBurstRandom', () => {
        const s = new ComboBurstSchedule({ images: 4, sounds: 0, random: true, rng: () => 0.8 });
        expect(s.image(30)?.image).toBe(3);
        expect(s.image(60)?.image).toBe(3);
    });

    it('plays sounds at the milestones, or only at CustomComboBurstSounds combos', () => {
        const plain = new ComboBurstSchedule({ images: 1, sounds: 3 });
        expect([30, 45, 60, 100, 150].map(c => plain.sound(c))).toEqual([0, -1, 1, 2, 0]);
        const custom = new ComboBurstSchedule({ images: 1, sounds: 2, customSounds: [50, 75, 125] });
        expect([30, 50, 60, 75, 100, 125].map(c => custom.sound(c))).toEqual([-1, 0, -1, 1, -1, 0]);
        expect(new ComboBurstSchedule({ images: 1, sounds: 0 }).sound(30)).toBe(-1);
    });

    it('reads the skin.ini settings', () => {
        const ini = parseSkinIni('[General]\nComboBurstRandom: 1\nCustomComboBurstSounds: 50, 100,x,150\nSpinnerFrequencyModulate: 0\n');
        expect(ini).toMatchObject({ comboBurstRandom: true, customComboBurstSounds: [50, 100, 150], spinnerFrequencyModulate: false });
    });

    it('slides in, then fades', () => {
        expect(burstFrame(0)?.offset).toBe(1);
        expect(burstFrame(350)!.offset).toBeCloseTo(0.25);
        expect(burstFrame(700)).toEqual({ offset: 0, alpha: 0.8 });
        expect(burstFrame(700 + 480)!.alpha).toBeCloseTo(0.4);
        expect(burstFrame(700 + 960)).toBeNull();
    });
});

const red = (time: number, beatLength: number, meter = 4, omitFirstBarLine = false): TimingPoint => ({
    time, beatLength, meter, omitFirstBarLine, uninherited: true, kiai: false, sampleSet: 0, sampleIndex: 0, volume: 100,
} as TimingPoint);

describe('Nightcore beat', () => {
    it('counts half-beats from the red line in effect', () => {
        const lines = redLines([red(1000, 500), { ...red(1500, -100), uninherited: false }, red(5000, 300)]);
        expect(lines).toHaveLength(2);
        expect(nightcoreBeatAt(lines, 1000)).toMatchObject({ line: 0, index: 0, since: 0 });
        expect(nightcoreBeatAt(lines, 1260)).toMatchObject({ line: 0, index: 1, since: 10 });
        expect(nightcoreBeatAt(lines, 900)!.index).toBe(-1);
        expect(nightcoreBeatAt(lines, 5000)).toMatchObject({ line: 1, index: 0 });
        // Half-beats under 50 ms double up.
        expect(nightcoreBeatAt([red(0, 60)], 70)!.index).toBe(1);
    });

    it('plays kick, hat, clap, hat in 4/4 with a finish every 4 bars', () => {
        const bar = Array.from({ length: 8 }, (_, i) => nightcoreSamples(i, 4, false, true));
        expect(bar).toEqual([
            ['nightcore-finish', 'nightcore-kick'], ['nightcore-hat'], ['nightcore-clap'], ['nightcore-hat'],
            ['nightcore-kick'], ['nightcore-hat'], ['nightcore-clap'], ['nightcore-hat'],
        ]);
        expect(nightcoreSamples(32, 4, false, true)).toEqual(['nightcore-finish', 'nightcore-kick']);
        expect(nightcoreSamples(8, 4, false, true)).toEqual(['nightcore-kick']);
        expect(nightcoreSamples(1, 4, false, false)).toEqual([]);
        expect(nightcoreSamples(-1, 4, false, true)).toEqual([]);
    });

    it('follows 3/4, skips the first finish when the bar line is omitted, and only finishes other meters', () => {
        expect(Array.from({ length: 6 }, (_, i) => nightcoreSamples(i, 3, false, true)[0])).toEqual([
            'nightcore-finish', 'nightcore-hat', 'nightcore-hat', 'nightcore-clap', 'nightcore-hat', 'nightcore-hat',
        ]);
        expect(nightcoreSamples(0, 4, true, true)).toEqual(['nightcore-kick']);
        expect(nightcoreSamples(32, 4, true, true)).toEqual(['nightcore-finish', 'nightcore-kick']);
        expect(nightcoreSamples(0, 5, false, true)).toEqual(['nightcore-finish']);
        expect(nightcoreSamples(3, 5, false, true)).toEqual([]);
    });

    it('plays hats only for even slider tick rates', () => {
        expect([1, 2, 3, 4, 0.5].map(nightcorePlaysHats)).toEqual([false, true, false, true, false]);
    });

    it('fires each half-beat once as time advances, and not after a jump', () => {
        const played: [number, NightcoreSample][] = [];
        let now = 0;
        const nc = new NightcoreBeats([red(0, 500)], true, s => played.push([now, s]));
        for (now = -100; now <= 1010; now += 10) nc.update(now);
        expect(played.map(([t, s]) => `${t}:${s.slice(10)}`)).toEqual([
            '0:finish', '0:kick', '250:hat', '500:clap', '750:hat', '1000:kick',
        ]);
        played.length = 0;
        now = 1400;
        nc.update(now); // 150 ms past a half-beat: a seek, stays silent
        expect(played).toEqual([]);
    });

    it('still plays the beats a slow frame crosses', () => {
        const played: string[] = [];
        const nc = new NightcoreBeats([red(0, 500)], false, s => played.push(s));
        for (let t = 0; t <= 1100; t += 110) nc.update(t);
        expect(played).toEqual(['nightcore-finish', 'nightcore-kick', 'nightcore-clap', 'nightcore-kick']);
    });
});
