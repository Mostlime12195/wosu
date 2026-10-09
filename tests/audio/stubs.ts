/**
 * Minimal Web Audio stand-ins for node tests. Only what the audio modules
 * touch is implemented; values are recorded so tests can assert on them.
 */
import { AudioEngine } from '../../src/audio/AudioEngine';

export class ParamStub {
    value: number;
    constructor(v = 0) { this.value = v; }
    setTargetAtTime(v: number): this { this.value = v; return this; }
    setValueAtTime(v: number): this { this.value = v; return this; }
    linearRampToValueAtTime(v: number): this { this.value = v; return this; }
    exponentialRampToValueAtTime(v: number): this { this.value = v; return this; }
    cancelScheduledValues(): this { return this; }
}

export class NodeStub {
    connections: unknown[] = [];
    disconnected = 0;
    connect(target: unknown): unknown { this.connections.push(target); return target; }
    disconnect(): void { this.disconnected++; this.connections = []; }
}

export class SourceStub extends NodeStub {
    playbackRate = new ParamStub(1);
    detune = new ParamStub(0);
    buffer: unknown = null;
    loop = false;
    onended: (() => void) | null = null;
    started: { when?: number; offset?: number } | null = null;
    stopped = false;
    start(when?: number, offset?: number): void { this.started = { when, offset }; }
    stop(): void { this.stopped = true; }
}

export interface BufferStub {
    duration: number;
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    tag?: string;
    getChannelData(c: number): Float32Array;
}

export interface ContextStubOptions {
    currentTime?: number;
    outputLatency?: number;
    baseLatency?: number;
    duration?: number;
    numberOfChannels?: number;
    state?: string;
    /** Return false to make decodeAudioData fail for this input. */
    decodeOk?: (data: ArrayBuffer) => boolean;
}

export function makeContext(opts: ContextStubOptions = {}) {
    const sources: SourceStub[] = [];
    const ctx = {
        state: opts.state ?? 'running',
        currentTime: opts.currentTime ?? 0,
        sampleRate: 48000,
        outputLatency: opts.outputLatency,
        baseLatency: opts.baseLatency,
        destination: new NodeStub(),
        resumed: 0,
        duration: opts.duration ?? 180,
        numberOfChannels: opts.numberOfChannels ?? 1,
        audioWorklet: undefined as unknown,
        sources,
        decodeOk: opts.decodeOk ?? (() => true),
        resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); },
        close() { return Promise.resolve(); },
        createGain() { const n = new NodeStub() as NodeStub & { gain: ParamStub }; n.gain = new ParamStub(1); return n; },
        createAnalyser() {
            const n = new NodeStub() as NodeStub & Record<string, unknown>;
            n.fftSize = 2048;
            n.frequencyBinCount = 1024;
            n.smoothingTimeConstant = 0.8;
            n.data = new Uint8Array(1024);
            n.getByteFrequencyData = (out: Uint8Array) => out.set((n.data as Uint8Array).subarray(0, out.length));
            return n;
        },
        createStereoPanner() { const n = new NodeStub() as NodeStub & { pan: ParamStub }; n.pan = new ParamStub(0); return n; },
        createBufferSource() { const s = new SourceStub(); sources.push(s); return s; },
        createBuffer(channels: number, length: number, sampleRate: number): BufferStub {
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { duration: length / sampleRate, numberOfChannels: channels, length, sampleRate, getChannelData: c => data[c] };
        },
        createMediaElementSource() { return new NodeStub(); },
        decodeAudioData(data: ArrayBuffer, ok: (b: BufferStub) => void, err: (e: Error) => void) {
            const okDecode = this.decodeOk(data);
            const channels = this.numberOfChannels;
            const duration = this.duration;
            setTimeout(() => {
                if (!okDecode) { err(new Error('decode failed')); return; }
                const chans = Array.from({ length: channels }, () => new Float32Array(8));
                ok({ duration, numberOfChannels: channels, length: 8, sampleRate: 48000, tag: String(data.byteLength), getChannelData: c => chans[c] });
            }, 0);
        },
    };
    return ctx;
}

export type ContextStub = ReturnType<typeof makeContext>;

export function makeEngine(opts: ContextStubOptions = {}): { engine: AudioEngine; ctx: ContextStub } {
    const ctx = makeContext(opts);
    const engine = new AudioEngine({ context: ctx as unknown as AudioContext });
    return { engine, ctx };
}

export const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));
