/**
 * Icon font subset: Font Awesome's solid font is 155 KB for ~1,400 icons,
 * and wosu! draws under a hundred of them. The build keeps only the glyphs
 * the code uses (every string in src/ui/icons.ts's Icons table, plus any
 * private-use character anywhere in src/), so the font is a few KB.
 *
 * Like the asset packs, the file name carries a content hash (cached for a
 * year by vercel.json) and the client learns it through a define
 * (__ICON_FONT__). The page preloads it, so it downloads alongside the JS.
 * The dev server subsets afresh on every request, so new icons show at once.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const FONT = 'node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2';
const ICONS = 'src/ui/icons.ts';
/** Private Use Area: where Font Awesome's icons live. */
const PUA = /[-]/gu;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
}

/** Every character drawn with the icon font, sorted (so the hash is stable). */
export function iconCharacters(root: string): string {
    const chars = new Set<string>();
    const icons = fs.readFileSync(path.join(root, ICONS), 'utf8');
    const table = /export const Icons = \{([\s\S]*?)\} as const/.exec(icons);
    if (!table) throw new Error(`${ICONS}: Icons table not found`);
    for (const m of table[1].matchAll(/:\s*'((?:[^'\\]|\\.)+)'/g)) for (const c of m[1]) chars.add(c);
    for (const file of walk(path.join(root, 'src'))) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(PUA)) chars.add(m[0]);
    }
    return [...chars].sort().join('');
}

type SubsetFont = (font: Buffer, text: string, options: { targetFormat: 'woff2' }) => Promise<Buffer>;

export async function buildIconFont(root: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    // harfbuzz (wasm) is only needed here, at build time.
    const { default: subsetFont } = (await import('subset-font' as string)) as { default: SubsetFont };
    const bytes = new Uint8Array(await subsetFont(fs.readFileSync(path.join(root, FONT)), iconCharacters(root), { targetFormat: 'woff2' }));
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    return { bytes, fileName: `assets/fa-solid.${hash}.woff2` };
}

/** The subset as a Vite plugin, plus the define that names it (__ICON_FONT__). */
export async function iconFont(root: string): Promise<{ plugin: Plugin; define: Record<string, string> }> {
    const built = await buildIconFont(root);
    const plugin: Plugin = {
        name: 'wosu-icon-font',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!/\/assets\/fa-solid\.[0-9a-f]+\.woff2$/.test(req.url?.split('?')[0] ?? '')) return next();
                buildIconFont(root).then(f => {
                    res.setHeader('Content-Type', 'font/woff2');
                    res.end(Buffer.from(f.bytes));
                }, next);
            });
        },
        transformIndexHtml() {
            return [{
                tag: 'link',
                attrs: { rel: 'preload', href: built.fileName, as: 'font', type: 'font/woff2', crossorigin: '' },
                injectTo: 'head',
            }];
        },
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: built.fileName, source: built.bytes });
        },
    };
    return { plugin, define: { __ICON_FONT__: JSON.stringify(built.fileName) } };
}
