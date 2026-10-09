import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { OszArchive, decodeName, mimeForFile } from '../../src/beatmap/archive';
import { MAP_BASIC } from './helpers';

function makeZip(files: Record<string, Uint8Array>, level: 0 | 6 = 6): Uint8Array {
    return zipSync(files, { level });
}

describe('OszArchive', () => {
    it('lists files and reads entries lazily', async () => {
        const big = new Uint8Array(700_000).map((_, i) => i % 7); // exercises the async inflate path
        const zip = makeZip({
            'map [Normal].osu': strToU8(MAP_BASIC),
            'Audio.MP3': new Uint8Array([1, 2, 3]),
            'sb/bg.jpg': new Uint8Array([9]),
            'video.mp4': big,
        });
        const a = await OszArchive.open(zip);
        expect(a.files.sort()).toEqual(['Audio.MP3', 'map [Normal].osu', 'sb/bg.jpg', 'video.mp4']);
        expect(a.osuFiles()).toEqual(['map [Normal].osu']);
        expect(await a.readText('map [Normal].osu')).toBe(MAP_BASIC);
        expect(Array.from(await a.readBytes('audio.mp3'))).toEqual([1, 2, 3]);
        const v = await a.readBytes('video.mp4');
        expect(v.length).toBe(big.length);
        expect(v[699_999]).toBe(699_999 % 7);
        const blob = await a.readBlob('sb/bg.jpg');
        expect(blob.type).toBe('image/jpeg');
        expect(blob.size).toBe(1);
    });

    it('accepts Blob and ArrayBuffer input', async () => {
        const zip = makeZip({ 'a.osu': strToU8('x') }, 0);
        const fromBlob = await OszArchive.open(new Blob([zip as Uint8Array<ArrayBuffer>]));
        expect(await fromBlob.readText('a.osu')).toBe('x');
        const fromBuffer = await OszArchive.open(zip.slice().buffer);
        expect(fromBuffer.files).toEqual(['a.osu']);
    });

    it('resolves names case-insensitively, by basename and backslash paths', async () => {
        const a = await OszArchive.open(makeZip({ 'songs/Audio.mp3': new Uint8Array([1]), 'BG.JPG': new Uint8Array([2]) }));
        expect(a.find('songs/audio.mp3')).toBe('songs/Audio.mp3');
        expect(a.find('audio.mp3')).toBe('songs/Audio.mp3');
        expect(a.find('songs\\Audio.mp3')).toBe('songs/Audio.mp3');
        expect(a.find('audio.mp3', { basenameFallback: false })).toBeNull();
        expect(a.find('AUDIO.MP3', { caseInsensitive: false })).toBeNull();
        expect(a.find('nope.ogg')).toBeNull();
        expect(a.findImage('bg.jpg')).toBe('BG.JPG');
        expect(a.findImage('')).toBe('BG.JPG'); // the only image
    });

    it('findAudio tolerates re-encoded files', async () => {
        const a = await OszArchive.open(makeZip({ 'audio.ogg': new Uint8Array([1]), 'x.osu': strToU8('') }));
        expect(a.findAudio('audio.mp3')).toBe('audio.ogg');
        const none = await OszArchive.open(makeZip({ 'bg.jpg': new Uint8Array([1]) }));
        expect(none.findAudio('audio.mp3')).toBeNull();
    });

    it('rejects non-zip data and missing entries clearly', async () => {
        await expect(OszArchive.open(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/valid \.osz/);
        const a = await OszArchive.open(makeZip({ 'a.osu': strToU8('x') }));
        await expect(a.readBytes('missing.mp3')).rejects.toThrow(/not found/);
    });

    it('decodes UTF-8 names stored without the UTF-8 flag, else CP437', () => {
        const utf8 = new TextEncoder().encode('曲.mp3');
        const latin = String.fromCharCode(...utf8);
        expect(decodeName(latin)).toBe('曲.mp3');
        expect(decodeName(String.fromCharCode(0x82, 0x41))).toBe('éA');
        expect(decodeName('plain.osu')).toBe('plain.osu');
        expect(decodeName('已解码.osu')).toBe('已解码.osu');
    });

    it('maps common extensions to MIME types', () => {
        expect(mimeForFile('a.OGG')).toBe('audio/ogg');
        expect(mimeForFile('v.webm')).toBe('video/webm');
        expect(mimeForFile('noext')).toBe('application/octet-stream');
    });
});
