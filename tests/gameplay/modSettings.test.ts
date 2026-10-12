import { describe, expect, it } from 'vitest';
import {
    audioPitch,
    extendedModInfo,
    extraLives,
    flashlightSettings,
    formatSetting,
    hasSettings,
    modSetting,
    modSettingDefs,
    modSettingsOf,
    modsKey,
    NO_MODS,
    playbackRate,
    preservesPitch,
    rateAdjustMultiplier,
    resetModSettings,
    restartOnFail,
    sanitizeModSettings,
    sanitizeMods,
    scoreMultiplier,
    toggleMod,
    usesDefaultConfiguration,
    withModSetting,
    withSettings,
} from '../../src/gameplay/mods';
import { ratingMods } from '../../src/screens/select/modStars';

const dt = (speed?: number, adjustPitch?: boolean) => {
    let m = sanitizeMods(['DT']);
    if (speed !== undefined) m = withModSetting(m, 'DT', 'speedChange', speed);
    if (adjustPitch !== undefined) m = withModSetting(m, 'DT', 'adjustPitch', adjustPitch);
    return m;
};

describe('mod settings model', () => {
    it("declares lazer's settings and defaults", () => {
        expect(modSettingDefs('DT').map(d => d.key)).toEqual(['speedChange', 'adjustPitch']);
        expect(modSettingDefs('NC').map(d => d.key)).toEqual(['speedChange']);
        expect(modSettingDefs('FL').map(d => d.key)).toEqual(['sizeMultiplier', 'comboBasedSize', 'followDelay']);
        expect(hasSettings('HR')).toBe(false);
        expect(modSetting(NO_MODS, 'DT', 'speedChange')).toBe(1.5);
        expect(modSetting(NO_MODS, 'HT', 'speedChange')).toBe(0.75);
        expect(modSetting(NO_MODS, 'DT', 'adjustPitch')).toBe(false);
        // ModPerfect turns Restart on by default; Sudden Death leaves it off.
        expect(modSetting(NO_MODS, 'PF', 'restart')).toBe(true);
        expect(modSetting(NO_MODS, 'SD', 'restart')).toBe(false);
        expect(modSetting(NO_MODS, 'EZ', 'retries')).toBe(2);
    });

    it('clamps and snaps values to range and precision', () => {
        expect(modSetting(dt(1.304), 'DT', 'speedChange')).toBe(1.3);
        expect(modSetting(dt(5), 'DT', 'speedChange')).toBe(2);
        expect(modSetting(dt(0.2), 'DT', 'speedChange')).toBe(1.01);
        const fl = withModSetting(sanitizeMods(['FL']), 'FL', 'followDelay', 290);
        expect(modSetting(fl, 'FL', 'followDelay')).toBe(240);
        const ht = withModSetting(sanitizeMods(['HT']), 'HT', 'speedChange', 0.999);
        expect(modSetting(ht, 'HT', 'speedChange')).toBe(0.99);
    });

    it('keeps only non-default settings of selected mods', () => {
        expect(dt(1.5).settings).toBeUndefined();
        expect(usesDefaultConfiguration(dt(1.5), 'DT')).toBe(true);
        const m = dt(1.3);
        expect(m.settings).toEqual({ DT: { speedChange: 1.3 } });
        expect(usesDefaultConfiguration(m, 'DT')).toBe(false);
        // Unselected mods can't be customised (lazer).
        expect(withModSetting(m, 'HT', 'speedChange', 0.6)).toBe(m);
        // Setting the same value is a no-op (no change notification loops).
        expect(withModSetting(m, 'DT', 'speedChange', 1.3)).toBe(m);
        expect(resetModSettings(m, 'DT').settings).toBeUndefined();
    });

    it('survives toggling other mods and resets when deselected (lazer)', () => {
        let m = dt(1.3);
        m = toggleMod(m, 'HD');
        expect(modSetting(m, 'DT', 'speedChange')).toBe(1.3);
        m = toggleMod(m, 'DT');
        expect(m.settings).toBeUndefined();
        m = toggleMod(m, 'DT');
        expect(modSetting(m, 'DT', 'speedChange')).toBe(1.5);
        // An incompatible pick drops the settings with the mod it replaces.
        expect(toggleMod(dt(1.3), 'HT').settings).toBeUndefined();
    });

    it('round-trips persisted settings and rejects junk', () => {
        const m = withModSetting(withModSetting(toggleMod(dt(1.25, true), 'FL'), 'FL', 'comboBasedSize', false), 'FL', 'sizeMultiplier', 1.5);
        const saved = JSON.parse(JSON.stringify({ mods: [...m], settings: modSettingsOf(m) }));
        const restored = sanitizeMods(saved.mods, saved.settings);
        expect(modsKey(restored)).toBe(modsKey(m));
        expect(flashlightSettings(restored)).toEqual({ sizeMultiplier: 1.5, comboBasedSize: false, followDelay: 120 });
        expect(sanitizeModSettings({ DT: { speedChange: 'x', bogus: 1 }, HT: { speedChange: 0.6 }, FL: [] }, ['DT'])).toEqual({});
        expect(sanitizeModSettings({ DT: { speedChange: '1.7', adjustPitch: 'yes' } }, ['DT'])).toEqual({ DT: { speedChange: 1.7 } });
        expect(sanitizeMods(['DT'], null).settings).toBeUndefined();
        expect(sanitizeMods(['DT'], [1, 2]).settings).toBeUndefined();
        expect(withSettings(['NC'], { NC: { speedChange: 1.2 } }).settings).toEqual({ NC: { speedChange: 1.2 } });
    });

    it('formats values and the extended icon text', () => {
        const [speed, pitch] = modSettingDefs('DT');
        expect(formatSetting(speed, 1.3)).toBe('1.30x');
        expect(formatSetting(pitch, true)).toBe('On');
        expect(formatSetting(modSettingDefs('FL')[2], 240)).toBe('240 ms');
        expect(formatSetting(modSettingDefs('FL')[0], 1.5)).toBe('1.5x');
        expect(extendedModInfo('DT', dt(1.3).settings)).toBe('1.30x');
        expect(extendedModInfo('DT', dt().settings)).toBe('');
        expect(extendedModInfo('HD', dt(1.3).settings)).toBe('');
    });
});

describe('rates and pitch', () => {
    it('uses the custom speed for every rate mod', () => {
        expect(playbackRate(dt(1.3))).toBe(1.3);
        expect(playbackRate(withModSetting(sanitizeMods(['NC']), 'NC', 'speedChange', 1.75))).toBe(1.75);
        expect(playbackRate(withModSetting(sanitizeMods(['HT']), 'HT', 'speedChange', 0.6))).toBe(0.6);
        expect(playbackRate(withModSetting(sanitizeMods(['DC']), 'DC', 'speedChange', 0.9))).toBe(0.9);
    });

    it('follows "Adjust pitch" for DT / HT and keeps nightcore pitch for NC / DC', () => {
        expect([audioPitch(dt()), preservesPitch(dt())]).toEqual([1, true]);
        expect([audioPitch(dt(1.3, true)), preservesPitch(dt(1.3, true))]).toEqual([1.3, false]);
        const ht = withModSetting(withModSetting(sanitizeMods(['HT']), 'HT', 'adjustPitch', true), 'HT', 'speedChange', 0.6);
        expect(audioPitch(ht)).toBe(0.6);
        // ModNightcore: frequency stays at SpeedChange.Default, tempo takes the rest.
        expect(audioPitch(withModSetting(sanitizeMods(['NC']), 'NC', 'speedChange', 1.2))).toBe(1.5);
        expect(audioPitch(sanitizeMods(['DC']))).toBe(0.75);
        expect(preservesPitch(sanitizeMods(['NC']))).toBe(false);
    });

    it('carries the custom rate into the star rating mods', () => {
        const rating = ratingMods(toggleMod(dt(1.3), 'HD'));
        expect(rating && [...rating]).toEqual(['DT']);
        expect(rating && playbackRate(rating)).toBe(1.3);
        expect(ratingMods(sanitizeMods(['HD', 'FL']))).toBeNull();
    });
});

describe('score multipliers (lazer OsuScoreMultiplierCalculatorV1)', () => {
    it('rateAdjustMultiplier floors the speed to 0.1 steps', () => {
        expect(rateAdjustMultiplier(1.5)).toBeCloseTo(1.1);
        expect(rateAdjustMultiplier(1.3)).toBeCloseTo(1.06);
        expect(rateAdjustMultiplier(1.39)).toBeCloseTo(1.06);
        expect(rateAdjustMultiplier(2)).toBeCloseTo(1.2);
        expect(rateAdjustMultiplier(1.01)).toBeCloseTo(1);
        expect(rateAdjustMultiplier(0.75)).toBeCloseTo(0.3);
        expect(rateAdjustMultiplier(0.5)).toBeCloseTo(0.1);
        expect(rateAdjustMultiplier(0.99)).toBeCloseTo(0.5);
    });

    it('applies custom rates and the default-configuration bonuses', () => {
        expect(scoreMultiplier(dt(1.3))).toBeCloseTo(1.06);
        expect(scoreMultiplier(withModSetting(sanitizeMods(['NC']), 'NC', 'speedChange', 2))).toBeCloseTo(1.2);
        expect(scoreMultiplier(withModSetting(sanitizeMods(['DC']), 'DC', 'speedChange', 0.5))).toBeCloseTo(0.1);
        expect(scoreMultiplier(sanitizeMods(['FL']))).toBeCloseTo(1.12);
        // Flashlight only rewards its default configuration.
        expect(scoreMultiplier(withModSetting(sanitizeMods(['FL']), 'FL', 'sizeMultiplier', 1.5))).toBeCloseTo(1);
        expect(scoreMultiplier(withModSetting(sanitizeMods(['EZ']), 'EZ', 'retries', 5))).toBeCloseTo(0.5);
        expect(scoreMultiplier(withModSetting(sanitizeMods(['PF']), 'PF', 'restart', false))).toBe(1);
    });
});

describe('fail overrides and lives', () => {
    it('restart on fail follows SD / PF settings', () => {
        expect(restartOnFail(NO_MODS)).toBe(false);
        expect(restartOnFail(sanitizeMods(['PF']))).toBe(true);
        expect(restartOnFail(sanitizeMods(['SD']))).toBe(false);
        expect(restartOnFail(withModSetting(sanitizeMods(['SD']), 'SD', 'restart', true))).toBe(true);
        expect(restartOnFail(withModSetting(sanitizeMods(['PF']), 'PF', 'restart', false))).toBe(false);
    });

    it('Easy lives are customisable', () => {
        expect(extraLives(NO_MODS)).toBe(0);
        expect(extraLives(sanitizeMods(['EZ']))).toBe(2);
        expect(extraLives(withModSetting(sanitizeMods(['EZ']), 'EZ', 'retries', 0))).toBe(0);
        expect(extraLives(withModSetting(sanitizeMods(['EZ']), 'EZ', 'retries', 7))).toBe(7);
    });
});
