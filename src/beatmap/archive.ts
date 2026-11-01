/**
 * Read-only .osz (zip) access backed by fflate.
 *
 * Opening only walks the central directory; entries are inflated one at a
 * time on demand, so pulling a .osu file out of a 20 MB set with a video
 * never touches the video bytes. Entries of WORKER_MIN_SIZE and up are
 * inflated in a worker (fflate's own `unzip` inflates barely-compressed
 * entries, i.e. every mp3 and jpg, on the main thread: 40 ms for a 6 MB
 * song on a fast laptop, several frames on a slow one); small ones
 * synchronously.
 */
import { inflate, inflateSync, unzip, unzipSync, type UnzipFileInfo } from 'fflate';

/** Entries this large (uncompressed bytes) are inflated off the main thread. */
export const WORKER_MIN_SIZE = 256 * 1024;

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
    /** Where its data is, from the central directory (null: let fflate find it). */
    loc: EntryLocation | null;
}

export interface EntryLocation {
    /** 0 stored, 8 deflated. */
    method: number;
    compressedSize: number;
    /** Offset of the entry's local file header. */
    headerOffset: number;
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
        let index = 0;
        let locs: EntryLocation[] | null = null;
        try {
            // fflate lists in central directory order, so our own walk lines up by index.
            locs = centralDirectory(data);
            // A filter that rejects everything lists the directory without inflating.
            unzipSync(data, {
                filter: (f: UnzipFileInfo) => {
                    const loc = locs?.[index++] ?? null;
                    if (!f.name.endsWith('/')) {
                        entries.push({ raw: f.name, name: normalizePath(decodeName(f.name)), size: f.originalSize, loc });
                    }
                    return false;
                },
            });
        } catch (e) {
            throw new Error(`Not a valid .osz/.zip archive (${e instanceof Error ? e.message : String(e)})`);
        }
        if (locs && locs.length !== index) for (const e of entries) e.loc = null;
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
        if (entry.loc && entry.size >= WORKER_MIN_SIZE) {
            try {
                return await inflateEntry(this.data, entry.loc, entry.size);
            } catch (e) {
                console.warn(`archive: worker inflate of ${name} failed, retrying in place`, e);
            }
        }
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
// Entry data
// ---------------------------------------------------------------------------

const u16 = (d: Uint8Array, i: number): number => d[i] | (d[i + 1] << 8);
const u32 = (d: Uint8Array, i: number): number => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

/**
 * Data locations of every central directory entry, in order; null for
 * archives this simple reader doesn't handle (zip64, no end record), which
 * then go through fflate alone.
 */
export function centralDirectory(data: Uint8Array): EntryLocation[] | null {
    let e = data.length - 22;
    const stop = Math.max(0, data.length - 65558);
    while (e >= stop && u32(data, e) !== 0x06054b50) e--;
    if (e < stop) return null;
    const count = u16(data, e + 10);
    let o = u32(data, e + 16);
    if (count === 0xffff || o === 0xffffffff) return null;
    const out: EntryLocation[] = [];
    for (let i = 0; i < count; i++) {
        if (o + 46 > data.length || u32(data, o) !== 0x02014b50) return null;
        const compressedSize = u32(data, o + 20);
        const headerOffset = u32(data, o + 42);
        if (compressedSize === 0xffffffff || headerOffset === 0xffffffff) return null;
        out.push({ method: u16(data, o + 10), compressedSize, headerOffset });
        o += 46 + u16(data, o + 28) + u16(data, o + 30) + u16(data, o + 32);
    }
    return out;
}

/** An entry's bytes, inflated in a worker (only its compressed bytes are copied there). */
function inflateEntry(data: Uint8Array, loc: EntryLocation, size: number): Promise<Uint8Array> {
    const h = loc.headerOffset;
    if (u32(data, h) !== 0x04034b50) return Promise.reject(new Error('bad local header'));
    const start = h + 30 + u16(data, h + 26) + u16(data, h + 28);
    const end = start + loc.compressedSize;
    if (end > data.length) return Promise.reject(new Error('entry past end of archive'));
    if (loc.method === 0) return Promise.resolve(data.slice(start, end));
    if (loc.method !== 8) return Promise.reject(new Error(`compression method ${loc.method}`));
    return new Promise((resolve, reject) => {
        try {
            inflate(data.slice(start, end), { size, consume: true }, (err, out) => (err ? reject(err) : resolve(out)));
        } catch (e) {
            // No workers here (CSP, old runtime): inflate in place.
            try {
                resolve(inflateSync(data.subarray(start, end), { out: new Uint8Array(size) }));
            } catch (e2) {
                reject(e2 instanceof Error ? e2 : new Error(String(e2)));
            }
        }
    });
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
