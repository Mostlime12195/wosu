import { describe, expect, it } from 'vitest';
import { topLocalGrade, topLocalGrades, type Grade, type ScoreRecord } from '../../src/storage/ScoreStore';

const rec = (beatmapKey: string, score: number, grade: Grade, passed = true, date = 0): ScoreRecord => ({
    beatmapKey, beatmapId: 0, setId: 0, title: '', artist: '', version: '', creator: '', mods: [],
    score, accuracy: 1, maxCombo: 0, count300: 0, count100: 0, count50: 0, countMiss: 0, grade, passed, date, player: 'Guest',
});

describe('top local rank', () => {
    it('is the grade of the highest scoring pass', () => {
        expect(topLocalGrade([rec('a', 100, 'B'), rec('a', 300, 'A'), rec('a', 200, 'S')])).toBe('A');
    });

    it('keeps silver grades (Hidden / Flashlight)', () => {
        expect(topLocalGrade([rec('a', 900, 'XH'), rec('a', 100, 'X')])).toBe('XH');
        expect(topLocalGrade([rec('a', 900, 'SH')])).toBe('SH');
    });

    it('ignores fails, and is null without a pass', () => {
        expect(topLocalGrade([rec('a', 999, 'F', false), rec('a', 10, 'D')])).toBe('D');
        expect(topLocalGrade([rec('a', 999, 'F', false)])).toBeNull();
        expect(topLocalGrade([])).toBeNull();
    });

    it('breaks score ties by the older play', () => {
        expect(topLocalGrade([rec('a', 500, 'A', true, 20), rec('a', 500, 'S', true, 10)])).toBe('S');
    });

    it('indexes every difficulty', () => {
        const m = topLocalGrades([rec('a', 1, 'C'), rec('b', 5, 'S'), rec('b', 9, 'A'), rec('c', 9, 'F', false)]);
        expect(Object.fromEntries(m)).toEqual({ a: 'C', b: 'A' });
    });
});
