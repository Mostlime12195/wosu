/**
 * Read-only beatmap mirror client: listings, search and per-set info.
 *
 * Requests for the same resource are shared while in flight, and set /
 * difficulty info is LRU-cached per provider (listing cards ask for the
 * same sets repeatedly as the user scrolls and switches tabs).
 */
import {
    isStandardSet,
    type ListKind,
    type ListRequest,
    type OnlineDifficulty,
    type OnlineSet,
    type Provider,
} from './providers';

export type ProviderSource = () => { browse: Provider; download: Provider };
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ListOptions {
    offset?: number;
    limit?: number;
    keyword?: string;
    genre?: number | null;
    lang?: number | null;
    signal?: AbortSignal;
    /** Drop sets without an osu!standard difficulty. */
    standardOnly?: boolean;
}

export interface ListResult {
    sets: OnlineSet[];
    /** The provider has no more rows after this page. */
    end: boolean;
    /** Offset to request for the next page. */
    nextOffset: number;
}

/** Highest SayoBot offset used for "random" listings. */
const RANDOM_OFFSET_RANGE = 20000;

export class LruCache<K, V> {
    private readonly map = new Map<K, V>();

    constructor(private readonly capacity: number) {}

    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v !== undefined) {
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }

    set(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    clear(): void {
        this.map.clear();
    }

    get size(): number {
        return this.map.size;
    }
}

export function abortError(): Error {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
}

export const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

interface Shared<T> {
    promise: Promise<T>;
    controller: AbortController;
    waiters: number;
}

/** osu!standard difficulties sorted by stars. */
export function standardDifficulties(diffs: readonly OnlineDifficulty[]): OnlineDifficulty[] {
    return diffs.filter(d => d.mode === 0).sort((a, b) => a.stars - b.stars);
}

export class BeatmapApi {
    private readonly setCache = new LruCache<string, OnlineSet>(300);
    private readonly diffCache = new LruCache<string, OnlineDifficulty[]>(300);
    private readonly inflight = new Map<string, Shared<unknown>>();

    constructor(private readonly getProviders: ProviderSource, private readonly fetchImpl: FetchFn = (i, init) => fetch(i, init)) {}

    async list(kind: ListKind, opts: ListOptions = {}): Promise<ListResult> {
        const browse = this.getProviders().browse;
        const limit = Math.max(1, opts.limit ?? 20);
        let offset = Math.max(0, opts.offset ?? 0);
        if (kind === 'random' && opts.offset === undefined) offset = Math.floor(Math.random() * RANDOM_OFFSET_RANGE);
        const req: ListRequest = {
            kind,
            offset,
            limit,
            keyword: opts.keyword ?? '',
            genre: opts.genre ?? null,
            lang: opts.lang ?? null,
        };
        const { url, fetchSize } = browse.listUrl(req);
        // Random pages are never shared: two random requests want different rows.
        const json = kind === 'random'
            ? await this.fetchJson(url, opts.signal)
            : await this.shared(`list:${url}`, s => this.fetchJson(url, s), opts.signal);
        let sets = browse.normalizeList(json, { ...req, fetchSize });
        for (const s of sets) {
            // Mino search rows carry difficulties: prime the caches.
            if (s.difficulties) {
                this.diffCache.set(`${browse.id}:${s.sid}`, s.difficulties);
                this.setCache.set(`${browse.id}:${s.sid}`, s);
            }
        }
        if (opts.standardOnly) sets = sets.filter(isStandardSet);
        return { sets, end: browse.rawCount(json) < fetchSize, nextOffset: offset + limit };
    }

    /** Set metadata with difficulties; null when the mirror doesn't know it. */
    async setInfo(sid: number, signal?: AbortSignal): Promise<OnlineSet | null> {
        const browse = this.getProviders().browse;
        const key = `${browse.id}:${sid}`;
        const hit = this.setCache.get(key);
        if (hit && hit.difficulties) return hit;
        const url = browse.setInfoUrl(sid);
        const set = await this.shared(`set:${url}`, async s => browse.normalizeSet(await this.fetchJson(url, s)), signal);
        if (set) {
            this.setCache.set(key, set);
            if (set.difficulties) this.diffCache.set(key, set.difficulties);
        }
        return set;
    }

    /** All difficulties of a set (any mode; see `standardDifficulties`). */
    async difficulties(sid: number, signal?: AbortSignal): Promise<OnlineDifficulty[]> {
        const browse = this.getProviders().browse;
        const key = `${browse.id}:${sid}`;
        const hit = this.diffCache.get(key);
        if (hit) return hit;
        const url = browse.infoUrl(sid);
        const diffs = await this.shared(`diffs:${url}`, async s => browse.normalizeDifficulties(await this.fetchJson(url, s)), signal);
        if (diffs.length) this.diffCache.set(key, diffs);
        return diffs;
    }

    clearCache(): void {
        this.setCache.clear();
        this.diffCache.clear();
    }

    private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
        const res = await this.fetchImpl(url, signal ? { signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // SayoBot labels JSON as text/html: parse the text ourselves.
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error('Mirror returned invalid JSON');
        }
    }

    /**
     * Run `fn` once per key while in flight. Each caller may abort
     * independently; the underlying request is cancelled only when every
     * waiting caller has aborted.
     */
    private shared<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(abortError());
        let entry = this.inflight.get(key) as Shared<T> | undefined;
        if (!entry) {
            const controller = new AbortController();
            const promise = fn(controller.signal);
            const created: Shared<T> = { promise, controller, waiters: 0 };
            entry = created;
            this.inflight.set(key, created as Shared<unknown>);
            const cleanup = () => {
                if (this.inflight.get(key) === (created as Shared<unknown>)) this.inflight.delete(key);
            };
            promise.then(cleanup, cleanup);
        }
        const e = entry;
        e.waiters++;
        if (!signal) return e.promise;
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                if (--e.waiters <= 0) {
                    e.controller.abort();
                    if (this.inflight.get(key) === (e as Shared<unknown>)) this.inflight.delete(key);
                }
                reject(abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            e.promise.then(
                v => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    resolve(v);
                },
                err => {
                    if (settled) return;
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    reject(err);
                },
            );
        });
    }
}
