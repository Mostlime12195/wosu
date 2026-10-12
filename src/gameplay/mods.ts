/**
 * osu!standard mod catalogue, combination rules and per-mod settings.
 *
 * A selection is a ReadonlySet of acronyms that may also carry the
 * selected mods' customised settings (`ModSet.settings`, lazer's
 * [SettingSource] values). Every mutation goes through `toggleMod`,
 * `withModSetting` or `sanitizeMods`, which enforce the incompatibility
 * rules and keep only non-default settings of selected mods, so persisted
 * or UI state can never hold a nonsense combination (e.g. DT+HT, EZ+HR).
 * Like lazer, deselecting a mod resets its settings to their defaults.
 */
export type ModAcronym =
    | 'EZ' | 'NF' | 'HT' | 'DC'
    | 'HR' | 'SD' | 'PF' | 'DT' | 'NC' | 'HD' | 'FL'
    | 'RX' | 'AP' | 'SO' | 'AT';

export type ModCategory = 'reduction' | 'increase' | 'automation';

export interface ModInfo {
    acronym: ModAcronym;
    name: string;
    description: string;
    category: ModCategory;
    /** ScoreV1 multiplier at the mod's default configuration (see `scoreMultiplier`). */
    scoreMultiplier: number;
    incompatible: readonly ModAcronym[];
    /** Default playback rate for rate-changing mods (customisable: "Speed increase/decrease"). */
    rate?: number;
    /** Excluded from score submission-ish features (history ranking). */
    unranked?: boolean;
}

const RATE = ['HT', 'DC', 'DT', 'NC'] as const;
type RateMod = typeof RATE[number];
const AUTO = ['RX', 'AP', 'AT'] as const;

export const MODS: readonly ModInfo[] = [
    { acronym: 'EZ', name: 'Easy', description: 'Larger circles, more forgiving HP drain, less accuracy required, and extra lives!', category: 'reduction', scoreMultiplier: 0.5, incompatible: ['HR'] },
    { acronym: 'NF', name: 'No Fail', description: "You can't fail, no matter what.", category: 'reduction', scoreMultiplier: 0.5, incompatible: ['SD', 'PF', 'RX', 'AP', 'AT'] },
    { acronym: 'HT', name: 'Half Time', description: 'Less zoom...', category: 'reduction', scoreMultiplier: 0.3, incompatible: ['DC', 'DT', 'NC'], rate: 0.75 },
    { acronym: 'DC', name: 'Daycore', description: 'Whoaaaaa...', category: 'reduction', scoreMultiplier: 0.3, incompatible: ['HT', 'DT', 'NC'], rate: 0.75 },
    { acronym: 'HR', name: 'Hard Rock', description: 'Everything just got a bit harder...', category: 'increase', scoreMultiplier: 1.06, incompatible: ['EZ'] },
    { acronym: 'SD', name: 'Sudden Death', description: 'Miss and fail.', category: 'increase', scoreMultiplier: 1, incompatible: ['NF', 'PF', 'RX', 'AP', 'AT'] },
    { acronym: 'PF', name: 'Perfect', description: 'SS or quit.', category: 'increase', scoreMultiplier: 1, incompatible: ['NF', 'SD', 'RX', 'AP', 'AT'] },
    { acronym: 'DT', name: 'Double Time', description: 'Zoooooooooom...', category: 'increase', scoreMultiplier: 1.1, incompatible: ['HT', 'DC', 'NC'], rate: 1.5 },
    { acronym: 'NC', name: 'Nightcore', description: 'Uguuuuuuuu...', category: 'increase', scoreMultiplier: 1.1, incompatible: ['HT', 'DC', 'DT'], rate: 1.5 },
    { acronym: 'HD', name: 'Hidden', description: 'Play with no approach circles and fading circles/sliders.', category: 'increase', scoreMultiplier: 1.06, incompatible: [] },
    { acronym: 'FL', name: 'Flashlight', description: 'Restricted view area.', category: 'increase', scoreMultiplier: 1.12, incompatible: [] },
    { acronym: 'RX', name: 'Relax', description: "You don't need to click. Give your clicking/tapping fingers a break from the heat of things.", category: 'automation', scoreMultiplier: 0.1, incompatible: ['NF', 'SD', 'PF', 'AP', 'AT'], unranked: true },
    { acronym: 'AP', name: 'Autopilot', description: 'Automatic cursor movement - just follow the rhythm.', category: 'automation', scoreMultiplier: 0.1, incompatible: ['NF', 'SD', 'PF', 'RX', 'AT', 'SO'], unranked: true },
    { acronym: 'SO', name: 'Spun Out', description: 'Spinners will be automatically completed.', category: 'automation', scoreMultiplier: 0.9, incompatible: ['AP', 'AT'] },
    { acronym: 'AT', name: 'Autoplay', description: 'Watch a perfect automated play through the song.', category: 'automation', scoreMultiplier: 1, incompatible: ['NF', 'SD', 'PF', 'RX', 'AP', 'SO'], unranked: true },
];

const BY_ACRONYM = new Map<ModAcronym, ModInfo>(MODS.map(m => [m.acronym, m]));

export function modInfo(acronym: ModAcronym): ModInfo {
    const m = BY_ACRONYM.get(acronym);
    if (!m) throw new Error(`unknown mod ${acronym}`);
    return m;
}

export function isModAcronym(s: unknown): s is ModAcronym {
    return typeof s === 'string' && BY_ACRONYM.has(s as ModAcronym);
}

// ----------------------------------------------------------------------
// Settings (lazer's [SettingSource] properties)
// ----------------------------------------------------------------------

export type ModSettingValue = number | boolean;

interface SettingBase {
    key: string;
    label: string;
    description: string;
}

export interface NumberSettingDef extends SettingBase {
    kind: 'number';
    default: number;
    min: number;
    max: number;
    precision: number;
    /** How the value reads: "1.50x", "120 ms" or a plain number. */
    unit: 'multiplier' | 'ms' | 'none';
}

export interface ToggleSettingDef extends SettingBase {
    kind: 'toggle';
    default: boolean;
}

export type ModSettingDef = NumberSettingDef | ToggleSettingDef;

/** Settings of one mod, keyed by setting key. */
export type ModSettingValues = Readonly<Record<string, ModSettingValue>>;
/** Customised (non-default) settings of the selected mods. */
export type ModSettingsMap = Readonly<Partial<Record<ModAcronym, ModSettingValues>>>;

const speedIncrease: NumberSettingDef = {
    kind: 'number', key: 'speedChange', label: 'Speed increase', description: 'The actual increase to apply',
    default: 1.5, min: 1.01, max: 2, precision: 0.01, unit: 'multiplier',
};
const speedDecrease: NumberSettingDef = {
    kind: 'number', key: 'speedChange', label: 'Speed decrease', description: 'The actual decrease to apply',
    default: 0.75, min: 0.5, max: 0.99, precision: 0.01, unit: 'multiplier',
};
const adjustPitch: ToggleSettingDef = {
    kind: 'toggle', key: 'adjustPitch', label: 'Adjust pitch', description: 'Should pitch be adjusted with speed', default: false,
};
const restart = (def: boolean): ToggleSettingDef => ({
    kind: 'toggle', key: 'restart', label: 'Restart on fail', description: 'Automatically restarts when failed.', default: def,
});

/**
 * lazer's settings for the mods wosu! has: ModDoubleTime / ModHalfTime
 * (speed + adjust pitch), ModNightcore / ModDaycore (speed), ModFailCondition
 * (restart; ModPerfect defaults it on), OsuModFlashlight (size, combo-based
 * size, follow delay) and ModEasyWithExtraLives (extra lives).
 */
const SETTINGS: Partial<Record<ModAcronym, readonly ModSettingDef[]>> = {
    EZ: [{ kind: 'number', key: 'retries', label: 'Extra Lives', description: 'Number of extra lives', default: 2, min: 0, max: 10, precision: 1, unit: 'none' }],
    HT: [speedDecrease, adjustPitch],
    DC: [speedDecrease],
    SD: [restart(false)],
    PF: [restart(true)],
    DT: [speedIncrease, adjustPitch],
    NC: [speedIncrease],
    FL: [
        { kind: 'number', key: 'sizeMultiplier', label: 'Flashlight size', description: 'Multiplier applied to the default flashlight size.', default: 1, min: 0.5, max: 2, precision: 0.1, unit: 'multiplier' },
        { kind: 'toggle', key: 'comboBasedSize', label: 'Change size based on combo', description: 'Decrease the flashlight size as combo increases.', default: true },
        { kind: 'number', key: 'followDelay', label: 'Follow delay', description: 'Milliseconds until the flashlight reaches the cursor', default: 120, min: 120, max: 1200, precision: 120, unit: 'ms' },
    ],
};

export function modSettingDefs(acronym: ModAcronym): readonly ModSettingDef[] {
    return SETTINGS[acronym] ?? [];
}

export function hasSettings(acronym: ModAcronym): boolean {
    return modSettingDefs(acronym).length > 0;
}

function settingDef(acronym: ModAcronym, key: string): ModSettingDef | undefined {
    return modSettingDefs(acronym).find(d => d.key === key);
}

/** Clamp and snap a number to a setting's range and precision (null when unusable). */
function coerceSetting(def: ModSettingDef, v: unknown): ModSettingValue | null {
    if (def.kind === 'toggle') return typeof v === 'boolean' ? v : null;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(def.max, Math.max(def.min, n));
    const snapped = Math.round((clamped - def.min) / def.precision) * def.precision + def.min;
    // Keep canonical decimals (1.3, not 1.2999999999999998).
    const decimals = Math.max(0, -Math.floor(Math.log10(def.precision)) + 1);
    return Math.min(def.max, Number(snapped.toFixed(decimals)));
}

export function formatSetting(def: ModSettingDef, v: ModSettingValue): string {
    if (def.kind === 'toggle') return v ? 'On' : 'Off';
    const n = Number(v);
    switch (def.unit) {
        case 'multiplier': return `${n.toFixed(def.precision < 0.1 ? 2 : 1)}x`;
        case 'ms': return `${Math.round(n)} ms`;
        default: return String(n);
    }
}

/**
 * A mod selection; `settings` holds the selected mods' non-default
 * settings (absent when every selected mod uses its defaults).
 */
export interface ModSet extends ReadonlySet<ModAcronym> {
    readonly settings?: ModSettingsMap;
}

export const NO_MODS: ModSet = new Set();

/** Valid, non-default settings of `mods` only (unknown keys and junk dropped). */
export function sanitizeModSettings(raw: unknown, mods: Iterable<ModAcronym>): ModSettingsMap {
    const out: Partial<Record<ModAcronym, Record<string, ModSettingValue>>> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const src = raw as Record<string, unknown>;
    for (const a of mods) {
        const values = src[a];
        if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
        for (const [key, v] of Object.entries(values as Record<string, unknown>)) {
            const def = settingDef(a, key);
            if (!def) continue;
            const value = coerceSetting(def, v);
            if (value === null || value === def.default) continue;
            (out[a] ??= {})[key] = value;
        }
    }
    return out;
}

function makeSet(acronyms: Iterable<ModAcronym>, settings?: unknown): ModSet {
    const set = new Set(acronyms);
    const clean = settings === undefined ? {} : sanitizeModSettings(settings, set);
    if (Object.keys(clean).length) (set as Set<ModAcronym> & { settings?: ModSettingsMap }).settings = clean;
    return set;
}

/** The value of one setting (its default when not customised or the mod isn't selected). */
export function modSetting(mods: ModSet, acronym: ModAcronym, key: string): ModSettingValue {
    const def = settingDef(acronym, key);
    if (!def) throw new Error(`unknown setting ${acronym}.${key}`);
    return mods.settings?.[acronym]?.[key] ?? def.default;
}

function numberSetting(mods: ModSet, acronym: ModAcronym, key: string): number {
    return Number(modSetting(mods, acronym, key));
}

function toggleSetting(mods: ModSet, acronym: ModAcronym, key: string): boolean {
    return modSetting(mods, acronym, key) === true;
}

/** Change one setting of a selected mod (unselected mods can't be customised, like lazer). */
export function withModSetting(mods: ModSet, acronym: ModAcronym, key: string, value: ModSettingValue): ModSet {
    const def = settingDef(acronym, key);
    if (!def || !mods.has(acronym)) return mods;
    const v = coerceSetting(def, value);
    if (v === null || v === modSetting(mods, acronym, key)) return mods;
    const settings = { ...(mods.settings ?? {}), [acronym]: { ...(mods.settings?.[acronym] ?? {}), [key]: v } };
    return makeSet(mods, settings);
}

/** Every setting of `acronym` back to its default. */
export function resetModSettings(mods: ModSet, acronym: ModAcronym): ModSet {
    if (!mods.settings?.[acronym]) return mods;
    const settings: Partial<Record<ModAcronym, ModSettingValues>> = { ...mods.settings };
    delete settings[acronym];
    return makeSet(mods, settings);
}

/** lazer's UsesDefaultConfiguration for one mod. */
export function usesDefaultConfiguration(mods: ModSet, acronym: ModAcronym): boolean {
    return !mods.settings?.[acronym];
}

/** The customised settings to persist or record with a score (a plain copy). */
export function modSettingsOf(mods: ModSet): ModSettingsMap {
    const out: Partial<Record<ModAcronym, ModSettingValues>> = {};
    for (const [a, values] of Object.entries(mods.settings ?? {}) as [ModAcronym, ModSettingValues][]) {
        if (mods.has(a)) out[a] = { ...values };
    }
    return out;
}

/** The same selection with `settings` (e.g. from a stored score) applied. */
export function withSettings(mods: Iterable<ModAcronym>, settings: unknown): ModSet {
    return makeSet(mods, settings);
}

/**
 * lazer's ExtendedIconInformation, shown beside the acronym on mod icons
 * and pills: the speed of a rate mod when it isn't the default ("1.30x").
 */
export function extendedModInfo(acronym: ModAcronym, settings?: ModSettingsMap): string {
    if (!(RATE as readonly string[]).includes(acronym)) return '';
    const v = settings?.[acronym]?.speedChange;
    return typeof v === 'number' ? `${v.toFixed(2)}x` : '';
}

/** Identity of a selection including its settings (cache keys). */
export function modsKey(mods: ModSet): string {
    const s = modSettingsOf(mods);
    return modsString(mods) + (Object.keys(s).length ? JSON.stringify(s) : '');
}

// ----------------------------------------------------------------------
// Selection
// ----------------------------------------------------------------------

/** Toggle a mod, dropping anything incompatible with it when enabling. */
export function toggleMod(mods: ModSet, acronym: ModAcronym): ModSet {
    const next = new Set(mods);
    if (next.has(acronym)) {
        next.delete(acronym);
        return makeSet(next, mods.settings);
    }
    for (const other of modInfo(acronym).incompatible) next.delete(other);
    // Incompatibility is declared on both sides, but be defensive.
    for (const m of [...next]) if (modInfo(m).incompatible.includes(acronym)) next.delete(m);
    next.add(acronym);
    return makeSet(next, mods.settings);
}

/**
 * Normalize an arbitrary list (persisted state, URL) into a valid set,
 * applying the earliest-listed mod first so the result is deterministic.
 * `settings` (persisted / stored) are sanitized against the result.
 */
export function sanitizeMods(list: Iterable<unknown>, settings?: unknown): ModSet {
    let set: ModSet = NO_MODS;
    for (const a of list) {
        if (isModAcronym(a) && !set.has(a)) set = toggleMod(set, a);
    }
    return settings === undefined ? set : makeSet(set, settings);
}

/** Canonical display order (osu! style: "HDHRDT"). */
export function sortedMods(mods: ModSet): ModAcronym[] {
    return MODS.filter(m => mods.has(m.acronym)).map(m => m.acronym);
}

export function modsString(mods: ModSet, separator = ''): string {
    return sortedMods(mods).join(separator);
}

// ----------------------------------------------------------------------
// Effects
// ----------------------------------------------------------------------

/**
 * lazer's OsuScoreMultiplierCalculatorV1.rateAdjustMultiplier (formerly
 * ModDoubleTime / ModHalfTime.ScoreMultiplier): +0.02 per 0.1 of speed
 * above 1 (DT 1.5x = 1.10), 0.6 − 0.1 per 0.1 below (HT 0.75x = 0.30),
 * the speed floored to a multiple of 0.1.
 */
export function rateAdjustMultiplier(speedChange: number): number {
    // The epsilon keeps 1.3 (stored as 1.2999…) on its own 0.1 step.
    const value = Math.trunc(speedChange * 10 + 1e-9) / 10 - 1;
    return speedChange >= 1 ? 1 + value / 5 : 0.6 + value;
}

/**
 * ScoreV1 multiplier, as lazer's OsuScoreMultiplierCalculatorV1: rate mods
 * scale with their speed, and Hidden / Flashlight only give their bonus
 * at the default configuration.
 */
export function scoreMultiplier(mods: ModSet): number {
    let m = 1;
    for (const a of mods) {
        if ((RATE as readonly string[]).includes(a)) m *= rateAdjustMultiplier(numberSetting(mods, a, 'speedChange'));
        else if (a === 'FL' || a === 'HD' || a === 'HR') m *= usesDefaultConfiguration(mods, a) ? modInfo(a).scoreMultiplier : 1;
        else m *= modInfo(a).scoreMultiplier;
    }
    return m;
}

function rateMod(mods: ModSet): RateMod | null {
    for (const a of RATE) if (mods.has(a)) return a;
    return null;
}

/** Overall speed of the song and gameplay (the rate mod's "Speed change"). */
export function playbackRate(mods: ModSet): number {
    const a = rateMod(mods);
    return a ? numberSetting(mods, a, 'speedChange') : 1;
}

/**
 * Frequency (pitch) ratio of the music, 1 = untouched. DT/HT keep pitch
 * unless "Adjust pitch" is on (then it follows the speed, RateAdjustModHelper).
 * NC/DC fix the frequency at their default speed and time-stretch the rest
 * (ModNightcore / ModDaycore: freq = SpeedChange.Default, tempo = speed / default),
 * so a 1.2x Nightcore is still nightcore-pitched.
 */
export function audioPitch(mods: ModSet): number {
    const a = rateMod(mods);
    if (!a) return 1;
    if (a === 'NC' || a === 'DC') return modInfo(a).rate ?? 1;
    return toggleSetting(mods, a, 'adjustPitch') ? numberSetting(mods, a, 'speedChange') : 1;
}

/** True when the music keeps its pitch at the mod's rate. */
export function preservesPitch(mods: ModSet): boolean {
    return audioPitch(mods) === 1;
}

/** lazer's IApplicableFailOverride.RestartOnFail (SD / PF "Restart on fail"). */
export function restartOnFail(mods: ModSet): boolean {
    if (mods.has('SD')) return toggleSetting(mods, 'SD', 'restart');
    if (mods.has('PF')) return toggleSetting(mods, 'PF', 'restart');
    return false;
}

/** Easy's extra lives (ModEasyWithExtraLives.Retries); 0 without EZ. */
export function extraLives(mods: ModSet): number {
    return mods.has('EZ') ? numberSetting(mods, 'EZ', 'retries') : 0;
}

export interface FlashlightSettings {
    sizeMultiplier: number;
    comboBasedSize: boolean;
    followDelay: number;
}

export function flashlightSettings(mods: ModSet): FlashlightSettings {
    return {
        sizeMultiplier: numberSetting(mods, 'FL', 'sizeMultiplier'),
        comboBasedSize: toggleSetting(mods, 'FL', 'comboBasedSize'),
        followDelay: numberSetting(mods, 'FL', 'followDelay'),
    };
}

export type InputMode = 'normal' | 'relax' | 'autopilot' | 'autoplay';

export function inputMode(mods: ModSet): InputMode {
    if (mods.has('AT')) return 'autoplay';
    if (mods.has('RX')) return 'relax';
    if (mods.has('AP')) return 'autopilot';
    return 'normal';
}

export function isAutomated(mods: ModSet): boolean {
    return AUTO.some(a => mods.has(a));
}

/** Difficulty multipliers applied by EZ/HR (stable rules). */
export function adjustDifficulty(
    d: { cs: number; ar: number; od: number; hp: number },
    mods: ModSet,
): { cs: number; ar: number; od: number; hp: number } {
    let { cs, ar, od, hp } = d;
    if (mods.has('HR')) {
        cs = Math.min(cs * 1.3, 10);
        ar = Math.min(ar * 1.4, 10);
        od = Math.min(od * 1.4, 10);
        hp = Math.min(hp * 1.4, 10);
    } else if (mods.has('EZ')) {
        cs *= 0.5;
        ar *= 0.5;
        od *= 0.5;
        hp *= 0.5;
    }
    return { cs, ar, od, hp };
}

/** Parse the legacy history format ("EZ+HD", "DT", "") into a set. */
export function parseLegacyModString(s: string): ModSet {
    if (!s) return NO_MODS;
    return sanitizeMods(s.split(/[+,\s]+/).filter(Boolean));
}
