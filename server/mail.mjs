/**
 * Outgoing mail (verification links, password resets) through Resend's
 * HTTP API. Without RESEND_API_KEY and MAIL_FROM nothing is sent and
 * `configured` is false, so the site keeps working: addresses are stored
 * but stay unverified and resets are unavailable.
 */
const KEY = process.env.RESEND_API_KEY ?? '';
const FROM = process.env.MAIL_FROM ?? '';

export const configured = Boolean(KEY && FROM);

/** Send one plain-text email; resolves true when the provider accepted it. */
export async function sendMail(to, subject, text) {
    if (!configured) return false;
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ from: FROM, to: [to], subject, text }),
        });
        if (!res.ok) console.warn('mail: provider refused', res.status, (await res.text()).slice(0, 200));
        return res.ok;
    } catch (e) {
        console.warn('mail: send failed', e);
        return false;
    }
}
