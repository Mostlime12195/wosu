/**
 * Small synthesized interface sounds (no audio assets needed): short,
 * quiet oscillator envelopes routed through the effects bus so they obey
 * the effect volume setting.
 */
import type { AudioEngine } from './AudioEngine';

const HOVER_MIN_INTERVAL_MS = 50;

interface Tone {
    from: number;
    to: number;
    ms: number;
    type: OscillatorType;
    peak: number;
    delayMs?: number;
    /** Optional lowpass cutoff to soften harsh waveforms. */
    lowpass?: number;
}

export class UISounds {
    /** Master switch (e.g. bound to a setting). */
    enabled = true;
    /** Extra scale on top of the effects bus. */
    volume = 1;

    private readonly engine: AudioEngine;
    private lastHover = -Infinity;
    private noise: AudioBuffer | null = null;

    constructor(engine: AudioEngine) {
        this.engine = engine;
    }

    hover(): void {
        const now = this.engine.now();
        if (now - this.lastHover < HOVER_MIN_INTERVAL_MS) return;
        this.lastHover = now;
        this.tones([{ from: 2200, to: 2600, ms: 28, type: 'sine', peak: 0.035 }]);
    }

    click(): void {
        this.noiseBurst(28, 0.05, 3200);
        this.tones([{ from: 1100, to: 700, ms: 45, type: 'triangle', peak: 0.06 }]);
    }

    select(): void {
        this.tones([
            { from: 660, to: 680, ms: 60, type: 'triangle', peak: 0.07 },
            { from: 990, to: 1010, ms: 70, type: 'triangle', peak: 0.06, delayMs: 45 },
        ]);
    }

    back(): void {
        this.tones([{ from: 720, to: 380, ms: 90, type: 'triangle', peak: 0.07, lowpass: 2400 }]);
    }

    toggleOn(): void {
        this.tones([{ from: 900, to: 1350, ms: 50, type: 'sine', peak: 0.06 }]);
    }

    toggleOff(): void {
        this.tones([{ from: 1250, to: 800, ms: 50, type: 'sine', peak: 0.05 }]);
    }

    notify(): void {
        this.tones([
            { from: 880, to: 880, ms: 60, type: 'sine', peak: 0.06 },
            { from: 1320, to: 1320, ms: 70, type: 'sine', peak: 0.05, delayMs: 55 },
        ]);
    }

    error(): void {
        this.tones([{ from: 230, to: 170, ms: 110, type: 'square', peak: 0.04, lowpass: 1200 }]);
    }

    private ready(): boolean {
        return this.enabled && this.volume > 0 && this.engine.context.state === 'running';
    }

    private tones(list: Tone[]): void {
        if (!this.ready()) return;
        const ctx = this.engine.context;
        try {
            for (const t of list) {
                const start = ctx.currentTime + (t.delayMs ?? 0) / 1000;
                const end = start + t.ms / 1000;
                const osc = ctx.createOscillator();
                osc.type = t.type;
                osc.frequency.setValueAtTime(t.from, start);
                if (t.to !== t.from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, t.to), end);
                const gain = ctx.createGain();
                this.envelope(gain.gain, start, end, t.peak * this.volume);
                let tail: AudioNode = gain;
                osc.connect(gain);
                if (t.lowpass) {
                    const lp = ctx.createBiquadFilter();
                    lp.type = 'lowpass';
                    lp.frequency.value = t.lowpass;
                    gain.connect(lp);
                    tail = lp;
                }
                tail.connect(this.engine.effectsBus);
                osc.onended = () => {
                    try { tail.disconnect(); } catch { /* ignore */ }
                    if (tail !== gain) try { gain.disconnect(); } catch { /* ignore */ }
                };
                osc.start(start);
                osc.stop(end + 0.01);
            }
        } catch {
            // UI sounds are decoration; never let them throw into UI code.
        }
    }

    private noiseBurst(ms: number, peak: number, bandHz: number): void {
        if (!this.ready()) return;
        const ctx = this.engine.context;
        try {
            if (!this.noise) {
                const len = Math.ceil((ctx.sampleRate || 44100) * 0.12);
                this.noise = ctx.createBuffer(1, len, ctx.sampleRate || 44100);
                const d = this.noise.getChannelData(0);
                for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            }
            const start = ctx.currentTime;
            const end = start + ms / 1000;
            const src = ctx.createBufferSource();
            src.buffer = this.noise;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = bandHz;
            bp.Q.value = 1.2;
            const gain = ctx.createGain();
            this.envelope(gain.gain, start, end, peak * this.volume);
            src.connect(bp);
            bp.connect(gain);
            gain.connect(this.engine.effectsBus);
            src.onended = () => {
                try { gain.disconnect(); } catch { /* ignore */ }
                try { bp.disconnect(); } catch { /* ignore */ }
            };
            src.start(start);
            src.stop(end + 0.01);
        } catch {
            // decoration only
        }
    }

    /** 3 ms attack, exponential decay to silence by `end`. */
    private envelope(param: AudioParam, start: number, end: number, peak: number): void {
        param.setValueAtTime(0, start);
        param.linearRampToValueAtTime(peak, start + 0.003);
        param.exponentialRampToValueAtTime(0.0001, end);
    }
}
