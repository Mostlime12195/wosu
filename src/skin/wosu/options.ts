/**
 * wosu!'s default skin is generated from these options (Settings → Skin →
 * wosu! skin), so it can look like what players pick skins for: flat
 * readable circles, a thin approach circle, small numbers, a dot cursor,
 * no 300s… or a classic osu! look. Presets set them all at once.
 */

export type CircleStyle = 'flat' | 'ring' | 'outline' | 'glossy' | 'neon';
export type PaletteId = 'wosu' | 'classic' | 'pastel' | 'neon' | 'mono' | 'custom';
/** Slider body: combo colour, near-black, osu!'s gradient, or nearly see-through. */
export type SliderBodyStyle = 'combo' | 'dark' | 'gradient' | 'hollow';
export type SliderBorderColour = 'white' | 'combo' | 'accent';
export type FollowPointStyle = 'dots' | 'arrows' | 'off';
export type CursorStyle = 'dot' | 'ring' | 'classic';
export type TrailLength = 'off' | 'short' | 'long';
/** Judgements: 100 / 50 / ✕, lazer's words (GREAT, OK, MEH, MISS), or small marks and only the miss spelled out. */
export type JudgementStyle = 'numbers' | 'words' | 'minimal';
export type PresetId = 'clean' | 'classic' | 'neon' | 'minimal';

export interface WosuSkinOptions {
    circleStyle: CircleStyle;
    palette: PaletteId;
    /** Hex colours for the custom palette ("#ff66aa, #66ccff, …"). */
    customColours: string;
    comboNumbers: boolean;
    /** Combo number size (1 = a third of the circle). */
    numberSize: number;
    /** Approach circle line width in osu! pixels at circle size 4-ish (a 128px circle). */
    approachWidth: number;
    sliderBody: SliderBodyStyle;
    sliderBorder: SliderBorderColour;
    /** Slider border width as a fraction of the slider's radius. */
    sliderBorderWidth: number;
    followPoints: FollowPointStyle;
    cursorStyle: CursorStyle;
    /** Cursor (and HUD accent) colour, 0xRRGGBB. */
    cursorColour: number;
    trail: TrailLength;
    show300: boolean;
    hitLighting: boolean;
    judgements: JudgementStyle;
}

export const PALETTES: Record<Exclude<PaletteId, 'custom'>, readonly number[]> = {
    wosu: [0xff66aa, 0x66ccff, 0xb388ff, 0xffcc22],
    classic: [0xffc000, 0x00ca00, 0x127cff, 0xf21839],
    pastel: [0xffaacc, 0xa8e0ff, 0xd2bfff, 0xbff0a8],
    neon: [0xff2e97, 0x00e5ff, 0xa64dff, 0xb6ff00],
    mono: [0xf0f0f0, 0xa8a8a8],
};

export const CURSOR_COLOURS: readonly { value: number; label: string }[] = [
    { value: 0xff66aa, label: 'Pink' },
    { value: 0xffffff, label: 'White' },
    { value: 0x66ccff, label: 'Sky' },
    { value: 0xffcc22, label: 'Yellow' },
    { value: 0xb388ff, label: 'Lavender' },
    { value: 0x88ff66, label: 'Lime' },
    { value: 0xff4455, label: 'Red' },
];

export const PRESETS: Record<PresetId, WosuSkinOptions> = {
    // Readable and modern: flat circles with a white rim, thin approach circles,
    // no 300s or hit lighting, a dot cursor with a short trail.
    clean: {
        circleStyle: 'flat', palette: 'wosu', customColours: '', comboNumbers: true, numberSize: 0.85,
        approachWidth: 3, sliderBody: 'combo', sliderBorder: 'white', sliderBorderWidth: 0.14,
        followPoints: 'dots', cursorStyle: 'dot', cursorColour: 0xff66aa, trail: 'short',
        show300: false, hitLighting: false, judgements: 'numbers',
    },
    // osu!'s look: shaded circles, osu!'s combo colours, gradient sliders, arrows, everything shown.
    classic: {
        circleStyle: 'glossy', palette: 'classic', customColours: '', comboNumbers: true, numberSize: 1,
        approachWidth: 5, sliderBody: 'gradient', sliderBorder: 'white', sliderBorderWidth: 0.128,
        followPoints: 'arrows', cursorStyle: 'classic', cursorColour: 0xffcc22, trail: 'long',
        show300: true, hitLighting: true, judgements: 'words',
    },
    // Glowing combo-coloured rings on dark sliders.
    neon: {
        circleStyle: 'neon', palette: 'neon', customColours: '', comboNumbers: true, numberSize: 0.85,
        approachWidth: 3, sliderBody: 'dark', sliderBorder: 'combo', sliderBorderWidth: 0.16,
        followPoints: 'dots', cursorStyle: 'ring', cursorColour: 0x00e5ff, trail: 'long',
        show300: false, hitLighting: true, judgements: 'minimal',
    },
    // What many top players use: outlines, no numbers, near-black sliders, nothing extra on screen.
    minimal: {
        circleStyle: 'outline', palette: 'mono', customColours: '', comboNumbers: false, numberSize: 0.85,
        approachWidth: 2, sliderBody: 'dark', sliderBorder: 'white', sliderBorderWidth: 0.1,
        followPoints: 'off', cursorStyle: 'dot', cursorColour: 0xffffff, trail: 'short',
        show300: false, hitLighting: false, judgements: 'minimal',
    },
};

export const DEFAULT_WOSU_SKIN: WosuSkinOptions = PRESETS.clean;

const ENUMS: { [K in keyof WosuSkinOptions]?: readonly string[] } = {
    circleStyle: ['flat', 'ring', 'outline', 'glossy', 'neon'],
    palette: ['wosu', 'classic', 'pastel', 'neon', 'mono', 'custom'],
    sliderBody: ['combo', 'dark', 'gradient', 'hollow'],
    sliderBorder: ['white', 'combo', 'accent'],
    followPoints: ['dots', 'arrows', 'off'],
    cursorStyle: ['dot', 'ring', 'classic'],
    trail: ['off', 'short', 'long'],
    judgements: ['numbers', 'words', 'minimal'],
};

/** Ranges of the numeric options. */
export const RANGES = {
    numberSize: { min: 0.6, max: 1.3, step: 0.05 },
    approachWidth: { min: 1, max: 8, step: 0.5 },
    sliderBorderWidth: { min: 0.04, max: 0.3, step: 0.01 },
} as const;

/** Options from stored settings: unknown keys dropped, bad values replaced by the default's. */
export function sanitizeWosuSkin(raw: unknown): WosuSkinOptions {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out = { ...DEFAULT_WOSU_SKIN } as Record<string, unknown>;
    for (const [key, def] of Object.entries(DEFAULT_WOSU_SKIN)) {
        const v = src[key];
        if (v === undefined || typeof v !== typeof def) continue;
        const allowed = ENUMS[key as keyof WosuSkinOptions];
        if (allowed && !allowed.includes(v as string)) continue;
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue;
            const range = RANGES[key as keyof typeof RANGES];
            out[key] = range ? Math.min(range.max, Math.max(range.min, v)) : key === 'cursorColour' ? v & 0xffffff : v;
        } else {
            out[key] = v;
        }
    }
    return out as unknown as WosuSkinOptions;
}

/** The preset these options are (custom colours typed in but not used don't count), or null (customised). */
export function matchPreset(o: WosuSkinOptions): PresetId | null {
    for (const [id, p] of Object.entries(PRESETS) as [PresetId, WosuSkinOptions][]) {
        if ((Object.keys(p) as (keyof WosuSkinOptions)[]).every(k => k === 'customColours' || p[k] === o[k])) return id;
    }
    return null;
}

/** "#f6a, 66ccff, …" → colours (bad entries skipped, at most 8 like skin.ini's Combo1–8). */
export function parseColours(text: string): number[] {
    const out: number[] = [];
    for (const part of text.split(/[\s,;]+/)) {
        let hex = part.trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map(c => c + c).join('');
        if (/^[0-9a-f]{6}$/i.test(hex)) out.push(parseInt(hex, 16));
        if (out.length === 8) break;
    }
    return out;
}

/** The combo colours the options give (a custom palette without valid colours uses wosu!'s). */
export function comboColours(o: WosuSkinOptions): number[] {
    if (o.palette === 'custom') {
        const c = parseColours(o.customColours);
        return c.length ? c : [...PALETTES.wosu];
    }
    return [...PALETTES[o.palette]];
}

/** Cursor trail fade time (ms) for lazer's default trail. */
export const TRAIL_FADE: Record<TrailLength, number> = { off: 0, short: 180, long: 450 };
