import type { SliderProfile } from '../../graphics/slider/sliderGeometry';
import type { SkinConfig } from '../SkinIni';
import { drawText, glyphWidth, textWidth, type TextStyle } from './font';
import { comboColours, TRAIL_FADE, type SliderBodyStyle, type WosuSkinOptions } from './options';
import { Raster, around, circle, ellipse, len, mix, ring, roundRect, segmentDistance, strokes } from './raster';

/**
 * wosu!'s default skin, drawn from its options: every image an osu! skin
 * would ship (all @2x, at osu!'s standard sizes), the skin.ini it would
 * have, and the two things skin.ini can't say (how slider bodies and the
 * cursor trail look), which the game reads from `extras`.
 *
 * Sizes follow osu! (osu! wiki, Skinning/osu!): at @2x a 256px hitcircle
 * spans one circle diameter, so 2 image px are one osu! pixel of a
 * 128-unit circle. Elements wosu! animates itself (judgements, follow
 * circle, reverse arrows, follow points, cursor) keep the sizes the
 * previous default skin had, so they sit where they always did.
 */

/** How the game draws slider bodies for this skin (osu! skins can't say this in skin.ini). */
export type SliderLook = SliderProfile;

export interface WosuSkinExtras {
    slider: SliderLook;
    /** lazer's default cursor trail fade time (ms). */
    trailFade: number;
}

export interface GeneratedSkin {
    config: SkinConfig;
    /** Images by osu! element name (without @2x or extension); all are @2x. */
    images: Map<string, Raster>;
    extras: WosuSkinExtras;
}

/** Hit circle canvas: one circle diameter at @2x. */
const S = 256;
const C = S / 2;
/** Outer radius of the circle art (osu!'s own default leaves a similar margin). */
const RO = 120;
const BLACK = 0x000000;
const WHITE = 0xffffff;
/** Judgement colours: brighter takes on osu!'s 300 / 100 / 50 / miss hues, readable on dimmed backgrounds. */
const JUDGEMENT = { great: 0x66ccff, ok: 0x9be05a, meh: 0xffcc22, miss: 0xff4455 };

/**
 * Images already drawn, by element group and the options that group
 * depends on: changing one option only redraws what it affects.
 */
export type SkinCache = Map<string, { images: Map<string, Raster>; value: number }>;

export function generateWosuSkin(o: WosuSkinOptions, cache: SkinCache = new Map()): GeneratedSkin {
    const images = new Map<string, Raster>();
    const colours = comboColours(o);
    const accent = o.cursorColour;
    const used = new Set<string>();
    /** Run `draw` (or reuse what it drew for the same `deps`), adding its images. */
    const group = (name: string, deps: unknown[], draw: (put: Put) => number | void): number => {
        const key = `${name}:${JSON.stringify(deps)}`;
        used.add(key);
        let hit = cache.get(key);
        if (!hit) {
            const own = new Map<string, Raster>();
            const value = draw((n, r) => own.set(n, r)) ?? 0;
            cache.set(key, (hit = { images: own, value }));
        }
        for (const [n, r] of hit.images) images.set(n, r);
        return hit.value;
    };

    group('circles', [o.circleStyle], put => hitCircles(o, put));
    const numberOverlap = group('numbers', [o.circleStyle, colours, o.comboNumbers, o.numberSize], put => comboNumbers(o, colours, put));
    group('approach', [o.approachWidth], put => approachCircle(o, put));
    group('slider', [o.circleStyle, accent], put => sliderParts(o, put));
    group('followpoints', [o.followPoints], put => followPoints(o, put));
    group('judgements', [o.judgements, o.show300], put => judgements(o, put));
    group('lighting', [o.hitLighting], put => {
        if (o.hitLighting) put('lighting', lighting());
    });
    group('spinner', [], spinner);
    group('cursor', [o.cursorStyle, accent, o.trail !== 'off'], put => cursor(o, put));
    const scoreOverlap = group('score', [], scoreFont);
    group('health', [accent], put => healthBar(accent, put));
    // Forget groups these options no longer use.
    for (const key of cache.keys()) if (!used.has(key)) cache.delete(key);

    const config: SkinConfig = {
        name: 'wosu!',
        author: 'wosu! contributors',
        version: 2.7,
        comboColours: colours,
        sliderBorder: o.sliderBorder === 'accent' ? accent : WHITE,
        sliderTrackOverride: o.sliderBody === 'dark' ? 0x14141c : undefined,
        animationFramerate: -1,
        allowSliderBallTint: false,
        sliderBallFlip: false,
        cursorRotate: false,
        cursorExpand: false,
        cursorCentre: true,
        hitCircleOverlayAboveNumber: false,
        hitCirclePrefix: 'default',
        hitCircleOverlap: numberOverlap,
        scorePrefix: 'score',
        scoreOverlap,
        comboPrefix: 'score',
        comboOverlap: scoreOverlap,
    };
    return {
        config,
        images,
        extras: { slider: sliderLook(o.sliderBody, o.sliderBorderWidth, o.sliderBorder === 'combo'), trailFade: TRAIL_FADE[o.trail] },
    };
}

/** The slider body profile for a body style. */
export function sliderLook(body: SliderBodyStyle, borderWidth: number, comboBorder: boolean): SliderLook {
    switch (body) {
        case 'combo': return { borderWidth, edgeOpacity: 0.82, centreOpacity: 0.72, shade: 0.28, comboBorder };
        case 'dark': return { borderWidth, edgeOpacity: 0.92, centreOpacity: 0.88, shade: 0, comboBorder };
        case 'hollow': return { borderWidth, edgeOpacity: 0.28, centreOpacity: 0.06, shade: 0, comboBorder };
        default: return { borderWidth, edgeOpacity: 0.8, centreOpacity: 0.3, shade: 0, comboBorder };
    }
}

type Put = (name: string, r: Raster) => void;

/** A transparent placeholder (osu!'s way of hiding an element; the game skips drawing these). */
const blank = (): Raster => new Raster(2, 2);

// ---------------------------------------------------------------------------
// Hit circles
// ---------------------------------------------------------------------------

/**
 * hitcircle (tinted with the combo colour by the game) and
 * hitcircleoverlay (drawn as is, above it).
 */
function hitCircles(o: WosuSkinOptions, put: Put): void {
    switch (o.circleStyle) {
        case 'flat': {
            const body = new Raster(S, S);
            body.shape(circle(C, C, RO - 4), WHITE);
            const over = new Raster(S, S);
            // A dark hairline outside the rim keeps the circle apart from bright backgrounds and slider borders.
            over.shape(ring(C, C, RO + 1, 4), BLACK, 0.35);
            over.shape(ring(C, C, RO - 8, 16), WHITE);
            over.shape(ring(C, C, RO - 17, 2.5), BLACK, 0.18);
            put('hitcircle', body);
            put('hitcircleoverlay', over);
            break;
        }
        case 'ring': {
            const body = new Raster(S, S);
            body.shape(circle(C, C, RO - 20), WHITE, 0.22);
            body.shape(ring(C, C, RO - 14, 24), WHITE);
            const over = new Raster(S, S);
            over.shape(ring(C, C, RO + 1, 4), BLACK, 0.35);
            over.shape(ring(C, C, RO - 2, 5), WHITE);
            over.shape(ring(C, C, RO - 27, 3), WHITE, 0.75);
            put('hitcircle', body);
            put('hitcircleoverlay', over);
            break;
        }
        case 'outline': {
            const body = new Raster(S, S);
            body.shape(circle(C, C, RO - 8), WHITE, 0.16);
            const over = new Raster(S, S);
            over.shape(ring(C, C, RO + 1, 5), BLACK, 0.4);
            over.shape(ring(C, C, RO - 5, 10), WHITE);
            put('hitcircle', body);
            put('hitcircleoverlay', over);
            break;
        }
        case 'glossy': {
            const body = new Raster(S, S);
            body.glow(circle(C, C + 3, RO - 4), BLACK, 0.45, 10);
            body.shape(circle(C, C, RO - 6), (x, y) => {
                const t = len(x - C, y - C * 0.82) / RO;
                return mix(WHITE, 0x8c8c8c, Math.pow(Math.min(1, t), 1.6));
            });
            const over = new Raster(S, S);
            over.shape(ring(C, C, RO - 9, 18), (_x, y) => mix(WHITE, 0xd6d6d6, (y - (C - RO)) / (2 * RO)));
            over.shape(ring(C, C, RO, 2), BLACK, 0.3);
            // The shine: a soft white crescent across the top.
            over.fill((x, y) => {
                const inside = 0.5 - ellipse(C, C - 46, 74, 44)(x, y) / 4;
                return Math.min(1, Math.max(0, inside)) * Math.max(0, 1 - (y - (C - 90)) / 80);
            }, WHITE, 0.32, around(C, C - 46, 80));
            put('hitcircle', body);
            put('hitcircleoverlay', over);
            break;
        }
        case 'neon': {
            // Bigger than one diameter: the glow spills outside the circle (osu! allows up to two).
            const N = 320, M = N / 2;
            const body = new Raster(N, N);
            body.shape(circle(M, M, RO - 6), BLACK, 0.55);
            body.glow(ring(M, M, RO - 10, 14), WHITE, 0.55, 26);
            body.shape(ring(M, M, RO - 10, 14), WHITE);
            const over = new Raster(N, N);
            over.shape(ring(M, M, RO - 10, 4), WHITE, 0.9);
            put('hitcircle', body);
            put('hitcircleoverlay', over);
            break;
        }
    }
    // Slider ends stay hidden (like lazer's default skin and many osu! skins): a blank sliderendcircle.
    put('sliderendcircle', blank());
}

/** Relative luminance of a colour (0..1). */
function luminance(c: number): number {
    const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255].map(v => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * default-0 … default-9. White with a soft dark edge, or dark on circles
 * filled with light colours. osu! draws them at 0.8 of circle scale, so a
 * glyph px is 0.4 osu! px of a 128-unit circle.
 */
function comboNumbers(o: WosuSkinOptions, colours: number[], put: Put): number {
    const filled = o.circleStyle === 'flat' || o.circleStyle === 'glossy';
    const light = filled && colours.reduce((s, c) => s + luminance(c), 0) / colours.length > 0.72;
    // A third of the circle's height at numberSize 1.
    const size = Math.round(0.33 * 128 / 0.4 * o.numberSize);
    const style: TextStyle = { size, weight: Math.max(6, Math.round(size * 0.16)) };
    const edge = Math.max(2, Math.round(style.weight * 0.35));
    const pad = edge + 2;
    for (let i = 0; i < 10; i++) {
        const ch = String(i);
        if (!o.comboNumbers) {
            put(`default-${ch}`, blank());
            continue;
        }
        const r = new Raster(Math.ceil(glyphWidth(ch, style)) + pad * 2, size + pad * 2);
        drawText(r, ch, pad, pad, style, light ? 0x1c1c22 : WHITE, 1,
            light ? { width: edge, colour: WHITE, alpha: 0.35 } : { width: edge, colour: BLACK, alpha: 0.35 });
        put(`default-${ch}`, r);
    }
    // Glyphs carry `pad` px either side; leave a small gap between digits (overlap is in @1x units).
    const gap = size * 0.16;
    return Math.round((pad * 2 - gap) / 2);
}

/**
 * approachcircle: a thin ring that lands on the circle's rim at hit time
 * (osu! shrinks it from 4× to 1×), with a faint dark edge for contrast.
 */
function approachCircle(o: WosuSkinOptions, put: Put): void {
    const w = o.approachWidth * 2;
    const r = new Raster(S, S);
    const rc = RO + 2 - w / 2;
    r.shape(ring(C, C, rc + w / 2 + 1, 2.5), BLACK, 0.25);
    r.shape(ring(C, C, rc, w), WHITE);
    put('approachcircle', r);
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

function sliderParts(o: WosuSkinOptions, put: Put): void {
    // Ball: a white ring around a dark centre, readable on any body colour (not tinted).
    const ball = new Raster(S, S);
    if (o.circleStyle === 'glossy') {
        ball.glow(circle(C, C + 2, RO - 14), BLACK, 0.4, 10);
        ball.shape(circle(C, C, RO - 16), (x, y) => mix(WHITE, 0xb4b4b4, Math.min(1, len(x - C + 24, y - C + 30) / (RO * 1.4))));
        ball.shape(ring(C, C, RO - 18, 6), 0x9a9a9a, 0.6);
    } else {
        ball.shape(circle(C, C, RO - 16), BLACK, 0.3);
        ball.shape(ring(C, C, RO - 22, 14), WHITE);
        ball.shape(circle(C, C, 18), WHITE, 0.9);
    }
    put('sliderb', ball);

    // Follow circle: osu!'s 2.4-diameter tracking area, shown as its edge (wosu! scales it up from the ball).
    const F = Math.round(2.4 * S);
    const fc = F / 2;
    const follow = new Raster(F, F);
    follow.shape(circle(fc, fc, fc - 6), WHITE, 0.06);
    if (o.circleStyle === 'neon') follow.glow(ring(fc, fc, fc - 14, 6), o.cursorColour, 0.5, 12);
    follow.shape(ring(fc, fc, fc - 14, 7), WHITE, 0.9);
    follow.shape(ring(fc, fc, fc - 9, 2.5), BLACK, 0.2);
    put('sliderfollowcircle', follow);

    // Tick: a small white dot with a dark edge.
    const tick = new Raster(32, 32);
    tick.shape(circle(16, 16, 10), BLACK, 0.45);
    tick.shape(circle(16, 16, 7.5), WHITE);
    put('sliderscorepoint', tick);

    // Reverse arrow: a bold chevron pointing right (the game turns it), with a dark edge.
    const ra = new Raster(80, 112);
    const chevron = [24, 22, 56, 56, 24, 90];
    ra.shape(strokes([chevron], 26), BLACK, 0.35);
    ra.shape(strokes([chevron], 17), WHITE);
    put('reversearrow', ra);
}

/** followpoint: drawn additively by the game, pointing along the path (right = forwards). */
function followPoints(o: WosuSkinOptions, put: Put): void {
    if (o.followPoints === 'off') return;
    if (o.followPoints === 'dots') {
        const r = new Raster(24, 24);
        r.glow(circle(12, 12, 3.5), WHITE, 0.35, 5);
        r.shape(circle(12, 12, 4.5), WHITE, 0.85);
        put('followpoint', r);
        return;
    }
    const r = new Raster(44, 32);
    r.shape(strokes([[14, 6, 28, 16, 14, 26]], 6), WHITE, 0.9);
    put('followpoint', r);
}

// ---------------------------------------------------------------------------
// Judgements and lighting
// ---------------------------------------------------------------------------

/** A judgement image: `text` in `colour` with a dark edge, `size` px tall. */
function judgementText(text: string, colour: number, size: number): Raster {
    const style: TextStyle = { size, weight: Math.round(size * 0.2), spacing: Math.round(size * 0.12) };
    const edge = Math.round(size * 0.1);
    const pad = edge + 3;
    const r = new Raster(Math.ceil(textWidth(text, style)) + pad * 2, size + pad * 2);
    drawText(r, text, pad, pad, style, colour, 1, { width: edge, colour: BLACK, alpha: 0.45 });
    return r;
}

/** A miss cross (✕). */
function cross(size: number, colour: number): Raster {
    const pad = 8;
    const r = new Raster(size + pad * 2, size + pad * 2);
    const a = pad, b = pad + size;
    const lines = [[a, a, b, b], [b, a, a, b]];
    const w = size * 0.2;
    r.shape(strokes(lines, w + size * 0.12), BLACK, 0.45);
    r.shape(strokes(lines, w), colour);
    return r;
}

function dot(radius: number, colour: number): Raster {
    const n = Math.ceil(radius * 2 + 8);
    const r = new Raster(n, n);
    r.shape(circle(n / 2, n / 2, radius + 2), BLACK, 0.4);
    r.shape(circle(n / 2, n / 2, radius), colour);
    return r;
}

/**
 * hit300 / hit100 / hit50 / hit0. The game pops them in and fades them
 * out; a judgement 46px tall spans 23 osu! px (a sixth of a circle).
 */
function judgements(o: WosuSkinOptions, put: Put): void {
    const h = 46;
    switch (o.judgements) {
        case 'numbers':
            put('hit300', o.show300 ? judgementText('300', JUDGEMENT.great, h) : blank());
            put('hit100', judgementText('100', JUDGEMENT.ok, h));
            put('hit50', judgementText('50', JUDGEMENT.meh, h));
            put('hit0', cross(44, JUDGEMENT.miss));
            break;
        case 'words':
            put('hit300', o.show300 ? judgementText('GREAT', JUDGEMENT.great, h) : blank());
            put('hit100', judgementText('OK', JUDGEMENT.ok, h));
            put('hit50', judgementText('MEH', JUDGEMENT.meh, h));
            put('hit0', judgementText('MISS', JUDGEMENT.miss, h));
            break;
        case 'minimal':
            put('hit300', o.show300 ? dot(7, JUDGEMENT.great) : blank());
            put('hit100', dot(8, JUDGEMENT.ok));
            put('hit50', dot(8, JUDGEMENT.meh));
            put('hit0', cross(30, JUDGEMENT.miss));
            break;
    }
}

/** lighting: a soft glow the game tints with the combo colour and draws additively under each hit. */
function lighting(): Raster {
    const n = 320, c = n / 2;
    const r = new Raster(n, n);
    r.fill((x, y) => {
        const t = len(x - c, y - c) / c;
        if (t >= 1) return 0;
        const k = 1 - t;
        return k * k * (0.35 + 0.65 * k);
    }, WHITE, 0.9);
    return r;
}

// ---------------------------------------------------------------------------
// Spinner (osu!'s new style, skin.ini Version 2+)
// ---------------------------------------------------------------------------

/**
 * lazer's LegacyNewStyleSpinner draws the disc layers at 0.625 scale, so
 * the 1216px (@2x) disc spans 380 osu! px and fills the playfield's
 * height. The big soft layers are drawn at normal resolution (608px,
 * scale 1): on screen they are never sharper than that, and they're a
 * quarter of the pixels to draw.
 *   spinner-bottom  a dark translucent disc with a faint rim (turns slowly)
 *   spinner-glow    a ring the game tints blue and fades in with progress
 *   spinner-top     tick marks inside the rim that turn with the cursor
 *   spinner-approachcircle  a thin ring (starts at the disc's size)
 */
function spinner(put: Put): void {
    const D = 608, c = D / 2;
    const lowRes = (r: Raster) => {
        r.scale = 1;
        return r;
    };
    const bottom = lowRes(new Raster(D, D));
    bottom.shape(circle(c, c, c - 4), 0x0c0c14, 0.55);
    bottom.shape(ring(c, c, c - 5, 2), WHITE, 0.22);
    bottom.shape(ring(c, c, c * 0.18, 1.5), WHITE, 0.18, around(c, c, c * 0.2));
    put('spinner-bottom', bottom);

    const glow = lowRes(new Raster(D, D));
    glow.glow(ring(c, c, c - 15, 9), WHITE, 0.35, 14);
    glow.shape(ring(c, c, c - 15, 9), WHITE, 0.9);
    put('spinner-glow', glow);

    // Twelve ticks inside the rim, plus a small hub: the spin is easy to see.
    const top = lowRes(new Raster(D, D));
    const ticks = 12, r0 = c - 48, r1 = c - 28, step = (2 * Math.PI) / ticks;
    top.fill((x, y) => {
        const dx = x - c, dy = y - c;
        const dist = len(dx, dy);
        if (dist < r0 - 10 || dist > r1 + 10) return 0;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        const ux = Math.cos(a), uy = Math.sin(a);
        return 0.5 - (segmentDistance(x, y, c + ux * r0, c + uy * r0, c + ux * r1, c + uy * r1) - 3.5);
    }, WHITE, 0.85);
    top.shape(ring(c, c, 27, 5), WHITE, 0.85, around(c, c, 32));
    top.shape(circle(c, c, 9), WHITE, 0.85, around(c, c, 10));
    put('spinner-top', top);

    // lazer starts the approach circle at 1.86 × 0.625 scale: 654px (@2x) spans the disc.
    const A = 327, ac = A / 2;
    const approach = lowRes(new Raster(A, A));
    approach.shape(ring(ac, ac, ac - 4, 3), WHITE, 0.85);
    put('spinner-approachcircle', approach);

    const words: TextStyle = { size: 72, weight: 13, spacing: 12 };
    for (const [name, text] of [['spinner-spin', 'SPIN'], ['spinner-clear', 'CLEAR']] as const) {
        const pad = 10;
        const r = new Raster(Math.ceil(textWidth(text, words)) + pad * 2, words.size + pad * 2);
        drawText(r, text, pad, pad, words, WHITE, 1, { width: 5, colour: BLACK, alpha: 0.4 });
        put(name, r);
    }

    // osu!'s spinner-rpm is 560×112: the counter is right-aligned 8 osu! px inside its right end.
    const rpm = new Raster(560, 112);
    rpm.shape(roundRect(3, 3, 557, 109, 54), 0x0c0c14, 0.7);
    rpm.shape(subtractRing(roundRect(3, 3, 557, 109, 54), 3), WHITE, 0.2);
    drawText(rpm, 'RPM', 44, 36, { size: 40, weight: 8, spacing: 6 }, 0xc8c8d8);
    put('spinner-rpm', rpm);
}

/** The outline (width w, inside) of a shape. */
const subtractRing = (sdf: (x: number, y: number) => number, w: number) => (x: number, y: number) => {
    const d = sdf(x, y);
    return Math.max(d, -(d + w));
};

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * cursor, cursormiddle and cursortrail. The game shows cursor images at
 * px × 0.5 / 1.6 playfield units (lazer's legacy cursor size), so a 96px
 * image is 30 units across. The dot follows what popular community skins
 * do (Rafis, Vaxei, WhiteCat, YUGEN...): a solid white core with a thin
 * rim and soft glow in the cursor colour, no centre dot, no expanding.
 */
function cursor(o: WosuSkinOptions, put: Put): void {
    const colour = o.cursorColour;
    let r: Raster;
    if (o.cursorStyle === 'dot') {
        const n = 96, c = n / 2;
        r = new Raster(n, n);
        r.glow(circle(c, c, 28), colour, 0.5, 16);
        r.shape(circle(c, c, 28), colour);
        r.shape(circle(c, c, 22), WHITE);
    } else if (o.cursorStyle === 'ring') {
        const n = 120, c = n / 2;
        r = new Raster(n, n);
        r.glow(ring(c, c, 38, 9), colour, 0.45, 14);
        r.shape(ring(c, c, 38, 13), BLACK, 0.3);
        r.shape(ring(c, c, 38, 9), colour);
        r.shape(circle(c, c, 33), colour, 0.12);
    } else {
        const n = 128, c = n / 2;
        r = new Raster(n, n);
        r.glow(circle(c, c, 42), colour, 0.5, 18);
        r.shape(circle(c, c, 38), colour, 0.5);
        r.shape(ring(c, c, 40, 9), WHITE);
    }
    put('cursor', r);
    // No centre dot (none of the popular skins draw one); an empty image keeps a fallback skin's from showing.
    put('cursormiddle', new Raster(1, 1));
    if (o.trail !== 'off') {
        // Parts of lazer's default trail: soft dots in the cursor colour, drawn additively.
        // Soft discs about half the cursor's size; they overlap additively, so keep them dim.
        const t = 30, tc = t / 2;
        const trail = new Raster(t, t);
        trail.fill((x, y) => {
            const k = 1 - len(x - tc, y - tc) / tc;
            return k > 0 ? Math.min(1, k * 2.2) : 0;
        }, mix(colour, WHITE, 0.2), 0.5);
        put('cursortrail', trail);
    }
    // Smoke: a small soft dot (the game tints and fades it).
    const sm = new Raster(64, 64);
    sm.fill((x, y) => {
        const k = 1 - len(x - 32, y - 32) / 30;
        return k > 0 ? k * k : 0;
    }, WHITE, 0.8);
    put('cursor-smoke', sm);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

/**
 * score-0 … score-9, score-dot, score-percent and score-x (score,
 * accuracy and combo). 92px tall with 16px of space on top, like the
 * glyphs wosu!'s HUD layout was tuned for.
 */
function scoreFont(put: Put): number {
    const style: TextStyle = { size: 60, weight: 10 };
    const side = 6, top = 22, height = 92;
    const edge = { width: 3, colour: BLACK, alpha: 0.3 };
    const glyph = (ch: string, name: string) => {
        const r = new Raster(Math.ceil(glyphWidth(ch, style)) + side * 2, height);
        drawText(r, ch, side, top, style, WHITE, 1, edge);
        put(name, r);
    };
    for (let i = 0; i < 10; i++) glyph(String(i), `score-${i}`);
    glyph('.', 'score-dot');
    glyph('%', 'score-percent');
    // The combo's "x" is lower case: its ink sits on the baseline.
    glyph('x', 'score-x');
    // Glyphs carry 6px either side: leave about 8px (4 units) between them.
    return 2;
}

/**
 * The health bar, as osu!'s new-style images: scorebar-bg (a dark track),
 * scorebar-colour (the fill, revealed left to right by health) and
 * scorebar-marker (a glow at the fill's end). osu! draws the fill at
 * (7.5, 7.8) × 1.6 HUD units from the bar's top-left, so the track sits
 * under it at the same offset. scorebar-ki* are for Version 1 skins.
 */
function healthBar(accent: number, put: Put): void {
    const coreW = 1120, coreH = 20, glowPx = 10;
    const fillX = 24, fillY = 24.96;
    const capsule = (x0: number, x1: number, cy: number, r: number) => (x: number, y: number) =>
        len(x - Math.min(Math.max(x, x0 + r), x1 - r), y - cy) - r;

    const fw = coreW + glowPx, fh = coreH + glowPx * 2;
    const fill = new Raster(fw, fh);
    // The core runs past the right edge: the game crops the fill by health.
    const core = capsule(glowPx, fw + coreH * 2, fh / 2, coreH / 2);
    fill.glow(core, accent, 0.45, glowPx);
    fill.shape(core, mix(accent, WHITE, 0.55));
    put('scorebar-colour', fill);

    const x0 = fillX + glowPx, y0 = fillY + glowPx;
    const bg = new Raster(Math.round(x0 + coreW + fillX), Math.round(y0 + coreH + fillY));
    bg.shape(capsule(x0, x0 + coreW, y0 + coreH / 2, coreH / 2), BLACK, 0.45);
    put('scorebar-bg', bg);

    // The marker: a cyan glow at the fill's end. Skins without one (many new-style skins) show this one
    // too, so it keeps the exact look wosu!'s marker always had.
    const marker = new Raster(42, 60);
    marker.fill((x, y) => {
        const t = len((x - 21) / 21, (y - 30) / 30);
        return t < 1 ? Math.min(233, 22 + 211 * Math.pow(1 - t, 1.4)) / 255 : Math.max(0, 1 - (t - 1) * 4) * (22 / 255);
    }, 0x30d1ff, 1);
    put('scorebar-marker', marker);

    const ki = (colour: number) => {
        const r = new Raster(64, 64);
        r.fill((x, y) => {
            const t = len(x - 32, y - 32) / 32;
            return t < 1 ? (t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7) : 0;
        }, (x, y) => mix(WHITE, colour, Math.min(1, len(x - 32, y - 32) / 10)), 1);
        return r;
    };
    put('scorebar-ki', ki(0x7fd4ff));
    put('scorebar-kidanger', ki(0xffa028));
    put('scorebar-kidanger2', ki(0xff2828));
}

