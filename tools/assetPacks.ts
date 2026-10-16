/**
 * Asset packs: folders of small static files (the default skin's images,
 * its hitsounds, the UI sounds) zipped into one file each, so a first
 * visit downloads three files instead of ~170. The host bills every
 * request, so this is most of what a visit costs.
 *
 * Pack file names carry a hash of their contents, so they're cached for a
 * year (vercel.json) and a changed pack gets a new name. The individual
 * files still ship in public/ as a fallback (and for the WAV hitsounds
 * browsers without Vorbis need).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Plugin } from 'vite';

interface PackSpec {
    readonly name: string;
    /** Folder under the project root; pack paths are relative to it. */
    readonly dir: string;
    readonly include: (rel: string, all: ReadonlySet<string>) => boolean;
}

const AUDIO = /\.(wav|ogg|mp3)$/i;
/** Already compressed: stored as-is (deflating them only costs time). */
const STORED = /\.(png|jpe?g|ogg|mp3)$/i;
/**
 * Files whose bytes repeat an earlier file are stored once and listed here
 * ({ duplicate: original }); the client (src/core/assetPacks.ts, PACK_ALIASES)
 * serves them under both names. The default skin's three identical
 * spinnerbonus WAVs alone were 1.7 MB of the hitsound pack.
 */
export const PACK_ALIASES = '.aliases.json';
/** Fixed timestamps keep the zip bytes (and so the hash) the same on every build. */
const MTIME = new Date('2026-01-01T00:00:00Z');

export const PACKS: readonly PackSpec[] = [
    // Images and skin.ini; hitsounds come separately (SampleBank loads them).
    { name: 'default-skin', dir: 'public/assets/skins/default', include: rel => !AUDIO.test(rel) && rel !== 'manifest.json' },
    // Every Vorbis hitsound, plus the ones that only exist as WAV (spinner sounds).
    {
        name: 'default-hitsounds',
        dir: 'public/assets/skins/default',
        include: (rel, all) => /^((normal|soft|drum)-|combobreak\.)/.test(rel)
            && (rel.endsWith('.ogg') || (rel.endsWith('.wav') && !all.has(rel.replace(/\.wav$/, '.ogg')))),
    },
    { name: 'ui-samples', dir: 'public/assets/samples', include: rel => rel.endsWith('.mp3') },
];

function walk(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walk(dir, rel));
        else out.push(rel);
    }
    return out;
}

export function buildPack(root: string, spec: PackSpec): { bytes: Uint8Array; fileName: string } {
    const dir = path.join(root, spec.dir);
    const all = walk(dir).sort();
    const set = new Set(all);
    const zip: Zippable = {};
    const byContent = new Map<string, string>();
    const aliases: Record<string, string> = {};
    for (const rel of all) {
        if (!spec.include(rel, set)) continue;
        const data = fs.readFileSync(path.join(dir, rel));
        const digest = createHash('sha256').update(data).digest('hex');
        const original = byContent.get(digest);
        if (original) {
            aliases[rel] = original;
            continue;
        }
        byContent.set(digest, rel);
        zip[rel] = [data, { level: STORED.test(rel) ? 0 : 6, mtime: MTIME }];
    }
    if (Object.keys(aliases).length) zip[PACK_ALIASES] = [strToU8(JSON.stringify(aliases)), { level: 6, mtime: MTIME }];
    const bytes = zipSync(zip);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    return { bytes, fileName: `assets/packs/${spec.name}.${hash}.zip` };
}

/**
 * The packs as a Vite plugin, plus the `define` that tells the client
 * their hashed names (__ASSET_PACKS__). Builds emit the zips; the dev
 * server zips the folders fresh on each request, so edits show at once.
 */
export function assetPacks(root: string): { plugin: Plugin; define: Record<string, string> } {
    const built = PACKS.map(spec => ({ spec, ...buildPack(root, spec) }));
    const names = Object.fromEntries(built.map(b => [b.spec.name, b.fileName]));
    const plugin: Plugin = {
        name: 'wosu-asset-packs',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const m = /\/assets\/packs\/([a-z-]+)\.[0-9a-f]+\.zip$/.exec(req.url?.split('?')[0] ?? '');
                const spec = m && PACKS.find(p => p.name === m[1]);
                if (!spec) return next();
                res.setHeader('Content-Type', 'application/zip');
                res.end(Buffer.from(buildPack(root, spec).bytes));
            });
        },
        generateBundle() {
            for (const b of built) this.emitFile({ type: 'asset', fileName: b.fileName, source: b.bytes });
        },
    };
    return { plugin, define: { __ASSET_PACKS__: JSON.stringify(names) } };
}
