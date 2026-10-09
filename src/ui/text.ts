import { BitmapText, Text, TextStyle, type TextStyleAlign, type TextStyleFontWeight } from 'pixi.js';
import { Fonts } from './theme';

export interface TextOptions {
    size?: number;
    weight?: TextStyleFontWeight;
    color?: number;
    italic?: boolean;
    align?: TextStyleAlign;
    /** Wrap width in px; enables word wrap. */
    wrap?: number;
    letterSpacing?: number;
    lineHeight?: number;
    shadow?: boolean;
    font?: string;
}

/**
 * Styles are shared between Text instances with identical options, which
 * lets Pixi reuse the measured style and keeps style churn out of hot
 * paths.
 */
const styleCache = new Map<string, TextStyle>();

export function textStyle(o: TextOptions = {}): TextStyle {
    const key = [o.size, o.weight, o.color, o.italic, o.align, o.wrap, o.letterSpacing, o.lineHeight, o.shadow, o.font].join('|');
    let s = styleCache.get(key);
    if (!s) {
        s = new TextStyle({
            fontFamily: o.font ?? Fonts.ui,
            fontSize: o.size ?? 16,
            fontWeight: o.weight ?? '500',
            fontStyle: o.italic ? 'italic' : 'normal',
            fill: o.color ?? 0xffffff,
            align: o.align ?? 'left',
            wordWrap: o.wrap !== undefined,
            wordWrapWidth: o.wrap ?? 0,
            breakWords: o.wrap !== undefined,
            letterSpacing: o.letterSpacing ?? 0,
            lineHeight: o.lineHeight,
            padding: 2,
            dropShadow: o.shadow
                ? { alpha: 0.45, blur: 4, color: 0x000000, distance: 1, angle: Math.PI / 2 }
                : undefined,
        });
        styleCache.set(key, s);
    }
    return s;
}

/** Canvas-rendered text: crisp at any size; use for labels that rarely change. */
export function label(content: string, o: TextOptions = {}): Text {
    const t = new Text({ text: content, style: textStyle(o) });
    t.eventMode = 'none';
    return t;
}

/** Bitmap text for values that change every frame (counters, clocks). */
export function counterText(content: string, o: { size?: number; color?: number; light?: boolean; align?: TextStyleAlign } = {}): BitmapText {
    const t = new BitmapText({
        text: content,
        style: {
            fontFamily: o.light ? `${Fonts.numeric}-Light` : Fonts.numeric,
            fontSize: o.size ?? 16,
            fill: o.color ?? 0xffffff,
            align: o.align ?? 'left',
        },
    });
    t.eventMode = 'none';
    return t;
}

/** Truncate a Text to a maximum width with an ellipsis (binary search). */
export function fitText(t: Text, maxWidth: number, full: string = t.text): void {
    t.text = full;
    if (t.width <= maxWidth || maxWidth <= 0) return;
    let lo = 0, hi = full.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        t.text = full.slice(0, mid).trimEnd() + '…';
        if (t.width <= maxWidth) lo = mid; else hi = mid - 1;
    }
    t.text = full.slice(0, lo).trimEnd() + '…';
}
