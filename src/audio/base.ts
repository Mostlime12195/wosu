/**
 * Shared helpers for resolving static asset URLs from audio code.
 *
 * The build uses a relative Vite base ('./'), so BASE_URL must be resolved
 * against the *document* URL: dynamic import() and AudioWorklet modules
 * would otherwise resolve relative paths against the bundle chunk's URL.
 */
export function assetBase(): string {
    let base = '/';
    try {
        const env = (import.meta as { env?: { BASE_URL?: string } }).env;
        if (env && typeof env.BASE_URL === 'string') base = env.BASE_URL;
    } catch {
        // import.meta.env is unavailable outside Vite; keep '/'
    }
    return base.endsWith('/') ? base : base + '/';
}

/** Absolute URL for a path under the public asset base. */
export function resolveAssetUrl(path: string): string {
    const rel = assetBase() + path.replace(/^\//, '');
    const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
    const docBase = g.document?.baseURI ?? g.location?.href;
    if (!docBase) return rel;
    try {
        return new URL(rel, docBase).href;
    } catch {
        return rel;
    }
}

/** Set an AudioParam smoothly when supported, else assign directly (stubs, old engines). */
export function setParam(param: AudioParam, value: number, now: number, timeConstant = 0.015): void {
    if (typeof param.setTargetAtTime === 'function' && typeof param.cancelScheduledValues === 'function') {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, timeConstant);
    } else {
        param.value = value;
    }
}

/** Linear ramp from the current value, falling back to direct assignment. */
export function rampParam(param: AudioParam, value: number, now: number, durationSec: number): void {
    if (durationSec <= 0 || typeof param.linearRampToValueAtTime !== 'function') {
        if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
        param.value = value;
        return;
    }
    const current = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(current, now);
    param.linearRampToValueAtTime(value, now + durationSec);
}
