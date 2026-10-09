import { Container, FillGradient, Graphics, Sprite, type Text, type Texture } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { damp } from '../../core/math';
import type { BeatState } from '../../app/MusicController';
import type { AudioLevels } from '../../audio/AudioEngine';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { Triangles } from '../../ui/Triangles';
import { UIComponent } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';
import { LogoVisualiser } from './LogoVisualiser';

export interface LogoAudio {
    beat(): BeatState;
    levels(): AudioLevels;
    fft(out: Uint8Array<ArrayBuffer>): void;
    /** dB spectrum; preferred by the visualiser (bytes clip at −30 dB). */
    fftDb?(out: Float32Array<ArrayBuffer>): void;
    /** Music gain before the analyser, divided back out by the visualiser. */
    inputGain?(): number;
    /** Analyser sample rate (Hz), for lazer's frequency → bar mapping. */
    sampleRate?: number;
}

/** lazer's visualizer_default_alpha. */
const VISUALISER_ALPHA = 0.5;

/**
 * The menu logo (lazer's OsuLogo): pink disc with drifting triangles, a
 * white ring and the wordmark, pulsing on the beat, rippling in kiai,
 * surrounded by the spectrum visualiser. Diameter = `size`.
 */
export class OsuLogo extends UIComponent {
    /** The spectrum; its alpha is the caller's (default lazer 0.5). */
    readonly visualiser: LogoVisualiser;
    /** Kiai beat flash multiplier on top of the visualiser's own alpha. */
    private readonly visualiserFlash = new Container();
    private readonly beatContainer = new Container();
    private readonly bounceContainer = new Container();
    private readonly amplitudeContainer = new Container();
    private readonly hoverContainer = new Container();
    private readonly shadow: Sprite;
    private readonly disc = new Graphics();
    private readonly discMask = new Graphics();
    private readonly triangles: Triangles;
    private readonly ring = new Graphics();
    private readonly flash = new Graphics();
    private readonly ripple = new Graphics();
    private readonly wordmark: Text;
    private lastBeat = -1;
    private sinceBeat = 0;
    private bassAvg = 0;
    private size = 400;
    /** Disable beat reactions (e.g. during transitions). */
    beatsEnabled = true;
    onClickLogo: (() => void) | null = null;

    constructor(textures: { triangle: Texture; glow: Texture; white: Texture }, private readonly audio: LogoAudio) {
        super();
        this.visualiser = new LogoVisualiser(textures.white, audio);
        this.visualiser.setSampleRate(audio.sampleRate ?? 44100);
        this.visualiser.alpha = VISUALISER_ALPHA;
        this.visualiserFlash.addChild(this.visualiser);
        this.shadow = new Sprite(textures.glow);
        this.shadow.anchor.set(0.5);
        this.shadow.tint = 0x000000;
        this.shadow.alpha = 0.6;
        this.triangles = new Triangles(textures.triangle, {
            colorLight: 0xff8fc5,
            colorDark: 0xe2558f,
            density: 1.6,
            velocity: 0.6,
            maskRadius: null,
            scale: 1.6,
        });
        this.triangles.mask = this.discMask;
        this.wordmark = label('wosu!', { size: 120, weight: '800', color: 0xffffff });
        this.wordmark.anchor.set(0.5, 0.56);
        this.flash.alpha = 0;
        this.ripple.alpha = 0;
        // lazer's nesting: hover → bounce (press) → [ripple, amplitude → beat → [visualiser, logo]].
        // Hover and bounce scale everything, visualiser included, and are what
        // the menu's button flow sizes its gap from (see flowScale).
        this.beatContainer.addChild(this.visualiserFlash, this.shadow, this.disc, this.triangles, this.discMask, this.flash, this.ring, this.wordmark);
        this.amplitudeContainer.addChild(this.beatContainer);
        this.bounceContainer.addChild(this.ripple, this.amplitudeContainer);
        this.hoverContainer.addChild(this.bounceContainer);
        this.addChild(this.hoverContainer);
        this.makeInteractive({ sounds: false });
        this.onFrame(dt => this.tick(dt));
        this.setDiameter(400);
    }

    get diameter(): number {
        return this.size;
    }

    /**
     * Hover × press scale (lazer's SizeForFlow factor). The menu's buttons
     * are laid out around `diameter × scale × flowScale` every frame, so
     * hovering or pressing the logo pushes them in sync with its bounce.
     */
    get flowScale(): number {
        return this.hoverContainer.scale.x * this.bounceContainer.scale.x;
    }

    /** Resize the logo; positions are relative to its centre (0,0). */
    setDiameter(size: number): void {
        this.size = size;
        const r = size / 2;
        const g = this.disc;
        g.clear().circle(0, 0, r).fill(new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 0, y: 1 },
            colorStops: [
                { offset: 0, color: '#ff8ec6' },
                { offset: 1, color: '#ef5b9b' },
            ],
            textureSpace: 'local',
        }));
        this.discMask.clear().circle(0, 0, r * 0.97).fill(0xffffff);
        this.triangles.position.set(-r, -r);
        this.triangles.resize(size, size);
        const ringW = size * 0.055;
        this.ring.clear().circle(0, 0, r - ringW / 2).stroke({ width: ringW, color: 0xffffff });
        this.flash.clear().circle(0, 0, r).fill(0xffffff);
        this.ripple.clear().circle(0, 0, r).stroke({ width: ringW * 0.8, color: 0xffffff });
        this.shadow.width = this.shadow.height = size * 1.45;
        this.wordmark.scale.set(size / 400 * 0.86);
        this.wordmark.position.set(0, size * 0.02);
        this.visualiser.setRadius(r);
        this.hitArea = {
            contains: (x: number, y: number) => {
                const rr = r * this.flowScale;
                return x * x + y * y <= rr * rr;
            },
        };
    }

    protected override onResize(): void {
        /* sized via setDiameter */
    }

    protected override updateHitArea(): void {
        /* circular hit area set in setDiameter */
    }

    protected override onHoverChange(hovered: boolean): void {
        if (hovered && !this.onClickLogo) return;
        tween(this.hoverContainer, { scale: hovered ? 1.1 : 1 }, { duration: 500, ease: 'OutElastic' });
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.bounceContainer, { scale: pressed ? 0.9 : 1 }, pressed
            ? { duration: 1000, ease: 'Out' }
            : { duration: 500, ease: 'OutElastic' });
    }

    protected override onClick(): void {
        uiSounds()?.play('Menu/osu-logo-select');
        this.flash.alpha = 0.4;
        tween(this.flash, { alpha: 0 }, { duration: 500, ease: 'OutQuint' });
        this.onClickLogo?.();
    }

    /** One beat pulse (also used for impact on transitions). */
    impact(strength = 1): void {
        this.beatContainer.scale.set(1 - 0.02 * strength);
        tween(this.beatContainer, { scale: 1 }, { duration: 600, ease: 'OutQuint' });
        this.flash.alpha = 0.1 * strength;
        tween(this.flash, { alpha: 0 }, { duration: 500, ease: 'OutQuint' });
    }

    private rippleOut(): void {
        this.ripple.scale.set(1);
        this.ripple.alpha = 0.25;
        tween(this.ripple, { scale: 1.3, alpha: 0 }, { duration: 800, ease: 'OutQuint' });
    }

    private tick(dt: number): void {
        const levels = this.audio.levels();
        const beat = this.audio.beat();
        this.visualiser.kiai = beat.kiai;
        this.visualiser.update(dt);
        this.sinceBeat += dt;
        if (!this.beatsEnabled) return;
        let isBeat = false;
        let kiai = beat.kiai;
        if (beat.beatLength > 0) {
            if (beat.beatIndex !== this.lastBeat) {
                this.lastBeat = beat.beatIndex;
                isBeat = true;
            }
        } else {
            // No timing info (online preview): detect bass onsets.
            this.bassAvg = damp(this.bassAvg, levels.bass, 300, dt);
            if (levels.bass > 0.35 && levels.bass > this.bassAvg * 1.25 && this.sinceBeat > 280) isBeat = true;
            kiai = levels.overall > 0.55;
        }
        if (isBeat) {
            this.sinceBeat = 0;
            const amp = Math.max(0.4, Math.min(1, levels.overall * 1.4));
            this.beatContainer.scale.set(1 - 0.02 * amp);
            tween(this.beatContainer, { scale: 1 }, { duration: Math.max(200, (beat.beatLength || 500) * 2), ease: 'OutQuint' });
            this.flash.alpha = (kiai ? 0.18 : 0.07) * amp;
            tween(this.flash, { alpha: 0 }, { duration: beat.beatLength || 400, ease: 'OutQuint' });
            if (kiai) {
                this.rippleOut();
                // lazer: the visualiser flares to 1.8× on kiai beats.
                this.visualiserFlash.alpha = 1.8 * amp;
                tween(this.visualiserFlash, { alpha: 1 }, { duration: beat.beatLength || 400 });
            }
        }
        // Loud passages shrink the logo slightly (lazer's amplitude scale).
        const target = 1 - Math.max(0, levels.overall - 0.4) * 0.06;
        this.amplitudeContainer.scale.set(damp(this.amplitudeContainer.scale.x, target, 60, dt));
    }

    get accent(): number {
        return Colors.pink;
    }
}
