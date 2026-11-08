/**
 * Custom analytics events. The site loads the self-hosted Umami tracker
 * from index.html (page views come from that); the game adds a few named
 * events so the dashboard can tell play from browsing. Without the
 * tracker (development, a static mirror) every call is a no-op. No
 * player identity is sent: Umami sees the same anonymous visitor it sees
 * for the page view.
 */
declare global {
    interface Window {
        umami?: { track(name: string, data?: Record<string, unknown>): void };
    }
}

export type EventData = Record<string, string | number | boolean>;

export function track(name: string, data?: EventData): void {
    try {
        window.umami?.track(name, data);
    } catch {
        /* an ad blocker stubbing the tracker, or a stale script */
    }
}
