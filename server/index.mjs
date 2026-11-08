/**
 * wosu! online: accounts, score submission and leaderboards.
 *
 * A single Node process (Node 22+, no dependencies) with a SQLite database
 * and replay files on disk. The static site proxies /api/* here.
 *
 *   WOSU_DATA=/var/lib/wosu PORT=3100 node server/index.mjs
 *
 * Routes (JSON unless noted):
 *   POST /api/auth/register   { name, password }        -> { user }        sets the session cookie
 *   POST /api/auth/login      { name, password }        -> { user }
 *   POST /api/auth/logout                               -> { ok }
 *   GET  /api/auth/me                                   -> { user | null }
 *   POST /api/scores          { score fields, replay? } -> { score, rank }  (signed in; passed, online beatmaps only)
 *   POST /api/scores/import   { scores: [...] }         -> { imported, skipped, invalid }  (a device's local scores, 25 per call)
 *   GET  /api/beatmaps/:id/scores?mods=HD,DT            -> { scores, mine }
 *   GET  /api/scores/:id/replay                         -> replay bytes (application/octet-stream)
 *   GET  /api/rankings?page=1                           -> { users, page, pages }
 *   GET  /api/users/:name                               -> { user, best, recent }
 *   GET  /api/health                                    -> { ok, users, scores }
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const PORT = Number(process.env.PORT ?? 3100);
const DATA = process.env.WOSU_DATA ?? join(process.cwd(), 'data');
const REPLAYS = join(DATA, 'replays');
const SESSION_COOKIE = 'wosu_session';
const SESSION_DAYS = 180;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_REPLAY = 3 * 1024 * 1024;
const NAME_MIN = 2;
const NAME_MAX = 15;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const LEADERBOARD_SIZE = 50;
const RANKINGS_PAGE = 50;
const IMPORT_BATCH = 25;
const GRADES = new Set(['XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D']);
const MODS = new Set(['EZ', 'NF', 'HT', 'DC', 'HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'DA', 'RX', 'AP', 'SO']);
/** Mods whose scores do not count towards the global rankings (osu!: unranked). */
const UNRANKED_MODS = new Set(['RX', 'AP', 'DA']);

mkdirSync(REPLAYS, { recursive: true });
const db = new DatabaseSync(join(DATA, 'wosu.sqlite'));
db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL UNIQUE,
        pass_hash BLOB NOT NULL,
        pass_salt BLOB NOT NULL,
        created INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        pp REAL NOT NULL DEFAULT 0,
        accuracy REAL NOT NULL DEFAULT 0,
        ranked_score INTEGER NOT NULL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        beatmap_id INTEGER NOT NULL,
        set_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        version TEXT NOT NULL,
        creator TEXT NOT NULL,
        mods TEXT NOT NULL,
        mod_settings TEXT,
        score INTEGER NOT NULL,
        accuracy REAL NOT NULL,
        max_combo INTEGER NOT NULL,
        count300 INTEGER NOT NULL,
        count100 INTEGER NOT NULL,
        count50 INTEGER NOT NULL,
        count_miss INTEGER NOT NULL,
        count_geki INTEGER,
        count_katu INTEGER,
        grade TEXT NOT NULL,
        pp REAL,
        ranked INTEGER NOT NULL DEFAULT 1,
        mechanics TEXT,
        date INTEGER NOT NULL,
        submitted INTEGER NOT NULL,
        has_replay INTEGER NOT NULL DEFAULT 0,
        client TEXT
    );
    CREATE INDEX IF NOT EXISTS scores_beatmap ON scores(beatmap_id, score DESC, submitted);
    CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id, submitted DESC);
    CREATE INDEX IF NOT EXISTS users_pp ON users(pp DESC);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`);

const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name_lower = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, name_lower, pass_hash, pass_salt, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)'),
    touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT s.user_id, s.expires FROM sessions s WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    expireSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    insertScore: db.prepare(`INSERT INTO scores (user_id, beatmap_id, set_id, title, artist, version, creator, mods, mod_settings, score, accuracy,
        max_combo, count300, count100, count50, count_miss, count_geki, count_katu, grade, pp, ranked, mechanics, date, submitted, has_replay, client)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    markReplay: db.prepare('UPDATE scores SET has_replay = 1 WHERE id = ?'),
    scoreById: db.prepare('SELECT * FROM scores WHERE id = ?'),
    scoreExists: db.prepare('SELECT id FROM scores WHERE user_id = ? AND beatmap_id = ? AND score = ? AND date = ? LIMIT 1'),
    /** Each user's best score on a beatmap (highest score, then earliest). */
    leaderboard: db.prepare(`
        SELECT s.*, u.name AS player FROM scores s
        JOIN users u ON u.id = s.user_id
        WHERE s.id IN (
            SELECT id FROM scores WHERE beatmap_id = ? AND (? = '' OR mods = ?)
            GROUP BY user_id HAVING id = (SELECT id FROM scores x WHERE x.user_id = scores.user_id AND x.beatmap_id = ? AND (? = '' OR x.mods = ?) ORDER BY score DESC, submitted ASC LIMIT 1)
        )
        ORDER BY s.score DESC, s.submitted ASC LIMIT ?`),
    rankOnBeatmap: db.prepare(`
        SELECT COUNT(*) + 1 AS rank FROM (
            SELECT MAX(score) AS best, MIN(submitted) AS first FROM scores WHERE beatmap_id = ? AND (? = '' OR mods = ?) AND user_id != ? GROUP BY user_id
        ) WHERE best > ? OR (best = ? AND first < ?)`),
    userBestOnBeatmap: db.prepare('SELECT * FROM scores WHERE beatmap_id = ? AND user_id = ? AND (? = \'\' OR mods = ?) ORDER BY score DESC, submitted ASC LIMIT 1'),
    /** Best pp per beatmap for a user (ranked scores only), highest first. */
    userTopPp: db.prepare(`
        SELECT s.* FROM scores s WHERE s.user_id = ? AND s.ranked = 1 AND s.pp IS NOT NULL
        AND s.id = (SELECT id FROM scores x WHERE x.user_id = s.user_id AND x.beatmap_id = s.beatmap_id AND x.ranked = 1 AND x.pp IS NOT NULL ORDER BY pp DESC, submitted ASC LIMIT 1)
        ORDER BY s.pp DESC, s.submitted ASC LIMIT ?`),
    userRankedScore: db.prepare('SELECT COALESCE(SUM(best), 0) AS total FROM (SELECT MAX(score) AS best FROM scores WHERE user_id = ? AND ranked = 1 GROUP BY beatmap_id)'),
    userPlayCount: db.prepare('SELECT COUNT(*) AS n FROM scores WHERE user_id = ?'),
    userRecent: db.prepare('SELECT * FROM scores WHERE user_id = ? ORDER BY submitted DESC LIMIT ?'),
    updateStats: db.prepare('UPDATE users SET pp = ?, accuracy = ?, ranked_score = ?, play_count = ? WHERE id = ?'),
    userRank: db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE pp > ? OR (pp = ? AND id < ?)'),
    rankings: db.prepare('SELECT id, name, pp, accuracy, ranked_score, play_count FROM users WHERE play_count > 0 ORDER BY pp DESC, id ASC LIMIT ? OFFSET ?'),
    rankedUsers: db.prepare('SELECT COUNT(*) AS n FROM users WHERE play_count > 0'),
    counts: db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM scores) AS scores'),
};

// ---------------------------------------------------------------------------
// Helpers

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const bad = (message) => new HttpError(400, message);

function sha256(s) {
    return createHash('sha256').update(s).digest('hex');
}

async function hashPassword(password, salt = randomBytes(16)) {
    const hash = await scrypt(password.normalize('NFKC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { hash, salt };
}

/** Display names: 2–15 visible characters, letters/digits/space/_-[]. (osu!'s rules, roughly.) */
function checkName(raw) {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const length = [...name].length;
    if (length < NAME_MIN) throw bad(`Your name needs at least ${NAME_MIN} characters.`);
    if (length > NAME_MAX) throw bad(`Your name can be at most ${NAME_MAX} characters.`);
    if (!/^[\p{L}\p{N} _\-\[\]]+$/u.test(name)) throw bad('Names can use letters, digits, spaces, _ - [ ].');
    return name;
}

function checkPassword(raw) {
    const password = String(raw ?? '');
    if (password.length < PASSWORD_MIN) throw bad(`Your password needs at least ${PASSWORD_MIN} characters.`);
    if (password.length > PASSWORD_MAX) throw bad('That password is too long.');
    return password;
}

function int(v, name, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
    if (v == null) {
        if (optional) return null;
        throw bad(`${name} is required.`);
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${name} is not valid.`);
    return v;
}

function str(v, name, max = 300) {
    if (typeof v !== 'string') throw bad(`${name} is required.`);
    const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    return s.length > max ? s.slice(0, max) : s;
}

function modString(mods) {
    if (!Array.isArray(mods) || mods.length > 10) throw bad('mods are not valid.');
    const set = new Set();
    for (const m of mods) {
        if (typeof m !== 'string' || !MODS.has(m)) throw bad(`Unknown mod ${JSON.stringify(m)}.`);
        set.add(m);
    }
    return [...set].sort().join(',');
}

function parseCookies(header) {
    const out = {};
    for (const part of (header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function sessionCookie(token, req, maxAge = SESSION_DAYS * 86400) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.headers['x-forwarded-proto'] === 'https,https';
    return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function publicUser(u) {
    const rank = u.play_count > 0 ? q.userRank.get(u.pp, u.pp, u.id).rank : null;
    return {
        id: u.id,
        name: u.name,
        pp: Math.round(u.pp * 100) / 100,
        accuracy: u.accuracy,
        rankedScore: u.ranked_score,
        playCount: u.play_count,
        rank,
        created: u.created,
    };
}

function publicScore(s, player) {
    return {
        id: s.id,
        userId: s.user_id,
        player: player ?? s.player,
        beatmapId: s.beatmap_id,
        setId: s.set_id,
        title: s.title,
        artist: s.artist,
        version: s.version,
        creator: s.creator,
        mods: s.mods ? s.mods.split(',') : [],
        modSettings: s.mod_settings ? JSON.parse(s.mod_settings) : undefined,
        score: s.score,
        accuracy: s.accuracy,
        maxCombo: s.max_combo,
        count300: s.count300,
        count100: s.count100,
        count50: s.count50,
        countMiss: s.count_miss,
        countGeki: s.count_geki ?? undefined,
        countKatu: s.count_katu ?? undefined,
        grade: s.grade,
        pp: s.pp ?? undefined,
        ranked: !!s.ranked,
        mechanics: s.mechanics ? JSON.parse(s.mechanics) : undefined,
        date: s.date,
        hasReplay: !!s.has_replay,
    };
}

/**
 * osu!'s performance model: each beatmap's best pp counts once, weighted
 * 0.95^i by position; accuracy is weighted the same way.
 */
function recomputeStats(userId) {
    const top = q.userTopPp.all(userId, 200);
    let pp = 0, accWeighted = 0, weights = 0;
    top.forEach((s, i) => {
        const w = 0.95 ** i;
        pp += s.pp * w;
        accWeighted += s.accuracy * w;
        weights += w;
    });
    const accuracy = weights > 0 ? accWeighted / weights : 0;
    const rankedScore = q.userRankedScore.get(userId).total;
    const playCount = q.userPlayCount.get(userId).n;
    q.updateStats.run(pp, accuracy, rankedScore, playCount, userId);
}

/** Small fixed-window limiter per key (IP or user). */
const buckets = new Map();
function bucket(key, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) buckets.set(key, (b = { count: 0, reset: now + windowMs }));
    return b;
}
/** Count an attempt; refuse once the window's limit is passed. */
function rateLimit(key, limit, windowMs) {
    if (++bucket(key, windowMs).count > limit) throw new HttpError(429, 'Slow down a little and try again.');
}
/** Refuse once the window's limit is reached, without counting (see rateHit). */
function rateCheck(key, limit, windowMs) {
    if (bucket(key, windowMs).count >= limit) throw new HttpError(429, 'Slow down a little and try again.');
}
function rateHit(key, windowMs) {
    bucket(key, windowMs).count++;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
    q.expireSessions.run(now);
}, 60_000).unref();

function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || '?';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new HttpError(413, 'That request is too large.'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJson(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try {
        const v = JSON.parse(buf.toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
        return v;
    } catch {
        throw bad('The request body is not valid JSON.');
    }
}

function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = q.session.get(sha256(token));
    if (!s || s.expires < Date.now()) return null;
    return q.userById.get(s.user_id) ?? null;
}

function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Sign in to do that.');
    return u;
}

function startSession(res, req, user) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    q.insertSession.run(sha256(token), user.id, now, now + SESSION_DAYS * 86400_000);
    q.touchUser.run(now, user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, req));
}

// ---------------------------------------------------------------------------
// Routes

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/health$/, () => ({ ok: true, ...q.counts.get() }));

route('POST', /^\/api\/auth\/register$/, async (req, res) => {
    // Attempts are capped loosely; accounts actually created, tightly.
    const ip = clientIp(req);
    rateLimit(`register-try:${ip}`, 60, 60 * 60_000);
    rateCheck(`register:${ip}`, 5, 60 * 60_000);
    const body = await readJson(req);
    const name = checkName(body.name);
    const password = checkPassword(body.password);
    if (q.userByName.get(name.toLowerCase())) throw new HttpError(409, 'That name is taken.');
    const { hash, salt } = await hashPassword(password);
    const now = Date.now();
    const { lastInsertRowid } = q.insertUser.run(name, name.toLowerCase(), hash, salt, now, now);
    rateHit(`register:${ip}`, 60 * 60_000);
    const user = q.userById.get(lastInsertRowid);
    startSession(res, req, user);
    return { user: publicUser(user) };
});

route('POST', /^\/api\/auth\/login$/, async (req, res) => {
    rateLimit(`login:${clientIp(req)}`, 20, 10 * 60_000);
    const body = await readJson(req);
    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const password = String(body.password ?? '');
    const user = q.userByName.get(name);
    const { hash } = await hashPassword(password, user ? user.pass_salt : randomBytes(16));
    if (!user || !timingSafeEqual(hash, user.pass_hash)) throw new HttpError(401, 'Wrong name or password.');
    startSession(res, req, user);
    return { user: publicUser(user) };
});

route('POST', /^\/api\/auth\/logout$/, (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie('', req, 0));
    return { ok: true };
});

route('GET', /^\/api\/auth\/me$/, (req) => {
    const u = currentUser(req);
    return { user: u ? publicUser(u) : null };
});

/** Validate one submitted play into its row values (plus the decoded replay). */
function parseScore(b) {
    const beatmapId = int(b.beatmapId, 'beatmapId', { min: 1 });
    if (b.passed !== true) throw bad('Only passed plays are submitted.');
    const mods = modString(b.mods);
    const count300 = int(b.count300, 'count300');
    const count100 = int(b.count100, 'count100');
    const count50 = int(b.count50, 'count50');
    const countMiss = int(b.countMiss, 'countMiss');
    if (count300 + count100 + count50 + countMiss === 0) throw bad('An empty play cannot be submitted.');
    const score = int(b.score, 'score', { max: 2 ** 40 });
    const maxCombo = int(b.maxCombo, 'maxCombo', { max: 1_000_000 });
    const accuracy = typeof b.accuracy === 'number' && b.accuracy >= 0 && b.accuracy <= 1 ? b.accuracy : null;
    if (accuracy === null) throw bad('accuracy is not valid.');
    const grade = String(b.grade);
    if (!GRADES.has(grade)) throw bad('grade is not valid.');
    const pp = b.pp == null ? null : typeof b.pp === 'number' && Number.isFinite(b.pp) && b.pp >= 0 && b.pp < 100_000 ? Math.round(b.pp * 1000) / 1000 : null;
    if (b.pp != null && pp === null) throw bad('pp is not valid.');
    const date = int(b.date, 'date', { min: 1_500_000_000_000, max: Date.now() + 3_600_000, optional: true }) ?? Date.now();
    const ranked = mods.split(',').every((m) => !m || !UNRANKED_MODS.has(m)) ? 1 : 0;
    let modSettings = null;
    if (b.modSettings && typeof b.modSettings === 'object' && !Array.isArray(b.modSettings) && Object.keys(b.modSettings).length) {
        modSettings = JSON.stringify(b.modSettings);
        if (modSettings.length > 2000) throw bad('modSettings is too large.');
    }
    let mechanics = null;
    if (b.mechanics && typeof b.mechanics === 'object') {
        mechanics = JSON.stringify(b.mechanics);
        if (mechanics.length > 2000) throw bad('mechanics is too large.');
    }
    let replay = null;
    if (b.replay != null) {
        if (typeof b.replay !== 'string') throw bad('replay must be base64.');
        replay = Buffer.from(b.replay, 'base64');
        if (!replay.length || replay.length > MAX_REPLAY) throw bad('replay is empty or too large.');
    }
    return {
        beatmapId, setId: int(b.setId, 'setId', { optional: true }) ?? 0,
        title: str(b.title, 'title'), artist: str(b.artist, 'artist'), version: str(b.version, 'version'), creator: str(b.creator, 'creator'),
        mods, modSettings, score, accuracy, maxCombo, count300, count100, count50, countMiss,
        countGeki: int(b.countGeki, 'countGeki', { optional: true }), countKatu: int(b.countKatu, 'countKatu', { optional: true }),
        grade, pp, ranked, mechanics, date, replay,
    };
}

/** Store a parsed play (and its replay file); returns the new score id. */
function insertScore(userId, p, client, now = Date.now()) {
    const { lastInsertRowid: id } = q.insertScore.run(
        userId, p.beatmapId, p.setId, p.title, p.artist, p.version, p.creator,
        p.mods, p.modSettings, p.score, p.accuracy, p.maxCombo, p.count300, p.count100, p.count50, p.countMiss,
        p.countGeki, p.countKatu, p.grade, p.pp, p.ranked, p.mechanics, p.date, now, 0, client,
    );
    if (p.replay) {
        try {
            writeFileSync(join(REPLAYS, `${id}.bin`), p.replay);
            q.markReplay.run(id);
        } catch (e) {
            console.warn('replay write failed', e);
        }
    }
    return id;
}

function clientOf(b) {
    return typeof b.client === 'string' ? b.client.slice(0, 40) : null;
}

route('POST', /^\/api\/scores$/, async (req) => {
    const user = requireUser(req);
    rateLimit(`submit:${user.id}`, 60, 10 * 60_000);
    const b = await readJson(req);
    const p = parseScore(b);
    const now = Date.now();
    const id = insertScore(user.id, p, clientOf(b), now);
    recomputeStats(user.id);
    q.touchUser.run(now, user.id);
    const saved = q.scoreById.get(id);
    const best = q.userBestOnBeatmap.get(p.beatmapId, user.id, '', '');
    const rank = q.rankOnBeatmap.get(p.beatmapId, '', '', user.id, best.score, best.score, best.submitted).rank;
    return { score: publicScore(saved, user.name), rank, best: best.id === id, user: publicUser(q.userById.get(user.id)) };
});

/**
 * Bring a device's local scores into the account (after signing up on a
 * device that already has plays). Up to IMPORT_BATCH per request; a play
 * already on the account (same beatmap, score and date) is skipped, and an
 * invalid one is reported without failing the rest.
 */
route('POST', /^\/api\/scores\/import$/, async (req) => {
    const user = requireUser(req);
    rateLimit(`import:${user.id}`, 60, 10 * 60_000);
    const b = await readJson(req);
    if (!Array.isArray(b.scores) || b.scores.length > IMPORT_BATCH) throw bad(`scores must be a list of at most ${IMPORT_BATCH}.`);
    const client = clientOf(b);
    const now = Date.now();
    let imported = 0, skipped = 0, invalid = 0;
    for (const item of b.scores) {
        let p;
        try {
            p = parseScore(item ?? {});
        } catch (e) {
            if (e instanceof HttpError && e.status === 400) {
                invalid++;
                continue;
            }
            throw e;
        }
        if (q.scoreExists.get(user.id, p.beatmapId, p.score, p.date)) {
            skipped++;
            continue;
        }
        insertScore(user.id, p, client ? `${client} import` : 'import', now);
        imported++;
    }
    if (imported) recomputeStats(user.id);
    q.touchUser.run(now, user.id);
    return { imported, skipped, invalid, user: publicUser(q.userById.get(user.id)) };
});

route('GET', /^\/api\/beatmaps\/(\d+)\/scores$/, (req, _res, m, url) => {
    const beatmapId = Number(m[1]);
    const modsParam = url.searchParams.get('mods');
    const mods = modsParam == null ? '' : modString(modsParam ? modsParam.split(',') : []) || '';
    // mods=: "any" when the parameter is absent, exact mod set otherwise (mods= alone means no mods).
    const filter = modsParam == null ? '' : 'exact';
    const rows = q.leaderboard.all(beatmapId, filter, mods, beatmapId, filter, mods, LEADERBOARD_SIZE);
    const scores = rows.map((r, i) => ({ ...publicScore(r), rank: i + 1 }));
    let mine = null;
    const user = currentUser(req);
    if (user) {
        const best = q.userBestOnBeatmap.get(beatmapId, user.id, filter, mods);
        if (best) {
            const rank = q.rankOnBeatmap.get(beatmapId, filter, mods, user.id, best.score, best.score, best.submitted).rank;
            mine = { ...publicScore(best, user.name), rank };
        }
    }
    return { scores, mine, total: scores.length };
});

route('GET', /^\/api\/scores\/(\d+)\/replay$/, (_req, res, m) => {
    const s = q.scoreById.get(Number(m[1]));
    const file = join(REPLAYS, `${Number(m[1])}.bin`);
    if (!s || !s.has_replay || !existsSync(file)) throw new HttpError(404, 'No replay for that score.');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return readFileSync(file);
});

route('GET', /^\/api\/rankings$/, (_req, _res, _m, url) => {
    const total = q.rankedUsers.get().n;
    const pages = Math.max(1, Math.ceil(total / RANKINGS_PAGE));
    const page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    const rows = q.rankings.all(RANKINGS_PAGE, (page - 1) * RANKINGS_PAGE);
    const users = rows.map((u, i) => ({
        rank: (page - 1) * RANKINGS_PAGE + i + 1,
        id: u.id,
        name: u.name,
        pp: Math.round(u.pp * 100) / 100,
        accuracy: u.accuracy,
        rankedScore: u.ranked_score,
        playCount: u.play_count,
    }));
    return { users, page, pages, total };
});

route('GET', /^\/api\/users\/([^/]+)$/, (_req, _res, m) => {
    const name = decodeURIComponent(m[1]).replace(/\s+/g, ' ').trim().toLowerCase();
    const u = q.userByName.get(name);
    if (!u) throw new HttpError(404, 'No such player.');
    return {
        user: publicUser(u),
        best: q.userTopPp.all(u.id, 50).map((s) => publicScore(s, u.name)),
        recent: q.userRecent.all(u.id, 50).map((s) => publicScore(s, u.name)),
    };
});

// ---------------------------------------------------------------------------
// Server

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    try {
        const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
        if (!r) {
            if (routes.some((x) => x.pattern.test(url.pathname))) throw new HttpError(405, 'Method not allowed.');
            throw new HttpError(404, 'Not found.');
        }
        // Cookie auth: only accept state changes from the site itself (plus any dev origin on localhost).
        if (req.method !== 'GET') {
            const origin = req.headers.origin;
            const host = req.headers['x-forwarded-host'] ?? req.headers.host;
            if (origin && new URL(origin).host !== host && !/^localhost(:\d+)?$/.test(new URL(origin).host)) {
                throw new HttpError(403, 'Cross-site requests are not allowed.');
            }
        }
        const body = await r.handler(req, res, url.pathname.match(r.pattern), url);
        if (Buffer.isBuffer(body)) {
            res.writeHead(200);
            res.end(body);
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        }
    } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(`${req.method} ${url.pathname}`, e);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : e.message }));
    }
});

server.listen(PORT, '127.0.0.1', () => console.log(`wosu api on http://127.0.0.1:${server.address().port} (data: ${DATA})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        server.close();
        db.close();
        process.exit(0);
    });
}

