// Convert a TrueType/OpenType font to WOFF2 (same glyphs and tables, Brotli-packed):
//   node tools/woff2.mjs public/assets/fonts/Exo2.ttf   → public/assets/fonts/Exo2.woff2
// The UI font (Exo 2) ships as WOFF2: ~300 KB per style as TTF, ~110 KB as WOFF2.
// fontverter comes with the subset-font devDependency (tools/iconFont.ts).
import fs from 'node:fs';
import fontverter from 'fontverter';

const [input, output = input.replace(/\.(ttf|otf)$/i, '.woff2')] = process.argv.slice(2);
if (!input || input === output) throw new Error('usage: node tools/woff2.mjs <font.ttf> [out.woff2]');
const woff2 = await fontverter.convert(fs.readFileSync(input), 'woff2');
fs.writeFileSync(output, woff2);
console.log(`${input} (${fs.statSync(input).size} B) → ${output} (${woff2.length} B)`);
