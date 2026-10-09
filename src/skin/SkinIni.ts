/**
 * osu!'s skin.ini (the osu!standard parts lazer's LegacySkinDecoder reads):
 * [General], [Colours] and [Fonts]. Values a skin leaves out stay
 * undefined so a skin chain can fall through to the next layer.
 */
export interface SkinConfig {
    name?: string;
    author?: string;
    /** skin.ini Version ("latest" = 2.7); below 2.0 means old-style spinners and health bar. */
    version?: number;
    /** Combo1..Combo8, in order. */
    comboColours?: number[];
    sliderTrackOverride?: number;
    sliderBorder?: number;
    /** Slider ball tint (only used when allowSliderBallTint is false). */
    sliderBall?: number;
    spinnerBackground?: number;
    /** Combo number font prefix ("default" → default-0.png). */
    hitCirclePrefix?: string;
    hitCircleOverlap?: number;
    scorePrefix?: string;
    scoreOverlap?: number;
    comboPrefix?: string;
    comboOverlap?: number;
    /** Frames per second for animations; -1 = the whole animation plays over a second. */
    animationFramerate?: number;
    allowSliderBallTint?: boolean;
    sliderBallFlip?: boolean;
    cursorRotate?: boolean;
    cursorExpand?: boolean;
    cursorCentre?: boolean;
    cursorTrailRotate?: boolean;
    hitCircleOverlayAboveNumber?: boolean;
    layeredHitSounds?: boolean;
    spinnerFadePlayfield?: boolean;
    spinnerNoBlink?: boolean;
}

/** What a skin chain falls back to when no layer sets a value (osu!'s defaults). */
export const SKIN_DEFAULTS: Required<Omit<SkinConfig, 'sliderTrackOverride' | 'sliderBorder' | 'sliderBall' | 'spinnerBackground'>>
    & Pick<SkinConfig, 'sliderTrackOverride' | 'sliderBorder' | 'sliderBall' | 'spinnerBackground'> = {
        name: 'Unnamed',
        author: '',
        version: 1,
        comboColours: [0xffc000, 0x00ca00, 0x127cff, 0xf21839],
        sliderBorder: 0xffffff,
        hitCirclePrefix: 'default',
        hitCircleOverlap: -2,
        scorePrefix: 'score',
        scoreOverlap: 0,
        comboPrefix: 'score',
        comboOverlap: 0,
        animationFramerate: -1,
        allowSliderBallTint: false,
        sliderBallFlip: true,
        cursorRotate: true,
        cursorExpand: true,
        cursorCentre: true,
        cursorTrailRotate: false,
        hitCircleOverlayAboveNumber: true,
        layeredHitSounds: true,
        spinnerFadePlayfield: false,
        spinnerNoBlink: false,
    };

export function parseSkinIni(text: string): SkinConfig {
    const out: SkinConfig = {};
    const combos: [number, number][] = [];
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            section = line.slice(1, -1).trim().toLowerCase();
            continue;
        }
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (section === 'general') {
            switch (key) {
                case 'name': out.name = value; break;
                case 'author': out.author = value; break;
                case 'version': {
                    const v = value.toLowerCase() === 'latest' ? 2.7 : Number(value);
                    if (Number.isFinite(v)) out.version = v;
                    break;
                }
                case 'animationframerate': setNum(out, 'animationFramerate', value); break;
                case 'allowsliderballtint': out.allowSliderBallTint = bool(value); break;
                case 'sliderballflip': out.sliderBallFlip = bool(value); break;
                case 'cursorrotate': out.cursorRotate = bool(value); break;
                case 'cursorexpand': out.cursorExpand = bool(value); break;
                case 'cursorcentre': out.cursorCentre = bool(value); break;
                case 'cursortrailrotate': out.cursorTrailRotate = bool(value); break;
                case 'hitcircleoverlayabovenumber':
                case 'hitcircleoverlayabovenumer': // a typo osu! also accepts
                    out.hitCircleOverlayAboveNumber = bool(value);
                    break;
                case 'layeredhitsounds': out.layeredHitSounds = bool(value); break;
                case 'spinnerfadeplayfield': out.spinnerFadePlayfield = bool(value); break;
                case 'spinnernoblink': out.spinnerNoBlink = bool(value); break;
            }
        } else if (section === 'colours') {
            const c = colour(value);
            if (c === null) continue;
            const m = /^combo(\d+)$/.exec(key);
            if (m) combos.push([Number(m[1]), c]);
            else if (key === 'slidertrackoverride') out.sliderTrackOverride = c;
            else if (key === 'sliderborder') out.sliderBorder = c;
            else if (key === 'sliderball') out.sliderBall = c;
            else if (key === 'spinnerbackground') out.spinnerBackground = c;
        } else if (section === 'fonts') {
            switch (key) {
                case 'hitcircleprefix': out.hitCirclePrefix = path(value); break;
                case 'hitcircleoverlap': setNum(out, 'hitCircleOverlap', value); break;
                case 'scoreprefix': out.scorePrefix = path(value); break;
                case 'scoreoverlap': setNum(out, 'scoreOverlap', value); break;
                case 'comboprefix': out.comboPrefix = path(value); break;
                case 'combooverlap': setNum(out, 'comboOverlap', value); break;
            }
        }
    }
    if (combos.length) out.comboColours = combos.sort((a, b) => a[0] - b[0]).slice(0, 8).map(c => c[1]);
    return out;
}

function bool(v: string): boolean {
    return v === '1' || v.toLowerCase() === 'true';
}

function setNum<K extends keyof SkinConfig>(out: SkinConfig, key: K, v: string): void {
    const n = Number(v);
    if (Number.isFinite(n)) (out as Record<string, unknown>)[key] = n;
}

/** "r,g,b" (alpha ignored) → 0xRRGGBB. */
function colour(v: string): number | null {
    const p = v.split(',').map(s => Number(s.trim()));
    if (p.length < 3 || p.slice(0, 3).some(n => !Number.isFinite(n))) return null;
    const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
    return (c(p[0]) << 16) | (c(p[1]) << 8) | c(p[2]);
}

/** Font prefixes are paths inside the skin ("fonts\\score" → "fonts/score"). */
function path(v: string): string {
    return v.replace(/\\/g, '/').replace(/^\/+/, '');
}
