import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicTrack, type StretchFactory } from '../../src/audio/MusicTrack';
import { makeEngine, tick, type ContextStub, type SourceStub } from './stubs';

const STRETCH_PATH = resolve(__dirname, '../../public/vendor/SignalsmithStretch.mjs');

interface WorkletNodeStub {
    options: AudioWorkletNodeOptions;
    startMessages: unknown[][];
    stopMessages: unknown[][];
    uploadTransfers: unknown[] | null;
    connected: number;
    disconnected: number;
    portClosed: boolean;
}

/**
 * Emulates the worklet side of Signalsmith Stretch: registration via
 * addModule, the 'ready' handshake and request/response messaging.
 */
function installWorklet(ctx: ContextStub): { urls: string[]; nodes: WorkletNodeStub[] } {
    const urls: string[] = [];
    const nodes: WorkletNodeStub[] = [];
    let ready = false;
    ctx.audioWorklet = {
        addModule(url: string) {
            urls.push(url);
            ready = true;
            return Promise.resolve();
        },
    };
    (globalThis as Record<string, unknown>).AudioWorkletNode = function (_c: unknown, _key: string, options: AudioWorkletNodeOptions) {
        if (!ready) throw new Error('processor not registered');
        const node: WorkletNodeStub & Record<string, unknown> = {
            options,
            startMessages: [],
            stopMessages: [],
            uploadTransfers: null,
            connected: 0,
            disconnected: 0,
            portClosed: false,
            port: {
                onmessage: null as null | ((e: { data: unknown[] }) => void),
                close() { node.portClosed = true; },
                postMessage(message: unknown[], transfer: unknown[]) {
                    const id = message[0];
                    const method = message[1];
                    const port = node.port as { onmessage: (e: { data: unknown[] }) => void };
                    if (method === 'start') node.startMessages.push(message.slice(2));
                    else if (method === 'stop') node.stopMessages.push([]);
                    if (method === 'addBuffers') node.uploadTransfers = transfer;
                    setTimeout(() => port.onmessage({ data: [id, method === 'addBuffers' ? 180 : null] }), 0);
                },
            },
            connect() { node.connected++; },
            disconnect() { node.disconnected++; },
        };
        setTimeout(() => (node.port as { onmessage: (e: { data: unknown[] }) => void }).onmessage({
            data: ['ready', { start: 5, stop: 1, addBuffers: 1 }],
        }), 0);
        nodes.push(node);
        return node;
    };
    return { urls, nodes };
}

async function loadRealStretch(): Promise<StretchFactory> {
    const url = pathToFileURL(STRETCH_PATH).href;
    const mod = (await import(/* @vite-ignore */ url)) as { default: StretchFactory };
    // Same contract as the production loader: module and worklet share a URL.
    mod.default.moduleUrl = 'https://example.test/app/vendor/SignalsmithStretch.mjs';
    return mod.default;
}

function lastSource(ctx: ContextStub): SourceStub {
    return ctx.sources[ctx.sources.length - 1];
}

async function makeTrack(opts: Parameters<typeof makeEngine>[0] & { filename?: string } = {}) {
    const { engine, ctx } = makeEngine({ currentTime: 100, ...opts });
    const track = await MusicTrack.decode(engine, new ArrayBuffer(8), opts.filename ?? 'song.ogg');
    track.smoothClock = false;
    return { engine, ctx, track };
}

describe('MusicTrack', () => {
    const originalLoader = MusicTrack.loadStretch;
    let diagnostics: string[];
    let offDiag: () => void;

    beforeEach(() => {
        diagnostics = [];
        offDiag = MusicTrack.diagnostics.add(m => diagnostics.push(m));
        (globalThis as Record<string, unknown>).AudioWorkletNode = undefined;
    });
    afterEach(() => {
        offDiag();
        MusicTrack.loadStretch = originalLoader;
        vi.restoreAllMocks();
    });

    it('decodes with the ogg start offset and reports duration', async () => {
        const { track } = await makeTrack({ duration: 120 });
        expect(track.startOffsetMs).toBe(19);
        expect(track.duration).toBe(120000);
        expect(track.isPlaying).toBe(false);
    });

    it('lead-in: negative position, pausable, resumes as a scheduled wait', async () => {
        const { ctx, track } = await makeTrack();
        track.play(2000);
        expect(track.isPlaying).toBe(true);
        expect(track.currentTime).toBeCloseTo(-2000 - track.posoffsetMs, 6);
        expect(lastSource(ctx).started).toEqual({ when: 102, offset: 0 });
        ctx.currentTime += 0.5;
        expect(track.currentTime).toBeCloseTo(-1500 - track.posoffsetMs, 6);
        expect(track.pause()).toBe(true);
        expect(track.isPlaying).toBe(false);
        expect(track.currentTime).toBeCloseTo(-1500 - track.posoffsetMs, 6);
        ctx.currentTime += 10; // paused: the clock must not move
        expect(track.currentTime).toBeCloseTo(-1500 - track.posoffsetMs, 6);
        track.play();
        expect(track.isPlaying).toBe(true);
        expect(lastSource(ctx).started).toEqual({ when: ctx.currentTime + 1.5, offset: 0 });
        expect(track.currentTime).toBeCloseTo(-1500 - track.posoffsetMs, 6);
        track.stop();
    });

    it('play() stops a leaked previous source', async () => {
        const { ctx, track } = await makeTrack();
        track.play();
        const first = lastSource(ctx);
        track.play();
        expect(first.stopped).toBe(true);
        expect(lastSource(ctx)).not.toBe(first);
        expect(track.isPlaying).toBe(true);
        track.stop();
    });

    it('stop() is idempotent and pause() when idle returns false', async () => {
        const { track } = await makeTrack();
        track.play();
        track.stop();
        track.stop();
        expect(track.isPlaying).toBe(false);
        expect(track.pause()).toBe(false);
        expect(track.currentTime).toBeCloseTo(-track.posoffsetMs, 6);
    });

    it('seek keeps playback state and rejects out-of-range targets', async () => {
        const { ctx, track } = await makeTrack();
        track.play();
        expect(track.seek(30000)).toBe(true);
        expect(track.isPlaying).toBe(true);
        expect(track.currentTime).toBeCloseTo(30000, 6);
        expect(lastSource(ctx).started!.offset).toBeCloseTo((30000 + track.posoffsetMs) / 1000, 9);
        track.pause();
        expect(track.seek(60000)).toBe(true);
        expect(track.isPlaying).toBe(false);
        expect(track.currentTime).toBeCloseTo(60000, 6);
        expect(track.seek(99999999)).toBe(false);
        expect(track.seek(Number.NaN)).toBe(false);
    });

    it('advances song time at the playback rate (pitch fallback without worklet)', async () => {
        const { ctx, track } = await makeTrack();
        await track.setRate(1.5, true);
        expect(track.usesTimeStretch).toBe(false);
        expect(track.pitchPreserved).toBe(false);
        expect(diagnostics.length).toBe(1);
        track.play();
        expect(lastSource(ctx).playbackRate.value).toBe(1.5);
        const t0 = track.currentTime;
        ctx.currentTime += 1;
        expect(track.currentTime - t0).toBeCloseTo(1500, 6);
        // NC: tempo-linked pitch through the source rate, no detune tricks
        await track.setRate(1.5, false);
        expect(lastSource(ctx).playbackRate.value).toBe(1.5);
        expect(lastSource(ctx).detune.value).toBe(0);
        await track.setRate(0.75, true);
        expect(lastSource(ctx).playbackRate.value).toBe(0.75);
        track.stop();
    });

    it('setRate while playing preserves song position', async () => {
        const { ctx, track } = await makeTrack();
        track.play();
        ctx.currentTime += 2;
        const before = track.currentTime;
        await track.setRate(1.5, false);
        expect(track.isPlaying).toBe(true);
        // the latency term changes with rate; buffer position must not jump
        expect(track.currentTime + track.posoffsetMs).toBeCloseTo(before + 19, 6);
        track.stop();
    });

    it('output latency joins the offset, scaled to song time by the rate', async () => {
        const { track } = await makeTrack({ outputLatency: 0.02, baseLatency: 0.005 });
        expect(track.posoffsetMs).toBeCloseTo(19 + 25, 6);
        await track.setRate(1.5, true);
        expect(track.posoffsetMs).toBeCloseTo(19 + 25 * 1.5, 6);
    });

    it('positive user offset delays song time', async () => {
        const { track } = await makeTrack();
        track.play();
        const base = track.currentTime;
        track.userOffsetMs = 50;
        expect(track.currentTime).toBeCloseTo(base - 50, 6);
        track.userOffsetMs = Number.NaN; // corrupt setting must not poison the clock
        expect(track.currentTime).toBeCloseTo(base, 6);
        track.stop();
    });

    it('falls back to the last good clock value instead of NaN, reporting once', async () => {
        const { ctx, track } = await makeTrack();
        track.play(1000);
        const good = track.currentTime;
        expect(Number.isFinite(good)).toBe(true);
        ctx.currentTime = Number.NaN;
        expect(track.currentTime).toBe(good);
        expect(track.currentTime).toBe(good);
        expect(diagnostics.length).toBe(1);
        expect(diagnostics[0]).toContain('posoffset');
        ctx.currentTime = 100;
        track.stop();
    });

    it('smooths the coarse clock: monotonic for small jitter, snaps on big jumps', async () => {
        const { ctx, track } = await makeTrack();
        track.smoothClock = true;
        let perf = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => perf);
        track.play();
        const a = track.currentTime;
        // 10 ms of wall time, context clock still on the previous quantum
        perf += 10;
        const b = track.currentTime;
        expect(b).toBeGreaterThan(a);
        expect(b - a).toBeLessThanOrEqual(10);
        // context quantum lands slightly behind the prediction: no going back
        ctx.currentTime += 0.008;
        perf += 0;
        const c = track.currentTime;
        expect(c).toBeGreaterThanOrEqual(b);
        // big discontinuity: snap to the raw clock
        ctx.currentTime += 5;
        perf += 16;
        const d = track.currentTime;
        expect(d).toBeCloseTo((ctx.currentTime - 100) * 1000 - track.posoffsetMs, 6);
        track.stop();
    });

    it('loops and emits ended on natural end', async () => {
        const { ctx, track } = await makeTrack({ duration: 10 });
        let ended = 0;
        track.ended.add(() => ended++);
        track.play();
        lastSource(ctx).onended!();
        expect(ended).toBe(1);
        expect(track.isPlaying).toBe(false);
        track.loop = true;
        track.play();
        const src = lastSource(ctx);
        src.onended!();
        expect(ended).toBe(1);
        expect(track.isPlaying).toBe(true);
        expect(lastSource(ctx)).not.toBe(src);
        // a source we stopped ourselves must not count as a natural end
        const playing = lastSource(ctx);
        track.pause();
        playing.onended?.();
        expect(ended).toBe(1);
        track.dispose();
    });

    it('playFrom fades in from the requested song time', async () => {
        const { ctx, track } = await makeTrack();
        track.volume = 0.8;
        track.playFrom(42000, 300);
        expect(track.isPlaying).toBe(true);
        expect(track.currentTime).toBeCloseTo(42000, 6);
        expect(lastSource(ctx).started!.offset).toBeCloseTo((42000 + track.posoffsetMs) / 1000, 9);
        track.stop();
    });

    it('uploads to the stretch worklet by transfer and survives pause/seek', async () => {
        const { ctx, track } = await makeTrack({ numberOfChannels: 2 });
        const worklet = installWorklet(ctx);
        MusicTrack.loadStretch = loadRealStretch;
        await track.setRate(1.5, true);
        expect(track.usesTimeStretch).toBe(true);
        expect(track.pitchPreserved).toBe(true);
        const node = worklet.nodes[0];
        expect(node.options.numberOfInputs).toBe(1);
        expect((node.options.processorOptions as { internalBufferMode: boolean }).internalBufferMode).toBe(true);
        expect(node.uploadTransfers!.length).toBe(2);
        expect(worklet.urls[0]).toBe('https://example.test/app/vendor/SignalsmithStretch.mjs');

        track.play();
        expect(node.startMessages.length).toBe(1);
        expect(node.startMessages[0][2]).toBeUndefined();
        expect(node.startMessages[0][3]).toBe(1.5);
        track.pause();
        track.play();
        expect(node.startMessages.length).toBe(2);
        track.seek(30000 - track.posoffsetMs);
        expect(node.startMessages[2][1]).toBeCloseTo(30, 9);
        expect(node.startMessages[2][2]).toBeUndefined();
        track.dispose();
        expect(node.portClosed).toBe(true);
        expect(track.usesTimeStretch).toBe(false);
    });

    it('stretch path finishes naturally and releases the DSP output', async () => {
        const { ctx, track } = await makeTrack({ duration: 0.05 });
        installWorklet(ctx);
        MusicTrack.loadStretch = loadRealStretch;
        await track.setRate(1.5, true);
        let ended = 0;
        track.ended.add(() => ended++);
        track.play();
        await tick(100);
        expect(track.isPlaying).toBe(false);
        expect(ended).toBe(1);
        track.dispose();
    });

    it('falls back to pitch shifting when the worklet module fails to load', async () => {
        const { ctx, track } = await makeTrack();
        installWorklet(ctx);
        MusicTrack.loadStretch = () => Promise.reject(new Error('blocked'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await track.setRate(1.5, true);
        expect(track.usesTimeStretch).toBe(false);
        expect(track.pitchPreserved).toBe(false);
        expect(diagnostics.length).toBe(1);
        track.play();
        expect(lastSource(ctx).playbackRate.value).toBe(1.5);
        track.dispose();
    });

    it('retries decoding from the next frame sync', async () => {
        const { engine, ctx } = makeEngine();
        // Junk prefix: fail unless the data starts at a frame sync.
        ctx.decodeOk = data => {
            const b = new Uint8Array(data);
            return b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
        };
        const bytes = new Uint8Array([1, 2, 3, 0xff, 0xfb, 0x90, 0x00, 0, 0, 0]);
        const track = await MusicTrack.decode(engine, bytes.buffer, 'x.ogg');
        expect(track.duration).toBeGreaterThan(0);
        ctx.decodeOk = () => false;
        await expect(MusicTrack.decode(engine, new Uint8Array([1, 2, 3]).buffer, 'x.ogg')).rejects.toThrow();
    });
});
