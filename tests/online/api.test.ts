import { describe, expect, it, vi } from 'vitest';
import { BeatmapApi, isAbortError, LruCache, standardDifficulties } from '../../src/online/BeatmapApi';
import { resolveProviders } from '../../src/online/providers';

type Route = (url: string) => unknown;

/** fetch mock: routes by URL, records calls, optionally delays. */
function mockFetch(route: Route, delay = 0) {
    const calls: string[] = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (delay) {
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, delay);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(t);
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            });
        }
        const body = route(url);
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'text/html' } });
    });
    return { fn, calls };
}

const sayoRows = (count: number) => ({ status: 0, data: Array.from({ length: count }, (_, i) => ({ sid: i + 1, title: `t${i}`, modes: i % 2 ? 1 : 2 })) });

describe('BeatmapApi.list', () => {
    it('reports end-of-data from short pages and filters std on request', async () => {
        const { fn } = mockFetch(() => sayoRows(5));
        const api = new BeatmapApi(() => resolveProviders('sayobot', 'mino'), fn);
        const r = await api.list('latest', { limit: 20, offset: 40 });
        expect(r.sets).toHaveLength(5);
        expect(r.end).toBe(true);
        expect(r.nextOffset).toBe(60);
        const std = await api.list('popular', { limit: 20, standardOnly: true });
        expect(std.sets.every(s => s.modes & 1)).toBe(true);
        const full = mockFetch(() => sayoRows(20));
        const api2 = new BeatmapApi(() => resolveProviders('sayobot', 'mino'), full.fn);
        expect((await api2.list('latest', { limit: 20 })).end).toBe(false);
    });

    it('picks a random offset for random listings', async () => {
        const { fn, calls } = mockFetch(() => sayoRows(3));
        const api = new BeatmapApi(() => resolveProviders('sayobot', 'mino'), fn);
        await api.list('random', { limit: 10 });
        expect(calls[0]).toMatch(/1=\d+&2=1/);
    });

    it('throws on HTTP errors and invalid JSON', async () => {
        const bad = mockFetch(() => new Response('nope', { status: 500 }));
        await expect(new BeatmapApi(() => resolveProviders(), bad.fn).list('latest')).rejects.toThrow('HTTP 500');
        const junk = mockFetch(() => new Response('<html>', { status: 200 }));
        await expect(new BeatmapApi(() => resolveProviders(), junk.fn).list('latest')).rejects.toThrow(/invalid JSON/);
    });

    it('primes difficulty caches from Mino search rows', async () => {
        const set = { id: 9, title: 'T', ranked: 1, beatmaps: [{ id: 91, mode_int: 0, difficulty_rating: 3, version: 'H' }] };
        const { fn, calls } = mockFetch(() => [set]);
        const api = new BeatmapApi(() => resolveProviders('mino', 'mino'), fn);
        await api.list('search', { keyword: 'x' });
        const diffs = await api.difficulties(9);
        expect(diffs[0].bid).toBe(91);
        expect((await api.setInfo(9))!.sid).toBe(9);
        expect(calls).toHaveLength(1);
    });
});

describe('BeatmapApi info caching and sharing', () => {
    const v2 = (sid: number) => ({ status: 0, data: { sid, title: 'S', creator: 'c', approved: 1, bid_data: [{ bid: sid * 10, mode: 0, star: 2 }] } });

    it('caches set info per provider and shares in-flight requests', async () => {
        const { fn, calls } = mockFetch(url => v2(Number(url.split('=').pop())), 5);
        const api = new BeatmapApi(() => resolveProviders('sayobot', 'mino'), fn);
        const [a, b] = await Promise.all([api.setInfo(1), api.setInfo(1)]);
        expect(a).toBe(b);
        expect(calls).toHaveLength(1);
        await api.setInfo(1);
        expect(calls).toHaveLength(1);
        // difficulties come from the cached set info
        expect((await api.difficulties(1))[0].bid).toBe(10);
        expect(calls).toHaveLength(1);
        api.clearCache();
        await api.setInfo(1);
        expect(calls).toHaveLength(2);
    });

    it('returns null for unknown sets without caching the miss', async () => {
        const { fn, calls } = mockFetch(() => ({ status: -1, data: null }));
        const api = new BeatmapApi(() => resolveProviders(), fn);
        expect(await api.setInfo(5)).toBeNull();
        expect(await api.setInfo(5)).toBeNull();
        expect(calls).toHaveLength(2);
    });

    it('lets one waiter abort without cancelling the other', async () => {
        const { fn, calls } = mockFetch(() => v2(3), 20);
        const api = new BeatmapApi(() => resolveProviders(), fn);
        const ctl = new AbortController();
        const p1 = api.setInfo(3, ctl.signal);
        const p2 = api.setInfo(3, new AbortController().signal);
        ctl.abort();
        await expect(p1).rejects.toSatisfy(isAbortError);
        expect((await p2)!.sid).toBe(3);
        expect(calls).toHaveLength(1);
    });

    it('cancels the request when the only waiter aborts', async () => {
        let aborted = false;
        const fn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () => {
                aborted = true;
                const e = new Error('aborted');
                e.name = 'AbortError';
                rej(e);
            });
        }));
        const api = new BeatmapApi(() => resolveProviders(), fn);
        const ctl = new AbortController();
        const p = api.setInfo(4, ctl.signal);
        ctl.abort();
        await expect(p).rejects.toSatisfy(isAbortError);
        expect(aborted).toBe(true);
        // a pre-aborted signal never starts a request
        await expect(api.setInfo(4, ctl.signal)).rejects.toSatisfy(isAbortError);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('helpers', () => {
    it('LruCache evicts least recently used', () => {
        const c = new LruCache<string, number>(2);
        c.set('a', 1);
        c.set('b', 2);
        c.get('a');
        c.set('c', 3);
        expect(c.has('a')).toBe(true);
        expect(c.has('b')).toBe(false);
        expect(c.size).toBe(2);
    });

    it('standardDifficulties keeps osu! mode sorted by stars', () => {
        const d = (bid: number, mode: number, stars: number) => ({ bid, mode, stars, version: '', creator: '', length: 0, bpm: 0 });
        expect(standardDifficulties([d(1, 0, 5), d(2, 3, 1), d(3, 0, 2)]).map(x => x.bid)).toEqual([3, 1]);
    });
});
