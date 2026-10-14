/**
 * osu!stable's combo bursts (osu! wiki: Gameplay/Combo_milestone,
 * Skinning/osu! "Comboburst", Skinning/Sounds, skin.ini ComboBurstRandom /
 * CustomComboBurstSounds): at a combo milestone a comboburst image slides
 * in from a side of the screen and a comboburst sound plays. Pure logic;
 * the drawable is gameplay/hud/ComboBursts.
 */

/** osu!'s combo milestones: 30x, 60x, 100x, then every multiple of 50. */
export function isComboMilestone(combo: number): boolean {
    return combo === 30 || combo === 60 || (combo >= 100 && combo % 50 === 0);
}

/** Position of a milestone in the run: 30 → 0, 60 → 1, 100 → 2, 150 → 3… (-1 if not one). */
export function milestoneOrdinal(combo: number): number {
    if (!isComboMilestone(combo)) return -1;
    if (combo === 30) return 0;
    if (combo === 60) return 1;
    return 2 + (combo - 100) / 50;
}

export type BurstSide = 'left' | 'right';

export interface BurstEvent {
    /** Which comboburst image (index into the skin's comboburst-N set), or -1 for none. */
    image: number;
    side: BurstSide;
}

export interface BurstOptions {
    /** comboburst-N images the skin has (1 for a lone comboburst, 0 for none). */
    images: number;
    /** comboburst-N sounds the skin has (1 for a lone comboburst sound, 0 for none). */
    sounds: number;
    /** skin.ini ComboBurstRandom. */
    random?: boolean;
    /** skin.ini CustomComboBurstSounds: combos that play a sound instead of the milestones. */
    customSounds?: readonly number[];
    /** Random source (tests). */
    rng?: () => number;
}

/**
 * Decides, for every combo increase, whether a burst image shows (and
 * which, on which side) and whether a burst sound plays (and which).
 *
 * Images go in turn through the set (comboburst-0, -1, … from the run's
 * first milestone), or at random with ComboBurstRandom; the sides
 * alternate, starting on the right. Sounds play at the milestones, or only
 * at the CustomComboBurstSounds combos when the skin lists any (that list
 * changes only the sounds, not the milestones), likewise in turn or at
 * random.
 */
export class ComboBurstSchedule {
    private bursts = 0;
    private readonly rng: () => number;

    constructor(private readonly o: BurstOptions) {
        this.rng = o.rng ?? Math.random;
    }

    /** The image to show when the combo reaches `combo`, or null. */
    image(combo: number): BurstEvent | null {
        const ordinal = milestoneOrdinal(combo);
        if (ordinal < 0 || this.o.images <= 0) return null;
        const n = this.o.images;
        const image = this.o.random ? Math.floor(this.rng() * n) % n : ordinal % n;
        const side: BurstSide = this.bursts++ % 2 === 0 ? 'right' : 'left';
        return { image, side };
    }

    /** The sound (index into the skin's comboburst-N sounds) to play when the combo reaches `combo`, or -1. */
    sound(combo: number): number {
        const n = this.o.sounds;
        if (n <= 0) return -1;
        const custom = this.o.customSounds ?? [];
        let ordinal: number;
        if (custom.length) {
            ordinal = custom.indexOf(combo);
        } else {
            ordinal = milestoneOrdinal(combo);
        }
        if (ordinal < 0) return -1;
        return this.o.random ? Math.floor(this.rng() * n) % n : ordinal % n;
    }
}

/** Slide-in time (ms) from fully off screen to touching the screen edge. */
export const BURST_SLIDE = 700;
/** Fade-out time (ms) once the image has arrived. */
export const BURST_FADE = 960;
/** Opacity the image slides in at. */
export const BURST_ALPHA = 0.8;

/**
 * A burst `dt` ms after it started: `offset` 1 → 0 is how far (in image
 * widths) it still is from its resting place at the screen edge, `alpha`
 * its opacity; null once it's gone.
 */
export function burstFrame(dt: number): { offset: number; alpha: number } | null {
    if (dt < 0 || dt >= BURST_SLIDE + BURST_FADE) return null;
    if (dt < BURST_SLIDE) {
        // Eased out (1 − OutQuad).
        const t = 1 - dt / BURST_SLIDE;
        return { offset: t * t, alpha: BURST_ALPHA };
    }
    return { offset: 0, alpha: BURST_ALPHA * (1 - (dt - BURST_SLIDE) / BURST_FADE) };
}
