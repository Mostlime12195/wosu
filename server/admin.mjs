/**
 * Server-side admin tasks (the first admin has to come from here).
 *
 *   WOSU_DATA=/var/lib/wosu node server/admin.mjs role <name> admin|mod|user
 *   WOSU_DATA=/var/lib/wosu node server/admin.mjs restrict <name> [reason]
 *   WOSU_DATA=/var/lib/wosu node server/admin.mjs unrestrict <name>
 *   WOSU_DATA=/var/lib/wosu node server/admin.mjs delete-score <id>
 *   WOSU_DATA=/var/lib/wosu node server/admin.mjs users | mods | log
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = process.env.WOSU_DATA ?? join(process.cwd(), 'data');
const db = new DatabaseSync(join(DATA, 'wosu.sqlite'));
db.exec('PRAGMA foreign_keys = ON');
const [cmd, ...args] = process.argv.slice(2);

const byName = (name) => {
    const u = db.prepare('SELECT * FROM users WHERE name_lower = ?').get(String(name ?? '').toLowerCase());
    if (!u) {
        console.error(`no user named ${name}`);
        process.exit(1);
    }
    return u;
};
const log = (action, target, detail, reason) => db.prepare('INSERT INTO mod_log (mod_id, target_id, score_id, action, detail, reason, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(target, target, null, `server:${action}`, detail ?? null, reason ?? null, Date.now());

switch (cmd) {
    case 'role': {
        const u = byName(args[0]);
        const role = args[1];
        if (!['user', 'mod', 'admin'].includes(role)) throw new Error('role must be user, mod or admin');
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
        log('role', u.id, role);
        console.log(`${u.name} is now ${role}`);
        break;
    }
    case 'restrict': {
        const u = byName(args[0]);
        db.prepare('UPDATE users SET restricted = 1, restricted_reason = ? WHERE id = ?').run(args.slice(1).join(' ') || null, u.id);
        log('restrict', u.id, null, args.slice(1).join(' ') || null);
        console.log(`${u.name} restricted`);
        break;
    }
    case 'unrestrict': {
        const u = byName(args[0]);
        db.prepare('UPDATE users SET restricted = 0, restricted_reason = NULL WHERE id = ?').run(u.id);
        log('unrestrict', u.id);
        console.log(`${u.name} unrestricted`);
        break;
    }
    case 'delete-score': {
        const s = db.prepare('SELECT * FROM scores WHERE id = ?').get(Number(args[0]));
        if (!s) throw new Error('no such score');
        db.prepare('DELETE FROM scores WHERE id = ?').run(s.id);
        try {
            unlinkSync(join(DATA, 'replays', `${s.id}.bin`));
        } catch { /* none */ }
        log('delete-score', s.user_id, `${s.title} [${s.version}] ${s.score}`);
        console.log(`score ${s.id} deleted (stats refresh on that player's next submission)`);
        break;
    }
    case 'users':
        for (const u of db.prepare('SELECT id, name, role, restricted, pp, play_count, email, email_verified FROM users ORDER BY id').all()) {
            console.log(`${String(u.id).padStart(4)}  ${u.name.padEnd(16)} ${u.role.padEnd(6)} ${u.restricted ? 'RESTRICTED ' : ''}${u.pp.toFixed(0)}pp ${u.play_count} plays${u.email ? `  ${u.email}${u.email_verified ? ' ✓' : ' (unverified)'}` : ''}`);
        }
        break;
    case 'mods':
        for (const u of db.prepare("SELECT name, role FROM users WHERE role != 'user' ORDER BY role, name").all()) console.log(`${u.role.padEnd(6)} ${u.name}`);
        break;
    case 'log':
        for (const l of db.prepare('SELECT l.*, m.name AS mod_name, t.name AS target_name FROM mod_log l JOIN users m ON m.id = l.mod_id LEFT JOIN users t ON t.id = l.target_id ORDER BY l.id DESC LIMIT 50').all()) {
            console.log(`${new Date(l.created).toISOString()}  ${l.mod_name} ${l.action} ${l.target_name ?? ''} ${l.detail ?? ''} ${l.reason ? `(${l.reason})` : ''}`);
        }
        break;
    default:
        console.log('commands: role <name> <role> | restrict <name> [reason] | unrestrict <name> | delete-score <id> | users | mods | log');
}
db.close();
