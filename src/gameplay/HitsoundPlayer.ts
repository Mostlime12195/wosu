import type { LoopHandle, SampleBank } from '../audio/SampleBank';
import { sampleSetName } from '../audio/SampleBank';
import type { PlayableBeatmap, PlayableHitObject, PlayableSlider, SampleSet } from '../beatmap/types';

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
    /** Ignore the map's sample sets (Settings → Audio → beatmap hitsounds off). */
    useBeatmapSets = true;

    constructor(private readonly samples: SampleBank, private readonly beatmap: PlayableBeatmap) {}

    private pan(x: number): number {
        return (x / 512 - 0.5) * PAN_AMOUNT;
    }

    private sets(time: number, normal: SampleSet, addition: SampleSet): { normal: number; addition: number; volume: number } {
        const cp = this.beatmap.controlPoints.at(time);
        if (!this.useBeatmapSets) return { normal: 1, addition: 1, volume: cp.volume / 100 };
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
        this.samples.playHit(h.hitSound, s.normal, s.addition, this.volumeFor(h, s.volume), this.pan(h.x));
    }

    /** Slider head (edge 0), repeats and tail. */
    sliderEdge(h: PlayableSlider, edge: number, x: number): void {
        const time = h.time + edge * h.spanDuration;
        const sets = h.edgeSets[edge] ?? { normalSet: 0 as SampleSet, additionSet: 0 as SampleSet };
        const s = this.sets(time, sets.normalSet || h.hitSample.normalSet, sets.additionSet || h.hitSample.additionSet);
        const bits = h.edgeSounds[edge] ?? h.hitSound;
        this.samples.playHit(bits, s.normal, s.addition, this.volumeFor(h, s.volume), this.pan(x));
    }

    tick(h: PlayableSlider, time: number, x: number): void {
        const s = this.sets(time, h.hitSample.normalSet, h.hitSample.additionSet);
        this.samples.playTick(s.normal, this.volumeFor(h, s.volume), this.pan(x));
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
        const loops = [this.samples.startLoop(`${sampleSetName(s.normal)}-sliderslide`, vol)];
        if (h.hitSound & 2) loops.push(this.samples.startLoop(`${sampleSetName(s.addition)}-sliderwhistle`, vol));
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
            this.spin = this.samples.startLoop(`${sampleSetName(s.normal)}-spinnerspin`, this.volumeFor(h, s.volume) * 0.5);
            this.spinIndex = h.index;
        }
        this.spin?.setVolume(0.25 + 0.25 * Math.min(1, progress));
    }

    spinnerBonus(h: PlayableHitObject): void {
        const s = this.sets(h.endTime, h.hitSample.normalSet, h.hitSample.additionSet);
        this.samples.play(`${sampleSetName(s.normal)}-spinnerbonus`, this.volumeFor(h, s.volume), { pan: this.pan(h.x) });
    }

    comboBreak(): void {
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
