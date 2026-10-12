import { collectionItemKey } from '../../beatmap/collections';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { collections } from '../../storage/Collections';
import { MENU_SPACER, type MenuAction, type MenuEntry } from '../../ui/ContextMenu';

/** What the carousel's context menus can do (implemented by song select). */
export interface CarouselMenuHost {
    isExpanded(set: LibrarySet): boolean;
    expand(set: LibrarySet): void;
    /** `diff` null: the set's selected difficulty. */
    play(set: LibrarySet, diff: DifficultySummary | null): void;
    /** Online details (listing) for sets with an id, else the local info card. */
    details(set: LibrarySet, diff: DifficultySummary | null): void;
    copyLink(url: string): void;
    manageCollections(addOnCreate?: { keys: string[]; label: string }): void;
    clearScores(set: LibrarySet, diff: DifficultySummary): void;
    deleteSet(set: LibrarySet): void;
    deleteDifficulty(set: LibrarySet, diff: DifficultySummary): void;
    restoreDifficulties(set: LibrarySet): void;
    canDeleteDifficulty(set: LibrarySet): boolean;
}

/** lazer's IBeatmapSetInfo.GetOnlineURL / IBeatmapInfo.GetOnlineURL. */
export function onlineUrl(set: LibrarySet, diff: DifficultySummary | null): string | null {
    if (!set.onlineSetId) return null;
    const base = `https://osu.ppy.sh/beatmapsets/${set.onlineSetId}`;
    if (!diff) return base;
    return diff.beatmapId > 0 ? `${base}#osu/${diff.beatmapId}` : null;
}

/**
 * lazer's "Collections" sub-menu: one toggle per collection (a set shows
 * a ternary state over all its difficulties), then "New collection…" and
 * "Manage…".
 */
function collectionsMenu(host: CarouselMenuHost, keys: string[], what: string): MenuAction {
    const store = collections();
    const items: MenuEntry[] = store.all.map(c => {
        const m = store.membership(c.id, keys);
        return {
            text: c.name,
            state: m === 'all' ? true : m === 'some' ? 'indeterminate' : false,
            onToggle: (next: boolean) => {
                if (next) store.add(c.id, keys);
                else store.removeItems(c.id, keys);
            },
        };
    });
    if (items.length) items.push(MENU_SPACER);
    items.push({ text: 'New collection…', action: () => host.manageCollections({ keys, label: what }) });
    items.push({ text: 'Manage…', action: () => host.manageCollections() });
    return { text: 'Collections', items };
}

/** lazer's PanelBeatmapSet.ContextMenuItems. */
export function setMenu(host: CarouselMenuHost, set: LibrarySet): MenuEntry[] {
    const items: MenuEntry[] = [];
    if (host.isExpanded(set)) {
        // lazer offers Edit here; we have no editor, so play the selected difficulty.
        items.push({ text: 'Play', type: 'highlighted', action: () => host.play(set, null) });
    } else {
        items.push({ text: 'Expand', type: 'highlighted', action: () => host.expand(set) });
    }
    items.push(MENU_SPACER);
    items.push({ text: 'Details', action: () => host.details(set, null) });
    const url = onlineUrl(set, null);
    if (url) items.push({ text: 'Copy link', action: () => host.copyLink(url) });
    items.push(MENU_SPACER);
    items.push(collectionsMenu(host, set.difficulties.map(d => collectionItemKey(set, d)), `${set.artist} - ${set.title}`));
    if (set.hidden?.length) items.push({ text: 'Restore all hidden', action: () => host.restoreDifficulties(set) });
    items.push({ text: 'Delete…', type: 'destructive', action: () => host.deleteSet(set) });
    return items;
}

/** lazer's SoloSongSelect.GetForwardActions (the difficulty panel's menu). */
export function diffMenu(host: CarouselMenuHost, set: LibrarySet, diff: DifficultySummary): MenuEntry[] {
    const items: MenuEntry[] = [
        { text: 'Play', type: 'highlighted', action: () => host.play(set, diff) },
        MENU_SPACER,
        { text: 'Details', action: () => host.details(set, diff) },
    ];
    const url = onlineUrl(set, diff);
    if (url) items.push({ text: 'Copy link', action: () => host.copyLink(url) });
    items.push(MENU_SPACER);
    items.push(collectionsMenu(host, [collectionItemKey(set, diff)], `[${diff.version}]`));
    items.push({ text: 'Clear all local scores', type: 'destructive', action: () => host.clearScores(set, diff) });
    // lazer's "Hide": the difficulty leaves the library but stays restorable.
    if (host.canDeleteDifficulty(set)) items.push({ text: 'Delete difficulty…', type: 'destructive', action: () => host.deleteDifficulty(set, diff) });
    return items;
}
