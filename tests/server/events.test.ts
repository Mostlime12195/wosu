import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
    actorOf, backfillEvents, clientInfo, createForwarder, MAX_PLAY_MS, maybeSnapshot, modsLabel, parsePlayPing, playEvent, runBackfill, snapshotData, umamiPayloads, UMAMI_USER_AGENT,
// @ts-expect-error plain JS module without types
} from '../../server/events.mjs';

const MODS = new Set(['HD', 'DT', 'HR', 'NF']);
const GUEST = '3f2b6c1e-8a4d-4c2b-9e1f-0a1b2c3d4e5f';
const CFG = { website: '9be6e577-eaee-46a2-8e09-48b974f2f4db', hostname: 'wosu.dino.icu' };
const T = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;

type Payload = { type: string; payload: Record<string, unknown> & { data?: Record<string, unknown> } };

describe('play pings', () => {
    it('accepts the five phases and rejects junk', () => {
        expect(parsePlayPing({ phase: 'open', anonId: GUEST }, MODS)).toMatchObject({ phase: 'open', beatmapId: 0, ms: 0, anonId: GUEST });
        expect(parsePlayPing({ phase: 'start', beatmapId: 42 }, MODS)).toMatchObject({ phase: 'start', beatmapId: 42 });
        for (const phase of ['finish', 'fail', 'quit']) expect(parsePlayPing({ phase, beatmapId: 42, ms: 5000 }, MODS)?.ms).toBe(5000);
        for (const junk of [null, 'x', [], {}, { phase: 'win' }, { phase: 'START', beatmapId: 1 }, { phase: 'start' }, { phase: 'start', beatmapId: 1.5 },
            { phase: 'start', beatmapId: '42' }, { phase: 'start', beatmapId: 2 ** 40 }, { phase: 'finish', beatmapId: 1 }, { phase: 'finish', beatmapId: 1, ms: 'lots' },
            { phase: 'fail', beatmapId: 1, ms: Number.NaN }, { phase: 'open', anonId: 'not-a-uuid' }, { phase: 'open', anonId: 12 }]) {
            expect(parsePlayPing(junk, MODS)).toBeNull();
        }
    });

    it('clamps play time, keeps local maps at 0 and drops bad optional fields', () => {
        expect(parsePlayPing({ phase: 'quit', beatmapId: 1, ms: -50 }, MODS).ms).toBe(0);
        expect(parsePlayPing({ phase: 'quit', beatmapId: 1, ms: 1e12 }, MODS).ms).toBe(MAX_PLAY_MS);
        expect(parsePlayPing({ phase: 'quit', beatmapId: 1, ms: 1234.6 }, MODS).ms).toBe(1235);
        expect(parsePlayPing({ phase: 'start', beatmapId: -1 }, MODS).beatmapId).toBe(0);
        const p = parsePlayPing({ phase: 'start', beatmapId: 7, mods: ['HD', 'XX', 3, 'DT'], map: 'A - B [C]\u0000\n'.padEnd(500, 'x'), stars: 1e9, screen: '1x1; drop', language: 'en-US', anonId: GUEST.toUpperCase() }, MODS);
        expect(p.mods).toEqual(['HD', 'DT']);
        expect(p.map.length).toBe(200);
        expect(p.map).not.toMatch(/[\u0000\n]/);
        expect(p.stars).toBeNull();
        expect(p.screen).toBeNull();
        expect(p.language).toBe('en-US');
        expect(p.anonId).toBe(GUEST);
    });

    it('prefers the account over the anonymous id', () => {
        expect(actorOf({ id: 5 }, GUEST)).toEqual({ id: 'u:5', signedIn: true });
        expect(actorOf(null, GUEST)).toEqual({ id: `g:${GUEST}`, signedIn: false });
        expect(actorOf(null, null)).toBeNull();
    });

    it('reads a rough browser / OS / device from the User-Agent', () => {
        expect(clientInfo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toEqual({ os: 'Windows 10', browser: 'chrome', device: 'desktop' });
        expect(clientInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ os: 'iOS', browser: 'ios', device: 'mobile' });
        expect(clientInfo('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toEqual({ os: 'Linux', browser: 'firefox', device: 'desktop' });
        expect(clientInfo('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toMatchObject({ os: 'Android OS', device: 'tablet' });
        expect(clientInfo('')).toEqual({});
    });

    it('labels mods like the site events do', () => {
        expect(modsLabel(['HD', 'DT'])).toBe('DTHD');
        expect(modsLabel('HD,HR')).toBe('HDHR');
        expect(modsLabel([])).toBe('NM');
        expect(modsLabel('')).toBe('NM');
    });
});

describe('Umami payloads', () => {
    const actor = { id: `g:${GUEST}`, signedIn: false };
    const client = { browser: 'firefox', os: 'Linux', device: 'desktop' };

    it('sends a page view for the game opening, tagged and with the distinct id', () => {
        const e = playEvent(parsePlayPing({ phase: 'open', anonId: GUEST, screen: '1920x1080', language: 'de' }, MODS), actor, client, T);
        const out: Payload[] = umamiPayloads(e, CFG);
        expect(out).toEqual([{ type: 'event', payload: {
            website: CFG.website, hostname: 'wosu.dino.icu', id: `g:${GUEST}`, tag: 'guest', timestamp: T / 1000,
            browser: 'firefox', os: 'Linux', device: 'desktop', screen: '1920x1080', language: 'de', url: '/', title: 'Game opened',
        } }]);
    });

    it('turns a play start into a map page view plus a play-start event', () => {
        const ping = parsePlayPing({ phase: 'start', beatmapId: 4242, mods: ['HD', 'DT'], map: 'Artist - Song [Hard]', stars: 4.271 }, MODS);
        const out: Payload[] = umamiPayloads(playEvent(ping, { id: 'u:3', signedIn: true }, {}, T), CFG);
        expect(out).toHaveLength(2);
        expect(out[0].payload).toMatchObject({ url: '/b/4242', title: 'Artist - Song [Hard]', id: 'u:3', tag: 'account' });
        expect(out[0].payload.name).toBeUndefined();
        expect(out[1].payload).toMatchObject({ url: '/b/4242', name: 'play-start', tag: 'account', timestamp: T / 1000 });
        expect(out[1].payload.data).toEqual({ mods: 'DTHD', beatmapId: 4242, map: 'Artist - Song [Hard]', stars: 4.27, signedIn: true });
    });

    it('sends finish / fail / quit as events only, with whole seconds', () => {
        for (const phase of ['finish', 'fail', 'quit']) {
            const out: Payload[] = umamiPayloads(playEvent(parsePlayPing({ phase, beatmapId: 0, ms: 61_400 }, MODS), actor, {}, T), CFG);
            expect(out).toHaveLength(1);
            expect(out[0].payload).toMatchObject({ name: `play-${phase}`, url: '/b/local', tag: 'guest' });
            expect(out[0].payload.data).toEqual({ mods: 'NM', beatmapId: 0, seconds: 61, signedIn: false });
        }
    });

    it('tags server events and leaves signedIn off them', () => {
        const out: Payload[] = umamiPayloads({ id: 'server', signedIn: null, ts: T, url: '/server', name: 'daily-snapshot', data: { accounts: 3 } }, CFG);
        expect(out).toEqual([{ type: 'event', payload: { website: CFG.website, hostname: 'wosu.dino.icu', id: 'server', tag: 'server', timestamp: T / 1000, url: '/server', name: 'daily-snapshot', data: { accounts: 3 } } }]);
    });

    it('never starts a name or tag with a spreadsheet formula character (Umami rejects those)', () => {
        const names = ['play-start', 'play-finish', 'play-fail', 'play-quit', 'signup', 'login', 'score-submit', 'score-import', 'daily-snapshot'];
        for (const n of [...names, 'account', 'guest', 'server']) expect(n).not.toMatch(/^[=+\-@\t\r]/);
    });
});

describe('forwarder', () => {
    type Call = { url: string; init: RequestInit };
    const fakeFetch = (calls: Call[], fail = () => false) => async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (fail()) throw new Error('connect ECONNREFUSED');
        return new Response('{}', { status: 200 });
    };
    const event = { id: 'u:1', signedIn: true, ts: T, url: '/login', name: 'login', data: {}, view: { url: '/login', title: 'Sign in' } };

    it('posts each part to /api/send with a browser-like User-Agent', async () => {
        const calls: Call[] = [];
        const f = createForwarder({ url: 'http://umami.test/stats/', ...CFG, fetchFn: fakeFetch(calls) });
        f.send(event);
        await f.idle();
        expect(calls.map(c => c.url)).toEqual(['http://umami.test/stats/api/send', 'http://umami.test/stats/api/send']);
        expect((calls[0].init.headers as Record<string, string>)['user-agent']).toBe(UMAMI_USER_AGENT);
        expect(JSON.parse(String(calls[1].init.body)).payload.name).toBe('login');
    });

    it('is a no-op without a website id', async () => {
        const calls: Call[] = [];
        const f = createForwarder({ url: 'http://umami.test', website: '', hostname: 'x', fetchFn: fakeFetch(calls) });
        f.send(event);
        await f.idle();
        expect(f.enabled).toBe(false);
        expect(await f.deliver(event)).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('returns at once and drops events while Umami is down', async () => {
        const calls: Call[] = [];
        const f = createForwarder({ url: 'http://umami.test', ...CFG, fetchFn: fakeFetch(calls, () => true), log: () => {} });
        const t0 = performance.now();
        for (let i = 0; i < 5; i++) f.send(event);
        expect(performance.now() - t0).toBeLessThan(20);
        await f.idle();
        expect(f.dropped).toBe(5);
    });

    it('bounds its queue', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        const f = createForwarder({ url: 'http://umami.test', ...CFG, maxQueue: 3, log: () => {}, fetchFn: async () => {
            await gate;
            return new Response('{}');
        } });
        for (let i = 0; i < 10; i++) f.send({ ...event, view: undefined });
        // One in flight, three queued, the rest dropped.
        expect(f.dropped).toBe(6);
        release();
        await f.idle();
        expect(f.dropped).toBe(6);
    });

    it('gives up on a hanging Umami after the timeout', async () => {
        const f = createForwarder({ url: 'http://umami.test', ...CFG, timeoutMs: 50, log: () => {}, fetchFn: (_u: string, init: RequestInit) => new Promise((_r, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('timeout')));
        }) });
        expect(await f.deliver(event)).toBe(false);
    });
});

describe('backfill and snapshot', () => {
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    function makeDb(): DatabaseSync {
        dir = mkdtempSync(join(tmpdir(), 'wosu-events-'));
        const db = new DatabaseSync(join(dir, 'test.sqlite'));
        db.exec(`
            CREATE TABLE users (id INTEGER PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, play_count INTEGER NOT NULL DEFAULT 0, first_play INTEGER);
            CREATE TABLE scores (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, beatmap_id INTEGER NOT NULL, title TEXT, artist TEXT, version TEXT, mods TEXT,
                grade TEXT, pp REAL, ranked INTEGER, accuracy REAL, client TEXT, date INTEGER NOT NULL, submitted INTEGER NOT NULL);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        const user = db.prepare('INSERT INTO users (id, created, last_seen, play_count, first_play) VALUES (?, ?, ?, ?, ?)');
        // 1: signs up day 0, plays day 0 and day 1. 2: signs up day 0, imports old plays on day 1, nothing else.
        // 3: signs up day 1, never plays, comes back day 2 (last seen only). 4: signs up after the cutoff.
        user.run(1, T - 2 * DAY, T - DAY + 60_000, 2, T - 2 * DAY + 1000);
        user.run(2, T - 2 * DAY + 5000, T - DAY, 2, T - 30 * DAY);
        user.run(3, T - DAY, T - 1000, 0, null);
        user.run(4, T + 10, T + 10, 0, null);
        const score = db.prepare(`INSERT INTO scores (id, user_id, beatmap_id, title, artist, version, mods, grade, pp, ranked, accuracy, client, date, submitted)
            VALUES (?, ?, ?, 'Song', 'Artist', 'Hard', ?, 'S', ?, 1, 0.98765, ?, ?, ?)`);
        score.run(1, 1, 100, 'HD,DT', 250.4, 'abc123', T - 2 * DAY + 1000, T - 2 * DAY + 1000);
        score.run(2, 1, 0, '', null, 'abc123', T - DAY + 60_000, 0); // submitted missing: falls back to date
        score.run(3, 2, 100, '', 10, 'abc123 import', T - 30 * DAY, T - DAY);
        score.run(4, 2, 101, '', 10, 'abc123 import', T - 31 * DAY, T - DAY);
        score.run(5, 1, 100, '', 10, 'abc123', T + 50, T + 50); // after the cutoff
        return db;
    }

    it('rebuilds sign-ups, scores, import batches, last-seen days and day-end snapshots before the cutoff', () => {
        const db = makeDb();
        const events = backfillEvents(db, T);
        const keys = events.map((e: { key: string }) => e.key);
        expect(keys).toEqual(['user:1', 'score:1', 'user:2', 'snapshot:2026-11-07', `import:2:${T - DAY}`, 'seen:2', 'user:3', 'score:2', 'snapshot:2026-11-08', 'seen:3']);
        const byKey = Object.fromEntries(events.map((e: { key: string }) => [e.key, e]));
        expect(byKey['score:1']).toMatchObject({ id: 'u:1', ts: T - 2 * DAY + 1000, name: 'score-submit', url: '/b/100', view: { url: '/b/100', title: 'Artist - Song [Hard]' } });
        expect(byKey['score:1'].data).toEqual({ mods: 'DTHD', beatmapId: 100, map: 'Artist - Song [Hard]', grade: 'S', ranked: true, accuracy: 98.77, pp: 250, backfill: true });
        expect(byKey['score:2']).toMatchObject({ ts: T - DAY + 60_000, url: '/b/local' });
        // Two imported plays, one upload: one event, no page view, counted at upload time.
        expect(byKey[`import:2:${T - DAY}`]).toMatchObject({ name: 'score-import', ts: T - DAY, data: { scores: 2, backfill: true } });
        expect(byKey[`import:2:${T - DAY}`].view).toBeUndefined();
        // Users 2 and 3 were last seen on days nothing else covers (an upload isn't a visit); user 1's last-seen day has a score.
        expect(byKey['seen:3']).toMatchObject({ id: 'u:3', ts: T - 1000, view: { url: '/' } });
        expect(byKey['seen:2']).toMatchObject({ id: 'u:2', ts: T - DAY });
        expect(keys).not.toContain('seen:1');
        // Accounts and never-played as of each finished day's end.
        expect(byKey['snapshot:2026-11-07'].data).toMatchObject({ accounts: 2, neverPlayed: 0 });
        expect(byKey['snapshot:2026-11-08'].data).toMatchObject({ accounts: 3, neverPlayed: 1 });
        expect(byKey['snapshot:2026-11-08'].ts).toBe(Date.UTC(2026, 10, 8, 23, 59, 59));
        // Nothing from the cutoff on; every event says it's a backfill.
        expect(events.every((e: { ts: number }) => e.ts < T)).toBe(true);
        expect(events.every((e: { data?: { backfill?: boolean }; key: string }) => e.key.startsWith('seen:') || e.data?.backfill === true)).toBe(true);
    });

    it('sends the backfill once, resuming after a failure without repeats', async () => {
        const db = makeDb();
        const sent: string[] = [];
        let failAt = 4;
        const forwarder = { enabled: true, deliver: async (e: { key: string }) => {
            if (sent.length === failAt) return false;
            sent.push(e.key);
            return true;
        } };
        const first = await runBackfill(db, forwarder, { website: CFG.website, now: T, log: () => {} });
        expect(first).toEqual({ sent: 4, done: false });
        failAt = -1;
        // A later start: same cutoff (stored), so user 4 and score 5 stay out.
        const second = await runBackfill(db, forwarder, { website: CFG.website, now: T + DAY, log: () => {} });
        expect(second).toEqual({ sent: 6, done: true });
        expect(sent).toEqual(backfillEvents(db, T).map((e: { key: string }) => e.key));
        expect(await runBackfill(db, forwarder, { website: CFG.website, now: T + 2 * DAY, log: () => {} })).toEqual({ sent: 0, done: true });
        expect(sent).toHaveLength(10);
    });

    it('takes a daily snapshot of the account totals, once per UTC day', () => {
        const db = makeDb();
        expect(snapshotData(db, T)).toEqual({
            accounts: 4, newAccounts: 2, neverPlayed: 2, active1d: 4, active7d: 4, active30d: 4, scores: 5,
            summary: '2026-11-09: 4 accounts, 4 active in 30d, 2 never played',
        });
        const queued: { name: string; id: string; data: { accounts: number } }[] = [];
        const forwarder = { enabled: true, send: (e: (typeof queued)[number]) => queued.push(e) };
        expect(maybeSnapshot(db, forwarder, T)).toBe(true);
        expect(maybeSnapshot(db, forwarder, T + 3_600_000)).toBe(false);
        expect(maybeSnapshot(db, forwarder, T + DAY)).toBe(true);
        expect(queued.map(e => [e.name, e.id, e.data.accounts])).toEqual([['daily-snapshot', 'server', 4], ['daily-snapshot', 'server', 4]]);
    });
});
