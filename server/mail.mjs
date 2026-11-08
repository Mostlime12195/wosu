/**
 * Outgoing mail (verification links, password resets), dependency-free.
 *
 * Either SMTP over implicit TLS (port 465), e.g. a Hack Club Nest mailbox:
 *   SMTP_HOST=mx.user.hackclub.app SMTP_PORT=465 SMTP_USER=you@user.hackclub.app SMTP_PASS=…
 * or Resend's HTTP API:
 *   RESEND_API_KEY=…
 * plus MAIL_FROM ("wosu! <you@user.hackclub.app>"). With neither, nothing is
 * sent and `configured` is false, so the site keeps working: addresses are
 * stored but stay unverified and resets are unavailable.
 */
import { randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

const env = process.env;
const SMTP = env.SMTP_HOST ? {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT ?? 465),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
} : null;
const RESEND_KEY = env.RESEND_API_KEY ?? '';
const FROM = env.MAIL_FROM ?? '';
const TIMEOUT_MS = 20_000;

export const configured = Boolean(FROM && (SMTP || RESEND_KEY));

/** The bare address in "Name <addr>" or "addr". */
export function addressOf(from) {
    const m = /<([^>]+)>/.exec(from);
    return (m ? m[1] : from).trim();
}

/** RFC 2047 for non-ASCII header text. */
function headerText(s) {
    return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** A plain-text message, base64 body (no dot-stuffing or line-length worries). */
export function buildMessage({ from, to, subject, text, date = new Date(), id = randomBytes(12).toString('hex') }) {
    const domain = addressOf(from).split('@')[1] ?? 'localhost';
    const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    const name = /^(.*)<[^>]+>\s*$/.exec(from)?.[1].trim().replace(/^"|"$/g, '');
    return [
        `From: ${name ? `${headerText(name)} <${addressOf(from)}>` : addressOf(from)}`,
        `To: <${to}>`,
        `Subject: ${headerText(subject)}`,
        `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: <${id}@${domain}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
    ].join('\r\n');
}

/** One SMTP conversation over implicit TLS. Rejects on any unexpected reply. */
export function smtpSend({ host, port, user, pass, servername = host, rejectUnauthorized = true }, from, to, message) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port, servername, rejectUnauthorized });
        let buffer = '';
        let waiting = null;
        const timer = setTimeout(() => fail(new Error('SMTP timed out')), TIMEOUT_MS);
        const fail = (e) => {
            clearTimeout(timer);
            socket.destroy();
            reject(e);
        };
        socket.setEncoding('utf8');
        socket.on('error', fail);
        socket.on('data', (chunk) => {
            buffer += chunk;
            // A reply ends with a line "NNN text" (continuation lines are "NNN-text").
            const lines = buffer.split('\r\n');
            for (let i = 0; i < lines.length - 1; i++) {
                if (/^\d{3} /.test(lines[i])) {
                    const reply = lines.slice(0, i + 1).join('\n');
                    buffer = lines.slice(i + 1).join('\r\n');
                    const w = waiting;
                    waiting = null;
                    w?.(reply);
                    return;
                }
            }
        });
        const expect = (code, line) => new Promise((ok) => {
            waiting = (reply) => (reply.startsWith(String(code)) ? ok(reply) : fail(new Error(`SMTP: expected ${code}, got "${reply.split('\n').pop()}"`)));
            if (line !== undefined) socket.write(`${line}\r\n`);
        });
        (async () => {
            await expect(220);
            await expect(250, `EHLO ${addressOf(from).split('@')[1] ?? 'localhost'}`);
            if (user) await expect(235, `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`);
            await expect(250, `MAIL FROM:<${addressOf(from)}>`);
            await expect(250, `RCPT TO:<${to}>`);
            await expect(354, 'DATA');
            await expect(250, `${message}\r\n.`);
            socket.write('QUIT\r\n');
            clearTimeout(timer);
            socket.end();
            resolve(true);
        })().catch(fail);
    });
}

/** Send one plain-text email; resolves true when the server accepted it (never throws). */
export async function sendMail(to, subject, text) {
    if (!configured) return false;
    try {
        if (SMTP) {
            return await smtpSend(SMTP, FROM, to, buildMessage({ from: FROM, to, subject, text }));
        }
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ from: FROM, to: [to], subject, text }),
        });
        if (!res.ok) console.warn('mail: provider refused', res.status, (await res.text()).slice(0, 200));
        return res.ok;
    } catch (e) {
        console.warn('mail: send failed', e.message);
        return false;
    }
}
