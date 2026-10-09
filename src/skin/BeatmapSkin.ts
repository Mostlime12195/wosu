import { Texture } from 'pixi.js';
import type { OszArchive } from '../beatmap/archive';

/**
 * A beatmap skin (osu!'s "beatmap skins" / "beatmap hitsounds"): gameplay
 * images and hitsound files shipped at the root of a beatmap's folder,
 * overriding the game's own look and sounds for that map only.
 */

/** Texture plus its logical scale (0.5 for @2x images, osu!'s high-res convention). */
export interface SkinTexture {
    texture: Texture;
    scale: number;
}

/** Elements a beatmap may override, by osu! file name (no extension). */
const ELEMENTS = [
    'hitcircle', 'hitcircleoverlay', 'approachcircle',
    'sliderstartcircle', 'sliderstartcircleoverlay',
    'sliderfollowcircle', 'sliderscorepoint', 'reversearrow', 'followpoint',
    'sliderb',
    'hit0', 'hit50', 'hit100', 'hit300',
    ...Array.from({ length: 10 }, (_, i) => `default-${i}`),
];
/** Elements that may come as numbered animation frames (sliderb0.png, sliderb1.png, …). */
const ANIMATED = ['sliderb', 'hit0', 'hit50', 'hit100', 'hit300'];

const IMAGE_RE = /\.(png|jpe?g)$/i;
const SAMPLE_RE = /^(normal|soft|drum)-(hitnormal|hitwhistle|hitfinish|hitclap|slidertick|sliderslide|sliderwhistle|spinnerspin|spinnerbonus)(\d*)\.(wav|ogg|mp3)$/i;

export class BeatmapSkin {
    private readonly textures = new Map<string, SkinTexture>();
    /** Decoded samples by lower-case name without extension; null = deliberately silent (blank file). */
    private readonly samples = new Map<string, AudioBuffer | null>();

    get textureCount(): number {
        return this.textures.size;
    }

    get sampleCount(): number {
        return this.samples.size;
    }

    /**
     * Read what the beatmap's folder overrides. `customFiles` are sample
     * file names hit objects reference directly (osu!'s per-object filename).
     */
    static async load(
        archive: OszArchive,
        ctx: BaseAudioContext,
        opts: { textures: boolean; samples: boolean; customFiles?: Iterable<string> },
    ): Promise<BeatmapSkin> {
        const skin = new BeatmapSkin();
        // Only the folder root counts, like osu!.
        const root = archive.files.filter(f => !f.includes('/'));
        const jobs: Promise<void>[] = [];
        if (opts.textures) {
            const byName = new Map(root.filter(f => IMAGE_RE.test(f)).map(f => [stem(f).toLowerCase(), f]));
            const wanted = new Set<string>();
            for (const e of ELEMENTS) {
                wanted.add(e);
                if (ANIMATED.includes(e)) for (let i = 0; i < 120 && (byName.has(`${e}${i}`) || byName.has(`${e}${i}@2x`) || byName.has(`${e}-${i}`) || byName.has(`${e}-${i}@2x`)); i++) {
                    wanted.add(e === 'sliderb' ? `${e}${i}` : `${e}-${i}`);
                }
            }
            for (const name of wanted) {
                const hi = byName.get(`${name}@2x`);
                const lo = byName.get(name);
                const file = hi ?? lo;
                if (!file) continue;
                jobs.push(decodeImage(archive, file).then(tex => {
                    if (tex) skin.textures.set(name, { texture: tex, scale: hi ? 0.5 : 1 });
                }));
            }
        }
        if (opts.samples) {
            const files = new Set(root.filter(f => SAMPLE_RE.test(f)));
            for (const f of opts.customFiles ?? []) {
                const hit = archive.find(f);
                if (hit) files.add(hit);
            }
            for (const f of files) {
                jobs.push(decodeSample(archive, ctx, f).then(buf => { skin.samples.set(stem(f).toLowerCase(), buf); }));
            }
        }
        await Promise.all(jobs);
        return skin;
    }

    texture(name: string): SkinTexture | null {
        return this.textures.get(name) ?? null;
    }

    /** Animation frames (sliderb0.., hit300-0..), or the single image, or []. */
    frames(name: string): SkinTexture[] {
        const out: SkinTexture[] = [];
        const sep = name === 'sliderb' ? '' : '-';
        for (let i = 0; ; i++) {
            const t = this.textures.get(`${name}${sep}${i}`);
            if (!t) break;
            out.push(t);
        }
        if (out.length) return out;
        const single = this.textures.get(name);
        return single ? [single] : [];
    }

    /**
     * A hitsound override, by osu! name ("soft-hitclap", index 2 →
     * "soft-hitclap2"). undefined: the beatmap doesn't override it; null:
     * it overrides it with silence.
     */
    sample(name: string, index = 1): AudioBuffer | null | undefined {
        return this.samples.get(index > 1 ? `${name}${index}` : name);
    }

    /** A sample a hit object names directly (custom filename). */
    file(filename: string): AudioBuffer | null | undefined {
        return this.samples.get(stem(basename(filename)).toLowerCase());
    }

    destroy(): void {
        for (const t of this.textures.values()) t.texture.destroy(true);
        this.textures.clear();
        this.samples.clear();
    }
}

function basename(p: string): string {
    const i = p.replace(/\\/g, '/').lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
}

function stem(f: string): string {
    const dot = f.lastIndexOf('.');
    return dot > 0 ? f.slice(0, dot) : f;
}

async function decodeImage(archive: OszArchive, file: string): Promise<Texture | null> {
    try {
        const bitmap = await createImageBitmap(await archive.readBlob(file));
        const tex = Texture.from(bitmap);
        tex.source.autoGenerateMipmaps = false;
        return tex;
    } catch {
        return null;
    }
}

async function decodeSample(archive: OszArchive, ctx: BaseAudioContext, file: string): Promise<AudioBuffer | null> {
    try {
        const bytes = await archive.readBytes(file);
        // Mappers mute hitsounds with empty or tiny files: that's silence, not "missing".
        if (bytes.byteLength < 100) return null;
        return await ctx.decodeAudioData(bytes.slice().buffer);
    } catch {
        return null;
    }
}
