import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The online API (server/index.mjs) end to end: a real process on a free
 * port with a throwaway data directory.
 */
let proc: ChildProcess;
let base = '';
let dataDir = '';

async function start(): Promise<void> {
    dataDir = mkdtempSync(join(tmpdir(), 'wosu-api-'));
    proc = spawn(process.execPath, ['--no-warnings', join(process.cwd(), 'server/index.mjs')], {
        env: { ...process.env, PORT: '0', WOSU_DATA: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    await new Promise<void>((resolve, reject) => {
        proc.stdout!.on('data', (d) => {
            out += String(d);
            const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (m) {
                base = `http://127.0.0.1:${m[1]}/api`;
                resolve();
            }
        });
        proc.stderr!.on('data', (d) => (out += String(d)));
        proc.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
        setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000).unref();
    });
}

beforeAll(start);
afterAll(() => {
    proc?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A client with its own cookie jar. */
function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(base + path, {
            method,
            headers: { 'content-type': 'application/json', origin: new URL(base).origin, ...(cookie ? { cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const text = await res.text();
        return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
    };
    return { call };
}

const play = (beatmapId: number, score: number, mods: string[] = [], pp = 100) => ({
    beatmapId, setId: 1, title: 'Song', artist: 'Artist', version: 'Insane', creator: 'mapper', mods,
    score, accuracy: 0.98, maxCombo: 300, count300: 290, count100: 8, count50: 1, countMiss: 1, grade: 'S', passed: true, pp,
    replay: Buffer.from([1, 2, 3]).toString('base64'),
});

describe('online API', () => {
    it('registers, keeps the session in a cookie and rejects bad names and passwords', async () => {
        const c = client();
        expect((await c.call('POST', '/auth/register', { name: 'x', password: 'longenough' })).status).toBe(400);
        expect((await c.call('POST', '/auth/register', { name: 'lime', password: 'short' })).status).toBe(400);
        expect((await c.call('POST', '/auth/register', { name: 'li<me>', password: 'longenough' })).status).toBe(400);
        const r = await c.call('POST', '/auth/register', { name: 'lime', password: 'longenough' });
        expect(r.status).toBe(200);
        expect(r.body.user.name).toBe('lime');
        expect((await c.call('GET', '/auth/me')).body.user.name).toBe('lime');
        // Names are unique ignoring case.
        expect((await c.call('POST', '/auth/register', { name: 'LIME', password: 'longenough' })).status).toBe(409);
    });

    it('signs in with the right password only, case-insensitively', async () => {
        const c = client();
        expect((await c.call('POST', '/auth/login', { name: 'lime', password: 'nope' })).status).toBe(401);
        expect((await c.call('POST', '/auth/login', { name: 'nobody', password: 'longenough' })).status).toBe(401);
        expect((await c.call('POST', '/auth/login', { name: 'Lime', password: 'longenough' })).status).toBe(200);
        expect((await c.call('POST', '/auth/logout')).status).toBe(200);
        expect((await c.call('GET', '/auth/me')).body.user).toBeNull();
    });

    it('refuses cross-site state changes', async () => {
        const res = await fetch(base + '/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
        expect(res.status).toBe(403);
    });

    it('submits scores, ranks players per beatmap and globally', async () => {
        const lime = client();
        await lime.call('POST', '/auth/login', { name: 'lime', password: 'longenough' });
        const syl = client();
        await syl.call('POST', '/auth/register', { name: 'syl', password: 'longenough' });

        expect((await client().call('POST', '/scores', play(10, 1000))).status).toBe(401);
        expect((await lime.call('POST', '/scores', { ...play(10, 1000), passed: false })).status).toBe(400);
        expect((await lime.call('POST', '/scores', { ...play(10, 1000), mods: ['ZZ'] })).status).toBe(400);
        expect((await lime.call('POST', '/scores', { ...play(10, 1000), grade: 'F' })).status).toBe(400);

        const first = await lime.call('POST', '/scores', play(10, 1000, ['HD'], 120));
        expect(first.status).toBe(200);
        expect(first.body.rank).toBe(1);
        expect(first.body.best).toBe(true);
        expect(first.body.score.hasReplay).toBe(true);
        expect(first.body.score.mods).toEqual(['HD']);

        const better = await syl.call('POST', '/scores', play(10, 2000, [], 150));
        expect(better.body.rank).toBe(1);
        const worse = await lime.call('POST', '/scores', play(10, 500, [], 10));
        expect(worse.body.best).toBe(false);
        expect(worse.body.rank).toBe(2);

        // Each player appears once with their best; the signed-in player's own best comes back as `mine`.
        const board = await lime.call('GET', '/beatmaps/10/scores');
        expect(board.body.scores.map((s: { player: string; rank: number }) => [s.player, s.rank])).toEqual([['syl', 1], ['lime', 2]]);
        expect(board.body.mine.rank).toBe(2);
        expect(board.body.mine.score).toBe(1000);
        // Mod filter: exact set.
        const hd = await lime.call('GET', '/beatmaps/10/scores?mods=HD');
        expect(hd.body.scores.map((s: { player: string }) => s.player)).toEqual(['lime']);
        const nomod = await lime.call('GET', '/beatmaps/10/scores?mods=');
        expect(nomod.body.scores.map((s: { player: string }) => s.player)).toEqual(['syl', 'lime']);

        // Rankings weight each map's best pp: lime has 120 (HD play) on map 10, syl 150.
        const rankings = await lime.call('GET', '/rankings');
        expect(rankings.body.users.map((u: { name: string; rank: number }) => [u.name, u.rank])).toEqual([['syl', 1], ['lime', 2]]);
        expect(rankings.body.users[1].pp).toBe(120);
        expect(rankings.body.users[1].playCount).toBe(2);

        // Relax plays are stored but do not count towards pp.
        await lime.call('POST', '/scores', play(11, 3000, ['RX'], 999));
        const me = await lime.call('GET', '/auth/me');
        expect(me.body.user.pp).toBe(120);
        expect(me.body.user.playCount).toBe(3);

        const profile = await client().call('GET', '/users/LIME');
        expect(profile.status).toBe(200);
        expect(profile.body.user.rank).toBe(2);
        expect(profile.body.best[0].pp).toBe(120);
        expect(profile.body.recent).toHaveLength(3);

        const replay = await fetch(`${base}/scores/${first.body.score.id}/replay`);
        expect(replay.status).toBe(200);
        expect(new Uint8Array(await replay.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect((await fetch(`${base}/scores/9999/replay`)).status).toBe(404);
    });

    it('reports health', async () => {
        const h = await client().call('GET', '/health');
        expect(h.body.ok).toBe(true);
        expect(h.body.users).toBe(2);
    });
});

describe('local score import', () => {
    it('imports in bulk, skips duplicates and reports invalid entries', async () => {
        const c = client();
        await c.call('POST', '/auth/register', { name: 'importer', password: 'longenough' });
        const scores = [{ ...play(20, 100, [], 10), date: 1700000000000 }, { ...play(21, 200, ['HD'], 20), date: 1700000001000 }, { ...play(22, 300), passed: false }, { ...play(23, 400), beatmapId: 0 }];
        const r = await c.call('POST', '/scores/import', { scores });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ imported: 2, skipped: 0, invalid: 2 });
        expect(r.body.user.playCount).toBe(2);
        // The same device again: nothing new.
        const again = await c.call('POST', '/scores/import', { scores: scores.slice(0, 2) });
        expect(again.body).toMatchObject({ imported: 0, skipped: 2, invalid: 0 });
        // Too many at once is refused outright.
        const big = await c.call('POST', '/scores/import', { scores: Array.from({ length: 26 }, (_, i) => play(100 + i, 1)) });
        expect(big.status).toBe(400);
        const board = await c.call('GET', '/beatmaps/21/scores');
        expect(board.body.scores[0].player).toBe('importer');
        expect(board.body.scores[0].date).toBeGreaterThan(0);
    });
});
