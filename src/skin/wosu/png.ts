import { zlibSync } from 'fflate';
import type { Raster } from './raster';

/** CRC-32 (PNG chunk checksums). */
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/**
 * An RGBA PNG of a raster (straight alpha, as image files have). Rows use
 * the Sub filter, which suits these smooth shapes; output is deterministic.
 */
export function encodePng(r: Raster): Uint8Array {
    const { width: w, height: h } = r;
    const px = r.rgba8(false);
    const raw = new Uint8Array(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        const o = y * (w * 4 + 1);
        raw[o] = 1; // Sub
        for (let i = 0; i < w * 4; i++) {
            const v = px[y * w * 4 + i];
            raw[o + 1 + i] = (v - (i >= 4 ? px[y * w * 4 + i - 4] : 0)) & 0xff;
        }
    }
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, w);
    v.setUint32(4, h);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlibSync(raw, { level: 9 })),
        chunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
