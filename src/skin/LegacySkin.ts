import { Texture } from 'pixi.js';
import { parseSkinIni, type SkinConfig } from './SkinIni';

/**
 * An osu!-format skin (lazer's LegacySkin): images, sounds and a skin.ini
 * from any file source: an imported .osk, a beatmap's folder (a beatmap
 * skin) or the game's own default skin. Only the elements wosu! draws are
 * decoded; lookups are by osu! element name without extension
 * ("hitcircle", "score-3", "sliderb0"), preferring @2x images.
 */

/** Texture plus its logical scale (0.5 for @2x images, osu!'s high-res convention). */
export interface SkinTexture {
    texture: Texture;
    scale: number;
}

/** Where a skin's files come from. Paths use forward slashes. */
export interface SkinFiles {
    readonly files: readonly string[];
    readBytes(path: string): Promise<Uint8Array>;
}

export interface LegacySkinOptions {
    /** Read skin.ini (beatmap skins don't: their colours come from the .osu). */
    ini?: boolean;
    textures?: boolean;
    samples?: boolean;
    /** Sample files hit objects name directly (osu!'s per-object filename). */
    customSampleFiles?: Iterable<string>;
    /** Browser can decode Vorbis: prefer .ogg over .wav when a skin has both. */
    preferOgg?: boolean;
}

/**
 * Image elements wosu! uses (osu!standard gameplay, HUD and cursor). Each may
 * also come as animation frames (name-0, name-1… or name0, name1…).
 */
const ELEMENTS = [
    // circles
    'hitcircle', 'hitcircleoverlay', 'approachcircle', 'lighting',
    'sliderstartcircle', 'sliderstartcircleoverlay', 'sliderendcircle', 'sliderendcircleoverlay',
    // sliders
    'sliderb', 'sliderb-nd', 'sliderb-spec', 'sliderfollowcircle', 'sliderscorepoint', 'reversearrow', 'followpoint',
    // judgements
    'hit0', 'hit50', 'hit100', 'hit300', 'hit100k', 'hit300k', 'hit300g',
    // spinners (new and old style)
    'spinner-glow', 'spinner-bottom', 'spinner-top', 'spinner-middle', 'spinner-middle2',
    'spinner-background', 'spinner-circle', 'spinner-metre', 'spinner-approachcircle',
    'spinner-clear', 'spinner-spin', 'spinner-rpm', 'spinner-osu',
    // cursor
    'cursor', 'cursormiddle', 'cursortrail',
    // HUD
    'scorebar-bg', 'scorebar-colour', 'scorebar-ki', 'scorebar-kidanger', 'scorebar-kidanger2', 'scorebar-marker',
    'inputoverlay-key', 'inputoverlay-background', 'play-skip',
];
/** Font glyph suffixes (prefix-0 … prefix-x). */
const GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'comma', 'dot', 'percent', 'x'];

const IMAGE_RE = /\.(png|jpe?g)$/i;
const AUDIO_RE = /\.(wav|ogg|mp3)$/i;
const HITSOUND_RE = /^(normal|soft|drum)-(hitnormal|hitwhistle|hitfinish|hitclap|slidertick|sliderslide|sliderwhistle|spinnerspin|spinnerbonus)(\d*)$/;
const OTHER_SAMPLES = new Set(['combobreak', 'spinnerspin', 'spinnerbonus', 'failsound', 'sectionpass', 'sectionfail', 'applause', 'comboburst']);

export class LegacySkin {
    readonly config: SkinConfig;
    private readonly textures = new Map<string, SkinTexture>();
    /** Decoded samples by lower-case name; null = deliberately silent (blank file). */
    private readonly samples = new Map<string, AudioBuffer | null>();

    private constructor(config: SkinConfig) {
        this.config = config;
    }

    get textureCount(): number {
        return this.textures.size;
    }

    get sampleCount(): number {
        return this.samples.size;
    }

    static async load(source: SkinFiles, ctx: BaseAudioContext | null, opts: LegacySkinOptions = {}): Promise<LegacySkin> {
        // Paths relative to the skin's root ("hitcircle.png", "fonts/score-0.png").
        const { root, files } = skinRoot(source.files);
        const rel = (f: string) => f.slice(root.length);
        // Elements and sounds sit at the root; only font glyphs may live in subfolders.
        const rootLevel = files.filter(f => !rel(f).includes('/'));
        const lookup = new Map(rootLevel.map(f => [rel(f).toLowerCase(), f]));
        let config: SkinConfig = {};
        if (opts.ini ?? true) {
            const ini = lookup.get('skin.ini');
            if (ini) {
                try {
                    config = parseSkinIni(new TextDecoder('utf-8').decode(await source.readBytes(ini)));
                } catch {
                    config = {};
                }
            }
        }
        const skin = new LegacySkin(config);
        const jobs: Promise<void>[] = [];
        if (opts.textures ?? true) {
            const fonts = [config.hitCirclePrefix ?? 'default', config.scorePrefix ?? 'score', config.comboPrefix ?? 'score']
                .map(p => p.toLowerCase());
            const wanted = (stem: string): boolean => {
                const base = stem.replace(/(-?\d+)$/, '');
                if (!stem.includes('/') && (ELEMENTS.includes(stem) || ELEMENTS.includes(base))) return true;
                return fonts.some(p => GLYPHS.some(g => stem === `${p}-${g}`));
            };
            // Group by element: prefer the @2x image over the 1x one.
            const picks = new Map<string, { file: string; hi: boolean }>();
            for (const f of files) {
                if (!IMAGE_RE.test(f)) continue;
                const r = rel(f);
                let stem = (r.includes('/') ? r.slice(0, r.lastIndexOf('.')) : stripExt(r)).toLowerCase();
                const hi = stem.endsWith('@2x');
                if (hi) stem = stem.slice(0, -3);
                if (!wanted(stem)) continue;
                const cur = picks.get(stem);
                if (!cur || (hi && !cur.hi)) picks.set(stem, { file: f, hi });
            }
            for (const [stem, { file, hi }] of picks) {
                jobs.push(decodeImage(source, file).then(tex => {
                    if (tex) skin.textures.set(stem, { texture: tex, scale: hi ? 0.5 : 1 });
                }));
            }
        }
        if ((opts.samples ?? true) && ctx) {
            const picks = new Map<string, string>();
            const ogg = opts.preferOgg ?? true;
            const rank = (f: string) => (/\.ogg$/i.test(f) ? (ogg ? 0 : 2) : /\.wav$/i.test(f) ? 1 : 3);
            const consider = (f: string) => {
                const stem = stripExt(basename(f)).toLowerCase();
                const cur = picks.get(stem);
                if (!cur || rank(f) < rank(cur)) picks.set(stem, f);
            };
            for (const f of rootLevel) {
                if (!AUDIO_RE.test(f)) continue;
                const stem = stripExt(f).toLowerCase();
                if (HITSOUND_RE.test(stem) || OTHER_SAMPLES.has(stem)) consider(f);
            }
            for (const f of opts.customSampleFiles ?? []) {
                const hit = lookup.get(basename(f.replace(/\\/g, '/')).toLowerCase());
                if (hit) consider(hit);
            }
            for (const [stem, file] of picks) {
                jobs.push(decodeSample(source, ctx, file).then(buf => {
                    skin.samples.set(stem, buf);
                }));
            }
        }
        await Promise.all(jobs);
        return skin;
    }

    texture(name: string): SkinTexture | null {
        return this.textures.get(name.toLowerCase()) ?? null;
    }

    /**
     * An animation's frames (name-0, name-1… or name0, name1…), else the
     * single image, else []. `animatable: false` only returns the still.
     */
    frames(name: string, animatable = true): SkinTexture[] {
        const key = name.toLowerCase();
        if (animatable) {
            for (const sep of ['-', '']) {
                const out: SkinTexture[] = [];
                for (let i = 0; ; i++) {
                    const t = this.textures.get(`${key}${sep}${i}`);
                    if (!t) break;
                    out.push(t);
                }
                if (out.length) return out;
            }
        }
        const single = this.textures.get(key);
        return single ? [single] : [];
    }

    /**
     * A sample, by osu! name ("soft-hitclap"; index 2 → "soft-hitclap2").
     * undefined: this skin doesn't have it; null: it's deliberately silent.
     */
    sample(name: string, index = 1): AudioBuffer | null | undefined {
        const key = name.toLowerCase();
        return this.samples.get(index > 1 ? `${key}${index}` : key);
    }

    /** A sample a hit object names directly (custom filename). */
    file(filename: string): AudioBuffer | null | undefined {
        return this.samples.get(stripExt(basename(filename.replace(/\\/g, '/'))).toLowerCase());
    }

    destroy(): void {
        for (const t of this.textures.values()) t.texture.destroy(true);
        this.textures.clear();
        this.samples.clear();
    }
}

/**
 * Files at the skin's root, with paths relative to it. Exported skins are
 * sometimes zipped inside one folder: then that folder is the root.
 */
function skinRoot(all: readonly string[]): { root: string; files: string[] } {
    const norm = all.map(f => f.replace(/\\/g, '/')).filter(f => !f.endsWith('/'));
    const top = norm.filter(f => !f.includes('/'));
    const looksLikeSkin = (fs: string[]) => fs.some(f => /^skin\.ini$/i.test(f) || IMAGE_RE.test(f) || AUDIO_RE.test(f));
    if (!looksLikeSkin(top)) {
        const dirs = new Set(norm.filter(f => f.includes('/')).map(f => f.split('/')[0]));
        if (dirs.size === 1) {
            const [dir] = dirs;
            return { root: `${dir}/`, files: norm.filter(f => f.startsWith(`${dir}/`)) };
        }
    }
    return { root: '', files: norm };
}

function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}

function stripExt(f: string): string {
    const name = basename(f);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

async function decodeImage(source: SkinFiles, file: string): Promise<Texture | null> {
    try {
        const bytes = await source.readBytes(file);
        const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
        const tex = Texture.from(bitmap);
        tex.source.autoGenerateMipmaps = false;
        return tex;
    } catch {
        return null;
    }
}

async function decodeSample(source: SkinFiles, ctx: BaseAudioContext, file: string): Promise<AudioBuffer | null> {
    try {
        const bytes = await source.readBytes(file);
        // Skins and mappers mute sounds with empty or tiny files: silence, not "missing".
        if (bytes.byteLength < 100) return null;
        return await ctx.decodeAudioData(bytes.slice().buffer);
    } catch {
        return null;
    }
}
