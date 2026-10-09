import { describe, expect, it } from 'vitest';
import {
    adjustDifficulty,
    inputMode,
    modsString,
    NO_MODS,
    parseLegacyModString,
    playbackRate,
    preservesPitch,
    sanitizeMods,
    scoreMultiplier,
    toggleMod,
} from '../../src/gameplay/mods';

describe('mods', () => {
    it('rate mods resolve rate and pitch behaviour', () => {
        expect(playbackRate(NO_MODS)).toBe(1);
        expect(preservesPitch(NO_MODS)).toBe(true);
        expect([playbackRate(sanitizeMods(['DT'])), preservesPitch(sanitizeMods(['DT']))]).toEqual([1.5, true]);
        expect([playbackRate(sanitizeMods(['NC'])), preservesPitch(sanitizeMods(['NC']))]).toEqual([1.5, false]);
        expect([playbackRate(sanitizeMods(['HT'])), preservesPitch(sanitizeMods(['HT']))]).toEqual([0.75, true]);
        expect([playbackRate(sanitizeMods(['DC'])), preservesPitch(sanitizeMods(['DC']))]).toEqual([0.75, false]);
    });

    it('toggleMod enforces exclusivity both ways', () => {
        let m = toggleMod(NO_MODS, 'DT');
        m = toggleMod(m, 'HT');
        expect([...m]).toEqual(['HT']);
        m = toggleMod(toggleMod(m, 'EZ'), 'HR');
        expect(m.has('EZ')).toBe(false);
        expect(m.has('HR')).toBe(true);
        m = toggleMod(m, 'HR');
        expect(m.has('HR')).toBe(false);
        const auto = toggleMod(toggleMod(toggleMod(NO_MODS, 'RX'), 'NF'), 'AT');
        expect([...auto]).toEqual(['AT']);
    });

    it('sanitizeMods resolves corrupt combinations deterministically', () => {
        expect(modsString(sanitizeMods(['DT', 'HT', 'DC']))).toBe('DC');
        expect(modsString(sanitizeMods(['EZ', 'HR', 'junk', 7]))).toBe('HR');
        expect(inputMode(sanitizeMods(['RX', 'AP', 'AT']))).toBe('autoplay');
        expect(inputMode(NO_MODS)).toBe('normal');
    });

    it('formats in canonical order and multiplies score', () => {
        const m = sanitizeMods(['DT', 'HR', 'HD']);
        expect(modsString(m)).toBe('HRDTHD');
        expect(scoreMultiplier(m)).toBeCloseTo(1.06 * 1.12 * 1.06);
        expect(modsString(parseLegacyModString('EZ+HD'), '+')).toBe('EZ+HD');
        expect(parseLegacyModString('').size).toBe(0);
    });

    it('adjustDifficulty applies HR caps and EZ halving', () => {
        expect(adjustDifficulty({ cs: 8, ar: 9, od: 9, hp: 9 }, sanitizeMods(['HR']))).toEqual({ cs: 10, ar: 10, od: 10, hp: 10 });
        const hr = adjustDifficulty({ cs: 4, ar: 5, od: 5, hp: 5 }, sanitizeMods(['HR']));
        expect(hr.cs).toBeCloseTo(5.2);
        expect(hr.ar).toBeCloseTo(7);
        expect(adjustDifficulty({ cs: 4, ar: 8, od: 6, hp: 2 }, sanitizeMods(['EZ']))).toEqual({ cs: 2, ar: 4, od: 3, hp: 1 });
        expect(adjustDifficulty({ cs: 4, ar: 8, od: 6, hp: 2 }, NO_MODS)).toEqual({ cs: 4, ar: 8, od: 6, hp: 2 });
    });
});
