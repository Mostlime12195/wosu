/**
 * osu!standard mod catalogue and combination rules.
 *
 * A selection is a ReadonlySet of acronyms. Every mutation goes through
 * `toggleMod`, which enforces the incompatibility rules so persisted or
 * UI state can never hold a nonsense combination (e.g. DT+HT, EZ+HR).
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
    /** ScoreV1 multiplier. */
    scoreMultiplier: number;
    incompatible: readonly ModAcronym[];
    /** Playback rate for rate-changing mods. */
    rate?: number;
    /** Rate mods: keep pitch (DT/HT) or shift it (NC/DC). */
    preservePitch?: boolean;
    /** Excluded from score submission-ish features (history ranking). */
    unranked?: boolean;
}

const RATE = ['HT', 'DC', 'DT', 'NC'] as const;
const AUTO = ['RX', 'AP', 'AT'] as const;

export const MODS: readonly ModInfo[] = [
    { acronym: 'EZ', name: 'Easy', description: 'Larger circles, more forgiving HP drain, less accuracy required, and three lives!', category: 'reduction', scoreMultiplier: 0.5, incompatible: ['HR'] },
    { acronym: 'NF', name: 'No Fail', description: "You can't fail, no matter what.", category: 'reduction', scoreMultiplier: 0.5, incompatible: ['SD', 'PF', 'RX', 'AP', 'AT'] },
    { acronym: 'HT', name: 'Half Time', description: 'Less zoom...', category: 'reduction', scoreMultiplier: 0.3, incompatible: ['DC', 'DT', 'NC'], rate: 0.75, preservePitch: true },
    { acronym: 'DC', name: 'Daycore', description: 'Whoaaaaa...', category: 'reduction', scoreMultiplier: 0.3, incompatible: ['HT', 'DT', 'NC'], rate: 0.75, preservePitch: false },
    { acronym: 'HR', name: 'Hard Rock', description: 'Everything just got a bit harder...', category: 'increase', scoreMultiplier: 1.06, incompatible: ['EZ'] },
    { acronym: 'SD', name: 'Sudden Death', description: 'Miss and fail.', category: 'increase', scoreMultiplier: 1, incompatible: ['NF', 'PF', 'RX', 'AP', 'AT'] },
    { acronym: 'PF', name: 'Perfect', description: 'SS or quit.', category: 'increase', scoreMultiplier: 1, incompatible: ['NF', 'SD', 'RX', 'AP', 'AT'] },
    { acronym: 'DT', name: 'Double Time', description: 'Zoooooooooom...', category: 'increase', scoreMultiplier: 1.12, incompatible: ['HT', 'DC', 'NC'], rate: 1.5, preservePitch: true },
    { acronym: 'NC', name: 'Nightcore', description: 'Uguuuuuuuu...', category: 'increase', scoreMultiplier: 1.12, incompatible: ['HT', 'DC', 'DT'], rate: 1.5, preservePitch: false },
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

export type ModSet = ReadonlySet<ModAcronym>;
export const NO_MODS: ModSet = new Set();

/** Toggle a mod, dropping anything incompatible with it when enabling. */
export function toggleMod(mods: ModSet, acronym: ModAcronym): ModSet {
    const next = new Set(mods);
    if (next.has(acronym)) {
        next.delete(acronym);
        return next;
    }
    for (const other of modInfo(acronym).incompatible) next.delete(other);
    // Incompatibility is declared on both sides, but be defensive.
    for (const m of [...next]) if (modInfo(m).incompatible.includes(acronym)) next.delete(m);
    next.add(acronym);
    return next;
}

/**
 * Normalize an arbitrary list (persisted state, URL) into a valid set,
 * applying the earliest-listed mod first so the result is deterministic.
 */
export function sanitizeMods(list: Iterable<unknown>): ModSet {
    let set: ModSet = NO_MODS;
    for (const a of list) {
        if (isModAcronym(a) && !set.has(a)) set = toggleMod(set, a);
    }
    return set;
}

/** Canonical display order (osu! style: "HDHRDT"). */
export function sortedMods(mods: ModSet): ModAcronym[] {
    return MODS.filter(m => mods.has(m.acronym)).map(m => m.acronym);
}

export function modsString(mods: ModSet, separator = ''): string {
    return sortedMods(mods).join(separator);
}

export function scoreMultiplier(mods: ModSet): number {
    let m = 1;
    for (const a of mods) m *= modInfo(a).scoreMultiplier;
    return m;
}

export function playbackRate(mods: ModSet): number {
    for (const a of RATE) if (mods.has(a)) return modInfo(a).rate ?? 1;
    return 1;
}

export function preservesPitch(mods: ModSet): boolean {
    for (const a of RATE) if (mods.has(a)) return modInfo(a).preservePitch ?? true;
    return true;
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
