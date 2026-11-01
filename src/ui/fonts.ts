import { BitmapFontManager, CanvasTextMetrics, TextStyle, type BitmapFont } from 'pixi.js';
import { Fonts } from './theme';

/**
 * Loads web fonts through the FontFace API (no stylesheet / DOM nodes)
 * and pre-installs the bitmap fonts used by frequently changing counters.
 * Canvas text (Pixi `Text`) can only use a family once it is loaded, so
 * the app awaits this before building any UI.
 *
 * index.html preloads the upright UI font and the icon subset, so they
 * download alongside the scripts. The italic face is only needed from
 * the main menu on, so it loads after the intro shows (loadMenuFonts).
 */
const BASE = import.meta.env.BASE_URL;

async function loadFace(family: string, url: string, descriptors: FontFaceDescriptors): Promise<void> {
    try {
        const face = new FontFace(family, `url(${url}) format('woff2')`, descriptors);
        await face.load();
        document.fonts.add(face);
    } catch (e) {
        console.warn(`font ${family} failed to load`, e);
    }
}

let loaded: Promise<void> | null = null;
let menuLoaded: Promise<void> | null = null;

/** The faces the first screen draws with (Exo 2 upright, the icon font). */
export function loadFonts(): Promise<void> {
    loaded ??= (async () => {
        await Promise.all([
            loadFace(Fonts.ui, `${BASE}assets/fonts/Exo2.woff2`, { weight: '100 900', style: 'normal' }),
            // Only the icons the code uses (tools/iconFont.ts).
            loadFace(Fonts.iconSolid, `${BASE}${__ICON_FONT__}`, { weight: '900' }),
        ]);
    })();
    return loaded;
}

/**
 * Exo 2 italic (song titles in the main menu, song select, results).
 * Canvas metrics measured while it was missing are dropped once it lands,
 * so text laid out early re-measures with the real face.
 */
export function loadMenuFonts(): Promise<void> {
    menuLoaded ??= (async () => {
        await loadFonts();
        await loadFace(Fonts.ui, `${BASE}assets/fonts/Exo2-Italic.woff2`, { weight: '100 900', style: 'italic' });
        CanvasTextMetrics.clearMetrics();
    })();
    return menuLoaded;
}

/** Every character counters draw; the atlas fills in during idle time (warmBitmapFonts). */
const COUNTER_CHARS = [[' ', '~'], '×', '±', '…', '·'] as const;
let counterFonts: { font: BitmapFont; style: TextStyle }[] = [];

/**
 * Bitmap fonts render each glyph once into an atlas, so changing text
 * (score, timers, FPS) costs no canvas redraw or texture upload. Glyphs
 * are added on first use (Pixi's dynamic bitmap fonts), so installing is
 * cheap; warmBitmapFonts draws the rest before gameplay needs them.
 */
export function installBitmapFonts(resolution: number): void {
    const res = Math.min(3, Math.max(1, resolution));
    // Pixi needs at least one character up front.
    const common = { chars: [' '], resolution: res, padding: 4 };
    counterFonts = ([[Fonts.numeric, '600'], [`${Fonts.numeric}-Light`, '400']] as const).map(([name, fontWeight]) => ({
        font: BitmapFontManager.install({
            name,
            style: { fontFamily: Fonts.ui, fontSize: 48, fontWeight, fill: 0xffffff },
            ...common,
        }),
        // Asking for glyphs of an installed font draws the missing ones.
        style: new TextStyle({ fontFamily: name }),
    }));
}

/** Draw the remaining counter glyphs, a few per call; true once all are in. */
export function warmBitmapFonts(batch = 6): boolean {
    const all = COUNTER_CHARS.flatMap(c => {
        if (typeof c === 'string') return [c];
        const out: string[] = [];
        for (let i = c[0].charCodeAt(0); i <= c[1].charCodeAt(0); i++) out.push(String.fromCharCode(i));
        return out;
    });
    for (const { font, style } of counterFonts) {
        const missing = all.filter(ch => !font.chars[ch]);
        if (!missing.length) continue;
        BitmapFontManager.getFont(missing.slice(0, batch).join(''), style);
        return false;
    }
    return true;
}
