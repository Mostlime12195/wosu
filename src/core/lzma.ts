/**
 * A minimal LZMA ("alone" / .lzma format) encoder, enough for osu!'s .osr
 * replays. It codes every byte as a literal with LZMA's adaptive range
 * coder (no match finder), so the output is a valid stream any LZMA
 * decoder reads (osu!stable, lazer, xz), compressing text like replay
 * frames to roughly half, without pulling in a full LZMA library.
 */

// lc = 3, lp = 0, pb = 2: the LZMA SDK defaults osu! uses too.
const LC = 3;
const PB = 2;
const PROPS = (PB * 5 + 0) * 9 + LC;
const DICT_SIZE = 1 << 21;
const PROB_INIT = 1024;
const TOP = 2 ** 24;

class RangeEncoder {
    private low = 0;
    private range = 0xffffffff;
    private cache = 0;
    private cacheSize = 1;
    private buf: Uint8Array;
    length = 0;

    constructor(capacity: number) {
        this.buf = new Uint8Array(Math.max(64, capacity));
    }

    private write(b: number): void {
        if (this.length === this.buf.length) {
            const next = new Uint8Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = b;
    }

    private shiftLow(): void {
        // `low` is kept below 2^33: bit 32 is the carry into the cached byte.
        if (this.low < 0xff000000 || this.low >= 2 ** 32) {
            const carry = this.low >= 2 ** 32 ? 1 : 0;
            let temp = this.cache;
            do {
                this.write((temp + carry) & 0xff);
                temp = 0xff;
            } while (--this.cacheSize !== 0);
            this.cache = (this.low >>> 24) & 0xff;
        }
        this.cacheSize++;
        this.low = (this.low % TOP) * 256;
    }

    bit(probs: Uint16Array, i: number, bit: number): void {
        const p = probs[i];
        const bound = (this.range >>> 11) * p;
        if (bit === 0) {
            this.range = bound;
            probs[i] = p + ((2048 - p) >> 5);
        } else {
            this.low += bound;
            this.range -= bound;
            probs[i] = p - (p >> 5);
        }
        while (this.range < TOP) {
            this.range = (this.range * 256) >>> 0;
            this.shiftLow();
        }
    }

    finish(): Uint8Array {
        for (let i = 0; i < 5; i++) this.shiftLow();
        return this.buf.subarray(0, this.length);
    }
}

/** Compress to the 13-byte-header .lzma format (props, dictionary size, uncompressed size). */
export function lzmaCompress(data: Uint8Array): Uint8Array {
    const rc = new RangeEncoder(data.length + 16);
    // Only literals are coded, so the LZMA state stays 0 and only its is-match bits are used.
    const isMatch = new Uint16Array(1 << PB).fill(PROB_INIT);
    const literals = new Uint16Array(0x300 << LC).fill(PROB_INIT);
    let prev = 0;
    for (let pos = 0; pos < data.length; pos++) {
        rc.bit(isMatch, pos & ((1 << PB) - 1), 0);
        const base = 0x300 * (prev >> (8 - LC));
        const byte = data[pos];
        let symbol = 1;
        for (let i = 7; i >= 0; i--) {
            const bit = (byte >> i) & 1;
            rc.bit(literals, base + symbol, bit);
            symbol = (symbol << 1) | bit;
        }
        prev = byte;
    }
    const body = rc.finish();
    const out = new Uint8Array(13 + body.length);
    const view = new DataView(out.buffer);
    out[0] = PROPS;
    view.setUint32(1, DICT_SIZE, true);
    view.setBigUint64(5, BigInt(data.length), true);
    out.set(body, 13);
    return out;
}
