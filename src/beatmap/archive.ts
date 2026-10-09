/**
 * Read-only .osz (zip) access backed by fflate.
 *
 * Opening only walks the central directory; entries are inflated one at a
 * time on demand, so pulling a .osu file out of a 20 MB set with a video
 * never touches the video bytes. fflate inflates large entries in a worker
 * and small ones synchronously.
 */
import { unzip, unzipSync, type UnzipFileInfo } from 'fflate';

const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|opus|aac)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

const MIME: Record<string, string> = {
    mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    m4a: 'audio/mp4', opus: 'audio/ogg', aac: 'audio/aac',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv',
    osu: 'text/plain', osb: 'text/plain', txt: 'text/plain',
};

export function mimeForFile(name: string): string {
    const dot = name.lastIndexOf('.');
    return (dot !== -1 && MIME[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

export interface FindOptions {
    /** Match ignoring case (default true). */
    caseInsensitive?: boolean;
    /** Fall back to matching the file name without folders (default true). */
    basenameFallback?: boolean;
}

interface Entry {
    /** Name as fflate reports it (used to select the entry). */
    raw: string;
    /** Display name (re-decoded as UTF-8 or CP437, '/' separators). */
    name: string;
    size: number;
}

const normalizePath = (s: string): string => s.replace(/\\/g, '/').replace(/^\.?\//, '');
const basename = (s: string): string => {
    const n = normalizePath(s);
    const i = n.lastIndexOf('/');
    return i === -1 ? n : n.slice(i + 1);
};

export class OszArchive {
    readonly files: string[];
    private readonly data: Uint8Array;
    private readonly entries: Map<string, Entry>;

    private constructor(data: Uint8Array, entries: Entry[]) {
        this.data = data;
        this.entries = new Map(entries.map(e => [e.name, e]));
        this.files = entries.map(e => e.name);
    }

    static async open(input: Blob | ArrayBuffer | Uint8Array): Promise<OszArchive> {
        let data: Uint8Array;
        if (input instanceof Uint8Array) data = input;
        else if (input instanceof ArrayBuffer) data = new Uint8Array(input);
        else data = new Uint8Array(await input.arrayBuffer());

        const entries: Entry[] = [];
        try {
            // A filter that rejects everything lists the directory without inflating.
            unzipSync(data, {
                filter: (f: UnzipFileInfo) => {
                    if (!f.name.endsWith('/')) {
                        entries.push({ raw: f.name, name: normalizePath(decodeName(f.name)), size: f.originalSize });
                    }
                    return false;
                },
            });
        } catch (e) {
            throw new Error(`Not a valid .osz/.zip archive (${e instanceof Error ? e.message : String(e)})`);
        }
        return new OszArchive(data, entries);
    }

    /** Resolve a file name as written in a .osu file to an archive entry name. */
    find(name: string, opts: FindOptions = {}): string | null {
        const want = normalizePath(name);
        if (this.entries.has(want)) return want;
        const ci = opts.caseInsensitive ?? true;
        if (ci) {
            const lower = want.toLowerCase();
            for (const f of this.files) if (f.toLowerCase() === lower) return f;
        }
        if (opts.basenameFallback ?? true) {
            const base = ci ? basename(want).toLowerCase() : basename(want);
            for (const f of this.files) {
                const b = ci ? basename(f).toLowerCase() : basename(f);
                if (b === base) return f;
            }
        }
        return null;
    }

    has(name: string): boolean {
        return this.find(name) !== null;
    }

    osuFiles(): string[] {
        return this.files.filter(f => /\.osu$/i.test(f));
    }

    /** Audio file referenced by a map, tolerating renames and re-encodes. */
    findAudio(filename: string): string | null {
        if (filename) {
            const hit = this.find(filename);
            if (hit) return hit;
        }
        return this.files.find(f => AUDIO_EXT.test(f)) ?? null;
    }

    /** Background image referenced by a map; falls back to the only image in the set. */
    findImage(filename: string): string | null {
        if (filename) {
            const hit = this.find(filename);
            if (hit) return hit;
        }
        const images = this.files.filter(f => IMAGE_EXT.test(f));
        return images.length === 1 ? images[0] : null;
    }

    sizeOf(name: string): number {
        return this.entries.get(this.find(name) ?? '')?.size ?? 0;
    }

    async readBytes(name: string): Promise<Uint8Array> {
        const resolved = this.find(name);
        const entry = resolved ? this.entries.get(resolved) : undefined;
        if (!entry) throw new Error(`File not found in archive: ${name}`);
        const raw = entry.raw;
        return new Promise<Uint8Array>((resolve, reject) => {
            unzip(this.data, { filter: f => f.name === raw }, (err, files) => {
                if (err) {
                    reject(new Error(`Could not extract ${name}: ${err.message}`));
                    return;
                }
                const out = files[raw];
                if (!out) reject(new Error(`Could not extract ${name}`));
                else resolve(out);
            });
        });
    }

    async readText(name: string): Promise<string> {
        return new TextDecoder('utf-8').decode(await this.readBytes(name));
    }

    async readBlob(name: string, mime?: string): Promise<Blob> {
        const bytes = await this.readBytes(name);
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? mimeForFile(name) });
    }
}

// ---------------------------------------------------------------------------
// File name decoding
// ---------------------------------------------------------------------------

const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/**
 * fflate decodes names without the UTF-8 flag as latin1, i.e. one char per
 * byte. osu! (and most zip tools) write UTF-8 regardless of the flag, so
 * try UTF-8 first and fall back to the zip spec's CP437.
 */
export function decodeName(name: string): string {
    let ascii = true;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if (c > 255) return name; // fflate already decoded UTF-8 (flag set)
        if (c > 127) ascii = false;
    }
    if (ascii) return name;
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        let out = '';
        for (const b of bytes) out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
        return out;
    }
}
