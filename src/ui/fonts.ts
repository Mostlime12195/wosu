import { BitmapFont } from 'pixi.js';
import faSolidUrl from '@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2?url';
import faRegularUrl from '@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2?url';
import { Fonts } from './theme';

/**
 * Loads web fonts through the FontFace API (no stylesheet / DOM nodes)
 * and pre-installs the bitmap fonts used by frequently changing counters.
 * Canvas text (Pixi `Text`) can only use a family once it is loaded, so
 * the app awaits this before building any UI.
 */
const BASE = import.meta.env.BASE_URL;

async function loadFace(family: string, url: string, descriptors: FontFaceDescriptors): Promise<void> {
    try {
        const face = new FontFace(family, `url(${url})`, descriptors);
        await face.load();
        document.fonts.add(face);
    } catch (e) {
        console.warn(`font ${family} failed to load`, e);
    }
}

let loaded: Promise<void> | null = null;

export function loadFonts(): Promise<void> {
    loaded ??= (async () => {
        await Promise.all([
            loadFace(Fonts.ui, `${BASE}assets/fonts/Exo2.ttf`, { weight: '100 900', style: 'normal' }),
            loadFace(Fonts.ui, `${BASE}assets/fonts/Exo2-Italic.ttf`, { weight: '100 900', style: 'italic' }),
            loadFace(Fonts.iconSolid, faSolidUrl, { weight: '900' }),
            loadFace(Fonts.iconRegular, faRegularUrl, { weight: '400' }),
        ]);
    })();
    return loaded;
}

/**
 * Bitmap fonts render each glyph once into an atlas, so changing text
 * (score, timers, FPS) costs no canvas redraw or texture upload.
 */
export function installBitmapFonts(resolution: number): void {
    const res = Math.min(3, Math.max(1, resolution));
    BitmapFont.install({
        name: Fonts.numeric,
        style: { fontFamily: Fonts.ui, fontSize: 48, fontWeight: '600', fill: 0xffffff },
        chars: [[' ', '~'], '×', '±', '…', '·'],
        resolution: res,
        padding: 4,
    });
    BitmapFont.install({
        name: `${Fonts.numeric}-Light`,
        style: { fontFamily: Fonts.ui, fontSize: 48, fontWeight: '400', fill: 0xffffff },
        chars: [[' ', '~'], '×', '±', '…', '·'],
        resolution: res,
        padding: 4,
    });
}
