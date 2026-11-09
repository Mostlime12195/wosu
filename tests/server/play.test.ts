import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * POST /api/play and the server's own events, end to end: the API in a
 * real process, forwarding to a stand-in for Umami's /api/send.
 */
const WEBSITE = '00000000-0000-4000-8000-000000000001';
const GUEST = '3f2b6c1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

type Sent = { type: string; payload: Record<string, unknown> & { data?: Record<string, unknown> } };
let umami: Server;
let umamiUp = true;
const sent: Sent[] = [];
const agents: string[] = [];
let proc: ChildProcess;
let base = '';
let dataDir = '';

beforeAll(async () => {
    umami = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            if (!umamiUp) {
                res.writeHead(500).end();
                return;
            }
            if (req.url === '/stats/api/send') {
                sent.push(JSON.parse(body));
                agents.push(String(req.headers['user-agent']));
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
    });
    await new Promise<void>((r) => umami.listen(0, '127.0.0.1', r));
    const port = (umami.address() as { port: number }).port;
    dataDir = mkdtempSync(join(tmpdir(), 'wosu-play-'));
    proc = spawn(process.execPath, ['--no-warnings', join(process.cwd(), 'server/index.mjs')], {
        env: { ...process.env, PORT: '0', WOSU_DATA: dataDir, UMAMI_URL: `http://127.0.0.1:${port}/stats`, UMAMI_GAME_WEBSITE: WEBSITE },
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
});

afterAll(() => {
    proc?.kill();
    umami?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown) => {
        const res = await fetch(base + path, {
            method,
            headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'en-GB,en;q=0.8', origin: new URL(base).origin, ...(cookie ? { cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, body: await res.json() };
    };
}

/** Wait until Umami has received at least `n` requests. */
async function received(n: number): Promise<Sent[]> {
    for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    return sent;
}

describe('game events', () => {
    it('sends a daily snapshot on start', async () => {
        const [snap] = await received(1);
        expect(snap.payload).toMatchObject({ website: WEBSITE, id: 'server', tag: 'server', name: 'daily-snapshot' });
        expect(snap.payload.data).toMatchObject({ accounts: 0, neverPlayed: 0, scores: 0 });
        expect(agents[0]).toMatch(/^Mozilla\/5\.0 .*wosu-game-events/);
        sent.length = 0;
    });

    it('forwards a guest play by its anonymous id, with the clamped play time', async () => {
        const call = client();
        expect((await call('POST', '/play', { phase: 'open', anonId: GUEST, screen: '1920x1080' })).status).toBe(200);
        expect((await call('POST', '/play', { phase: 'start', anonId: GUEST, beatmapId: 77, mods: ['HD'], map: 'A - B [C]' })).status).toBe(200);
        // Claims an hour, but the start was just now: capped to the time since (plus a little slack).
        expect((await call('POST', '/play', { phase: 'finish', anonId: GUEST, beatmapId: 77, mods: ['HD'], ms: 3_600_000 })).status).toBe(200);
        const out = await received(4);
        expect(out.map((s) => s.payload.name ?? `view ${s.payload.url}`)).toEqual(['view /', 'view /b/77', 'play-start', 'play-finish']);
        for (const s of out) expect(s.payload).toMatchObject({ website: WEBSITE, hostname: 'wosu.dino.icu', id: `g:${GUEST}`, tag: 'guest', browser: 'firefox', os: 'Linux', device: 'desktop' });
        expect(out[0].payload).toMatchObject({ screen: '1920x1080', title: 'Game opened' });
        expect(out[1].payload.title).toBe('A - B [C]');
        expect(out[3].payload.data!.seconds).toBeLessThanOrEqual(11);
        expect(out[3].payload.data).toMatchObject({ mods: 'HD', beatmapId: 77, signedIn: false });
        sent.length = 0;
    });

    it('rejects junk and a signed-out ping without an anonymous id', async () => {
        const call = client();
        expect((await call('POST', '/play', { phase: 'dance', anonId: GUEST })).status).toBe(400);
        expect((await call('POST', '/play', { phase: 'start', anonId: GUEST, beatmapId: 'x' })).status).toBe(400);
        expect((await call('POST', '/play', { phase: 'open' })).status).toBe(400);
        expect((await call('POST', '/play', { phase: 'open', anonId: 'nope' })).status).toBe(400);
        await new Promise((r) => setTimeout(r, 50));
        expect(sent).toHaveLength(0);
    });

    it('uses the account when signed in, and reports sign-up, sign-in and scores', async () => {
        const call = client();
        const reg = await call('POST', '/auth/register', { name: 'player', password: 'longenough' });
        const id = reg.body.user.id;
        await call('POST', '/auth/login', { name: 'player', password: 'longenough' });
        await call('POST', '/play', { phase: 'start', anonId: GUEST, beatmapId: 5, mods: [] });
        await call('POST', '/scores', {
            beatmapId: 5, setId: 1, title: 'Song', artist: 'Artist', version: 'Insane', creator: 'mapper', mods: ['DT'],
            score: 1000, accuracy: 0.9512, maxCombo: 30, count300: 29, count100: 1, count50: 0, countMiss: 0, grade: 'A', passed: true, pp: 12.6,
        });
        await call('POST', '/play', { phase: 'quit', beatmapId: 5, ms: 1000 });
        const out = await received(8);
        expect(out.map((s) => s.payload.name ?? `view ${s.payload.url}`)).toEqual(['view /signup', 'signup', 'view /login', 'login', 'view /b/5', 'play-start', 'score-submit', 'play-quit']);
        for (const s of out) expect(s.payload).toMatchObject({ id: `u:${id}`, tag: 'account', language: 'en-GB' });
        expect(out[6].payload).toMatchObject({ url: '/b/5' });
        expect(out[6].payload.data).toEqual({ mods: 'DT', beatmapId: 5, map: 'Artist - Song [Insane]', grade: 'A', ranked: true, accuracy: 95.12, pp: 13, signedIn: true });
        sent.length = 0;
    });

    it('rate-limits a player', async () => {
        const call = client();
        const id = '11111111-2222-4333-8444-555555555555';
        let limited = 0;
        for (let i = 0; i < 160; i++) if ((await call('POST', '/play', { phase: 'open', anonId: id })).status === 429) limited++;
        expect(limited).toBe(10);
        sent.length = 0;
    });

    it('keeps answering while Umami is down', async () => {
        umamiUp = false;
        const call = client();
        const t0 = performance.now();
        const r = await call('POST', '/play', { phase: 'open', anonId: '99999999-2222-4333-8444-555555555555' });
        expect(r.status).toBe(200);
        expect(performance.now() - t0).toBeLessThan(500);
        expect((await call('GET', '/health')).status).toBe(200);
        umamiUp = true;
    });
});
