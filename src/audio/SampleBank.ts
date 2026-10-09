/**
 * Hitsound samples decoded into AudioBuffers and fired as one-shot
 * BufferSources into the effects bus.
 *
 * Note: osu! never pitch-shifts hitsounds for rate mods (DT/NC/HT/DC);
 * the `rate` option exists for special effects only.
 */
import type { AudioEngine } from './AudioEngine';
import { resolveAssetUrl, setParam } from './base';

export type SampleSetName = 'normal' | 'soft' | 'drum';
export type HitsoundName =
    | 'hitnormal' | 'hitwhistle' | 'hitfinish' | 'hitclap'
    | 'slidertick' | 'sliderslide' | 'sliderwhistle'
    | 'spinnerspin' | 'spinnerbonus';
export type SampleName = `${SampleSetName}-${HitsoundName}` | 'combobreak';

const SETS: readonly SampleSetName[] = ['normal', 'soft', 'drum'];
const OGG_AND_WAV: readonly HitsoundName[] = [
    'hitnormal', 'hitwhistle', 'hitfinish', 'hitclap', 'slidertick', 'sliderslide', 'sliderwhistle',
];
/** Only shipped as .wav in the default skin (public/assets/skins/default). */
const WAV_ONLY: readonly HitsoundName[] = ['spinnerspin', 'spinnerbonus'];

interface SampleSpec {
    name: SampleName;
    extensions: readonly ('ogg' | 'wav')[];
}

/** Every sample the bank tries to load, with the formats that exist on disk. */
export function sampleManifest(): SampleSpec[] {
    const out: SampleSpec[] = [];
    for (const set of SETS) {
        for (const h of OGG_AND_WAV) out.push({ name: `${set}-${h}`, extensions: ['ogg', 'wav'] });
        for (const h of WAV_ONLY) out.push({ name: `${set}-${h}`, extensions: ['wav'] });
    }
    out.push({ name: 'combobreak', extensions: ['ogg', 'wav'] });
    return out;
}

/** Map a beatmap sample set index (1 normal, 2 soft, 3 drum) to a name. */
export function sampleSetName(set: number): SampleSetName {
    return set === 2 ? 'soft' : set === 3 ? 'drum' : 'normal';
}

export interface PlayOptions {
    /** -1 (left) .. 1 (right) */
    pan?: number;
    rate?: number;
}

export interface LoopHandle {
    setVolume(volume: number): void;
    stop(): void;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

function canPlayOgg(): boolean {
    try {
        const g = globalThis as unknown as { Audio?: new () => HTMLAudioElement };
        if (!g.Audio) return true; // non-browser: just try
        return new g.Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '';
    } catch {
        return true;
    }
}

export class SampleBank {
    private readonly engine: AudioEngine;
    private readonly fetcher: Fetcher;
    private readonly buffers = new Map<SampleName, AudioBuffer>();
    private loading: Promise<void> | null = null;
    private preferWav: boolean;

    constructor(engine: AudioEngine, options: { fetcher?: Fetcher; preferWav?: boolean } = {}) {
        this.engine = engine;
        this.fetcher = options.fetcher ?? ((url: string) => fetch(url));
        // Old Safari can't decode Vorbis; skip the doomed .ogg downloads.
        this.preferWav = options.preferWav ?? !canPlayOgg();
    }

    get loaded(): number {
        return this.buffers.size;
    }

    has(name: SampleName): boolean {
        return this.buffers.has(name);
    }

    /** Load every sample (missing ones are skipped). Idempotent. */
    load(baseUrl: string = resolveAssetUrl('assets/skins/default/')): Promise<void> {
        if (!this.loading) {
            const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
            this.loading = Promise.all(sampleManifest().map(spec => this.loadOne(base, spec))).then(() => undefined);
        }
        return this.loading;
    }

    play(name: SampleName, volume: number, opts: PlayOptions = {}): void {
        const buffer = this.buffers.get(name);
        if (buffer) this.playBuffer(buffer, volume, opts);
    }

    /** Play any decoded buffer (e.g. a beatmap's own hitsound) like a bank sample. */
    playBuffer(buffer: AudioBuffer, volume: number, opts: PlayOptions = {}): void {
        if (!(volume > 0)) return;
        const ctx = this.engine.context;
        try {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            if (opts.rate && opts.rate !== 1) src.playbackRate.value = opts.rate;
            const gain = ctx.createGain();
            gain.gain.value = Math.min(1, volume);
            src.connect(gain);
            const out = this.panned(gain, opts.pan);
            out.connect(this.engine.effectsBus);
            src.onended = () => {
                try { out.disconnect(); } catch { /* ignore */ }
                if (out !== gain) try { gain.disconnect(); } catch { /* ignore */ }
            };
            src.start();
        } catch (e) {
            console.warn('sample playback failed', e);
        }
    }

    /**
     * osu! hit sound layering: the normal sample always plays (from the
     * normal set); whistle/finish/clap come from the addition set.
     */
    playHit(bitmask: number, normalSet: number, additionSet: number, volume: number, pan = 0): void {
        const normal = sampleSetName(normalSet);
        const addition = sampleSetName(additionSet);
        const opts = { pan };
        this.play(`${normal}-hitnormal`, volume, opts);
        if (bitmask & 2) this.play(`${addition}-hitwhistle`, volume, opts);
        if (bitmask & 4) this.play(`${addition}-hitfinish`, volume, opts);
        if (bitmask & 8) this.play(`${addition}-hitclap`, volume, opts);
    }

    playTick(set: number, volume: number, pan = 0): void {
        this.play(`${sampleSetName(set)}-slidertick`, volume, { pan });
    }

    /** Looping sample (slider slide, spinner spin); stop() ends it. */
    startLoop(name: SampleName, volume: number, opts: PlayOptions = {}): LoopHandle {
        return this.startLoopBuffer(this.buffers.get(name) ?? null, volume, opts);
    }

    /** Loop any decoded buffer; null gives a silent handle. */
    startLoopBuffer(buffer: AudioBuffer | null, volume: number, opts: PlayOptions = {}): LoopHandle {
        const ctx = this.engine.context;
        if (!buffer) return { setVolume() { /* no sample */ }, stop() { /* no sample */ } };
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        if (opts.rate && opts.rate !== 1) src.playbackRate.value = opts.rate;
        const gain = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, volume));
        src.connect(gain);
        const out = this.panned(gain, opts.pan);
        out.connect(this.engine.effectsBus);
        src.start();
        let stopped = false;
        return {
            setVolume: (v: number) => {
                if (!stopped) setParam(gain.gain, Math.max(0, Math.min(1, v)), ctx.currentTime, 0.01);
            },
            stop: () => {
                if (stopped) return;
                stopped = true;
                try { src.stop(); } catch { /* ignore */ }
                try { out.disconnect(); } catch { /* ignore */ }
                if (out !== gain) try { gain.disconnect(); } catch { /* ignore */ }
            },
        };
    }

    private panned(node: AudioNode, pan: number | undefined): AudioNode {
        if (!pan) return node;
        const ctx = this.engine.context;
        if (typeof ctx.createStereoPanner !== 'function') return node;
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        node.connect(p);
        return p;
    }

    private async loadOne(base: string, spec: SampleSpec): Promise<void> {
        const exts = this.preferWav && spec.extensions.includes('wav')
            ? (['wav', ...spec.extensions.filter(e => e !== 'wav')] as const)
            : spec.extensions;
        for (const ext of exts) {
            try {
                const res = await this.fetcher(`${base}${spec.name}.${ext}`);
                if (!res.ok) continue;
                const data = await res.arrayBuffer();
                const buffer = await decode(this.engine.context, data);
                this.buffers.set(spec.name, buffer);
                return;
            } catch {
                // Decode failure on .ogg means this browser lacks Vorbis:
                // prefer .wav for the remaining samples.
                if (ext === 'ogg') this.preferWav = true;
            }
        }
    }
}

function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
        let settled = false;
        const ok = (b: AudioBuffer): void => { if (!settled) { settled = true; resolve(b); } };
        const fail = (e?: unknown): void => { if (!settled) { settled = true; reject(e ?? new Error('decode failed')); } };
        try {
            const p = ctx.decodeAudioData(data, ok, fail) as Promise<AudioBuffer> | undefined;
            if (p && typeof p.then === 'function') p.then(ok, fail);
        } catch (e) {
            fail(e);
        }
    });
}
