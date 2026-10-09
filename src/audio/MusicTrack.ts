/**
 * A decoded song: menu music, song-select previews from the library and
 * the gameplay clock.
 *
 * Position model (unchanged from the original OsuAudio so timing feels
 * identical): `position` is the buffer offset in seconds at context time
 * `started`; while playing it advances at `rate`. A negative position is
 * a lead-in: the source is scheduled to start that far in the future.
 *
 * Song time (what gameplay uses) = buffer time − posoffset, where
 * posoffset = decoder start offset + output latency (scaled to song time
 * by the rate) + the user's global offset.
 *
 * The raw clock only moves when the audio thread renders a quantum, so
 * `currentTime` interpolates with performance.now between ticks and pulls
 * gently toward the raw clock; large disagreements (seek, stall) snap.
 */
import { Signal } from '../core/Signal';
import type { AudioEngine } from './AudioEngine';
import { rampParam, resolveAssetUrl } from './base';
import { analyzeAudio } from './mp3Info';

/** AudioWorkletNode extended with Signalsmith Stretch's remote methods. */
export interface StretchNode extends AudioNode {
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<unknown>;
    readonly port: MessagePort;
}

export type StretchFactory = ((context: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>) & {
    moduleUrl?: string;
};

const SMOOTH_SNAP_MS = 30;
const SMOOTH_HALF_LIFE_MS = 100;

const perfNow = (): number =>
    (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onLateResolve?: (value: T) => void): Promise<T> {
    let timedOut = false;
    const observed = Promise.resolve(promise);
    // A late success after the timeout still owns resources (e.g. a worklet
    // node); hand it to the cleanup callback instead of leaking it.
    observed.then(value => {
        if (timedOut && onLateResolve) {
            try { onLateResolve(value); } catch { /* ignore late cleanup failure */ }
        }
    }, () => { /* the raced path reports the original rejection */ });
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${label} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        observed.then(value => {
            if (timedOut) return;
            clearTimeout(timer);
            resolve(value);
        }, error => {
            if (timedOut) return;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function releaseStretchNode(node: StretchNode | null | undefined): void {
    if (!node) return;
    try { node.disconnect(); } catch { /* ignore */ }
    try { node.port.close(); } catch { /* ignore */ }
}

let stretchModule: Promise<StretchFactory> | null = null;

/**
 * Load the vendored worklet module once. The same absolute URL is used for
 * the main-thread import and the AudioWorklet so only one file ships (and
 * strict CSPs that forbid blob: workers still work).
 */
function defaultLoadStretch(): Promise<StretchFactory> {
    if (!stretchModule) {
        const url = resolveAssetUrl('vendor/SignalsmithStretch.mjs');
        stretchModule = import(/* @vite-ignore */ url).then((mod: { default: StretchFactory }) => {
            const factory = mod.default;
            factory.moduleUrl = url;
            return factory;
        });
        stretchModule.catch(() => { stretchModule = null; });
    }
    return stretchModule;
}

function decodeOnce(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
        let settled = false;
        const ok = (b: AudioBuffer): void => {
            if (settled) return;
            settled = true;
            resolve(b);
        };
        const fail = (e?: unknown): void => {
            if (settled) return;
            settled = true;
            reject(e instanceof Error ? e : new Error('audio decode failed'));
        };
        try {
            // Callback form for old Safari; newer engines also return a promise.
            const p = ctx.decodeAudioData(data, ok, fail) as Promise<AudioBuffer> | undefined;
            if (p && typeof p.then === 'function') p.then(ok, fail);
        } catch (e) {
            fail(e);
        }
    });
}

/** Index of the next plausible MPEG frame sync at or after `from`, or -1. */
function findFrameSync(bytes: Uint8Array, from: number): number {
    for (let i = Math.max(0, from); i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return i;
    }
    return -1;
}

/**
 * decodeAudioData, retrying from the next frame sync when a file has junk
 * in front of its first frame (seen in the wild). decodeAudioData detaches
 * its input, so each attempt gets a copy.
 */
async function decodeWithResync(ctx: BaseAudioContext, buffer: ArrayBuffer, maxRetries = 3): Promise<AudioBuffer> {
    let bytes = new Uint8Array(buffer);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await decodeOnce(ctx, bytes.slice().buffer);
        } catch (e) {
            lastError = e;
            const next = findFrameSync(bytes, 1);
            if (next <= 0) break;
            bytes = bytes.subarray(next);
        }
    }
    throw lastError instanceof Error ? lastError : new Error('audio decode failed');
}

export class MusicTrack {
    /** Overridable for tests and alternative hosting. */
    static loadStretch: () => Promise<StretchFactory> = defaultLoadStretch;
    static pitchStretchTimeoutMs = 10000;
    /** User-facing problems (pitch fallback, clock glitches); the app shows toasts. */
    static readonly diagnostics = new Signal<[message: string]>();

    readonly ended = new Signal<[]>();
    readonly filename: string;
    /** Decoder start offset predicted from the file header (ms). */
    readonly startOffsetMs: number;
    /** User global offset (ms); positive delays judgement like the old setting. */
    userOffsetMs = 0;
    loop = false;
    /** Interpolate the coarse audio clock (disable for deterministic tests). */
    smoothClock = true;

    private readonly engine: AudioEngine;
    private readonly ctx: BaseAudioContext;
    private readonly gain: GainNode;
    private failFilters: BiquadFilterNode[] | null = null;
    private decoded: AudioBuffer | null;
    private readonly durationSec: number;
    private channelCount: number;

    private stretch: StretchNode | null = null;
    private stretchConnected = false;
    private stretchStopTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingStretch: Promise<void> | null = null;
    private generation = 0;
    private source: AudioBufferSourceNode | StretchNode | null = null;

    private position = 0;
    private started = 0;
    private playing = false;
    private rate = 1;
    private preservePitch = true;
    private _volume = 1;

    private smoothMs = 0;
    private smoothPerf = 0;
    private smoothValid = false;
    private lastGood = 0;
    private nanWarned = false;
    private disposed = false;

    static async decode(engine: AudioEngine, bytes: ArrayBuffer, filename: string): Promise<MusicTrack> {
        const analysis = analyzeAudio(filename, bytes);
        const buffer = await decodeWithResync(engine.context, analysis.buffer);
        return new MusicTrack(engine, buffer, filename, analysis.startOffsetMs);
    }

    constructor(engine: AudioEngine, decoded: AudioBuffer, filename: string, startOffsetMs: number) {
        this.engine = engine;
        this.ctx = engine.context;
        this.decoded = decoded;
        this.filename = filename;
        this.startOffsetMs = startOffsetMs;
        this.durationSec = Number(decoded.duration);
        this.channelCount = Math.max(1, decoded.numberOfChannels || 1);
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 1;
        this.gain.connect(engine.musicBus);
    }

    get isPlaying(): boolean {
        return this.playing;
    }

    /** Song duration in ms. */
    get duration(): number {
        return this.durationSec * 1000;
    }

    get playbackRate(): number {
        return this.rate;
    }

    /** True when rate ≠ 1 actually keeps pitch (worklet available). */
    get pitchPreserved(): boolean {
        if (this.rate === 1) return true;
        return this.preservePitch && !!this.stretch;
    }

    get usesTimeStretch(): boolean {
        return !!this.stretch;
    }

    /** Total ms subtracted from buffer time to get song time. */
    get posoffsetMs(): number {
        return this.startOffsetMs + this.engine.outputLatencyMs * this.rate + (Number(this.userOffsetMs) || 0);
    }

    /** Song time in ms. Never NaN. */
    get currentTime(): number {
        const raw = this.rawPositionSec() * 1000 - this.posoffsetMs;
        if (!Number.isFinite(raw)) {
            if (!this.nanWarned) {
                this.nanWarned = true;
                const info = JSON.stringify({
                    playing: this.playing,
                    position: this.position,
                    currentTime: this.ctx.currentTime,
                    started: this.started,
                    rate: this.rate,
                    posoffset: this.posoffsetMs,
                });
                console.error('audio clock NaN; components:', info);
                MusicTrack.diagnostics.emit(`Audio clock glitch detected (${info}). If the game misbehaves, please report this.`);
            }
            return this.lastGood;
        }
        const t = this.playing && this.smoothClock ? this.smooth(raw) : raw;
        if (!this.playing) this.smoothValid = false;
        this.lastGood = t;
        return t;
    }

    get volume(): number {
        return this._volume;
    }

    set volume(v: number) {
        this._volume = Math.max(0, Number.isFinite(v) ? v : 0);
        rampParam(this.gain.gain, this._volume, this.ctx.currentTime, 0);
    }

    /** Ramp the track gain; resolves when the ramp is done. */
    fadeTo(volume: number, ms: number): Promise<void> {
        this._volume = Math.max(0, Number.isFinite(volume) ? volume : 0);
        rampParam(this.gain.gain, this._volume, this.ctx.currentTime, Math.max(0, ms) / 1000);
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }

    /**
     * Start playback. `leadInMs > 0` restarts from the beginning with that
     * much silence first (the old play(wait)); resuming from a negative
     * position (paused during lead-in) converts it back into a wait.
     */
    play(leadInMs = 0): void {
        if (this.disposed) return;
        if ((this.ctx.state as string) === 'suspended') {
            try { void (this.ctx as AudioContext).resume(); } catch { /* ignore */ }
        }
        let wait = leadInMs;
        if (!(wait > 0) && this.position < 0) wait = -this.position * 1000;
        if (!(wait > 0) && this.position >= this.durationSec) this.position = 0;
        // Never let a previous source survive a restart (echo/overlap bug).
        this.stopSource();
        this.playing = true;
        this.started = this.ctx.currentTime;
        this.smoothValid = false;
        if (wait > 0) {
            this.position = -wait / 1000;
            this.startSource(this.ctx.currentTime + wait / 1000 / this.rate, 0);
        } else {
            this.startSource(this.ctx.currentTime, Math.max(0, this.position));
        }
    }

    /** Pause, keeping the position (also during lead-in). Returns false when idle. */
    pause(): boolean {
        if (!this.playing) return false;
        const p = this.rawPositionSec();
        this.position = Number.isFinite(p) ? p : this.position || 0;
        this.stopSource();
        this.playing = false;
        this.smoothValid = false;
        return true;
    }

    /** Stop and rewind to the start. Idempotent. */
    stop(): void {
        this.stopSource();
        this.playing = false;
        this.position = 0;
        this.smoothValid = false;
    }

    /**
     * Jump to song time `ms` (negative values become a lead-in on play).
     * Keeps playing if it was. Returns false when out of range.
     */
    seek(ms: number): boolean {
        if (this.disposed || (!this.decoded && !this.stretch)) return false;
        const sec = (ms + this.posoffsetMs) / 1000;
        if (!Number.isFinite(sec) || sec >= this.durationSec) return false;
        const wasPlaying = this.playing;
        this.stopSource();
        this.playing = false;
        this.position = sec;
        this.smoothValid = false;
        if (wasPlaying) this.play();
        return true;
    }

    /** Start from song time `ms` with an optional fade-in (song select previews). */
    playFrom(ms: number, fadeInMs = 0): void {
        if (this.disposed) return;
        const startMs = Math.min(Math.max(0, Number.isFinite(ms) ? ms : 0), Math.max(0, this.duration - 1));
        this.stopSource();
        this.playing = false;
        this.position = Math.max(0, (startMs + this.posoffsetMs) / 1000);
        if (fadeInMs > 0) {
            const target = this._volume;
            rampParam(this.gain.gain, 0, this.ctx.currentTime, 0);
            this.play();
            rampParam(this.gain.gain, target, this.ctx.currentTime, fadeInMs / 1000);
        } else {
            this.play();
        }
    }

    /**
     * Change the playback rate. Pitch-preserving rates need the time
     * stretch worklet; when it is unavailable the rate still applies but
     * pitch follows it (reported through `diagnostics`).
     */
    async setRate(rate: number, preservePitch = true): Promise<void> {
        const r = Number(rate) > 0 && Number.isFinite(Number(rate)) ? Number(rate) : 1;
        if (this.pendingStretch) await this.pendingStretch;
        const wasPlaying = this.pause();
        this.rate = r;
        this.preservePitch = preservePitch;
        if (preservePitch && r !== 1 && !this.stretch) {
            this.pendingStretch = this.prepareStretch();
            try {
                await this.pendingStretch;
            } finally {
                this.pendingStretch = null;
            }
        }
        if (wasPlaying && !this.disposed) this.play();
    }

    /**
     * lazer's fail effect (FailAnimationContainer): the song slows to a
     * stop (speed and pitch together), its volume halves, a high-pass sits
     * at 300 Hz and a low-pass sweeps down to 300 Hz (OutCubic), leaving a
     * thin, muffled wind-down. The position clock is not adjusted; callers
     * stop using it once a play has failed. Undone by the next playback.
     */
    failSlowdown(ms: number): void {
        const ctx = this.ctx;
        const now = ctx.currentTime;
        const end = now + ms / 1000;
        // Only a plain buffer source can bend speed; the stretch worklet fades out instead.
        const rate = (this.source as AudioBufferSourceNode | null)?.playbackRate;
        if (rate && typeof rate.linearRampToValueAtTime === 'function') {
            try {
                rate.cancelScheduledValues(now);
                rate.setValueAtTime(rate.value, now);
                rate.linearRampToValueAtTime(0.001, end);
            } catch { /* ignore */ }
        } else {
            void this.fadeTo(0, ms);
        }
        rampParam(this.gain.gain, this._volume * 0.5, now, 0);
        try {
            this.clearFailEffect();
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 300;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            const from = Math.min(22000, ctx.sampleRate / 2);
            const curve = new Float32Array(64);
            for (let i = 0; i < curve.length; i++) {
                const t = i / (curve.length - 1);
                const k = 1 - Math.pow(1 - t, 3); // OutCubic
                curve[i] = from + (300 - from) * k;
            }
            lp.frequency.setValueAtTime(from, now);
            lp.frequency.setValueCurveAtTime(curve, now, ms / 1000);
            this.gain.disconnect();
            this.gain.connect(hp);
            hp.connect(lp);
            lp.connect(this.engine.musicBus);
            this.failFilters = [hp, lp];
        } catch {
            /* filters are an effect only */
        }
    }

    /** Remove the fail filters (a retry or the menu reuses this track). */
    private clearFailEffect(): void {
        if (!this.failFilters) return;
        for (const f of this.failFilters) try { f.disconnect(); } catch { /* ignore */ }
        this.failFilters = null;
        try { this.gain.disconnect(); } catch { /* ignore */ }
        this.gain.connect(this.engine.musicBus);
        // Undo the halved volume too.
        rampParam(this.gain.gain, this._volume, this.ctx.currentTime, 0);
    }

    dispose(): void {
        if (this.disposed) return;
        this.stopSource();
        this.playing = false;
        if (this.stretch) {
            try { this.stretch.disconnect(); } catch { /* ignore */ }
            try { this.stretch.port.close(); } catch { /* ignore */ }
            this.stretch = null;
        }
        this.stretchConnected = false;
        this.decoded = null;
        try { this.gain.disconnect(); } catch { /* ignore */ }
        this.disposed = true;
        this.ended.clear();
    }

    private rawPositionSec(): number {
        if (!this.playing) return this.position;
        return this.position + (this.ctx.currentTime - this.started) * this.rate;
    }

    private smooth(raw: number): number {
        const now = perfNow();
        if (!this.smoothValid) {
            this.smoothValid = true;
            this.smoothMs = raw;
            this.smoothPerf = now;
            return raw;
        }
        const dt = Math.max(0, now - this.smoothPerf);
        const predicted = this.smoothMs + dt * this.rate;
        const error = raw - predicted;
        let next: number;
        if (Math.abs(error) > SMOOTH_SNAP_MS) {
            next = raw;
        } else {
            const k = 1 - Math.pow(0.5, dt / SMOOTH_HALF_LIFE_MS);
            next = Math.max(this.smoothMs, predicted + error * k);
        }
        this.smoothMs = next;
        this.smoothPerf = now;
        return next;
    }

    private async prepareStretch(): Promise<void> {
        const ctx = this.ctx as BaseAudioContext & { audioWorklet?: AudioWorklet };
        if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            this.reportPitchFallback('AudioWorklet is unavailable');
            return;
        }
        const decoded = this.decoded;
        if (!decoded) return;
        const timeout = MusicTrack.pitchStretchTimeoutMs;
        let stretch: StretchNode | null = null;
        try {
            const factory = await withTimeout(MusicTrack.loadStretch(), timeout, 'Pitch-preserving audio module load');
            const channelCount = this.channelCount;
            stretch = await withTimeout(
                factory(ctx, {
                    // Keep one input slot for the processor's inactive-path
                    // contract, but select uploaded-buffer mode explicitly so
                    // a silent input is never mistaken for live audio.
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [channelCount],
                    processorOptions: { internalBufferMode: true },
                }),
                timeout,
                'Pitch-preserving audio initialization',
                releaseStretchNode,
            );
            const channels: Float32Array[] = [];
            const transfer: Transferable[] = [];
            for (let c = 0; c < channelCount; c++) {
                const samples = decoded.getChannelData(c);
                channels.push(samples);
                if (!transfer.includes(samples.buffer as ArrayBuffer)) transfer.push(samples.buffer as ArrayBuffer);
            }
            stretch.connect(this.gain);
            this.stretchConnected = true;
            // Transfer ownership into the worklet: cloning would keep a second
            // full copy of the song in memory.
            await withTimeout(stretch.addBuffers(channels, transfer), timeout, 'Pitch-preserving audio buffer upload');
            this.stretch = stretch;
            this.decoded = null;
        } catch (e) {
            releaseStretchNode(stretch);
            this.stretch = null;
            this.stretchConnected = false;
            this.reportPitchFallback(e);
        }
    }

    private reportPitchFallback(reason: unknown): void {
        console.warn('Pitch-preserving rate adjustment unavailable; falling back.', reason ?? '');
        MusicTrack.diagnostics.emit('Pitch-preserving speed is unavailable in this browser; DT/HT audio will change pitch.');
    }

    private startSource(when: number, offset: number): void {
        this.clearFailEffect();
        if (this.stretch) {
            const stretch = this.stretch;
            if (!this.stretchConnected) {
                stretch.connect(this.gain);
                this.stretchConnected = true;
            }
            this.source = stretch;
            // Signalsmith's start(duration) path can drop the active segment
            // when the context clock already passed `when`; schedule our own
            // wall-clock stop instead (pause/seek can cancel it safely).
            if (this.preservePitch || this.rate === 1) {
                void stretch.start(when, offset, undefined, this.rate);
            } else {
                // NC/DC through the worklet: shift pitch with the tempo.
                void stretch.start(when, offset, undefined, this.rate, 12 * Math.log2(this.rate));
            }
            if (Number.isFinite(this.durationSec)) {
                const remaining = Math.max(0, this.durationSec - offset) / this.rate;
                const delay = Math.max(0, when - this.ctx.currentTime) + remaining;
                const generation = ++this.generation;
                const timer = setTimeout(() => {
                    this.stretchStopTimer = null;
                    if (generation !== this.generation || this.source !== this.stretch || !this.playing) return;
                    this.handleNaturalEnd();
                }, delay * 1000);
                (timer as { unref?: () => void }).unref?.();
                this.stretchStopTimer = timer;
            }
            return;
        }
        if (!this.decoded) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this.decoded;
        src.playbackRate.value = this.rate;
        src.connect(this.gain);
        const generation = ++this.generation;
        src.onended = () => {
            if (generation !== this.generation || this.source !== src || !this.playing) return;
            this.handleNaturalEnd();
        };
        src.start(when, offset);
        this.source = src;
    }

    private stopSource(): void {
        if (this.stretchStopTimer) {
            clearTimeout(this.stretchStopTimer);
            this.stretchStopTimer = null;
        }
        ++this.generation;
        const src = this.source;
        this.source = null;
        if (!src) return;
        if (src === this.stretch) {
            try { void (src as StretchNode).stop(); } catch { /* ignore */ }
            return;
        }
        const buf = src as AudioBufferSourceNode;
        try { buf.onended = null; } catch { /* ignore */ }
        try { buf.stop(); } catch { /* not started */ }
        try { buf.disconnect(); } catch { /* ignore */ }
    }

    private handleNaturalEnd(): void {
        this.stopSource();
        this.playing = false;
        this.position = this.durationSec;
        this.smoothValid = false;
        if (this.loop && !this.disposed) {
            this.position = 0;
            this.play();
            return;
        }
        // Release the DSP node's output while idle; play() reconnects it.
        if (this.stretch && this.stretchConnected) {
            try { this.stretch.disconnect(); } catch { /* ignore */ }
            this.stretchConnected = false;
        }
        this.ended.emit();
    }
}
