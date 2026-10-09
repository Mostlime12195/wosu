/**
 * Visual language, modelled on osu!lazer's OsuColour + OverlayColourProvider.
 * Every component pulls colours/sizes from here so the look can be tuned
 * in one place.
 */

/** HSL (h in degrees, s/l in 0..1) to 0xRRGGBB. */
export function hsl(h: number, s: number, l: number): number {
    h = (((h % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const conv = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const r = Math.round(conv(h + 1 / 3) * 255);
    const g = Math.round(conv(h) * 255);
    const b = Math.round(conv(h - 1 / 3) * 255);
    return (r << 16) | (g << 8) | b;
}

export const Colors = {
    white: 0xffffff,
    black: 0x000000,

    pinkLighter: 0xffddee,
    pinkLight: 0xff99cc,
    pink: 0xff66aa,
    pinkDark: 0xcc5288,
    pinkDarker: 0xbb1177,

    purpleLighter: 0xeeeeff,
    purpleLight: 0xaa88ff,
    purple: 0x8866ee,
    purpleDark: 0x6644cc,
    purpleDarker: 0x441188,

    blueLighter: 0xddffff,
    blueLight: 0x99eeff,
    blue: 0x66ccff,
    blueDark: 0x44aadd,
    blueDarker: 0x2299bb,

    yellowLighter: 0xffffdd,
    yellowLight: 0xffff99,
    yellow: 0xffcc22,
    yellowDark: 0xeeaa00,
    yellowDarker: 0xcc6600,

    greenLighter: 0xeeffcc,
    greenLight: 0xb3d944,
    green: 0x88b300,
    greenDark: 0x668800,
    greenDarker: 0x445500,

    redLighter: 0xffeeee,
    redLight: 0xff7777,
    red: 0xed1121,
    redDark: 0xba0011,
    redDarker: 0x870000,

    orange: 0xffa200,
    lime: 0x88ff00,

    gray0: 0x000000,
    gray1: 0x111111,
    gray2: 0x222222,
    gray3: 0x333333,
    gray4: 0x444444,
    gray5: 0x555555,
    gray6: 0x666666,
    gray7: 0x777777,
    gray8: 0x888888,
    gray9: 0x999999,
    grayA: 0xaaaaaa,
    grayB: 0xbbbbbb,
    grayC: 0xcccccc,
    grayD: 0xdddddd,
    grayE: 0xeeeeee,

    // Judgement colours (match the gameplay judgement text).
    great: 0x66ccff,
    ok: 0x88b300,
    meh: 0xffcc22,
    miss: 0xed1121,
} as const;

/** Overlay palettes keyed by hue, like lazer's OverlayColourScheme. */
export type ColorScheme = 'red' | 'pink' | 'orange' | 'lime' | 'green' | 'purple' | 'blue' | 'plum' | 'aquamarine';

const SCHEME_HUE: Record<ColorScheme, number> = {
    red: 0,
    pink: 333,
    orange: 45,
    lime: 90,
    green: 125,
    aquamarine: 160,
    purple: 255,
    blue: 200,
    plum: 320,
};

export class ColorProvider {
    readonly hue: number;
    constructor(scheme: ColorScheme) {
        this.hue = SCHEME_HUE[scheme];
    }
    private c(s: number, l: number): number {
        return hsl(this.hue, s, l);
    }
    get highlight1() { return this.c(1, 0.7); }
    get content1() { return this.c(0.4, 1); }
    get content2() { return this.c(0.4, 0.9); }
    get light1() { return this.c(0.4, 0.8); }
    get light2() { return this.c(0.4, 0.75); }
    get light3() { return this.c(0.4, 0.7); }
    get light4() { return this.c(0.4, 0.5); }
    get dark1() { return this.c(0.2, 0.35); }
    get dark2() { return this.c(0.2, 0.3); }
    get dark3() { return this.c(0.2, 0.25); }
    get dark4() { return this.c(0.2, 0.2); }
    get dark5() { return this.c(0.2, 0.15); }
    get dark6() { return this.c(0.2, 0.1); }
    get foreground1() { return this.c(0.1, 0.6); }
    get background1() { return this.c(0.1, 0.4); }
    get background2() { return this.c(0.1, 0.3); }
    get background3() { return this.c(0.1, 0.25); }
    get background4() { return this.c(0.1, 0.2); }
    get background5() { return this.c(0.1, 0.15); }
    get background6() { return this.c(0.1, 0.1); }
}

export const Fonts = {
    /** UI font (variable weight 100–900). */
    ui: 'Exo 2',
    /** Font Awesome 6 Free (solid/regular). */
    iconSolid: 'FA6 Solid',
    iconRegular: 'FA6 Regular',
    /** Bitmap font names installed at boot (see fonts.ts). */
    numeric: 'Exo2Numeric',
    venera: 'Venera',
} as const;

export const Metrics = {
    toolbarHeight: 40,
    cornerRadius: 5,
    buttonHeight: 40,
    settingsWidth: 400,
    settingsSidebarWidth: 60,
    footerHeight: 50,
} as const;

/** Star rating → difficulty colour (lazer's spectrum, simplified stops). */
const STAR_STOPS: [number, number][] = [
    [0.1, 0xaaaaaa],
    [0.1, 0x4290fb],
    [1.25, 0x4fc0ff],
    [2.0, 0x4fffd5],
    [2.5, 0x7cff4f],
    [3.3, 0xf6f05c],
    [4.2, 0xff8068],
    [4.9, 0xff4e6f],
    [5.8, 0xc645b8],
    [6.7, 0x6563de],
    [7.7, 0x18158e],
    [9.0, 0x000000],
];

export function starColor(stars: number | null): number {
    if (stars === null || !Number.isFinite(stars)) return 0x999999;
    if (stars < 0.1) return 0xaaaaaa;
    for (let i = 1; i < STAR_STOPS.length; i++) {
        const [s1, c1] = STAR_STOPS[i - 1];
        const [s2, c2] = STAR_STOPS[i];
        if (stars <= s2) {
            const t = s2 === s1 ? 1 : (stars - s1) / (s2 - s1);
            const r = Math.round(((c1 >> 16) & 255) + (((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * t);
            const g = Math.round(((c1 >> 8) & 255) + (((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * t);
            const b = Math.round((c1 & 255) + ((c2 & 255) - (c1 & 255)) * t);
            return (r << 16) | (g << 8) | b;
        }
    }
    return 0x000000;
}

/** Text colour that stays readable on a star-colour background. */
export function starTextColor(stars: number | null): number {
    if (stars !== null && stars >= 6.5) return Colors.yellow;
    return 0x000000;
}

/** Ranked-status pill colours (osu! web). */
export function statusInfo(approved: number): { label: string; color: number; text: number } {
    switch (approved) {
        case 4: return { label: 'LOVED', color: 0xff66ab, text: 0x000000 };
        case 3: return { label: 'QUALIFIED', color: 0x66ccff, text: 0x000000 };
        case 2: return { label: 'APPROVED', color: 0xb3ff66, text: 0x000000 };
        case 1: return { label: 'RANKED', color: 0xb3ff66, text: 0x000000 };
        case 0: return { label: 'PENDING', color: 0xffd966, text: 0x000000 };
        case -1: return { label: 'WIP', color: 0xff9966, text: 0x000000 };
        case -2: return { label: 'GRAVEYARD', color: 0x000000, text: 0x888888 };
        default: return { label: 'UNKNOWN', color: 0x444444, text: 0xcccccc };
    }
}

/** Grade colours (lazer). */
export function gradeColor(grade: string): number {
    switch (grade) {
        case 'XH': case 'SH': return 0xe0e0e0;
        case 'X': case 'S': return 0xffcc22;
        case 'A': return 0x88da20;
        case 'B': return 0x66ccff;
        case 'C': return 0xff8e5d;
        case 'D': return 0xff5a5a;
        default: return 0xed1121;
    }
}

export function gradeLabel(grade: string): string {
    switch (grade) {
        case 'XH': case 'X': return 'SS';
        case 'SH': return 'S';
        default: return grade;
    }
}
