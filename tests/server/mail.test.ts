import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module without types
import { addressOf, buildMessage } from '../../server/mail.mjs';

describe('server mail', () => {
    it('builds a plain-text message with encoded headers and a base64 body', () => {
        const raw: string = buildMessage({
            from: 'wosu! <me@user.hackclub.app>', to: 'you@example.com', subject: 'Réinitialiser', text: 'line one\n.\nline three',
            date: new Date(Date.UTC(2026, 10, 8)), id: 'abc',
        });
        const [head, body] = raw.split('\r\n\r\n');
        expect(head).toContain('From: wosu! <me@user.hackclub.app>');
        expect(head).toContain('To: <you@example.com>');
        expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from('Réinitialiser').toString('base64')}?=`);
        expect(head).toContain('Message-ID: <abc@user.hackclub.app>');
        expect(head).toContain('Content-Transfer-Encoding: base64');
        // A lone "." line can't end the DATA early: the body is base64.
        expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('line one\r\n.\r\nline three');
        expect(body.split('\r\n').every((l: string) => l.length <= 76)).toBe(true);
    });

    it('pulls the bare address out of a display name', () => {
        expect(addressOf('wosu! <a@b.c>')).toBe('a@b.c');
        expect(addressOf('a@b.c')).toBe('a@b.c');
    });
});
