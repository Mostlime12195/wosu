import { describe, expect, it } from 'vitest';
import { collectionItemKey } from '../../src/beatmap/collections';
import type { LibrarySet } from '../../src/beatmap/Library';
import type { DifficultySummary } from '../../src/beatmap/types';
import { filterSets, parseQuery } from '../../src/screens/select/filter';
import { diffMenu, onlineUrl, setMenu, type CarouselMenuHost } from '../../src/screens/select/CarouselMenus';
import { MENU_SPACER, nextToggleState, type MenuAction, type MenuEntry } from '../../src/ui/ContextMenu';

function diff(over: Partial<DifficultySummary> = {}): DifficultySummary {
    return {
        file: 'a.osu', version: 'Normal', beatmapId: 0, mode: 0, cs: 4, ar: 8, od: 7, hp: 5,
        bpm: 180, bpmMin: 180, bpmMax: 180, length: 120_000, circles: 300, sliders: 200, spinners: 1,
        maxCombo: 900, previewTime: 0, stars: 4.2, ...over,
    };
}

function set(over: Partial<LibrarySet> = {}): LibrarySet {
    return {
        key: 'osu-1', onlineSetId: 1, title: 'Title', titleUnicode: 'Title', artist: 'Artist', artistUnicode: 'Artist',
        creator: 'mapper', source: '', tags: '', difficulties: [diff()], audioFile: 'audio.mp3', backgroundFile: null,
        previewTime: 0, hasVideo: false, addedAt: 0, lastPlayedAt: null, sizeBytes: 0, ...over,
    };
}

describe('collection filter', () => {
    const a = set({ key: 'osu-1', title: 'Alpha', difficulties: [diff({ file: 'e.osu', version: 'Easy', stars: 2 }), diff({ file: 'h.osu', version: 'Hard', stars: 5 })] });
    const b = set({ key: 'local-x', onlineSetId: null, title: 'Beta', difficulties: [diff({ file: 'n.osu' })] });
    const c = set({ key: 'osu-3', title: 'Gamma' });

    it('keeps only member difficulties and drops sets without any', () => {
        const members = new Set([collectionItemKey(a, a.difficulties[1]), collectionItemKey(b, b.difficulties[0])]);
        const out = filterSets([a, b, c], { ...parseQuery(''), collection: members });
        expect(out.map(e => [e.set.title, e.diffs.map(d => d.version)])).toEqual([['Alpha', ['Hard']], ['Beta', ['Normal']]]);
    });

    it('combines with search terms and numeric filters', () => {
        const members = new Set(a.difficulties.map(d => collectionItemKey(a, d)).concat(collectionItemKey(b, b.difficulties[0])));
        expect(filterSets([a, b, c], { ...parseQuery('beta'), collection: members }).map(e => e.set.title)).toEqual(['Beta']);
        const hard = filterSets([a, b, c], { ...parseQuery('stars>3'), collection: members });
        expect(hard.map(e => [e.set.title, e.diffs.map(d => d.version)])).toEqual([['Alpha', ['Hard']], ['Beta', ['Normal']]]);
    });

    it('an empty collection shows nothing; no collection shows everything', () => {
        expect(filterSets([a, b, c], { ...parseQuery(''), collection: new Set() })).toEqual([]);
        expect(filterSets([a, b, c], { ...parseQuery(''), collection: null })).toHaveLength(3);
    });
});

function host(over: Partial<CarouselMenuHost> = {}): CarouselMenuHost {
    const noop = () => {};
    return {
        isExpanded: () => false, expand: noop, play: noop, details: noop, copyLink: noop, manageCollections: noop,
        clearScores: noop, deleteSet: noop, deleteDifficulty: noop, restoreDifficulties: noop, canDeleteDifficulty: () => true,
        ...over,
    };
}

const texts = (items: MenuEntry[]) => items.map(i => (i === MENU_SPACER ? '-' : i.text));

describe('carousel context menus', () => {
    it('set menu follows lazer: expand, details, copy link, collections, restore hidden, delete', () => {
        const s = set({ onlineSetId: 7, hidden: [diff({ file: 'x.osu' })] });
        expect(texts(setMenu(host(), s))).toEqual(['Expand', '-', 'Details', 'Copy link', '-', 'Collections', 'Restore all hidden', 'Delete…']);
        const local = set({ onlineSetId: null });
        expect(texts(setMenu(host({ isExpanded: () => true }), local))).toEqual(['Play', '-', 'Details', '-', 'Collections', 'Delete…']);
    });

    it('difficulty menu: play, details, link, collections, clear scores, delete difficulty', () => {
        const s = set({ onlineSetId: 7 });
        const d = diff({ beatmapId: 99 });
        expect(texts(diffMenu(host(), s, d))).toEqual(['Play', '-', 'Details', 'Copy link', '-', 'Collections', 'Clear all local scores', 'Delete difficulty…']);
        expect(texts(diffMenu(host({ canDeleteDifficulty: () => false }), s, diff()))).toEqual(['Play', '-', 'Details', '-', 'Collections', 'Clear all local scores']);
        expect(onlineUrl(s, d)).toBe('https://osu.ppy.sh/beatmapsets/7#osu/99');
        expect(onlineUrl(s, null)).toBe('https://osu.ppy.sh/beatmapsets/7');
    });

    it('the collections sub-menu always offers New collection… and Manage…', () => {
        const managed: unknown[] = [];
        const items = setMenu(host({ manageCollections: x => managed.push(x) }), set());
        const sub = (items.find(i => i !== MENU_SPACER && i.text === 'Collections') as MenuAction).items!;
        const last = sub.slice(-2) as MenuAction[];
        expect(last.map(i => i.text)).toEqual(['New collection…', 'Manage…']);
        last[0].action!();
        last[1].action!();
        expect(managed[0]).toEqual({ keys: ['osu-1|a.osu'], label: 'Artist - Title' });
        expect(managed[1]).toBeUndefined();
    });

    it('ternary toggles go to true unless already true (lazer)', () => {
        expect(nextToggleState(false)).toBe(true);
        expect(nextToggleState('indeterminate')).toBe(true);
        expect(nextToggleState(true)).toBe(false);
    });
});
