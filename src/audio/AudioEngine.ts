/**
 * Owns the single AudioContext and the mixing graph:
 *
 *   music bus ──┬─► music volume ──► master ──► destination
 *               └─► analyser (visualiser tap before the volume, like lazer's)
 *   effects bus ───────────────► master
 *
 * Every sound in the game (songs, previews, hitsounds, UI sounds) is
 * routed into one of the two buses, so the volume settings apply
 * uniformly and the menu visualiser sees exactly the music.
 */
import { setParam } from './base';

export interface AudioLevels {
    bass: number;
    mid: number;
    treble: number;
    overall: number;
}

export interface AudioVolumes {
    master: number;
    music: number;
    effects: number;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function contextConstructor(): AudioContextCtor | null {
    const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return g.AudioContext ?? g.webkitAudioContext ?? null;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

interface Graph {
    readonly context: AudioContext;
    readonly master: GainNode;
    readonly musicBus: GainNode;
    readonly musicVolume: GainNode;
    readonly effectsBus: GainNode;
    readonly analyser: AnalyserNode;
    readonly freqData: Uint8Array<ArrayBuffer>;
    readonly bands: { bass: [number, number]; mid: [number, number]; treble: [number, number] };
}

export class AudioEngine {
    private graph: Graph | null = null;
    private readonly Ctor: AudioContextCtor | null;
    private readonly volumes: AudioVolumes = { master: 1, music: 1, effects: 1 };
    private readonly levels: AudioLevels = { bass: 0, mid: 0, treble: 0, overall: 0 };
    private unlockPromise: Promise<void> | null = null;
    private wasUnlocked = false;
    private removeVisibilityListener: (() => void) | null = null;

    /**
     * The context is created on first use (or by `start`), not here:
     * opening the audio output is a long main-thread task, and boot keeps
     * it off the first frame. Nothing is audible before a user gesture
     * anyway, and `unlock` (inside that gesture) creates it at the latest.
     */
    constructor(options: { context?: AudioContext } = {}) {
        this.Ctor = contextConstructor();
        if (options.context) this.graph = this.build(options.context);
        else if (!this.Ctor) throw new Error('Web Audio is not supported in this browser');
    }

    /** Create the context and mixing graph now (idempotent). */
    start(): void {
        if (!this.graph) this.graph = this.build(new this.Ctor!({ latencyHint: 'interactive' }));
    }

    /** The context exists (it is created lazily; see the constructor). */
    get started(): boolean {
        return this.graph !== null;
    }

    private get g(): Graph {
        this.start();
        return this.graph!;
    }

    get context(): AudioContext { return this.g.context; }
    get master(): GainNode { return this.g.master; }
    get musicBus(): GainNode { return this.g.musicBus; }
    /** Music volume, after the visualiser tap. */
    get musicVolume(): GainNode { return this.g.musicVolume; }
    get effectsBus(): GainNode { return this.g.effectsBus; }
    get analyser(): AnalyserNode { return this.g.analyser; }

    private build(ctx: AudioContext): Graph {
        const master = ctx.createGain();
        const musicBus = ctx.createGain();
        const musicVolume = ctx.createGain();
        const effectsBus = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;

        musicBus.connect(musicVolume);
        musicVolume.connect(master);
        musicBus.connect(analyser);
        effectsBus.connect(master);
        master.connect(ctx.destination);

        const bins = analyser.frequencyBinCount || 1024;
        const hzPerBin = (ctx.sampleRate || 44100) / (analyser.fftSize || 2048);
        const bin = (hz: number): number => Math.max(0, Math.min(bins - 1, Math.round(hz / hzPerBin)));
        const graph: Graph = {
            context: ctx, master, musicBus, musicVolume, effectsBus, analyser,
            freqData: new Uint8Array(bins),
            bands: {
                bass: [bin(20), Math.max(bin(20) + 1, bin(250))],
                mid: [bin(250), Math.max(bin(250) + 1, bin(2000))],
                treble: [bin(2000), Math.max(bin(2000) + 1, bin(8000))],
            },
        };
        // Volumes set before the context existed.
        const now = ctx.currentTime;
        setParam(master.gain, this.volumes.master, now);
        setParam(musicVolume.gain, this.volumes.music, now);
        setParam(effectsBus.gain, this.volumes.effects, now);

        this.wasUnlocked = ctx.state === 'running';
        this.installVisibilityResume(ctx);
        return graph;
    }

    get unlocked(): boolean {
        return this.wasUnlocked && this.graph?.context.state === 'running';
    }

    /** Context time in ms. */
    now(): number {
        return this.context.currentTime * 1000;
    }

    /**
     * Heard audio lags the context clock by the output pipeline; this is
     * the wall-clock compensation in ms (clamped to something plausible so
     * a bogus browser report can't wreck sync).
     */
    get outputLatencyMs(): number {
        const ctx = this.context as AudioContext & { outputLatency?: number };
        const sec = (Number(ctx.outputLatency) || 0) + (Number(ctx.baseLatency) || 0);
        if (!Number.isFinite(sec) || sec <= 0 || sec >= 1) return 0;
        return sec * 1000;
    }

    getVolumes(): Readonly<AudioVolumes> {
        return this.volumes;
    }

    setVolumes(v: Partial<AudioVolumes>): void {
        if (v.master !== undefined) this.volumes.master = clamp01(v.master);
        if (v.music !== undefined) this.volumes.music = clamp01(v.music);
        if (v.effects !== undefined) this.volumes.effects = clamp01(v.effects);
        const g = this.graph;
        if (!g) return; // applied when the context is created
        const now = g.context.currentTime;
        if (v.master !== undefined) setParam(g.master.gain, this.volumes.master, now);
        if (v.music !== undefined) setParam(g.musicVolume.gain, this.volumes.music, now);
        if (v.effects !== undefined) setParam(g.effectsBus.gain, this.volumes.effects, now);
    }

    /**
     * Resume the context. Browsers only allow this inside a user gesture,
     * so besides trying immediately (works when called from a click
     * handler) we keep gesture listeners armed until it succeeds.
     * Idempotent: every caller shares one promise.
     */
    unlock(): Promise<void> {
        if (this.unlockPromise) return this.unlockPromise;
        if (this.context.state === 'running') {
            this.wasUnlocked = true;
            this.unlockPromise = Promise.resolve();
            return this.unlockPromise;
        }
        this.unlockPromise = new Promise<void>(resolve => {
            const target = globalThis as unknown as EventTarget & { addEventListener?: EventTarget['addEventListener'] };
            const events = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
            let done = false;
            const cleanup = (): void => {
                if (typeof target.removeEventListener !== 'function') return;
                for (const e of events) target.removeEventListener(e, attempt, true);
            };
            const attempt = (): void => {
                if (done) return;
                this.primeOutput();
                let p: Promise<void> | undefined;
                try {
                    p = this.context.resume();
                } catch {
                    p = undefined;
                }
                Promise.resolve(p).then(() => {
                    if (done || this.context.state !== 'running') return;
                    done = true;
                    this.wasUnlocked = true;
                    cleanup();
                    resolve();
                }, () => { /* not in a gesture yet; listeners stay armed */ });
            };
            if (typeof target.addEventListener === 'function') {
                for (const e of events) target.addEventListener(e, attempt, { capture: true, passive: true });
            }
            attempt();
        });
        return this.unlockPromise;
    }

    getFrequencyData(out: Uint8Array<ArrayBuffer>): void {
        if (this.graph) this.graph.analyser.getByteFrequencyData(out);
        else out.fill(0);
    }

    /**
     * Band energies in 0..1 from the analyser. Allocation-free: the same
     * object is returned (and overwritten) on every call.
     */
    getLevels(): AudioLevels {
        const l = this.levels;
        const g = this.graph;
        if (!g) {
            l.bass = l.mid = l.treble = l.overall = 0;
            return l;
        }
        const data = g.freqData;
        g.analyser.getByteFrequencyData(data);
        const avg = (range: [number, number]): number => {
            let sum = 0;
            for (let i = range[0]; i < range[1]; i++) sum += data[i];
            return sum / ((range[1] - range[0]) * 255);
        };
        l.bass = avg(g.bands.bass);
        l.mid = avg(g.bands.mid);
        l.treble = avg(g.bands.treble);
        l.overall = (l.bass * 2 + l.mid + l.treble) / 4;
        return l;
    }

    dispose(): void {
        this.removeVisibilityListener?.();
        this.removeVisibilityListener = null;
        const g = this.graph;
        if (!g) return;
        try { g.master.disconnect(); } catch { /* already gone */ }
        try { void g.context.close(); } catch { /* ignore */ }
    }

    /** iOS only unlocks output after something is started inside the gesture. */
    private primeOutput(): void {
        try {
            const ctx = this.context;
            if (typeof ctx.createBuffer !== 'function') return;
            const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this.master);
            src.start(0);
        } catch {
            // best effort
        }
    }

    /**
     * A hidden tab can suspend the context (and rAF stops); resume when it
     * comes back so audio and visuals re-sync without a reload.
     */
    private installVisibilityResume(ctx: AudioContext): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc || typeof doc.addEventListener !== 'function') return;
        const onVisible = (): void => {
            if (doc.hidden || !this.wasUnlocked) return;
            const state = ctx.state as string;
            if (state === 'suspended' || state === 'interrupted') {
                try { void ctx.resume(); } catch { /* ignore */ }
            }
        };
        doc.addEventListener('visibilitychange', onVisible);
        this.removeVisibilityListener = () => doc.removeEventListener('visibilitychange', onVisible);
    }
}
