import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeAudio, MP3_DECODER_DELAY, osuStartTrim, parseFrameHeader, predictMp3Offset, readMp3Tags } from '../../src/audio/mp3Info';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/map1/audio.mp3');

function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface SynthOptions {
    id3?: boolean;
    tag?: 'Xing' | 'Info' | null;
    encDelay?: number;
    encPadding?: number;
    /** LAME tag encoder name ('' = first byte 0, as some encoders write). */
    encoder?: string;
    /** 0 = 44100, 1 = 48000, 2 = 32000 (MPEG1) */
    srIndex?: number;
    frames?: number;
}

/** MPEG1 Layer III, 128 kbps, stereo. */
function synthMp3(o: SynthOptions = {}): ArrayBuffer {
    const srIndex = o.srIndex ?? 0;
    const sr = [44100, 48000, 32000][srIndex];
    const frameLen = Math.floor((1152 * 16000) / sr);
    const header = [0xff, 0xfb, 0x90 | (srIndex << 2), 0x00];
    const parts: number[] = [];
    if (o.id3) {
        // ID3v2.3, no flags, 20-byte body
        parts.push(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0));
    }
    if (o.tag) {
        const f = new Array(frameLen).fill(0);
        header.forEach((b, i) => (f[i] = b));
        const id = 36; // MPEG1 stereo: 4-byte header + 32-byte side info
        for (let i = 0; i < 4; i++) f[id + i] = o.tag.charCodeAt(i);
        f[id + 7] = 0x0f; // flags: frames | bytes | toc | quality
        const lame = id + 8 + 4 + 4 + 100 + 4;
        (o.encoder ?? 'LAME3.100').split('').forEach((c, i) => (f[lame + i] = c.charCodeAt(0)));
        const delay = o.encDelay ?? 576;
        const padding = o.encPadding ?? 1000;
        f[lame + 21] = (delay >> 4) & 0xff;
        f[lame + 22] = ((delay & 15) << 4) | ((padding >> 8) & 15);
        f[lame + 23] = padding & 0xff;
        parts.push(...f);
    }
    for (let n = 0; n < (o.frames ?? 3); n++) {
        const f = new Array(frameLen).fill(0x55);
        header.forEach((b, i) => (f[i] = b));
        f[36] = 0; // make sure no accidental identifier
        parts.push(...f);
    }
    return new Uint8Array(parts).buffer;
}

describe('mp3Info', () => {
    it('puts song time 0 where osu! (BASS with OLDGAPS) has it on the fixture', () => {
        const ab = toArrayBuffer(readFileSync(FIXTURE));
        // LAME "Info" header at 44.1 kHz, encoder delay 576: osu! drops 576 + 529 samples,
        // and a browser decoding the stripped stream keeps all 1105 (25.06 ms).
        expect(analyzeAudio('audio.mp3', ab).startOffsetMs).toBeCloseTo((1105 / 44100) * 1000, 9);
    });

    it('scans the same sections as the original parser on the fixture', () => {
        const ab = toArrayBuffer(readFileSync(FIXTURE));
        const tags = readMp3Tags(new DataView(ab));
        expect(tags.map(t => [t.type, t.offset, t.byteLength])).toEqual([
            ['ID3v2', 0, 144],
            ['Xing', 144, 626],
            ['frame', 770, 626],
        ]);
        const xing = tags[1];
        expect(xing.type === 'Xing' && xing.encDelay).toBe(576);
    });

    it('strips exactly the Xing frame and leaves a decodable stream', () => {
        const ab = toArrayBuffer(readFileSync(FIXTURE));
        const original = new Uint8Array(ab.slice(0));
        const { buffer, strippedXing } = analyzeAudio('Audio.MP3', ab);
        expect(strippedXing).toBe(true);
        expect(buffer.byteLength).toBe(original.length - 626);
        const out = new Uint8Array(buffer);
        // ID3 tag untouched, first audio frame now directly after it
        expect(Array.from(out.subarray(0, 144))).toEqual(Array.from(original.subarray(0, 144)));
        expect(Array.from(out.subarray(144, 144 + 64))).toEqual(Array.from(original.subarray(770, 770 + 64)));
        const header = parseFrameHeader(new DataView(buffer), 144);
        expect(header).not.toBeNull();
        expect(header!.sampleRate).toBe(44100);
        expect(header!.samplesPerFrame).toBe(1152);
        // no Xing frame left
        expect(readMp3Tags(new DataView(buffer)).some(t => t.type === 'Xing')).toBe(false);
    });

    it('decodes other formats sample-exact (offset 0)', () => {
        const ab = new ArrayBuffer(16);
        const r = analyzeAudio('song.ogg', ab);
        expect(r.startOffsetMs).toBe(0);
        expect(r.buffer).toBe(ab);
    });

    it('trims like BASS: encoder delay + 529 with a named LAME tag, nothing without one', () => {
        const ms = (samples: number, rate = 44100) => (samples / rate) * 1000;
        const cases: [string, SynthOptions, number][] = [
            ['xing with id3', { id3: true, tag: 'Xing' }, ms(1105)],
            ['xing without id3', { tag: 'Xing' }, ms(1105)],
            ['info tag', { id3: true, tag: 'Info' }, ms(1105)],
            ['other delay', { id3: true, tag: 'Xing', encDelay: 1105 }, ms(1105 + 529)],
            ['no tag', { id3: true, tag: null }, 0],
            ['zero delay and padding', { tag: 'Xing', encDelay: 0, encPadding: 0 }, 0],
            ['unnamed encoder', { tag: 'Xing', encoder: '' }, 0],
            ['48k', { tag: 'Xing', srIndex: 1 }, ms(1105, 48000)],
            ['32k', { tag: 'Xing', srIndex: 2 }, ms(1105, 32000)],
        ];
        for (const [name, opts, expected] of cases) {
            expect(analyzeAudio('x.mp3', synthMp3(opts)).startOffsetMs, name).toBeCloseTo(expected, 9);
        }
        expect(predictMp3Offset([])).toBe(0);
        expect(osuStartTrim(readMp3Tags(new DataView(synthMp3({ tag: 'Xing', encDelay: 576 }))))).toBe(576 + MP3_DECODER_DELAY);
    });

    it('compensates a decoder that drops its own delay (Safari-like)', () => {
        // The stripped stream then lacks the 529 samples osu!'s decoder plays.
        expect(analyzeAudio('x.mp3', synthMp3({ tag: 'Xing' }), 0).startOffsetMs).toBeCloseTo((576 / 44100) * 1000, 9);
        expect(analyzeAudio('x.mp3', synthMp3({ tag: null }), 0).startOffsetMs).toBeCloseTo((-529 / 44100) * 1000, 9);
    });

    it('removes the Xing frame even without an ID3 tag', () => {
        const ab = synthMp3({ tag: 'Xing', frames: 2 });
        const r = analyzeAudio('x.mp3', ab.slice(0));
        expect(r.strippedXing).toBe(true);
        expect(r.buffer.byteLength).toBe(ab.byteLength - 417);
        expect(parseFrameHeader(new DataView(r.buffer), 0)).not.toBeNull();
    });

    it('survives garbage input', () => {
        const junk = new Uint8Array(4096);
        for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
        const r = analyzeAudio('junk.mp3', junk.buffer);
        expect(Number.isFinite(r.startOffsetMs)).toBe(true);
        expect(analyzeAudio('empty.mp3', new ArrayBuffer(0)).startOffsetMs).toBe(0);
    });
});
