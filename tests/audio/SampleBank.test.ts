import { describe, expect, it } from 'vitest';
import { SampleBank, sampleManifest, sampleSetName } from '../../src/audio/SampleBank';
import { makeEngine, type SourceStub } from './stubs';

/** Fake file server: payload length encodes the extension (ogg=1, wav=2). */
function fetcherFor(files: Set<string>) {
    const requested: string[] = [];
    const fetcher = async (url: string) => {
        requested.push(url);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const ok = files.has(name);
        return { ok, arrayBuffer: async () => new ArrayBuffer(name.endsWith('.ogg') ? 1 : 2) };
    };
    return { fetcher, requested };
}

function allFiles(): Set<string> {
    const files = new Set<string>();
    for (const s of sampleManifest()) for (const e of s.extensions) files.add(`${s.name}.${e}`);
    return files;
}

function bufferTag(src: SourceStub): string {
    return (src.buffer as { tag: string }).tag;
}

describe('SampleBank', () => {
    it('manifest matches the shipped formats', () => {
        const m = new Map(sampleManifest().map(s => [s.name, s.extensions]));
        expect(m.get('normal-hitnormal')).toEqual(['ogg', 'wav']);
        expect(m.get('drum-spinnerspin')).toEqual(['wav']);
        expect(m.get('combobreak')).toEqual(['ogg', 'wav']);
        expect(sampleSetName(1)).toBe('normal');
        expect(sampleSetName(2)).toBe('soft');
        expect(sampleSetName(3)).toBe('drum');
        expect(sampleSetName(0)).toBe('normal');
    });

    it('loads ogg when it decodes', async () => {
        const { engine } = makeEngine();
        const { fetcher } = fetcherFor(allFiles());
        const bank = new SampleBank(engine, { fetcher, preferWav: false });
        await bank.load('/h/');
        expect(bank.loaded).toBe(sampleManifest().length);
        const { ctx } = { ctx: engine.context as unknown as { sources: SourceStub[] } };
        bank.play('normal-hitnormal', 0.5);
        expect(bufferTag(ctx.sources[ctx.sources.length - 1])).toBe('1'); // ogg payload
    });

    it('falls back to wav when ogg decoding fails, and prefers wav afterwards', async () => {
        const { engine, ctx } = makeEngine();
        ctx.decodeOk = data => data.byteLength !== 1; // no Vorbis support
        const { fetcher, requested } = fetcherFor(allFiles());
        const bank = new SampleBank(engine, { fetcher, preferWav: false });
        await bank.load('/h/');
        expect(bank.loaded).toBe(sampleManifest().length);
        bank.play('soft-hitclap', 1);
        expect(bufferTag(ctx.sources[ctx.sources.length - 1])).toBe('2');
        expect(requested.some(u => u.endsWith('.wav'))).toBe(true);
    });

    it('skips missing files without throwing', async () => {
        const { engine } = makeEngine();
        const files = new Set(['normal-hitnormal.ogg', 'combobreak.wav']);
        const { fetcher } = fetcherFor(files);
        const bank = new SampleBank(engine, { fetcher, preferWav: false });
        await bank.load('/h/');
        expect(bank.has('normal-hitnormal')).toBe(true);
        expect(bank.has('combobreak')).toBe(true);
        expect(bank.has('drum-hitclap')).toBe(false);
        expect(() => bank.play('drum-hitclap', 1)).not.toThrow();
    });

    it('layers hit sounds like osu!: normal from the normal set, additions from the addition set', async () => {
        const { engine, ctx } = makeEngine();
        const { fetcher } = fetcherFor(allFiles());
        const bank = new SampleBank(engine, { fetcher, preferWav: false });
        await bank.load('/h/');
        const played: string[] = [];
        const orig = bank.play.bind(bank);
        bank.play = (name, volume, opts) => { played.push(name); orig(name, volume, opts); };
        bank.playHit(2 | 8, 2, 3, 0.7, 0.2);
        expect(played).toEqual(['soft-hitnormal', 'drum-hitwhistle', 'drum-hitclap']);
        // hitsounds are never rate-shifted
        expect(ctx.sources.slice(-3).every(s => s.playbackRate.value === 1)).toBe(true);
        played.length = 0;
        bank.playTick(1, 0.5);
        expect(played).toEqual(['normal-slidertick']);
    });

    it('silent volume is a no-op; loops can be stopped twice', async () => {
        const { engine, ctx } = makeEngine();
        const { fetcher } = fetcherFor(allFiles());
        const bank = new SampleBank(engine, { fetcher, preferWav: false });
        await bank.load('/h/');
        const before = ctx.sources.length;
        bank.play('normal-hitnormal', 0);
        expect(ctx.sources.length).toBe(before);
        const loop = bank.startLoop('normal-sliderslide', 0.4);
        const src = ctx.sources[ctx.sources.length - 1];
        expect(src.loop).toBe(true);
        loop.setVolume(0.2);
        loop.stop();
        loop.stop();
        expect(src.stopped).toBe(true);
        const missing = bank.startLoop('combobreak' as never, 1);
        expect(() => missing.stop()).not.toThrow();
    });
});
