import { describe, expect, it, vi } from 'vitest';
import { AccountManager, ApiError, base64, toScoreRecord, type OnlineScore } from '../../src/online/Account';
import type { ScoreRecord } from '../../src/storage/ScoreStore';

type Call = { url: string; init?: RequestInit };

/** fetch mock answering by (method, path) with JSON bodies or Responses. */
function mockApi(routes: Record<string, unknown | ((call: Call) => unknown)>) {
    const calls: Call[] = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        const call = { url, init };
        calls.push(call);
        const key = `${init?.method ?? 'GET'} ${url.replace(/\?.*$/, '')}`;
        const r = routes[key];
        if (r === undefined) return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 });
        const body = typeof r === 'function' ? r(call) : r;
        if (body instanceof Response) return body;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { fn: fn as unknown as typeof fetch, calls };
}

const user = { id: 1, name: 'lime', pp: 123.4, accuracy: 0.98, rankedScore: 100, playCount: 3, rank: 7, created: 1 };

const record: ScoreRecord = {
    beatmapKey: 'bid:42', beatmapId: 42, setId: 7, title: 'T', artist: 'A', version: 'Insane', creator: 'C',
    mods: ['HD', 'DT'], score: 1000, accuracy: 0.97, maxCombo: 300, count300: 200, count100: 5, count50: 1, countMiss: 0,
    grade: 'S', passed: true, date: 1700000000000, player: 'lime', pp: 50.5,
};

describe('AccountManager', () => {
    it('restores the session on init and stays signed out when the API is missing', async () => {
        const api = mockApi({ 'GET /api/auth/me': { user } });
        const a = new AccountManager('/api', api.fn);
        await a.init();
        expect(a.user.value?.name).toBe('lime');
        expect(a.available.value).toBe(true);

        const dead = new AccountManager('/api', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
        await dead.init();
        expect(dead.user.value).toBeNull();
        expect(dead.available.value).toBe(false);
        // A 404 (static host, no server) still counts as "answered", just signed out.
        const none = new AccountManager('/api', mockApi({}).fn);
        await none.init();
        expect(none.user.value).toBeNull();
        expect(none.available.value).toBe(true);
    });

    it('signs in, surfaces server errors and signs out', async () => {
        const api = mockApi({
            'POST /api/auth/login': (c: Call) => {
                const body = JSON.parse(String(c.init?.body));
                return body.password === 'right' ? { user } : new Response(JSON.stringify({ error: 'Wrong name or password.' }), { status: 401 });
            },
            'POST /api/auth/logout': { ok: true },
        });
        const a = new AccountManager('/api', api.fn);
        await expect(a.login('lime', 'wrong')).rejects.toMatchObject({ status: 401, message: 'Wrong name or password.' });
        expect(a.user.value).toBeNull();
        await a.login('lime', 'right');
        expect(a.signedIn).toBe(true);
        expect(api.calls[1].init?.credentials).toBe('same-origin');
        await a.logout();
        expect(a.user.value).toBeNull();
    });

    it('submits passed plays on online beatmaps with the replay as base64', async () => {
        const api = mockApi({
            'GET /api/auth/me': { user },
            'POST /api/scores': (c: Call) => {
                const body = JSON.parse(String(c.init?.body));
                expect(body.beatmapId).toBe(42);
                expect(body.mods).toEqual(['HD', 'DT']);
                expect(body.replay).toBe(base64(new Uint8Array([1, 2, 3, 250])));
                return { score: { ...record, id: 9, userId: 1, ranked: true, hasReplay: true }, rank: 2, best: true, user: { ...user, pp: 200 } };
            },
        });
        const a = new AccountManager('/api', api.fn);
        await a.init();
        const submitted = vi.fn();
        a.submitted.add(submitted);
        expect(a.canSubmit(record)).toBe(true);
        expect(a.canSubmit({ ...record, passed: false })).toBe(false);
        expect(a.canSubmit({ ...record, beatmapId: 0 })).toBe(false);
        const r = await a.submit(record, new Uint8Array([1, 2, 3, 250]));
        expect(r.rank).toBe(2);
        expect(a.user.value?.pp).toBe(200);
        expect(submitted).toHaveBeenCalledTimes(1);
    });

    it('drops the session when the server says 401 and reports leaderboard mods', async () => {
        const api = mockApi({
            'GET /api/auth/me': { user },
            'POST /api/scores': new Response(JSON.stringify({ error: 'Sign in to do that.' }), { status: 401 }),
            'GET /api/beatmaps/42/scores': { scores: [], mine: null },
        });
        const a = new AccountManager('/api', api.fn);
        await a.init();
        await expect(a.submit(record)).rejects.toBeInstanceOf(ApiError);
        expect(a.user.value).toBeNull();
        await a.leaderboard(42, ['DT', 'HD']);
        expect(api.calls.at(-1)?.url).toBe('/api/beatmaps/42/scores?mods=DT%2CHD');
        await a.leaderboard(42);
        expect(api.calls.at(-1)?.url).toBe('/api/beatmaps/42/scores');
    });
});

describe('helpers', () => {
    it('base64 handles empty and large inputs', () => {
        expect(base64(new Uint8Array())).toBe('');
        expect(base64(new Uint8Array([104, 105]))).toBe('aGk=');
        const big = new Uint8Array(100_000).map((_, i) => i & 0xff);
        expect(atob(base64(big)).length).toBe(100_000);
    });

    it('toScoreRecord keeps the fields rows draw and never claims a local replay', () => {
        const s: OnlineScore = { ...record, id: 3, userId: 1, ranked: true, hasReplay: true, rank: 1, player: 'syl' };
        const r = toScoreRecord(s);
        expect(r.player).toBe('syl');
        expect(r.hasReplay).toBe(false);
        expect(r.passed).toBe(true);
        expect(r.id).toBeUndefined();
        expect(r.beatmapKey).toBe('bid:42');
    });
});
