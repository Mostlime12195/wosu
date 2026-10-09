import { Container, Particle, ParticleContainer, Rectangle, type Texture } from 'pixi.js';

/** Number of bars to jump each update. */
const INDEX_CHANGE = 5;
/** Max bar length in lazer's logo space (where the visualiser is 0.94 × 512 = 481.28 wide). */
const BAR_LENGTH = 600;
const LAZER_VISUALISER_SIZE = 512 * 0.94;
/** Bars in one rotation. */
const BARS = 200;
/** Times the bars are repeated around the circumference, overlapping each other. */
const ROUNDS = 5;
/** Fraction of a full bar lost per ms. */
const DECAY_PER_MS = 0.0024;
const UPDATE_INTERVAL = 50;
const DEAD_ZONE = 1 / BAR_LENGTH;
/** Per-bar alpha (lazer's `transparent_white`); the five rounds add up on top of each other. */
const BAR_ALPHA = 0.2;

/**
 * BASS's 512-sample FFT (what lazer reads) has 256 linear-magnitude bins of
 * ~86 Hz. The Web Audio analyser gives dB values over finer bins, so each
 * lazer bin takes the loudest of its analyser bins converted back to
 * linear magnitude. Web Audio scales magnitudes by 1/N with a Blackman
 * window, so it reads several times quieter than BASS; GAIN maps it back.
 */
const LAZER_BIN_HZ = 44100 / 512;
const GAIN = 5;
/** Byte data range (AnalyserNode min/maxDecibels defaults), for the byte fallback. */
const BYTE_MIN_DB = -100;
const BYTE_MAX_DB = -30;

export interface VisualiserSource {
    /** Byte spectrum (getByteFrequencyData). */
    fft(out: Uint8Array<ArrayBuffer>): void;
    /** dB spectrum (getFloatFrequencyData); preferred, as bytes clip at −30 dB. */
    fftDb?(out: Float32Array<ArrayBuffer>): void;
    /** Gain applied before the analyser (music volume), divided back out like lazer's pre-volume data. */
    inputGain?(): number;
}

/**
 * Port of osu!lazer's LogoVisualisation. 200 bars start at the logo's rim
 * and point outwards; the set is drawn five times, each copy rotated by
 * 72°, so every angle carries five overlapping bars (additive, 0.2 alpha
 * each) taken from different frequencies. Amplitudes are refreshed from the
 * FFT every 50 ms with a rotating index offset, halved outside kiai, and
 * decay every frame. Bar length is 600 units in a logo space where the
 * visualiser is 481 units wide, i.e. it scales with the logo.
 *
 * Callers set the container alpha (lazer's default is 0.5).
 */
export class LogoVisualiser extends Container {
    private readonly particles: ParticleContainer;
    private readonly bars: Particle[] = [];
    private readonly amplitudes = new Float32Array(BARS);
    private readonly targets = new Float32Array(BARS);
    private readonly fft: Uint8Array<ArrayBuffer>;
    private readonly fftDb: Float32Array<ArrayBuffer>;
    private indexOffset = 0;
    private sinceUpdate = 0;
    /** Bar length in px for a full (1.0) amplitude at the current radius. */
    private barLength = 600;
    private sampleRate = 44100;
    kiai = false;

    constructor(texture: Texture, private readonly source: VisualiserSource, bins = 1024) {
        super();
        this.fft = new Uint8Array(bins);
        this.fftDb = new Float32Array(bins);
        this.particles = new ParticleContainer({
            dynamicProperties: { vertex: true, position: false, rotation: false, uvs: false, color: false },
        });
        this.particles.blendMode = 'add';
        this.addChild(this.particles);
        for (let r = 0; r < ROUNDS; r++) {
            for (let i = 0; i < BARS; i++) {
                const p = new Particle({ texture, anchorX: 0, anchorY: 0.5, alpha: BAR_ALPHA, tint: 0xffffff });
                this.bars.push(p);
                this.particles.addParticle(p);
            }
        }
        this.eventMode = 'none';
        this.setRadius(100);
    }

    /** Analyser sample rate, so frequency → bin mapping matches lazer's. */
    setSampleRate(rate: number): void {
        if (rate > 0) this.sampleRate = rate;
    }

    /** Radius of the rim the bars grow from (lazer: the logo disc). */
    setRadius(radius: number): void {
        this.barLength = BAR_LENGTH * ((radius * 2) / LAZER_VISUALISER_SIZE);
        const tex = this.bars[0].texture;
        // lazer's bar width: the chord spanning one bar step, halved.
        const barWidth = radius * Math.sqrt(2 * (1 - Math.cos((2 * Math.PI) / BARS)));
        for (let r = 0; r < ROUNDS; r++) {
            for (let i = 0; i < BARS; i++) {
                const p = this.bars[r * BARS + i];
                const angle = ((i / BARS) * 360 + (r * 360) / ROUNDS) * (Math.PI / 180);
                p.rotation = angle;
                p.x = Math.cos(angle) * radius;
                p.y = Math.sin(angle) * radius;
                p.scaleY = barWidth / tex.height;
                p.scaleX = 0;
            }
        }
        const ext = radius + this.barLength;
        this.particles.boundsArea = new Rectangle(-ext, -ext, ext * 2, ext * 2);
        this.particles.update();
    }

    private sampleTargets(): void {
        const src = this.source;
        const useDb = !!src.fftDb;
        if (src.fftDb) src.fftDb(this.fftDb);
        else src.fft(this.fft);
        const n = this.fft.length;
        const analyserBinHz = this.sampleRate / 2 / n;
        const gain = GAIN / Math.max(0.1, src.inputGain?.() ?? 1);
        for (let k = 0; k < BARS; k++) {
            const lo = Math.floor((k * LAZER_BIN_HZ) / analyserBinHz);
            const hi = Math.max(lo + 1, Math.floor(((k + 1) * LAZER_BIN_HZ) / analyserBinHz));
            let db = -Infinity;
            for (let b = lo; b < hi && b < n; b++) {
                const v = useDb ? this.fftDb[b] : this.fft[b] === 0 ? -Infinity : BYTE_MIN_DB + (this.fft[b] / 255) * (BYTE_MAX_DB - BYTE_MIN_DB);
                if (v > db) db = v;
            }
            this.targets[k] = db === -Infinity ? 0 : gain * Math.pow(10, db / 20);
        }
    }

    update(dt: number): void {
        this.sinceUpdate += dt;
        if (this.sinceUpdate >= UPDATE_INTERVAL) {
            this.sinceUpdate %= UPDATE_INTERVAL;
            this.sampleTargets();
            const kiaiMultiplier = this.kiai ? 1 : 0.5;
            for (let i = 0; i < BARS; i++) {
                const target = this.targets[(i + this.indexOffset) % BARS] * kiaiMultiplier;
                if (target > this.amplitudes[i]) this.amplitudes[i] = target;
            }
            this.indexOffset = (this.indexOffset + INDEX_CHANGE) % BARS;
        }
        const decay = dt * DECAY_PER_MS;
        for (let i = 0; i < BARS; i++) {
            // 3% extra so bars near zero still drop quickly.
            const a = this.amplitudes[i] - decay * (this.amplitudes[i] + 0.03);
            this.amplitudes[i] = a < 0 ? 0 : a;
        }
        const scale = this.barLength / this.bars[0].texture.width;
        for (let r = 0; r < ROUNDS; r++) {
            for (let i = 0; i < BARS; i++) {
                const a = this.amplitudes[i];
                this.bars[r * BARS + i].scaleX = a < DEAD_ZONE ? 0 : a * scale;
            }
        }
    }
}
