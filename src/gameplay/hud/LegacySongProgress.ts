import { Container, Graphics } from 'pixi.js';

export interface SongProgressState {
    /** 0..1 through the intro (`intro`) or through the hit objects. */
    progress: number;
    /** Before the first hit object. */
    intro: boolean;
}

/**
 * lazer's SongProgress.Update: before the first object, progress through
 * the intro (from the gameplay clock's start); after it, progress from the
 * first object's start to the last object's end. Time past the last
 * object counts as the end.
 */
export function songProgressAt(time: number, introStart: number, firstHit: number, lastHit: number): SongProgressState {
    const t = Math.min(time, lastHit);
    if (t < firstHit) {
        const length = firstHit - introStart;
        return { progress: length > 0 ? clamp01((t - introStart) / length) : 1, intro: true };
    }
    const length = lastHit - firstHit;
    return { progress: length > 0 ? clamp01((t - firstHit) / length) : 0, intro: false };
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The pie's size (lazer units): a 33-unit ring, the pie at 0.92 of it. */
export const PIE_SIZE = 33;
const PIE_RADIUS = (PIE_SIZE * 0.92) / 2;
const BORDER = 2;
const DOT = 4;
/** lazer's colours: white at 60% while playing, lime at 60% during the intro. */
const PLAY_COLOUR = 0xffffff;
const INTRO_COLOUR = 0xc7ff2f;
const PIE_ALPHA = 153 / 255;
/** Redraw once the pie's edge has moved this far (radians). */
const REDRAW_STEP = 0.004;

/**
 * lazer's LegacySongProgress (stable's progress pie, next to the accuracy
 * in the legacy HUD layout): a white ring with a centre dot and a pie
 * filling clockwise from 12 o'clock through the map. During the intro the
 * pie is mirrored and lime, emptying towards the first object.
 * Units are lazer's; the origin is the ring's right edge, centred
 * vertically (lazer's Origin.CentreRight).
 */
export class LegacySongProgress extends Container {
    private readonly pie = new Graphics();
    private shownAngle = NaN;
    private shownIntro: boolean | null = null;

    constructor(private readonly introStart: number, private readonly firstHit: number, private readonly lastHit: number) {
        super();
        this.eventMode = 'none';
        const ring = new Graphics()
            .circle(-PIE_SIZE / 2, 0, PIE_SIZE / 2 - BORDER / 2)
            .stroke({ width: BORDER, color: 0xffffff })
            .circle(-PIE_SIZE / 2, 0, DOT / 2)
            .fill(0xffffff);
        this.addChild(this.pie, ring);
    }

    /** Its box in lazer units (origin centre right). */
    get box(): { x: number; y: number; w: number; h: number } {
        return { x: -PIE_SIZE, y: -PIE_SIZE / 2, w: PIE_SIZE, h: PIE_SIZE };
    }

    update(time: number): void {
        const { progress, intro } = songProgressAt(time, this.introStart, this.firstHit, this.lastHit);
        // The intro pie is mirrored and shows what is left of the intro.
        const angle = (intro ? 1 - progress : progress) * Math.PI * 2;
        if (intro === this.shownIntro && Math.abs(angle - this.shownAngle) < REDRAW_STEP) return;
        this.shownIntro = intro;
        this.shownAngle = angle;
        const g = this.pie.clear();
        if (angle <= 0) return;
        const cx = -PIE_SIZE / 2;
        const top = -Math.PI / 2;
        const colour = intro ? INTRO_COLOUR : PLAY_COLOUR;
        if (angle >= Math.PI * 2 - 1e-6) {
            g.circle(cx, 0, PIE_RADIUS).fill({ color: colour, alpha: PIE_ALPHA });
            return;
        }
        g.moveTo(cx, 0)
            .arc(cx, 0, PIE_RADIUS, top, intro ? top - angle : top + angle, intro)
            .closePath()
            .fill({ color: colour, alpha: PIE_ALPHA });
    }
}
