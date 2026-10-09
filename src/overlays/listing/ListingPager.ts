/**
 * Data side of the beatmap listing: what a query is, which filters each
 * mirror can honour, and a pager that streams result pages for one query
 * (dedupes, applies the client-side status filter, aborts on dispose).
 */
import { Signal } from '../../core/Signal';
import { isAbortError, type ListOptions, type ListResult } from '../../online/BeatmapApi';
import {
    isStandardSet,
    minoGenreIds,
    minoLangIds,
    statusFilter,
    type ListKind,
    type OnlineSet,
    type ProviderId,
} from '../../online/providers';

export type ListingTab = 'latest' | 'popular' | 'random' | 'favourites' | 'search';
export type StatusChoice = 'any' | 'ranked' | 'loved' | 'qualified' | 'pending' | 'graveyard';

export interface ListingQuery {
    tab: ListingTab;
    keyword: string;
    /** SayoBot-style genre mask (1 = any). */
    genre: number;
    /** SayoBot-style language mask (1 = any). */
    lang: number;
    status: StatusChoice;
}

export interface Choice<T> {
    value: T;
    label: string;
}

export const TABS: Choice<ListingTab>[] = [
    { value: 'latest', label: 'latest' },
    { value: 'popular', label: 'popular' },
    { value: 'random', label: 'random' },
    { value: 'favourites', label: 'favourites' },
    { value: 'search', label: 'search results' },
];

export const STATUSES: Choice<StatusChoice>[] = [
    { value: 'any', label: 'Any' },
    { value: 'ranked', label: 'Ranked' },
    { value: 'loved', label: 'Loved' },
    { value: 'qualified', label: 'Qualified' },
    { value: 'pending', label: 'Pending' },
    { value: 'graveyard', label: 'Graveyard' },
];

/** `approved` codes per status choice (ranked includes approved, pending includes WIP). */
const STATUS_CODES: Record<StatusChoice, number[]> = {
    any: [],
    ranked: [1, 2],
    loved: [4],
    qualified: [3],
    pending: [0, -1],
    graveyard: [-2],
};

// Masks from the old genres page (SayoBot's bit values).
const GENRES: Choice<number>[] = [
    { value: 1, label: 'Any' },
    { value: 4, label: 'Video Game' },
    { value: 8, label: 'Anime' },
    { value: 16, label: 'Rock' },
    { value: 32, label: 'Pop' },
    { value: 128, label: 'Novelty' },
    { value: 1024, label: 'Electronic' },
    { value: 2 + 64 + 256, label: 'Other' },
];

const LANGUAGES: Choice<number>[] = [
    { value: 1, label: 'Any' },
    { value: 4, label: 'English' },
    { value: 8, label: 'Japanese' },
    { value: 16, label: 'Chinese' },
    { value: 64, label: 'Korean' },
    { value: 128, label: 'French' },
    { value: 256, label: 'German' },
    { value: 32, label: 'Instrumental' },
    { value: 2 + 1024, label: 'Other' },
];

/**
 * Genre choices the browse mirror can filter by. SayoBot filters
 * server-side; Mino only maps some genres to osu! ids (filtered per page).
 */
export function genreChoices(provider: ProviderId): Choice<number>[] {
    return GENRES.filter(g => provider === 'sayobot' || g.value === 1 || minoGenreIds(g.value) !== null);
}

export function languageChoices(provider: ProviderId): Choice<number>[] {
    return LANGUAGES.filter(l => provider === 'sayobot' || l.value === 1 || minoLangIds(l.value) !== null);
}

/** Genre/language rows apply to the browsing tabs only. */
export function supportsGenreFilter(tab: ListingTab): boolean {
    return tab === 'latest' || tab === 'popular' || tab === 'random';
}

export function statusPredicate(choice: StatusChoice): ((s: OnlineSet) => boolean) | null {
    const preds = STATUS_CODES[choice].map(c => statusFilter(c)).filter(p => p !== null);
    if (!preds.length) return null;
    return s => preds.some(p => p(s));
}

export function sameQuery(a: ListingQuery, b: ListingQuery): boolean {
    return a.tab === b.tab && a.keyword === b.keyword && a.genre === b.genre && a.lang === b.lang && a.status === b.status;
}

export interface PagerSource {
    list(kind: ListKind, opts: ListOptions): Promise<ListResult>;
    setInfo(sid: number, signal?: AbortSignal): Promise<OnlineSet | null>;
    /** Favourite set ids, newest first. */
    favourites(): number[];
    /** Minimal metadata for a favourite the mirror no longer knows. */
    fallback(sid: number): OnlineSet;
}

export type PagerState = 'idle' | 'loading' | 'error' | 'end';

const PAGE_SIZE = 30;
const FAVOURITES_PAGE = 12;
/** Pages in a row that added nothing (filters too narrow) before giving up. */
const MAX_EMPTY_PAGES = 6;

/** Streams pages for one query; create a new pager when the query changes. */
export class ListingPager {
    readonly sets: OnlineSet[] = [];
    readonly changed = new Signal<[]>();
    state: PagerState = 'idle';
    error = '';
    private readonly seen = new Set<number>();
    private readonly controller = new AbortController();
    private readonly accept: ((s: OnlineSet) => boolean) | null;
    private readonly favouriteIds: number[] | null;
    private offset = 0;
    private emptyPages = 0;

    constructor(private readonly source: PagerSource, readonly query: ListingQuery) {
        this.accept = statusPredicate(query.status);
        this.favouriteIds = query.tab === 'favourites' ? source.favourites() : null;
        if (query.tab === 'search' && !query.keyword.trim()) this.state = 'end';
    }

    get disposed(): boolean {
        return this.controller.signal.aborted;
    }

    dispose(): void {
        this.controller.abort();
        this.changed.clear();
    }

    async loadMore(): Promise<void> {
        if (this.state === 'loading' || this.state === 'end' || this.disposed) return;
        this.setState('loading');
        try {
            const page = await this.fetchPage();
            if (this.disposed) return;
            let added = 0;
            for (const s of page.sets) {
                if (this.seen.has(s.sid) || (this.accept && !this.accept(s))) continue;
                this.seen.add(s.sid);
                this.sets.push(s);
                added++;
            }
            this.emptyPages = added ? 0 : this.emptyPages + 1;
            this.setState(page.end || this.emptyPages >= MAX_EMPTY_PAGES ? 'end' : 'idle');
        } catch (e) {
            if (this.disposed || isAbortError(e)) return;
            this.error = e instanceof Error ? e.message : String(e);
            this.setState('error');
        }
    }

    retry(): void {
        if (this.state !== 'error') return;
        this.state = 'idle';
        void this.loadMore();
    }

    private setState(s: PagerState): void {
        this.state = s;
        this.changed.emit();
    }

    private async fetchPage(): Promise<{ sets: OnlineSet[]; end: boolean }> {
        const q = this.query;
        const signal = this.controller.signal;
        if (q.tab === 'favourites') return this.favouritesPage(signal);
        if (q.tab === 'search') {
            const keyword = q.keyword.trim();
            const lead: OnlineSet[] = [];
            // A bare number is most likely a set id: show that set first.
            if (this.offset === 0 && /^\d{1,9}$/.test(keyword)) {
                const hit = await this.source.setInfo(Number(keyword), signal).catch(e => {
                    if (isAbortError(e)) throw e;
                    return null;
                });
                if (hit && isStandardSet(hit)) lead.push(hit);
            }
            const r = await this.source.list('search', { offset: this.offset, limit: PAGE_SIZE, keyword, signal, standardOnly: true });
            this.offset = r.nextOffset;
            return { sets: lead.concat(r.sets), end: r.end };
        }
        const filtered = supportsGenreFilter(q.tab) && (q.genre !== 1 || q.lang !== 1);
        const kind: ListKind = filtered ? 'genre' : q.tab;
        const random = kind === 'random';
        const r = await this.source.list(kind, {
            // Random pages pick their own offset every time.
            offset: random ? undefined : this.offset,
            limit: PAGE_SIZE,
            genre: q.genre,
            lang: q.lang,
            signal,
            standardOnly: true,
        });
        this.offset = r.nextOffset;
        return { sets: r.sets, end: random ? false : r.end };
    }

    private async favouritesPage(signal: AbortSignal): Promise<{ sets: OnlineSet[]; end: boolean }> {
        const ids = this.favouriteIds ?? [];
        const slice = ids.slice(this.offset, this.offset + FAVOURITES_PAGE);
        const sets = await Promise.all(slice.map(async sid => {
            try {
                return (await this.source.setInfo(sid, signal)) ?? this.source.fallback(sid);
            } catch (e) {
                if (isAbortError(e)) throw e;
                return this.source.fallback(sid);
            }
        }));
        this.offset += slice.length;
        return { sets, end: this.offset >= ids.length };
    }
}
