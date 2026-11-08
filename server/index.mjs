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
 *   GET  /api/users/:name                               -> { user, best, recent, grades }
 *   GET  /api/users/:id/avatar | /cover                 -> image
 *   PUT/DELETE /api/me/avatar | /cover                  -> { user }        (raw image body, png/jpeg/webp)
 *   POST /api/me/email        { email }                 -> { user, sent }  verification mail when mail is configured
 *   POST /api/me/password     { current, password }     -> { ok }
 *   GET  /api/auth/verify?token=                        -> HTML
 *   POST /api/auth/forgot     { email }                 -> { ok, sent }
 *   GET  /api/auth/reset?token= / POST { token, password } -> HTML / { ok }
 *   DELETE /api/scores/:id    { reason }                -> { ok }          (moderators)
 *   POST /api/users/:id/restrict { restricted, reason } -> { user }        (moderators)
 *   POST /api/users/:id/rename   { name, reason }       -> { user }        (moderators)
 *   POST /api/users/:id/role     { role }               -> { user }        (admins)
 *   GET  /api/mod/log?page=                             -> { entries }     (moderators)
 *   GET  /api/health                                    -> { ok, users, scores, mail }
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { configured as mailConfigured, sendMail } from './mail.mjs';

const scrypt = promisify(scryptCb);

const PORT = Number(process.env.PORT ?? 3100);
const DATA = process.env.WOSU_DATA ?? join(process.cwd(), 'data');
/** Where links in emails point (the site's public origin). */
const SITE_URL = (process.env.SITE_URL ?? 'https://wosu.dino.icu').replace(/\/$/, '');
const REPLAYS = join(DATA, 'replays');
const IMAGES = join(DATA, 'images');
const MAX_AVATAR = 1024 * 1024;
const MAX_COVER = 2 * 1024 * 1024;
const TOKEN_HOURS = 24;
const ROLES = ['user', 'mod', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
mkdirSync(IMAGES, { recursive: true });
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
    CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mod_log (
        id INTEGER PRIMARY KEY,
        mod_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        score_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        reason TEXT,
        created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_beatmap ON scores(beatmap_id, score DESC, submitted);
    CREATE INDEX IF NOT EXISTS scores_user ON scores(user_id, submitted DESC);
    CREATE INDEX IF NOT EXISTS users_pp ON users(pp DESC);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`);

/** Columns added after the first release (CREATE TABLE above only covers new databases). */
function addColumn(table, column, definition) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('users', 'email', 'TEXT');
addColumn('users', 'email_lower', 'TEXT');
addColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
addColumn('users', 'restricted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'restricted_reason', 'TEXT');
addColumn('users', 'avatar_ext', 'TEXT');
addColumn('users', 'avatar_v', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'cover_ext', 'TEXT');
addColumn('users', 'cover_v', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email_lower) WHERE email_lower IS NOT NULL');

const q = {
    userByName: db.prepare('SELECT * FROM users WHERE name_lower = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email_lower = ?'),
    setEmail: db.prepare('UPDATE users SET email = ?, email_lower = ?, email_verified = 0 WHERE id = ?'),
    verifyEmail: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?'),
    setImage: db.prepare('UPDATE users SET avatar_ext = CASE WHEN ? = \'avatar\' THEN ? ELSE avatar_ext END, avatar_v = CASE WHEN ? = \'avatar\' THEN avatar_v + 1 ELSE avatar_v END, cover_ext = CASE WHEN ? = \'cover\' THEN ? ELSE cover_ext END, cover_v = CASE WHEN ? = \'cover\' THEN cover_v + 1 ELSE cover_v END WHERE id = ?'),
    setRestricted: db.prepare('UPDATE users SET restricted = ?, restricted_reason = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ?, name_lower = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    insertToken: db.prepare('INSERT INTO tokens (token_hash, user_id, kind, created, expires) VALUES (?, ?, ?, ?, ?)'),
    token: db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?'),
    deleteToken: db.prepare('DELETE FROM tokens WHERE token_hash = ?'),
    deleteUserTokens: db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?'),
    expireTokens: db.prepare('DELETE FROM tokens WHERE expires < ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    deleteScore: db.prepare('DELETE FROM scores WHERE id = ?'),
    insertLog: db.prepare('INSERT INTO mod_log (mod_id, target_id, score_id, action, detail, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    modLog: db.prepare(`SELECT l.*, m.name AS mod_name, t.name AS target_name FROM mod_log l
        JOIN users m ON m.id = l.mod_id LEFT JOIN users t ON t.id = l.target_id ORDER BY l.id DESC LIMIT ? OFFSET ?`),
    userGrades: db.prepare(`SELECT grade, COUNT(*) AS n FROM scores s WHERE s.user_id = ? AND s.ranked = 1
        AND s.id = (SELECT id FROM scores x WHERE x.user_id = s.user_id AND x.beatmap_id = s.beatmap_id AND x.ranked = 1 ORDER BY score DESC, submitted ASC LIMIT 1)
        GROUP BY grade`),
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
        SELECT s.*, u.name AS player, u.avatar_ext, u.avatar_v FROM scores s
        JOIN users u ON u.id = s.user_id AND u.restricted = 0
        WHERE s.id IN (
            SELECT id FROM scores WHERE beatmap_id = ? AND (? = '' OR mods = ?)
            GROUP BY user_id HAVING id = (SELECT id FROM scores x WHERE x.user_id = scores.user_id AND x.beatmap_id = ? AND (? = '' OR x.mods = ?) ORDER BY score DESC, submitted ASC LIMIT 1)
        )
        ORDER BY s.score DESC, s.submitted ASC LIMIT ?`),
    rankOnBeatmap: db.prepare(`
        SELECT COUNT(*) + 1 AS rank FROM (
            SELECT MAX(s.score) AS best, MIN(s.submitted) AS first FROM scores s JOIN users u ON u.id = s.user_id AND u.restricted = 0
            WHERE s.beatmap_id = ? AND (? = '' OR s.mods = ?) AND s.user_id != ? GROUP BY s.user_id
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
    userRank: db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE restricted = 0 AND play_count > 0 AND (pp > ? OR (pp = ? AND id < ?))'),
    rankings: db.prepare('SELECT * FROM users WHERE play_count > 0 AND restricted = 0 ORDER BY pp DESC, id ASC LIMIT ? OFFSET ?'),
    rankedUsers: db.prepare('SELECT COUNT(*) AS n FROM users WHERE play_count > 0 AND restricted = 0'),
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

function imageUrl(u, kind) {
    const ext = kind === 'avatar' ? u.avatar_ext : u.cover_ext;
    return ext ? `/api/users/${u.id}/${kind}?v=${kind === 'avatar' ? u.avatar_v : u.cover_v}` : null;
}

/** A user as everyone sees them; `self` adds what only the owner should see. */
function publicUser(u, self = false) {
    const rank = u.play_count > 0 && !u.restricted ? q.userRank.get(u.pp, u.pp, u.id).rank : null;
    const out = {
        id: u.id,
        name: u.name,
        pp: Math.round(u.pp * 100) / 100,
        accuracy: u.accuracy,
        rankedScore: u.ranked_score,
        playCount: u.play_count,
        rank,
        created: u.created,
        lastSeen: u.last_seen,
        role: u.role ?? 'user',
        restricted: !!u.restricted,
        avatarUrl: imageUrl(u, 'avatar'),
        coverUrl: imageUrl(u, 'cover'),
    };
    if (self) {
        out.email = u.email ?? null;
        out.emailVerified = !!u.email_verified;
        out.restrictedReason = u.restricted ? u.restricted_reason ?? null : null;
    }
    return out;
}

function roleRank(role) {
    return Math.max(0, ROLES.indexOf(role ?? 'user'));
}

function requireRole(req, role) {
    const u = requireUser(req);
    if (roleRank(u.role) < roleRank(role)) throw new HttpError(403, 'You cannot do that.');
    return u;
}

function logAction(mod, action, { target = null, score = null, detail = null, reason = null } = {}) {
    q.insertLog.run(mod.id, target, score, action, detail, reason, Date.now());
}

function checkEmail(raw) {
    const email = String(raw ?? '').trim();
    if (!email) return null;
    if (email.length > 200 || !EMAIL_RE.test(email)) throw bad('That email address does not look right.');
    return email;
}

function issueToken(userId, kind) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    q.deleteUserTokens.run(userId, kind);
    q.insertToken.run(sha256(token), userId, kind, now, now + TOKEN_HOURS * 3_600_000);
    return token;
}

function consumeToken(raw, kind) {
    const token = String(raw ?? '');
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const t = q.token.get(sha256(token), kind);
    if (!t) return null;
    q.deleteToken.run(t.token_hash);
    if (t.expires < Date.now()) return null;
    return q.userById.get(t.user_id) ?? null;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The small pages linked from emails (verification result, password reset form). */
function page(title, body) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · wosu!</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1c1c24;color:#eee;font:16px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;background:#26262f;border-radius:12px}h1{font-size:22px;margin:0 0 12px}a{color:#ff66aa}
input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 14px;border-radius:6px;border:1px solid #444;background:#1c1c24;color:#eee}
button{padding:10px 18px;border:0;border-radius:6px;background:#ff66aa;color:#fff;font-weight:600;cursor:pointer}.err{color:#ff8a8a}</style>
<main>${body}</main>`;
}

const html = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return null;
};

/** PNG / JPEG / WebP by magic bytes, for uploaded images. */
function imageType(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function publicScore(s, player, avatarUrl) {
    return {
        id: s.id,
        userId: s.user_id,
        player: player ?? s.player,
        avatarUrl: avatarUrl !== undefined ? avatarUrl : s.avatar_ext ? `/api/users/${s.user_id}/avatar?v=${s.avatar_v}` : null,
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
    q.expireTokens.run(now);
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

route('GET', /^\/api\/health$/, () => ({ ok: true, ...q.counts.get(), mail: mailConfigured }));

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
    return { user: publicUser(user, true) };
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
    return { user: publicUser(user, true) };
});

route('POST', /^\/api\/auth\/logout$/, (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie('', req, 0));
    return { ok: true };
});

route('GET', /^\/api\/auth\/me$/, (req) => {
    const u = currentUser(req);
    return { user: u ? publicUser(u, true) : null, mail: mailConfigured };
});

// ---------------------------------------------------------------------------
// Account settings: email, password, pictures

route('POST', /^\/api\/me\/email$/, async (req) => {
    const user = requireUser(req);
    rateLimit(`email:${user.id}`, 6, 60 * 60_000);
    const body = await readJson(req);
    const email = checkEmail(body.email);
    if (email && q.userByEmail.get(email.toLowerCase())?.id !== undefined && q.userByEmail.get(email.toLowerCase()).id !== user.id) {
        throw new HttpError(409, 'That email address is already on another account.');
    }
    q.setEmail.run(email, email ? email.toLowerCase() : null, user.id);
    let sent = false;
    if (email) {
        const token = issueToken(user.id, 'verify');
        sent = await sendMail(email, 'Verify your wosu! email',
            `Hi ${user.name},\n\nConfirm this address for your wosu! account by opening:\n${SITE_URL}/api/auth/verify?token=${token}\n\nThe link works for ${TOKEN_HOURS} hours. If this wasn't you, ignore this mail.`);
    }
    return { user: publicUser(q.userById.get(user.id), true), sent };
});

route('GET', /^\/api\/auth\/verify$/, (_req, res, _m, url) => {
    const user = consumeToken(url.searchParams.get('token'), 'verify');
    if (!user || !user.email) return html(res, 400, page('Link expired', `<h1>That link has expired</h1><p>Ask for a new verification mail from your profile in <a href="${SITE_URL}">wosu!</a>.</p>`));
    q.verifyEmail.run(user.id);
    return html(res, 200, page('Email verified', `<h1>Email verified</h1><p>${escapeHtml(user.email)} now belongs to <b>${escapeHtml(user.name)}</b>. You can close this tab and go back to <a href="${SITE_URL}">wosu!</a>.</p>`));
});

route('POST', /^\/api\/me\/password$/, async (req) => {
    const user = requireUser(req);
    rateLimit(`password:${user.id}`, 10, 10 * 60_000);
    const body = await readJson(req);
    const { hash } = await hashPassword(String(body.current ?? ''), user.pass_salt);
    if (!timingSafeEqual(hash, user.pass_hash)) throw new HttpError(401, 'Your current password is wrong.');
    const next = await hashPassword(checkPassword(body.password));
    q.setPassword.run(next.hash, next.salt, user.id);
    // Other devices sign out; this one keeps its session.
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    q.deleteOtherSessions.run(user.id, sha256(token));
    return { ok: true };
});

route('POST', /^\/api\/auth\/forgot$/, async (req) => {
    rateLimit(`forgot:${clientIp(req)}`, 5, 60 * 60_000);
    const body = await readJson(req);
    const email = checkEmail(body.email);
    if (!email) throw bad('Enter the email address on your account.');
    if (!mailConfigured) throw new HttpError(503, 'Password resets are not available: this server cannot send mail yet.');
    const user = q.userByEmail.get(email.toLowerCase());
    let sent = false;
    if (user && user.email_verified) {
        const token = issueToken(user.id, 'reset');
        sent = await sendMail(user.email, 'Reset your wosu! password',
            `Hi ${user.name},\n\nReset the password of your wosu! account by opening:\n${SITE_URL}/api/auth/reset?token=${token}\n\nThe link works for ${TOKEN_HOURS} hours. If this wasn't you, ignore this mail.`);
    }
    // The answer never says whether the address exists.
    return { ok: true, sent: sent || !user };
});

const resetForm = (token, error = '') => page('Reset password', `<h1>Choose a new password</h1>${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${SITE_URL}/api/auth/reset"><input type="hidden" name="token" value="${escapeHtml(token)}">
<label>New password (8+ characters)<input type="password" name="password" minlength="8" required autofocus></label><button>Set password</button></form>`);

route('GET', /^\/api\/auth\/reset$/, (_req, res, _m, url) => {
    const token = String(url.searchParams.get('token') ?? '');
    if (!/^[a-f0-9]{64}$/.test(token)) return html(res, 400, page('Bad link', '<h1>That link is not valid</h1>'));
    return html(res, 200, resetForm(token));
});

route('POST', /^\/api\/auth\/reset$/, async (req, res) => {
    rateLimit(`reset:${clientIp(req)}`, 10, 60 * 60_000);
    const raw = await readBody(req);
    const form = (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    const body = form ? Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) : JSON.parse(raw.toString('utf8') || '{}');
    let password;
    try {
        password = checkPassword(body.password);
    } catch (e) {
        if (form) return html(res, 400, resetForm(String(body.token ?? ''), e.message));
        throw e;
    }
    const user = consumeToken(body.token, 'reset');
    if (!user) {
        if (form) return html(res, 400, page('Link expired', `<h1>That link has expired</h1><p>Ask for a new one from the sign-in card in <a href="${SITE_URL}">wosu!</a>.</p>`));
        throw bad('That reset link has expired.');
    }
    const next = await hashPassword(password);
    q.setPassword.run(next.hash, next.salt, user.id);
    q.deleteOtherSessions.run(user.id, '');
    if (form) return html(res, 200, page('Password changed', `<h1>Password changed</h1><p>Sign in to <a href="${SITE_URL}">wosu!</a> with your new password.</p>`));
    return { ok: true };
});

async function putImage(req, kind) {
    const user = requireUser(req);
    rateLimit(`image:${user.id}`, 20, 60 * 60_000);
    const buf = await readBody(req);
    const max = kind === 'avatar' ? MAX_AVATAR : MAX_COVER;
    if (buf.length > max) throw bad(`That picture is too large (${Math.round(max / 1024 / 1024)} MB at most).`);
    const ext = imageType(buf);
    if (!ext) throw bad('Pictures must be PNG, JPEG or WebP.');
    writeFileSync(join(IMAGES, `${kind}-${user.id}.${ext}`), buf);
    q.setImage.run(kind, ext, kind, kind, ext, kind, user.id);
    return { user: publicUser(q.userById.get(user.id), true) };
}

function dropImage(req, kind) {
    const user = requireUser(req);
    const ext = kind === 'avatar' ? user.avatar_ext : user.cover_ext;
    if (ext) {
        try {
            unlinkSync(join(IMAGES, `${kind}-${user.id}.${ext}`));
        } catch { /* already gone */ }
    }
    q.setImage.run(kind, null, kind, kind, null, kind, user.id);
    return { user: publicUser(q.userById.get(user.id), true) };
}

route('PUT', /^\/api\/me\/avatar$/, (req) => putImage(req, 'avatar'));
route('PUT', /^\/api\/me\/cover$/, (req) => putImage(req, 'cover'));
route('DELETE', /^\/api\/me\/avatar$/, (req) => dropImage(req, 'avatar'));
route('DELETE', /^\/api\/me\/cover$/, (req) => dropImage(req, 'cover'));

route('GET', /^\/api\/users\/(\d+)\/(avatar|cover)$/, (_req, res, m) => {
    const u = q.userById.get(Number(m[1]));
    const kind = m[2];
    const ext = u ? (kind === 'avatar' ? u.avatar_ext : u.cover_ext) : null;
    const file = ext ? join(IMAGES, `${kind}-${u.id}.${ext}`) : null;
    if (!file || !existsSync(file)) throw new HttpError(404, 'No picture.');
    res.setHeader('Content-Type', MIME[ext]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return readFileSync(file);
});

// ---------------------------------------------------------------------------
// Moderation

route('DELETE', /^\/api\/scores\/(\d+)$/, async (req, _res, m) => {
    const mod = requireRole(req, 'mod');
    const s = q.scoreById.get(Number(m[1]));
    if (!s) throw new HttpError(404, 'No such score.');
    const body = await readJson(req);
    q.deleteScore.run(s.id);
    try {
        unlinkSync(join(REPLAYS, `${s.id}.bin`));
    } catch { /* no replay */ }
    recomputeStats(s.user_id);
    logAction(mod, 'delete-score', { target: s.user_id, score: s.id, detail: `${s.title} [${s.version}] ${s.score} ${s.mods}`, reason: str(body.reason ?? '', 'reason', 500) || null });
    return { ok: true };
});

route('POST', /^\/api\/users\/(\d+)\/restrict$/, async (req, _res, m) => {
    const mod = requireRole(req, 'mod');
    const target = q.userById.get(Number(m[1]));
    if (!target) throw new HttpError(404, 'No such player.');
    if (target.id === mod.id) throw bad('You cannot restrict yourself.');
    if (roleRank(target.role) >= roleRank(mod.role)) throw new HttpError(403, 'Only a higher role can restrict that account.');
    const body = await readJson(req);
    const restricted = body.restricted === true ? 1 : 0;
    const reason = str(body.reason ?? '', 'reason', 500) || null;
    q.setRestricted.run(restricted, restricted ? reason : null, target.id);
    logAction(mod, restricted ? 'restrict' : 'unrestrict', { target: target.id, reason });
    return { user: publicUser(q.userById.get(target.id)) };
});

route('POST', /^\/api\/users\/(\d+)\/rename$/, async (req, _res, m) => {
    const mod = requireRole(req, 'mod');
    const target = q.userById.get(Number(m[1]));
    if (!target) throw new HttpError(404, 'No such player.');
    const body = await readJson(req);
    const name = checkName(body.name);
    const taken = q.userByName.get(name.toLowerCase());
    if (taken && taken.id !== target.id) throw new HttpError(409, 'That name is taken.');
    q.setName.run(name, name.toLowerCase(), target.id);
    logAction(mod, 'rename', { target: target.id, detail: `${target.name} -> ${name}`, reason: str(body.reason ?? '', 'reason', 500) || null });
    return { user: publicUser(q.userById.get(target.id)) };
});

route('POST', /^\/api\/users\/(\d+)\/role$/, async (req, _res, m) => {
    const admin = requireRole(req, 'admin');
    const target = q.userById.get(Number(m[1]));
    if (!target) throw new HttpError(404, 'No such player.');
    const body = await readJson(req);
    const role = String(body.role ?? '');
    if (!ROLES.includes(role)) throw bad('role must be user, mod or admin.');
    if (target.id === admin.id) throw bad('Change your own role from the server, not here.');
    q.setRole.run(role, target.id);
    logAction(admin, 'role', { target: target.id, detail: role });
    return { user: publicUser(q.userById.get(target.id)) };
});

route('GET', /^\/api\/mod\/log$/, (req, _res, _m, url) => {
    requireRole(req, 'mod');
    const page_ = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const entries = q.modLog.all(50, (page_ - 1) * 50).map((l) => ({
        id: l.id, action: l.action, detail: l.detail, reason: l.reason, created: l.created, scoreId: l.score_id,
        mod: { id: l.mod_id, name: l.mod_name }, target: l.target_id ? { id: l.target_id, name: l.target_name } : null,
    }));
    return { entries, page: page_ };
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
    return { score: publicScore(saved, user.name, imageUrl(user, 'avatar')), rank, best: best.id === id, user: publicUser(q.userById.get(user.id), true) };
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
    return { imported, skipped, invalid, user: publicUser(q.userById.get(user.id), true) };
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
            mine = { ...publicScore(best, user.name, imageUrl(user, 'avatar')), rank };
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
        avatarUrl: imageUrl(u, 'avatar'),
    }));
    return { users, page, pages, total };
});

route('GET', /^\/api\/users\/([^/]+)$/, (_req, _res, m) => {
    const name = decodeURIComponent(m[1]).replace(/\s+/g, ' ').trim().toLowerCase();
    const u = q.userByName.get(name);
    if (!u) throw new HttpError(404, 'No such player.');
    const avatar = imageUrl(u, 'avatar');
    const grades = { XH: 0, X: 0, SH: 0, S: 0, A: 0 };
    for (const g of q.userGrades.all(u.id)) if (g.grade in grades) grades[g.grade] = g.n;
    return {
        user: publicUser(u),
        best: q.userTopPp.all(u.id, 50).map((s) => publicScore(s, u.name, avatar)),
        recent: q.userRecent.all(u.id, 50).map((s) => publicScore(s, u.name, avatar)),
        grades,
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
        if (body === null) return;
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

