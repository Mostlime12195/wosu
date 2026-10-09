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

export class AudioEngine {
    readonly context: AudioContext;
    readonly master: GainNode;
    readonly musicBus: GainNode;
    /** Music volume, after the visualiser tap. */
    readonly musicVolume: GainNode;
    readonly effectsBus: GainNode;
    readonly analyser: AnalyserNode;

    private readonly volumes: AudioVolumes = { master: 1, music: 1, effects: 1 };
    private readonly freqData: Uint8Array<ArrayBuffer>;
    private readonly levels: AudioLevels = { bass: 0, mid: 0, treble: 0, overall: 0 };
    private readonly bands: { bass: [number, number]; mid: [number, number]; treble: [number, number] };
    private unlockPromise: Promise<void> | null = null;
    private wasUnlocked = false;
    private removeVisibilityListener: (() => void) | null = null;

    constructor(options: { context?: AudioContext } = {}) {
        let ctx = options.context;
        if (!ctx) {
            const Ctor = contextConstructor();
            if (!Ctor) throw new Error('Web Audio is not supported in this browser');
            ctx = new Ctor({ latencyHint: 'interactive' });
        }
        this.context = ctx;

        this.master = ctx.createGain();
        this.musicBus = ctx.createGain();
        this.musicVolume = ctx.createGain();
        this.effectsBus = ctx.createGain();
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.8;

        this.musicBus.connect(this.musicVolume);
        this.musicVolume.connect(this.master);
        this.musicBus.connect(this.analyser);
        this.effectsBus.connect(this.master);
        this.master.connect(ctx.destination);

        const bins = this.analyser.frequencyBinCount || 1024;
        this.freqData = new Uint8Array(bins);
        const hzPerBin = (ctx.sampleRate || 44100) / (this.analyser.fftSize || 2048);
        const bin = (hz: number): number => Math.max(0, Math.min(bins - 1, Math.round(hz / hzPerBin)));
        this.bands = {
            bass: [bin(20), Math.max(bin(20) + 1, bin(250))],
            mid: [bin(250), Math.max(bin(250) + 1, bin(2000))],
            treble: [bin(2000), Math.max(bin(2000) + 1, bin(8000))],
        };

        this.wasUnlocked = ctx.state === 'running';
        this.installVisibilityResume();
    }

    get unlocked(): boolean {
        return this.wasUnlocked && this.context.state === 'running';
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
        const now = this.context.currentTime;
        if (v.master !== undefined) {
            this.volumes.master = clamp01(v.master);
            setParam(this.master.gain, this.volumes.master, now);
        }
        if (v.music !== undefined) {
            this.volumes.music = clamp01(v.music);
            setParam(this.musicVolume.gain, this.volumes.music, now);
        }
        if (v.effects !== undefined) {
            this.volumes.effects = clamp01(v.effects);
            setParam(this.effectsBus.gain, this.volumes.effects, now);
        }
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
        this.analyser.getByteFrequencyData(out);
    }

    /**
     * Band energies in 0..1 from the analyser. Allocation-free: the same
     * object is returned (and overwritten) on every call.
     */
    getLevels(): AudioLevels {
        const data = this.freqData;
        this.analyser.getByteFrequencyData(data);
        const avg = (range: [number, number]): number => {
            let sum = 0;
            for (let i = range[0]; i < range[1]; i++) sum += data[i];
            return sum / ((range[1] - range[0]) * 255);
        };
        const l = this.levels;
        l.bass = avg(this.bands.bass);
        l.mid = avg(this.bands.mid);
        l.treble = avg(this.bands.treble);
        l.overall = (l.bass * 2 + l.mid + l.treble) / 4;
        return l;
    }

    dispose(): void {
        this.removeVisibilityListener?.();
        this.removeVisibilityListener = null;
        try { this.master.disconnect(); } catch { /* already gone */ }
        try { void this.context.close(); } catch { /* ignore */ }
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
    private installVisibilityResume(): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc || typeof doc.addEventListener !== 'function') return;
        const onVisible = (): void => {
            if (doc.hidden || !this.wasUnlocked) return;
            const state = this.context.state as string;
            if (state === 'suspended' || state === 'interrupted') {
                try { void this.context.resume(); } catch { /* ignore */ }
            }
        };
        doc.addEventListener('visibilitychange', onVisible);
        this.removeVisibilityListener = () => doc.removeEventListener('visibilitychange', onVisible);
    }
}
