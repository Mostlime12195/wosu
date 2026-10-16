import { unzip } from 'fflate';
import { resolveAssetUrl } from '../audio/base';

/**
 * Asset packs (built by tools/assetPacks.ts): the default skin, its
 * hitsounds and the UI sounds, each one zip download instead of one
 * request per file. A pack that fails to load leaves its files to be
 * fetched one by one, as before.
 */
export type PackName = keyof typeof __ASSET_PACKS__;

/** Duplicate files are stored once; this entry maps each duplicate to its original (tools/assetPacks.ts). */
export const PACK_ALIASES = '.aliases.json';

/** A pack's unzipped files with its duplicates restored under their own names. */
export function packEntries(files: Readonly<Record<string, Uint8Array>>): Map<string, Uint8Array> {
    const out = new Map(Object.entries(files));
    const list = out.get(PACK_ALIASES);
    if (!list) return out;
    out.delete(PACK_ALIASES);
    try {
        const aliases = JSON.parse(new TextDecoder().decode(list)) as Record<string, string>;
        for (const [dup, original] of Object.entries(aliases)) {
            const bytes = out.get(original);
            if (bytes) out.set(dup, bytes);
        }
    } catch (e) {
        console.warn('[assets] bad pack alias list', e);
    }
    return out;
}

export class AssetPack {
    constructor(private readonly entries: ReadonlyMap<string, Uint8Array>) {}

    /** Paths inside the pack (relative to the folder it was built from). */
    get files(): string[] {
        return [...this.entries.keys()];
    }

    get(path: string): Uint8Array | undefined {
        return this.entries.get(path);
    }
}

const loads = new Map<PackName, Promise<AssetPack | null>>();

/** Download and unzip a pack once (later calls share the result); null when unavailable. */
export function loadPack(name: PackName): Promise<AssetPack | null> {
    let p = loads.get(name);
    if (!p) {
        p = (async () => {
            try {
                const res = await fetch(resolveAssetUrl(__ASSET_PACKS__[name]));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const zip = new Uint8Array(await res.arrayBuffer());
                const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
                    unzip(zip, (err, data) => (err ? reject(err) : resolve(data)));
                });
                return new AssetPack(packEntries(files));
            } catch (e) {
                console.warn(`[assets] pack ${name} unavailable, fetching its files one by one`, e);
                return null;
            }
        })();
        loads.set(name, p);
    }
    return p;
}

/**
 * A fetch for the files of the folder at `baseUrl`: answered from the
 * pack when it has the file, from the network otherwise (a missing pack,
 * or files it leaves out such as the WAV hitsounds).
 */
export function packFetch(name: PackName, baseUrl: string): (url: string) => Promise<Response> {
    const pack = loadPack(name);
    return async url => {
        const p = await pack;
        if (p && url.startsWith(baseUrl)) {
            const bytes = p.get(decodeURIComponent(url.slice(baseUrl.length)));
            if (bytes) return new Response(bytes as Uint8Array<ArrayBuffer>);
        }
        return fetch(url);
    };
}
