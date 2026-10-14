import { Container, Texture } from 'pixi.js';
import type { LegacySkin, SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { ComboBurstSchedule, burstFrame, type BurstSide } from '../comboBurst';
import { sprite } from '../drawables/context';

/**
 * A skin's comboburst sounds: comboburst-0, comboburst-1… (or a lone
 * comboburst) from the first skin that has any; null entries are
 * deliberately silent files.
 */
export function comboBurstSounds(skins: readonly (LegacySkin | null | undefined)[]): (AudioBuffer | null)[] {
    for (const skin of skins) {
        if (!skin) continue;
        const out: (AudioBuffer | null)[] = [];
        for (let i = 0; ; i++) {
            const s = skin.sample(`comboburst-${i}`);
            if (s === undefined) break;
            out.push(s);
        }
        if (out.length) return out;
        const single = skin.sample('comboburst');
        if (single !== undefined) return [single];
    }
    return [];
}

/**
 * osu!stable's combo bursts (see gameplay/comboBurst): at a combo
 * milestone the skin's comboburst image (one of comboburst-N) slides in
 * from a side of the screen, sitting on its bottom edge, then fades; on
 * the right it's mirrored (the art faces right, toward the playfield).
 * Sizes follow stable's 1024×768 skin space scaled to the screen height.
 * Only skins with comboburst art show anything: wosu!'s default skin has
 * none. It runs on real time (stable's game clock), not song time.
 */
export class ComboBursts extends Container {
    /** The "Combo bursts" setting (images and sounds). */
    enabled = true;
    private readonly images: SkinTexture[];
    private readonly schedule: ComboBurstSchedule;
    private readonly burst = sprite(Texture.EMPTY, 1, 0);
    private side: BurstSide = 'right';
    private image: SkinTexture | null = null;
    /** ms since the current burst started (Infinity: none). */
    private elapsed = Infinity;
    private w = 1280;
    private h = 720;

    constructor(
        chain: SkinChain,
        private readonly sounds: readonly (AudioBuffer | null)[],
        private readonly play: (buffer: AudioBuffer) => void,
    ) {
        super();
        this.eventMode = 'none';
        this.images = chain.frames('comboburst');
        this.schedule = new ComboBurstSchedule({
            images: this.images.length,
            sounds: sounds.length,
            random: chain.config('comboBurstRandom'),
            customSounds: chain.config('customComboBurstSounds'),
        });
        this.burst.anchor.set(0, 1);
        this.burst.visible = false;
        this.addChild(this.burst);
    }

    /** The combo went up to `combo`. */
    onCombo(combo: number): void {
        if (!this.enabled) return;
        const sound = this.schedule.sound(combo);
        const buffer = sound >= 0 ? this.sounds[sound] : null;
        if (buffer) this.play(buffer);
        const ev = this.schedule.image(combo);
        if (!ev) return;
        this.image = this.images[ev.image];
        this.side = ev.side;
        this.burst.texture = this.image.texture;
        this.elapsed = 0;
        this.draw();
    }

    layout(w: number, h: number): void {
        this.w = w;
        this.h = h;
        this.draw();
    }

    /** Advance by `dt` ms of real time. */
    update(dt: number): void {
        if (this.elapsed === Infinity) return;
        this.elapsed += dt;
        this.draw();
    }

    private draw(): void {
        const f = this.enabled && this.image ? burstFrame(this.elapsed) : null;
        if (!f || !this.image) {
            this.burst.visible = false;
            if (!f) this.elapsed = Infinity;
            return;
        }
        const s = this.image.scale * (this.h / 768);
        const width = this.image.texture.width * s;
        const left = this.side === 'left';
        this.burst.visible = true;
        this.burst.alpha = f.alpha;
        // Mirrored on the right: anchored at its (flipped) left edge, which rests on the screen's right edge.
        this.burst.scale.set(left ? s : -s, s);
        this.burst.position.set(left ? -f.offset * width : this.w + f.offset * width, this.h);
    }
}
