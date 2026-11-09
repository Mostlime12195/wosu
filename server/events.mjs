/**
 * Game events, forwarded to a self-hosted Umami.
 *
 * The game client reports plays to our own API (POST /api/play), so ad
 * blockers can't drop them, and the server adds what only it knows
 * (sign-ups, sign-ins, submitted scores, a daily account snapshot). Each
 * event goes to Umami's /api/send for a website kept just for game stats.
 *
 * Who: Umami's distinct id is 'u:<user id>' for accounts and 'g:<uuid>' for
 * guests (a random id the client keeps in localStorage), and every event is
 * tagged 'account' or 'guest'. All requests come from this server with the
 * same User-Agent and no IP, so Umami's session (and so its visitor) is one
 * per player per month: its visitors and unique-visitor charts count players.
 * Umami only counts a visitor once it has a page view, so "presence" events
 * (game opened, play started, sign-up, sign-in) also send one.
 *
 * Forwarding is fire-and-forget: a small bounded queue, one request at a
 * time with a short timeout, and anything that fails is dropped. Umami being
 * down never slows the API or the game. No IPs or other personal data are
 * sent.
 */

/** What the client may report about a play. `open` is the game starting up. */
export const PLAY_PHASES = new Set(['open', 'start', 'finish', 'fail', 'quit']);
/** Longest play time one ping can carry (marathons included). */
export const MAX_PLAY_MS = 3 * 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOD_RE = /^[A-Z]{2}$/;
/** Sent to Umami: browser-like enough for its bot filter, and the same for every event. */
export const UMAMI_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) wosu-game-events/1.0';
const DAY_MS = 86_400_000;

const clean = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** 'YYYY-MM-DD' (UTC) of a ms timestamp. */
export function dayOf(ts) {
    return new Date(ts).toISOString().slice(0, 10);
}

/** Mods as one short string, the way the site's own events have them ('HDDT', 'NM'). */
export function modsLabel(mods) {
    const list = (Array.isArray(mods) ? mods : typeof mods === 'string' && mods ? mods.split(',') : []).filter((m) => MOD_RE.test(m));
    return [...new Set(list)].sort().join('') || 'NM';
}

/**
 * Validate a play ping's body. Returns the cleaned ping, or null for junk
 * (unknown phase, a non-integer beatmap id, a bad anon id...). Play time is
 * clamped to [0, MAX_PLAY_MS]; optional fields that don't look right are
 * dropped rather than failing the ping.
 */
export function parsePlayPing(b, knownMods) {
    if (!b || typeof b !== 'object') return null;
    const phase = b.phase;
    if (typeof phase !== 'string' || !PLAY_PHASES.has(phase)) return null;
    let beatmapId = 0;
    if (phase !== 'open') {
        if (typeof b.beatmapId !== 'number' || !Number.isInteger(b.beatmapId) || Math.abs(b.beatmapId) > 2 ** 31) return null;
        beatmapId = Math.max(0, b.beatmapId);
    }
    let ms = 0;
    if (phase === 'finish' || phase === 'fail' || phase === 'quit') {
        if (typeof b.ms !== 'number' || !Number.isFinite(b.ms)) return null;
        ms = Math.round(Math.min(MAX_PLAY_MS, Math.max(0, b.ms)));
    }
    let anonId = null;
    if (b.anonId != null) {
        if (typeof b.anonId !== 'string' || !UUID_RE.test(b.anonId)) return null;
        anonId = b.anonId.toLowerCase();
    }
    const mods = Array.isArray(b.mods) && b.mods.length <= 20 ? b.mods.filter((m) => typeof m === 'string' && (!knownMods || knownMods.has(m))) : [];
    const map = typeof b.map === 'string' ? clean(b.map, 200) : '';
    const stars = typeof b.stars === 'number' && Number.isFinite(b.stars) && b.stars >= 0 && b.stars < 100 ? Math.round(b.stars * 100) / 100 : null;
    const screen = typeof b.screen === 'string' && /^\d{2,5}x\d{2,5}$/.test(b.screen) ? b.screen : null;
    const language = typeof b.language === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(b.language) && b.language.length <= 35 ? b.language : null;
    return { phase, beatmapId, ms, mods, map, stars, anonId, screen, language };
}

/**
 * Browser / OS / device from a User-Agent, using Umami's own names (so its
 * icons show). Rough on purpose: the full UA never leaves this server.
 */
export function clientInfo(ua) {
    const s = String(ua ?? '');
    if (!s) return {};
    let os = null;
    if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
    else if (/Android/.test(s)) os = 'Android OS';
    else if (/CrOS/.test(s)) os = 'Chrome OS';
    else if (/Windows NT 10/.test(s)) os = 'Windows 10';
    else if (/Windows/.test(s)) os = 'Windows';
    else if (/Mac OS X|Macintosh/.test(s)) os = 'Mac OS';
    else if (/Linux/.test(s)) os = 'Linux';
    let browser = null;
    if (/Edg\//.test(s)) browser = 'edge-chromium';
    else if (/OPR\//.test(s)) browser = 'opera';
    else if (/SamsungBrowser/.test(s)) browser = 'samsung';
    else if (/CriOS/.test(s)) browser = 'crios';
    else if (/FxiOS/.test(s)) browser = 'fxios';
    else if (/Firefox\//.test(s)) browser = 'firefox';
    else if (/Chrome\//.test(s)) browser = 'chrome';
    else if (/Safari\//.test(s)) browser = os === 'iOS' ? 'ios' : 'safari';
    let device = 'desktop';
    if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = 'tablet';
    else if (/Mobi|iPhone|iPod|Android/.test(s)) device = 'mobile';
    const out = { device };
    if (os) out.os = os;
    if (browser) out.browser = browser;
    return out;
}

/** The distinct id and kind of whoever an event is about. */
export function actorOf(user, anonId) {
    if (user) return { id: `u:${user.id}`, signedIn: true };
    if (anonId) return { id: `g:${anonId}`, signedIn: false };
    return null;
}

/** Umami path for a beatmap ('/b/123'; maps without an online id share '/b/local'). */
export const beatmapPath = (beatmapId) => (beatmapId > 0 ? `/b/${beatmapId}` : '/b/local');

/** The event for a validated play ping. */
export function playEvent(ping, actor, client, ts = Date.now()) {
    const c = { ...client };
    if (ping.screen) c.screen = ping.screen;
    if (ping.language) c.language = ping.language;
    if (ping.phase === 'open') return { id: actor.id, signedIn: actor.signedIn, ts, client: c, view: { url: '/', title: 'Game opened' } };
    const url = beatmapPath(ping.beatmapId);
    const data = { mods: modsLabel(ping.mods), beatmapId: ping.beatmapId };
    if (ping.map) data.map = ping.map;
    if (ping.stars != null) data.stars = ping.stars;
    if (ping.phase !== 'start') data.seconds = Math.round(ping.ms / 1000);
    return {
        id: actor.id, signedIn: actor.signedIn, ts, client: c, url, name: `play-${ping.phase}`, data,
        // A started play is also a page view of its map: Umami's Pages / Titles lists become the most played maps.
        view: ping.phase === 'start' ? { url, title: ping.map || (ping.beatmapId > 0 ? `Beatmap ${ping.beatmapId}` : 'Local beatmap') } : undefined,
    };
}

/** "Artist - Title [Version]" for a score row or parsed play. */
export function mapLabel(s) {
    return clean(`${s.artist} - ${s.title} [${s.version}]`, 200);
}

/**
 * The /api/send bodies for one event: a page view when the event marks
 * presence, then the named custom event with its properties.
 */
export function umamiPayloads(e, { website, hostname }) {
    const tag = e.signedIn == null ? 'server' : e.signedIn ? 'account' : 'guest';
    const base = { website, hostname, id: e.id, tag, timestamp: Math.floor(e.ts / 1000) };
    for (const k of ['browser', 'os', 'device', 'screen', 'language']) if (e.client?.[k]) base[k] = e.client[k];
    const out = [];
    if (e.view) out.push({ type: 'event', payload: { ...base, url: e.view.url, title: e.view.title } });
    if (e.name) {
        const data = { ...e.data };
        if (e.signedIn != null) data.signedIn = e.signedIn;
        out.push({ type: 'event', payload: { ...base, url: e.url ?? e.view?.url ?? '/', name: e.name, data } });
    }
    return out;
}

/**
 * Sends events to Umami. `send` queues and returns at once (dropping when
 * the queue is full); `deliver` sends now and resolves to whether Umami took
 * every part (the backfill uses it to know how far it got). Disabled (all
 * no-ops) without a website id.
 */
export function createForwarder({ url, website, hostname, fetchFn = fetch, maxQueue = 2000, timeoutMs = 3000, log = console.warn } = {}) {
    const enabled = !!(url && website);
    const endpoint = enabled ? `${url.replace(/\/$/, '')}/api/send` : '';
    const queue = [];
    let running = null;
    let dropped = 0;
    let lastWarn = 0;
    const warn = (msg) => {
        const now = Date.now();
        if (now - lastWarn > 60_000) {
            lastWarn = now;
            log(`[umami] ${msg}${dropped ? ` (${dropped} events dropped so far)` : ''}`);
        }
    };

    async function post(body) {
        const res = await fetchFn(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': UMAMI_USER_AGENT },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        // Drain the body so the connection is reused.
        await res.text().catch(() => '');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    async function deliver(e) {
        if (!enabled) return false;
        try {
            for (const body of umamiPayloads(e, { website, hostname })) await post(body);
            return true;
        } catch (err) {
            warn(`send failed: ${err?.message ?? err}`);
            return false;
        }
    }

    async function drain() {
        while (queue.length) {
            const e = queue.shift();
            if (!(await deliver(e))) dropped++;
        }
        running = null;
    }

    return {
        enabled,
        send(e) {
            if (!enabled) return;
            if (queue.length >= maxQueue) {
                dropped++;
                warn('queue full');
                return;
            }
            queue.push(e);
            running ??= drain();
        },
        deliver,
        /** Resolves once the queue is empty (tests, shutdown). */
        async idle() {
            while (running) await running;
        },
        get dropped() {
            return dropped;
        },
    };
}

// ---------------------------------------------------------------------------
// Account snapshot and backfill (need the database)

/** Account totals right now, as the daily snapshot event's properties. */
export function snapshotData(db, now = Date.now()) {
    const one = (sql, ...a) => Number(db.prepare(sql).get(...a).n);
    const accounts = one('SELECT COUNT(*) AS n FROM users');
    const neverPlayed = one('SELECT COUNT(*) AS n FROM users WHERE first_play IS NULL AND play_count = 0');
    const active = (days) => one('SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?', now - days * DAY_MS);
    const data = {
        accounts,
        newAccounts: one('SELECT COUNT(*) AS n FROM users WHERE created >= ?', now - DAY_MS),
        neverPlayed,
        active1d: active(1),
        active7d: active(7),
        active30d: active(30),
        scores: one('SELECT COUNT(*) AS n FROM scores'),
    };
    data.summary = `${dayOf(now)}: ${accounts} accounts, ${data.active30d} active in 30d, ${neverPlayed} never played`;
    return data;
}

export const snapshotEvent = (data, ts) => ({ id: 'server', signedIn: null, ts, url: '/server', name: 'daily-snapshot', data });

/**
 * Everything that happened before `cutoff`, as events in (ts, key) order:
 * sign-ups (users.created), submitted scores (at `submitted`, falling back
 * to `date`; each a page view of its map plus 'score-submit'), local-score
 * imports (one 'score-import' per upload batch: those plays happened long
 * before, so they count as an upload, not as plays), a last-seen page view
 * for days nothing else covers, and an end-of-day account snapshot for each
 * finished day (accounts and never-played as of then; activity can't be
 * rebuilt). Every event carries backfill: true.
 */
export function backfillEvents(db, cutoff) {
    const events = [];
    const days = new Map(); // `${userId}|${day}` -> covered
    const cover = (uid, ts) => days.set(`${uid}|${dayOf(ts)}`, true);
    const users = db.prepare('SELECT id, created, last_seen, first_play FROM users ORDER BY id').all();
    for (const u of users) {
        if (u.created >= cutoff) continue;
        events.push({ key: `user:${u.id}`, id: `u:${u.id}`, signedIn: true, ts: u.created, url: '/signup', name: 'signup', data: { backfill: true }, view: { url: '/signup', title: 'Sign up' } });
        cover(u.id, u.created);
    }
    const scores = db.prepare(`SELECT id, user_id, beatmap_id, title, artist, version, mods, grade, pp, ranked, accuracy, client,
        COALESCE(NULLIF(submitted, 0), date) AS ts FROM scores ORDER BY ts, id`).all();
    const imports = new Map();
    for (const s of scores) {
        if (s.ts >= cutoff) continue;
        if (typeof s.client === 'string' && s.client.endsWith('import')) {
            const k = `${s.user_id}|${s.ts}`;
            const batch = imports.get(k);
            if (batch) batch.data.scores++;
            else imports.set(k, { key: `import:${s.user_id}:${s.ts}`, id: `u:${s.user_id}`, signedIn: true, ts: s.ts, url: '/import', name: 'score-import', data: { scores: 1, backfill: true } });
            continue;
        }
        const url = beatmapPath(s.beatmap_id);
        const map = mapLabel(s);
        const data = { mods: modsLabel(s.mods), beatmapId: s.beatmap_id, map, grade: s.grade, ranked: !!s.ranked, accuracy: Math.round(s.accuracy * 10000) / 100, backfill: true };
        if (s.pp != null) data.pp = Math.round(s.pp);
        events.push({ key: `score:${s.id}`, id: `u:${s.user_id}`, signedIn: true, ts: s.ts, url, name: 'score-submit', data, view: { url, title: map } });
        cover(s.user_id, s.ts);
    }
    events.push(...imports.values());
    for (const u of users) {
        if (u.last_seen >= cutoff || days.has(`${u.id}|${dayOf(u.last_seen)}`)) continue;
        events.push({ key: `seen:${u.id}`, id: `u:${u.id}`, signedIn: true, ts: u.last_seen, view: { url: '/', title: 'Last seen (backfill)' } });
    }
    // End-of-day snapshots for finished days since the first account.
    if (users.length) {
        const first = Math.min(...users.map((u) => u.created));
        for (let end = Date.parse(`${dayOf(first)}T00:00:00Z`) + DAY_MS - 1000; end < cutoff && dayOf(end) < dayOf(cutoff); end += DAY_MS) {
            const accounts = users.filter((u) => u.created <= end);
            const neverPlayed = accounts.filter((u) => u.first_play == null || u.first_play > end).length;
            events.push({ key: `snapshot:${dayOf(end)}`, ...snapshotEvent({ accounts: accounts.length, neverPlayed, summary: `${dayOf(end)}: ${accounts.length} accounts, ${neverPlayed} never played`, backfill: true }, end) });
        }
    }
    events.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return events;
}

const after = (e, cursor) => !cursor || e.ts > cursor.ts || (e.ts === cursor.ts && e.key > cursor.key);

/**
 * Send the backfill once per website, resumably: the cutoff (the first
 * time this ran) and the last event Umami accepted are kept in the `meta`
 * table, so a restart continues where it stopped and never sends twice.
 * Stops at the first failure (Umami down) and picks up on the next start.
 */
export async function runBackfill(db, forwarder, { website, now = Date.now(), log = console.log } = {}) {
    if (!forwarder.enabled || !website) return { sent: 0, done: false };
    const get = db.prepare('SELECT value FROM meta WHERE key = ?');
    const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const key = `umami-backfill:${website}`;
    let state = get.get(key)?.value;
    state = state ? JSON.parse(state) : { cutoff: now, cursor: null, done: false };
    if (state.done) return { sent: 0, done: true };
    set.run(key, JSON.stringify(state));
    let sent = 0;
    for (const e of backfillEvents(db, state.cutoff)) {
        if (!after(e, state.cursor)) continue;
        if (!(await forwarder.deliver(e))) {
            log(`[umami] backfill paused after ${sent} events; it resumes on the next start`);
            return { sent, done: false };
        }
        state.cursor = { ts: e.ts, key: e.key };
        set.run(key, JSON.stringify(state));
        sent++;
    }
    state.done = true;
    set.run(key, JSON.stringify(state));
    if (sent) log(`[umami] backfill sent ${sent} events`);
    return { sent, done: true };
}

/** Send today's account snapshot if it hasn't gone out yet (checked every few minutes). */
export function maybeSnapshot(db, forwarder, now = Date.now()) {
    if (!forwarder.enabled) return false;
    const day = dayOf(now);
    const last = db.prepare("SELECT value FROM meta WHERE key = 'umami-snapshot-day'").get()?.value;
    if (last === day) return false;
    db.prepare("INSERT INTO meta (key, value) VALUES ('umami-snapshot-day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(day);
    forwarder.send(snapshotEvent(snapshotData(db, now), now));
    return true;
}
