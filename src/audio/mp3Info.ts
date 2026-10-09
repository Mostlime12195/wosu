/**
 * Minimal MP3 header inspection, replacing the vendored mp3-parser.
 *
 * Why this exists: browsers disagree about MP3 encoder delay. Decoders
 * that understand the Xing/LAME header trim the encoder delay (gapless),
 * others play it as leading silence, so the same song started at the same
 * time is heard ~25-50 ms apart. We remove the Xing frame so every decoder
 * behaves the same (no trimming), then compensate with a start offset
 * predicted from the LAME header. The offset values below are the ones the
 * game has always used (tuned empirically); keep them in sync with
 * `tests/audio/mp3Info.test.ts`.
 */

export interface FrameHeader {
    offset: number;
    /** 1, 2 or 2.5 */
    version: number;
    /** 1, 2 or 3 */
    layer: number;
    /** kbit/s */
    bitrateKbps: number;
    sampleRate: number;
    padding: boolean;
    /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono */
    channelMode: number;
    samplesPerFrame: number;
    frameLength: number;
}

export type Mp3Tag =
    | { type: 'ID3v2'; offset: number; byteLength: number }
    | {
        type: 'Xing';
        offset: number;
        byteLength: number;
        identifier: 'Xing' | 'Info';
        header: FrameHeader;
        /** LAME encoder delay in samples, -1 when absent/implausible. */
        encDelay: number;
        encPadding: number;
        lameVersion: string;
    }
    | { type: 'frame'; offset: number; byteLength: number; header: FrameHeader; sampleLength: number };

const BITRATES: Record<string, readonly number[]> = {
    // [version-class][layer] -> kbps by index (index 0 = free, 15 = bad)
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<number, readonly number[]> = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    2.5: [11025, 12000, 8000],
};

/** Decode the 4-byte frame header at `offset`, or null if it isn't one. */
export function parseFrameHeader(view: DataView, offset: number): FrameHeader | null {
    if (view.byteLength - offset <= 4) return null;
    if (view.getUint8(offset) !== 0xff) return null;
    const b1 = view.getUint8(offset + 1);
    if (b1 < 0xe0) return null;
    const versionBits = (b1 >> 3) & 3;
    const layerBits = (b1 >> 1) & 3;
    if (versionBits === 1 || layerBits === 0) return null; // reserved
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits; // 3 -> I, 2 -> II, 1 -> III

    const b2 = view.getUint8(offset + 2);
    const bitrateIndex = b2 >> 4;
    if (bitrateIndex === 15) return null;
    const table = BITRATES[`${version === 1 ? 1 : 2}-${layer}`];
    const bitrateKbps = table[bitrateIndex];
    const srIndex = (b2 >> 2) & 3;
    if (srIndex === 3) return null;
    const sampleRate = SAMPLE_RATES[version][srIndex];
    const padding = ((b2 >> 1) & 1) === 1;
    const channelMode = (view.getUint8(offset + 3) >> 6) & 3;

    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    // Same arithmetic as the replaced library (byte rate based), so section
    // lengths match it exactly.
    const paddingSize = padding ? (layer === 1 ? 4 : 1) : 0;
    const frameLength = Math.floor((samplesPerFrame * ((bitrateKbps * 1000) / 8)) / sampleRate + paddingSize);

    return { offset, version, layer, bitrateKbps, sampleRate, padding, channelMode, samplesPerFrame, frameLength };
}

/** Offset of the Xing/Info identifier relative to the frame start (4-byte header + side info). */
function xingOffset(h: FrameHeader): number {
    const mono = h.channelMode === 3;
    if (h.version === 1) return mono ? 21 : 36;
    return mono ? 13 : 21;
}

function isSeq(view: DataView, offset: number, seq: string): boolean {
    if (offset < 0 || offset + seq.length > view.byteLength) return false;
    for (let i = 0; i < seq.length; i++) {
        if (view.getUint8(offset + i) !== seq.charCodeAt(i)) return false;
    }
    return true;
}

function readId3v2(view: DataView, offset: number): Mp3Tag | null {
    if (view.byteLength - offset < 10) return null;
    if (!isSeq(view, offset, 'ID3')) return null;
    if (view.getUint8(offset + 3) === 0xff || view.getUint8(offset + 4) === 0xff) return null;
    let size = 0;
    for (let i = 0; i < 4; i++) {
        const b = view.getUint8(offset + 6 + i);
        if (b >= 0x80) return null; // not syncsafe
        size = (size << 7) | b;
    }
    const hasFooter = (view.getUint8(offset + 5) & 0x10) !== 0;
    return { type: 'ID3v2', offset, byteLength: 10 + size + (hasFooter ? 10 : 0) };
}

function readXing(view: DataView, offset: number): Mp3Tag | null {
    const header = parseFrameHeader(view, offset);
    if (!header) return null;
    const idAt = offset + xingOffset(header);
    if (view.byteLength < idAt + 4) return null;
    const identifier = isSeq(view, idAt, 'Xing') ? 'Xing' : isSeq(view, idAt, 'Info') ? 'Info' : null;
    if (!identifier) return null;

    let pos = idAt + 4;
    const inRange = (n: number): boolean => pos + n <= view.byteLength;
    let encDelay = -1, encPadding = -1, lameVersion = '';
    if (inRange(4)) {
        const flags = view.getUint32(pos);
        pos += 4;
        if (flags & 1) pos += 4; // frames
        if (flags & 2) pos += 4; // bytes
        if (flags & 4) pos += 100; // TOC
        if (flags & 8) pos += 4; // quality
        // LAME extension: 9-char encoder version, then delay/padding 21 bytes in.
        if (inRange(24)) {
            for (let i = 0; i < 9; i++) lameVersion += String.fromCharCode(view.getUint8(pos + i));
            const b0 = view.getUint8(pos + 21);
            const b1 = view.getUint8(pos + 22);
            const b2 = view.getUint8(pos + 23);
            encDelay = (b0 << 4) | (b1 >> 4);
            encPadding = ((b1 & 15) << 8) | b2;
            if (encDelay > 3000) encDelay = -1;
            if (encPadding > 3000) encPadding = -1;
        }
    }
    return { type: 'Xing', offset, byteLength: header.frameLength, identifier, header, encDelay, encPadding, lameVersion };
}

function readFrame(view: DataView, offset: number): Mp3Tag | null {
    const header = parseFrameHeader(view, offset);
    if (!header) return null;
    // A frame carrying a Xing/Info tag is metadata, not audio.
    const idAt = offset + xingOffset(header);
    if (isSeq(view, idAt, 'Xing') || isSeq(view, idAt, 'Info')) return null;
    return { type: 'frame', offset, byteLength: header.frameLength, header, sampleLength: header.samplesPerFrame };
}

/**
 * Scan from the start of the file: ID3v2 tags, the Xing/Info frame, then
 * stop at the first audio frame. Unrecognized bytes are skipped one at a
 * time (same strategy as the replaced library).
 */
export function readMp3Tags(view: DataView): Mp3Tag[] {
    const tags: Mp3Tag[] = [];
    const readers = [readId3v2, readXing, readFrame];
    let n = 0;
    outer: while (n < view.byteLength) {
        let matched = false;
        for (const read of readers) {
            const tag = read(view, n);
            if (!tag) continue;
            tags.push(tag);
            if (tag.type === 'frame') break outer;
            n += Math.max(1, tag.byteLength);
            matched = true;
            break;
        }
        if (!matched) n++;
    }
    return tags;
}

const DEFAULT_MP3_OFFSET = 22;
const OGG_OFFSET = 19;

/** Predicted decoder start offset (ms) from the scanned tags. */
export function predictMp3Offset(tags: readonly Mp3Tag[]): number {
    if (!tags.length) return DEFAULT_MP3_OFFSET;
    const last = tags[tags.length - 1];
    if (last.type !== 'frame' || last.sampleLength !== 1152) return DEFAULT_MP3_OFFSET;
    let xing: Extract<Mp3Tag, { type: 'Xing' }> | null = null;
    for (const t of tags) if (t.type === 'Xing') xing = t;
    if (!xing) return DEFAULT_MP3_OFFSET;
    if (xing.encDelay !== 576) return DEFAULT_MP3_OFFSET;
    const sr = xing.header.sampleRate;
    if (sr === 32000) return 89 - 1152000 / sr;
    if (sr === 44100 || sr === 48000) return 68 - 1152000 / sr;
    return DEFAULT_MP3_OFFSET;
}

export interface AudioAnalysis {
    /** ms to subtract from the decoded clock to get song time. */
    startOffsetMs: number;
    /** Buffer to decode (the input, or a copy without the Xing frame). */
    buffer: ArrayBuffer;
    /** True when the Xing frame was removed. */
    strippedXing: boolean;
}

/**
 * Inspect an audio file before decoding. Non-MP3 files (by extension, like
 * the original code) get the fixed Ogg offset.
 */
export function analyzeAudio(filename: string, buffer: ArrayBuffer): AudioAnalysis {
    const name = filename.toLowerCase();
    if (name.slice(-3) !== 'mp3') return { startOffsetMs: OGG_OFFSET, buffer, strippedXing: false };

    let tags: Mp3Tag[];
    try {
        tags = readMp3Tags(new DataView(buffer));
    } catch {
        return { startOffsetMs: DEFAULT_MP3_OFFSET, buffer, strippedXing: false };
    }
    const startOffsetMs = predictMp3Offset(tags);

    const xi = tags.findIndex(t => t.type === 'Xing');
    const hasFrameAfter = xi !== -1 && tags.slice(xi + 1).some(t => t.type === 'frame');
    if (!hasFrameAfter) return { startOffsetMs, buffer, strippedXing: false };

    const xing = tags[xi];
    const cutStart = xing.offset;
    const cutEnd = Math.min(buffer.byteLength, xing.offset + xing.byteLength);
    const out = new Uint8Array(buffer.byteLength - (cutEnd - cutStart));
    out.set(new Uint8Array(buffer, 0, cutStart), 0);
    out.set(new Uint8Array(buffer, cutEnd), cutStart);
    return { startOffsetMs, buffer: out.buffer, strippedXing: true };
}
