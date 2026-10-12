import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lzmaCompress } from '../../src/core/lzma';
import { md5Hex } from '../../src/core/md5';
import { encodeOsr, legacyFrames, legacyModBits } from '../../src/gameplay/replay/osr';
import type { ReplayEvent } from '../../src/gameplay/replay/Replay';

/** The standard LZMA range decoder, literals only (what lzmaCompress emits). */
function lzmaDecodeLiterals(data: Uint8Array): Uint8Array {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(data[0]).toBe(0x5d);
    const size = Number(view.getBigUint64(5, true));
    let pos = 13;
    expect(data[pos++]).toBe(0);
    let code = 0;
    for (let i = 0; i < 4; i++) code = (code * 256 + data[pos++]) >>> 0;
    let range = 0xffffffff;
    const bit = (probs: Uint16Array, i: number): number => {
        const p = probs[i];
        const bound = (range >>> 11) * p;
        let b: number;
        if (code < bound) {
            range = bound;
            probs[i] = p + ((2048 - p) >> 5);
            b = 0;
        } else {
            code -= bound;
            range -= bound;
            probs[i] = p - (p >> 5);
            b = 1;
        }
        if (range < 2 ** 24) {
            range = (range * 256) >>> 0;
            code = (code * 256 + (data[pos++] ?? 0)) >>> 0;
        }
        return b;
    };
    const isMatch = new Uint16Array(4).fill(1024);
    const lit = new Uint16Array(0x300 * 8).fill(1024);
    const out = new Uint8Array(size);
    let prev = 0;
    for (let i = 0; i < size; i++) {
        expect(bit(isMatch, i & 3)).toBe(0);
        const base = 0x300 * (prev >> 5);
        let symbol = 1;
        while (symbol < 0x100) symbol = (symbol << 1) | bit(lit, base + symbol);
        out[i] = prev = symbol & 0xff;
    }
    return out;
}

describe('md5', () => {
    it('matches node:crypto', () => {
        for (const s of ['', 'a', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'osu! ♪ '.repeat(100)]) {
            expect(md5Hex(s)).toBe(createHash('md5').update(s).digest('hex'));
        }
    });
});

describe('lzma', () => {
    it('round-trips through a standard range decoder', () => {
        let seed = 9;
        const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const samples = [
            new Uint8Array(0),
            new TextEncoder().encode('12|256.5|192|5,'.repeat(2000)),
            Uint8Array.from({ length: 20000 }, () => Math.floor(rand() * 256)),
            new Uint8Array(5000).fill(0xff),
        ];
        for (const s of samples) expect(lzmaDecodeLiterals(lzmaCompress(s))).toEqual(s);
        // Replay-like text compresses well even without matches.
        expect(lzmaCompress(samples[1]).length).toBeLessThan(samples[1].length / 2);
    });
});

describe('.osr export', () => {
    const events: ReplayEvent[] = [
        { kind: 'frame', time: -500, x: 0, y: 0, buttons: 0 },
        { kind: 'frame', time: 10, x: 100, y: 50, buttons: 0 },
        { kind: 'press', time: 12.4, x: 101.25, y: 50, button: 'K1' },
        { kind: 'frame', time: 20, x: 110, y: 60, buttons: 1 },
        { kind: 'resume', time: 25 },
        { kind: 'frame', time: 30.6, x: 120, y: 70, buttons: 4 | 2 },
    ];

    it('writes stable frames with osu! button bits', () => {
        expect(legacyFrames(events)).toBe('0|256|-500|0,-1|256|-500|0,11|100|50|0,2|101.25|50|5,8|110|60|5,11|120|70|11,-12345|0|0|0,');
    });

    it('maps mods to legacy bits', () => {
        expect(legacyModBits(['HD', 'DT'])).toBe(72);
        expect(legacyModBits(['NC', 'PF'])).toBe(64 | 512 | 32 | 16384);
    });

    it('writes the header and the compressed frames', () => {
        const osr = encodeOsr({
            beatmapMd5: 'd41d8cd98f00b204e9800998ecf8427e', player: 'Guest', count300: 10, count100: 2, count50: 1, countMiss: 0,
            score: 12345, maxCombo: 13, perfect: true, mods: ['HD'], date: 0, events,
        });
        const view = new DataView(osr.buffer);
        expect(osr[0]).toBe(0);
        expect(view.getInt32(1, true)).toBe(20240411);
        expect(osr[5]).toBe(0x0b);
        expect(osr[6]).toBe(32);
        expect(new TextDecoder().decode(osr.subarray(7, 39))).toBe('d41d8cd98f00b204e9800998ecf8427e');
        // The frames block sits before the trailing online id.
        let p = 39;
        const str = () => { if (osr[p++] === 0) return; const n = osr[p++]; p += n; };
        str(); str();
        expect(view.getUint16(p, true)).toBe(10);
        p += 12;
        expect(view.getInt32(p, true)).toBe(12345);
        p += 4 + 2 + 1;
        expect(view.getInt32(p, true)).toBe(8);
        p += 4;
        str();
        expect(view.getBigInt64(p, true)).toBe(621355968000000000n);
        p += 8;
        const len = view.getInt32(p, true);
        p += 4;
        const frames = new TextDecoder().decode(lzmaDecodeLiterals(osr.subarray(p, p + len)));
        expect(frames).toBe(legacyFrames(events));
        expect(osr.length).toBe(p + len + 8);
    });
});
