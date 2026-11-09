/**
 * Game events for the site's own API (POST /api/play), which forwards them
 * to its analytics. Unlike the Umami tracker in index.html these go to the
 * wosu! server itself, so ad blockers don't drop them.
 *
 * Signed-in players are known from the session cookie. Guests are a random
 * id kept in localStorage (no name, nothing about the device); the server
 * ignores it when there is a session. Fire-and-forget: nothing waits on
 * these and failures are silent.
 */
import { DEFAULT_API_BASE } from './Account';

export type PlayPhase = 'open' | 'start' | 'finish' | 'fail' | 'quit';

export interface PlayPing {
    phase: PlayPhase;
    beatmapId?: number;
    /** Time spent playing (pauses excluded), for finish / fail / quit. */
    ms?: number;
    mods?: readonly string[];
    /** "Artist - Title [Version]" */
    map?: string;
    stars?: number;
}

const ANON_KEY = 'wosu:anon-id';
let memoryId: string | null = null;

function randomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** This browser's anonymous id (made on first use; per tab when storage is blocked). */
export function anonId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string {
    try {
        const saved = storage?.getItem(ANON_KEY);
        if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
    } catch {
        /* storage blocked */
    }
    memoryId ??= randomId();
    try {
        storage?.setItem(ANON_KEY, memoryId);
    } catch {
        /* storage blocked or full: this tab keeps the in-memory id */
    }
    return memoryId;
}

function safeStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/** The request body for a ping (the browser's screen and language ride along for the analytics session). */
export function pingBody(ping: PlayPing, id = anonId()): Record<string, unknown> {
    const body: Record<string, unknown> = { ...ping, anonId: id };
    if (ping.ms !== undefined) body.ms = Math.max(0, Math.round(ping.ms));
    if (typeof screen !== 'undefined' && screen.width > 0) body.screen = `${Math.round(screen.width)}x${Math.round(screen.height)}`;
    if (typeof navigator !== 'undefined' && navigator.language) body.language = navigator.language;
    return body;
}

export function sendPlayPing(ping: PlayPing, base = DEFAULT_API_BASE, fetchFn: typeof fetch = (...a) => fetch(...a)): void {
    try {
        void fetchFn(`${base}/play`, {
            method: 'POST',
            credentials: 'same-origin',
            // Survives the tab closing mid-play (a quit).
            keepalive: true,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pingBody(ping)),
        }).catch(() => { /* offline or no server: nothing to do */ });
    } catch {
        /* no fetch */
    }
}
