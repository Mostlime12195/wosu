import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import type { SongSort } from '../../settings/Settings';

/**
 * Song select search (osu!lazer's FilterQueryParser, trimmed down).
 *
 * Plain words must all appear in the set's text (title, artist, creator,
 * source, tags, difficulty names). `key<op>value` terms filter
 * difficulties numerically: stars/sr, ar, cs, od, hp, bpm, length
 * (seconds, "2:30", "90s", "3m"), objects. A set is shown when at least
 * one difficulty matches; non-matching difficulties are hidden.
 */
export type NumericKey = 'stars' | 'ar' | 'cs' | 'od' | 'hp' | 'bpm' | 'length' | 'objects';
export type Op = '=' | '!=' | '<' | '>' | '<=' | '>=';

export interface NumericFilter {
    key: NumericKey;
    op: Op;
    value: number;
}

export interface FilterCriteria {
    terms: string[];
    numeric: NumericFilter[];
}

export interface FilterEntry {
    set: LibrarySet;
    /** Difficulties passing the numeric filters (never empty). */
    diffs: DifficultySummary[];
}

const KEY_ALIASES: Record<string, NumericKey> = {
    stars: 'stars', star: 'stars', sr: 'stars',
    ar: 'ar', cs: 'cs', od: 'od', hp: 'hp', dr: 'hp',
    bpm: 'bpm', length: 'length', len: 'length', objects: 'objects',
};

const TERM = /^([a-z]+)(<=|>=|!=|==|=|:|<|>)(.+)$/i;

export function parseQuery(query: string): FilterCriteria {
    const terms: string[] = [];
    const numeric: NumericFilter[] = [];
    for (const raw of query.trim().toLowerCase().split(/\s+/)) {
        if (!raw) continue;
        const m = TERM.exec(raw);
        const key = m ? KEY_ALIASES[m[1]] : undefined;
        if (m && key) {
            const value = key === 'length' ? parseLength(m[3]) : parseFloat(m[3]);
            if (Number.isFinite(value)) {
                const op: Op = m[2] === '==' || m[2] === ':' ? '=' : (m[2] as Op);
                numeric.push({ key, op, value });
                continue;
            }
        }
        terms.push(raw);
    }
    return { terms, numeric };
}

/** Length in seconds from "150", "150s", "2:30", "3m", "1m30s". */
export function parseLength(s: string): number {
    const colon = /^(\d+):(\d{1,2})$/.exec(s);
    if (colon) return +colon[1] * 60 + +colon[2];
    const parts = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(s);
    if (parts && (parts[1] || parts[2])) return (parts[1] ? +parts[1] * 60 : 0) + (parts[2] ? +parts[2] : 0);
    return NaN;
}

function numericValue(d: DifficultySummary, key: NumericKey): number | null {
    switch (key) {
        case 'stars': return d.stars;
        case 'ar': return d.ar;
        case 'cs': return d.cs;
        case 'od': return d.od;
        case 'hp': return d.hp;
        case 'bpm': return d.bpm;
        case 'length': return d.length / 1000;
        case 'objects': return d.circles + d.sliders + d.spinners;
    }
}

function compare(v: number, op: Op, target: number, key: NumericKey): boolean {
    // Equality on fractional values uses the displayed precision, like
    // lazer (stars=4 matches 4.0–4.09, ar=9 matches 9.0–9.09).
    const eps = key === 'length' || key === 'objects' || key === 'bpm' ? 0.5 : 0.05;
    switch (op) {
        case '=': return Math.abs(v - target) < eps;
        case '!=': return Math.abs(v - target) >= eps;
        case '<': return v < target;
        case '>': return v > target;
        case '<=': return v <= target + eps;
        case '>=': return v >= target - eps;
    }
}

const textCache = new WeakMap<LibrarySet, string>();

function searchText(set: LibrarySet): string {
    let t = textCache.get(set);
    if (t === undefined) {
        t = [set.title, set.titleUnicode, set.artist, set.artistUnicode, set.creator, set.source, set.tags,
            ...set.difficulties.map(d => d.version), set.onlineSetId ? String(set.onlineSetId) : '']
            .join(' ').toLowerCase();
        textCache.set(set, t);
    }
    return t;
}

export function filterSets(sets: readonly LibrarySet[], c: FilterCriteria): FilterEntry[] {
    const out: FilterEntry[] = [];
    for (const set of sets) {
        if (!set.difficulties.length) continue;
        if (c.terms.length) {
            const text = searchText(set);
            if (!c.terms.every(term => text.includes(term))) continue;
        }
        let diffs = set.difficulties;
        if (c.numeric.length) {
            diffs = diffs.filter(d => c.numeric.every(f => {
                const v = numericValue(d, f.key);
                return v !== null && compare(v, f.op, f.value, f.key);
            }));
            if (!diffs.length) continue;
        }
        out.push({ set, diffs });
    }
    return out;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function maxOf(e: FilterEntry, f: (d: DifficultySummary) => number): number {
    let m = -Infinity;
    for (const d of e.diffs) m = Math.max(m, f(d));
    return m;
}

export function sortEntries(entries: FilterEntry[], sort: SongSort): FilterEntry[] {
    const by = (f: (e: FilterEntry) => number, desc = false) =>
        (a: FilterEntry, b: FilterEntry) => (desc ? f(b) - f(a) : f(a) - f(b)) || collator.compare(a.set.title, b.set.title);
    const sorted = entries.slice();
    switch (sort) {
        case 'artist':
            sorted.sort((a, b) => collator.compare(a.set.artist, b.set.artist) || collator.compare(a.set.title, b.set.title));
            break;
        case 'creator':
            sorted.sort((a, b) => collator.compare(a.set.creator, b.set.creator) || collator.compare(a.set.title, b.set.title));
            break;
        case 'difficulty':
            sorted.sort(by(e => maxOf(e, d => d.stars ?? d.od)));
            break;
        case 'length':
            sorted.sort(by(e => maxOf(e, d => d.length)));
            break;
        case 'bpm':
            sorted.sort(by(e => maxOf(e, d => d.bpm)));
            break;
        case 'dateAdded':
            sorted.sort(by(e => e.set.addedAt, true));
            break;
        case 'lastPlayed':
            sorted.sort(by(e => e.set.lastPlayedAt ?? 0, true));
            break;
        default:
            sorted.sort((a, b) => collator.compare(a.set.title, b.set.title) || collator.compare(a.set.artist, b.set.artist));
    }
    return sorted;
}

/** Mod-adjusted difficulty for display (EZ/HR scaling, then rate on AR/OD). */
export function effectiveAr(ar: number, rate: number): number {
    let preempt = ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
    preempt /= rate;
    return preempt > 1200 ? 5 - (preempt - 1200) / 120 : 5 + (1200 - preempt) / 150;
}

export function effectiveOd(od: number, rate: number): number {
    const w300 = (80 - 6 * od) / rate;
    return (80 - w300) / 6;
}
