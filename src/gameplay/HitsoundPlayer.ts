import type { HitsoundName, LoopHandle, SampleBank, SampleName } from '../audio/SampleBank';
import { sampleSetName } from '../audio/SampleBank';
import type { PlayableBeatmap, PlayableHitObject, PlayableSlider, SampleSet } from '../beatmap/types';
import type { LegacySkin } from '../skin/LegacySkin';

/** Stereo spread by horizontal position (lazer's balance adjust). */
const PAN_AMOUNT = 0.8;

/**
 * Turns judgements into hitsounds with osu!'s sample rules: the normal
 * sample always plays from the normal set, whistle/finish/clap from the
 * addition set; set 0 inherits from the timing point (whose own 0 is the
 * map default), volume 0 inherits the timing point volume. Rate mods do
 * not pitch-shift hitsounds (osu! doesn't either).
 */
export class HitsoundPlayer {
    private readonly slides = new Map<number, LoopHandle[]>();
    private spin: LoopHandle | null = null;
    private spinIndex = -1;
    /**
     * Use the beatmap's own hitsound files (lazer's "Beatmap hitsounds").
     * Sample sets (normal/soft/drum) always follow the map, as in osu!.
     */
    useBeatmapSamples = true;

    constructor(
        private readonly samples: SampleBank,
        private readonly beatmap: PlayableBeatmap,
        private readonly custom: LegacySkin | null = null,
        /** The selected skin's hitsounds, used wherever the map doesn't override (index-less, like osu!). */
        private readonly userSkin: LegacySkin | null = null,
    ) {}

    /** osu!'s sample index: the object's own, else its timing point's (0 = the game's samples). */
    private indexAt(time: number, own = 0): number {
        return own || this.beatmap.controlPoints.at(time).sampleIndex;
    }

    /** The map's override for a sample (null = silenced), or undefined to use ours. */
    private override(set: number, name: HitsoundName, index: number): AudioBuffer | null | undefined {
        const key = `${sampleSetName(set)}-${name}`;
        if (this.custom && this.useBeatmapSamples && index !== 0) {
            const b = this.custom.sample(key, index);
            if (b !== undefined) return b;
        }
        const skin = this.userSkin?.sample(key);
        if (skin !== undefined) return skin;
        // Skins name the spinner sounds without a sample set ("spinnerspin.wav").
        return name === 'spinnerspin' || name === 'spinnerbonus' ? this.userSkin?.sample(name) : undefined;
    }

    private playOne(set: number, name: HitsoundName, index: number, volume: number, pan: number): void {
        const o = this.override(set, name, index);
        if (o === undefined) this.samples.play(`${sampleSetName(set)}-${name}` as SampleName, volume, { pan });
        else if (o) this.samples.playBuffer(o, volume, { pan });
    }

    private loop(set: number, name: HitsoundName, index: number, volume: number): LoopHandle {
        const o = this.override(set, name, index);
        if (o === undefined) return this.samples.startLoop(`${sampleSetName(set)}-${name}` as SampleName, volume);
        return this.samples.startLoopBuffer(o, volume);
    }

    /**
     * osu! hit sound layering: hitnormal always plays (normal set), then
     * whistle/finish/clap from the addition set. A hit object that names
     * its own sample file plays just that file instead.
     */
    private playHit(bits: number, normal: number, addition: number, index: number, volume: number, pan: number, filename = ''): void {
        if (filename && this.custom && this.useBeatmapSamples) {
            const f = this.custom.file(filename);
            if (f !== undefined) {
                if (f) this.samples.playBuffer(f, volume, { pan });
                return;
            }
        }
        this.playOne(normal, 'hitnormal', index, volume, pan);
        if (bits & 2) this.playOne(addition, 'hitwhistle', index, volume, pan);
        if (bits & 4) this.playOne(addition, 'hitfinish', index, volume, pan);
        if (bits & 8) this.playOne(addition, 'hitclap', index, volume, pan);
    }

    private pan(x: number): number {
        return (x / 512 - 0.5) * PAN_AMOUNT;
    }

    private sets(time: number, normal: SampleSet, addition: SampleSet): { normal: number; addition: number; volume: number } {
        const cp = this.beatmap.controlPoints.at(time);
        const n = normal || cp.sampleSet || 1;
        const a = addition || n;
        return { normal: n, addition: a, volume: cp.volume / 100 };
    }

    private volumeFor(h: PlayableHitObject, cpVolume: number): number {
        return h.hitSample.volume > 0 ? h.hitSample.volume / 100 : cpVolume;
    }

    /** Circle hit or spinner completion. */
    hit(h: PlayableHitObject): void {
        const time = h.kind === 'spinner' ? h.endTime : h.time;
        const s = this.sets(time, h.hitSample.normalSet, h.hitSample.additionSet);
        this.playHit(h.hitSound, s.normal, s.addition, this.indexAt(time, h.hitSample.index), this.volumeFor(h, s.volume), this.pan(h.x), h.hitSample.filename);
    }

    /** Slider head (edge 0), repeats and tail. */
    sliderEdge(h: PlayableSlider, edge: number, x: number): void {
        const time = h.time + edge * h.spanDuration;
        const sets = h.edgeSets[edge] ?? { normalSet: 0 as SampleSet, additionSet: 0 as SampleSet };
        const s = this.sets(time, sets.normalSet || h.hitSample.normalSet, sets.additionSet || h.hitSample.additionSet);
        const bits = h.edgeSounds[edge] ?? h.hitSound;
        this.playHit(bits, s.normal, s.addition, this.indexAt(time, h.hitSample.index), this.volumeFor(h, s.volume), this.pan(x));
    }

    tick(h: PlayableSlider, time: number, x: number): void {
        const s = this.sets(time, h.hitSample.normalSet, h.hitSample.additionSet);
        this.playOne(s.normal, 'slidertick', this.indexAt(time, h.hitSample.index), this.volumeFor(h, s.volume), this.pan(x));
    }

    /** Slider slide loop (and whistle loop when the slider whistles) while tracking. */
    setSliding(h: PlayableSlider, on: boolean): void {
        const active = this.slides.get(h.index);
        if (on === !!active) return;
        if (!on) {
            for (const l of active!) l.stop();
            this.slides.delete(h.index);
            return;
        }
        const s = this.sets(h.time, h.hitSample.normalSet, h.hitSample.additionSet);
        const vol = this.volumeFor(h, s.volume) * 0.6;
        const index = this.indexAt(h.time, h.hitSample.index);
        const loops = [this.loop(s.normal, 'sliderslide', index, vol)];
        if (h.hitSound & 2) loops.push(this.loop(s.addition, 'sliderwhistle', index, vol));
        this.slides.set(h.index, loops);
    }

    /** Spinner spin loop; pitch rises with progress like stable. */
    setSpinning(h: PlayableHitObject, on: boolean, progress: number): void {
        if (!on) {
            if (this.spinIndex === h.index) this.stopSpin();
            return;
        }
        if (this.spinIndex !== h.index) {
            this.stopSpin();
            const s = this.sets(h.time, h.hitSample.normalSet, h.hitSample.additionSet);
            this.spin = this.loop(s.normal, 'spinnerspin', this.indexAt(h.time, h.hitSample.index), this.volumeFor(h, s.volume) * 0.5);
            this.spinIndex = h.index;
        }
        this.spin?.setVolume(0.25 + 0.25 * Math.min(1, progress));
    }

    spinnerBonus(h: PlayableHitObject): void {
        const s = this.sets(h.endTime, h.hitSample.normalSet, h.hitSample.additionSet);
        this.playOne(s.normal, 'spinnerbonus', this.indexAt(h.endTime, h.hitSample.index), this.volumeFor(h, s.volume), this.pan(h.x));
    }

    comboBreak(): void {
        const map = this.useBeatmapSamples ? this.custom?.sample('combobreak') : undefined;
        const own = map !== undefined ? map : this.userSkin?.sample('combobreak');
        if (own !== undefined) {
            if (own) this.samples.playBuffer(own, 0.8);
            return;
        }
        this.samples.play('combobreak', 0.8);
    }

    private stopSpin(): void {
        this.spin?.stop();
        this.spin = null;
        this.spinIndex = -1;
    }

    /** Silence every loop (pause, fail, exit). */
    stopAll(): void {
        for (const loops of this.slides.values()) for (const l of loops) l.stop();
        this.slides.clear();
        this.stopSpin();
    }
}
