#!/usr/bin/env node
/**
 * Writes wosu!'s generated default skin out as an ordinary osu! skin
 * folder (every image @2x plus skin.ini), for looking at the art, diffing
 * it, or playing it in osu!. The game doesn't need these files: it draws
 * the same images at runtime from the options in Settings → Skin (see
 * src/skin/wosu/). Same code, so the output is identical pixel for pixel.
 *
 *     node tools/default-skin/build.mjs [outDir] [preset] [optionsJson]
 *
 * outDir defaults to dist/wosu-skin/<preset>; preset is clean (default),
 * classic, neon or minimal; optionsJson overrides single options,
 * e.g. '{"circleStyle":"ring","show300":true}'. Needs only Node and the
 * project's dependencies (Vite runs the TypeScript).
 *
 * The skin's hitsounds are ordinary files: art/hitsounds, copied as they
 * are to public/assets/skins/default (packed by tools/assetPacks.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outArg, preset = 'clean', json = '{}'] = process.argv.slice(2);
const out = path.resolve(outArg ?? path.join(root, 'dist', 'wosu-skin', preset));

const load = (rel) => runnerImport(path.join(root, rel), { configFile: false, root, logLevel: 'error' }).then(r => r.module);
const { PRESETS, sanitizeWosuSkin } = await load('src/skin/wosu/options.ts');
const { wosuSkinFiles } = await load('src/skin/wosu/export.ts');
if (!PRESETS[preset]) throw new Error(`unknown preset ${preset} (${Object.keys(PRESETS).join(', ')})`);
const options = sanitizeWosuSkin({ ...PRESETS[preset], ...JSON.parse(json) });

const t0 = performance.now();
const files = wosuSkinFiles(options);
fs.mkdirSync(out, { recursive: true });
for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(out, name), bytes);
const size = Object.values(files).reduce((n, b) => n + b.length, 0);
console.log(`${Object.keys(files).length} files (${(size / 1024).toFixed(0)} kB) in ${path.relative(process.cwd(), out)} [${(performance.now() - t0).toFixed(0)} ms]`);
