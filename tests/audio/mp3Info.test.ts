import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { analyzeAudio, parseFrameHeader, predictMp3Offset, readMp3Tags } from '../../src/audio/mp3Info';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/map1/audio.mp3');

function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * The original pipeline: the old site's vendored mp3-parser (kept as a test
 * oracle in tests/fixtures/legacy) + preprocAudio/offset_predict_mp3 from
 * its osu-audio.js, replicated verbatim (offset part only).
 */
function oldStartOffset(filename: string, buffer: ArrayBuffer): number {
    if (filename.substr(-3) !== 'mp3') return 19;
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(resolve(ROOT, 'tests/fixtures/legacy/mp3parse.min.js'), 'utf8'), sandbox);
    const mp3Parser = sandbox.mp3Parser as { readTags(v: DataView): any[] };
    const tags = mp3Parser.readTags(new DataView(buffer));
    const defaultOffset = 22;
    if (!tags || !tags.length) return defaultOffset;
    const frametag = tags[tags.length - 1];
    if (frametag._section.sampleLength != 1152) return defaultOffset;
    let vbr: any = null;
    for (let i = 0; i < tags.length; ++i) if (tags[i]._section.type == 'Xing') vbr = tags[i];
    if (!vbr) return defaultOffset;
    if (!vbr.identifier) return defaultOffset;
    if (vbr.vbrinfo.ENC_DELAY != 576) return defaultOffset;
    const sampleRate = vbr.header.samplingRate;
    if (sampleRate == 32000) return 89 - 1152000 / sampleRate;
    if (sampleRate == 44100) return 68 - 1152000 / sampleRate;
    if (sampleRate == 48000) return 68 - 1152000 / sampleRate;
    return defaultOffset;
}

interface SynthOptions {
    id3?: boolean;
    tag?: 'Xing' | 'Info' | null;
    encDelay?: number;
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
        'LAME3.100'.split('').forEach((c, i) => (f[lame + i] = c.charCodeAt(0)));
        const delay = o.encDelay ?? 576;
        const padding = 1000;
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
    it('matches the original offset prediction on the fixture', () => {
        const ab = toArrayBuffer(readFileSync(FIXTURE));
        const expected = oldStartOffset('audio.mp3', ab);
        const result = analyzeAudio('audio.mp3', ab);
        expect(result.startOffsetMs).toBeCloseTo(expected, 9);
        // The fixture carries a LAME "Info" header at 44.1 kHz: 68 - 1152000/44100.
        expect(result.startOffsetMs).toBeCloseTo(68 - 1152000 / 44100, 9);
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

    it('uses the fixed ogg offset for non-mp3 names', () => {
        const ab = new ArrayBuffer(16);
        const r = analyzeAudio('song.ogg', ab);
        expect(r.startOffsetMs).toBe(19);
        expect(r.buffer).toBe(ab);
        expect(oldStartOffset('song.ogg', ab)).toBe(19);
    });

    it('agrees with the original on synthetic headers', () => {
        const cases: [string, SynthOptions][] = [
            ['xing with id3', { id3: true, tag: 'Xing' }],
            ['xing without id3', { tag: 'Xing' }],
            ['info tag', { id3: true, tag: 'Info' }],
            ['bad enc delay', { id3: true, tag: 'Xing', encDelay: 1105 }],
            ['no tag', { id3: true, tag: null }],
            ['48k', { tag: 'Xing', srIndex: 1 }],
            ['32k', { tag: 'Xing', srIndex: 2 }],
        ];
        for (const [name, opts] of cases) {
            const ab = synthMp3(opts);
            const mine = analyzeAudio('x.mp3', ab.slice(0)).startOffsetMs;
            const old = oldStartOffset('x.mp3', ab.slice(0));
            expect(mine, name).toBeCloseTo(old, 9);
        }
    });

    it('predicts the documented offsets', () => {
        expect(analyzeAudio('x.mp3', synthMp3({ tag: null })).startOffsetMs).toBe(22);
        expect(analyzeAudio('x.mp3', synthMp3({ tag: 'Xing', encDelay: 100 })).startOffsetMs).toBe(22);
        expect(analyzeAudio('x.mp3', synthMp3({ tag: 'Xing', srIndex: 1 })).startOffsetMs).toBeCloseTo(68 - 24, 9);
        expect(analyzeAudio('x.mp3', synthMp3({ tag: 'Xing', srIndex: 2 })).startOffsetMs).toBeCloseTo(89 - 36, 9);
        expect(predictMp3Offset([])).toBe(22);
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
        expect(analyzeAudio('empty.mp3', new ArrayBuffer(0)).startOffsetMs).toBe(22);
    });
});
