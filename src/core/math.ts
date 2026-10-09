export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));

/**
 * Frame-rate independent exponential approach: moves `current` toward
 * `target`, covering half the distance every `halfLife` ms.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
    if (halfLife <= 0) return target;
    return target + (current - target) * Math.pow(0.5, dt / halfLife);
}

/** osu!-style difficulty interpolation (value at 0, 5 and 10). */
export function difficultyRange(difficulty: number, min: number, mid: number, max: number): number {
    if (difficulty > 5) return mid + ((max - mid) * (difficulty - 5)) / 5;
    if (difficulty < 5) return mid - ((mid - min) * (5 - difficulty)) / 5;
    return mid;
}

export function lerpColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
}

/** Multiply an RGB colour's channels (e.g. darken by 0.5). */
export function scaleColor(c: number, f: number): number {
    const r = clamp(Math.round(((c >> 16) & 255) * f), 0, 255);
    const g = clamp(Math.round(((c >> 8) & 255) * f), 0, 255);
    const b = clamp(Math.round((c & 255) * f), 0, 255);
    return (r << 16) | (g << 8) | b;
}

export function rgbToHex(r: number, g: number, b: number): number {
    return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

export function hsvToRgb(h: number, s: number, v: number): number {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r = 0, g = 0, b = 0;
    switch (((i % 6) + 6) % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
    }
    return rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

export function formatTime(ms: number): string {
    const neg = ms < 0;
    let s = Math.floor(Math.abs(ms) / 1000);
    const m = Math.floor(s / 60);
    s %= 60;
    return `${neg ? '-' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

export function formatNumber(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

/** Deterministic PRNG (mulberry32) for reproducible visuals. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Vec2 {
    x: number;
    y: number;
}

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
