import type { FlashlightSettings } from './mods';

/**
 * The Flashlight mod's logic, ported from lazer's ModFlashlight and
 * OsuModFlashlight (rendering lives in Flashlight.ts). Everything is in
 * osu! playfield units and gameplay milliseconds: lazer's flashlight runs
 * on the gameplay clock, so rate mods speed its animations up and pausing
 * freezes them.
 */

/** OsuModFlashlight.DefaultFlashlightSize (playfield units). */
export const FLASHLIGHT_DEFAULT_SIZE = 125;
/** OsuFlashlight.FlashlightSmoothness: the edge fades from r to 1.4 r (sh_CircularFlashlight). */
export const FLASHLIGHT_SMOOTHNESS = 1.4;
/** ModFlashlight.BreakTimeScale (= 8.0 / 3.2, stable). */
export const BREAK_TIME_SCALE = 2.5;
/**
 * OsuFlashlight.OnSliderTrackingChange: while a started slider is tracked
 * the remaining visible area is mixed 80% towards black (FlashlightDim).
 */
export const SLIDER_DIM = 0.8;
/**
 * OsuFlashlight.scale_animation_speed: stable's 0.1 units per 60 fps frame,
 * relative to the default size (1.875 / 1000 per ms).
 */
const SCALE_ANIMATION_SPEED = 1.875 / 1000;

/**
 * ModFlashlight.GetComboScaleFor (stable's Ruleset.cs sizes, relative to
 * the size at 0 combo): smaller from 100 and again from 200 combo.
 */
export function comboScaleFor(combo: number): number {
    if (combo >= 200) return 0.625; // 2.0 / 3.2
    if (combo >= 100) return 0.8125; // 2.6 / 3.2
    return 1;
}

/** ModFlashlight.Flashlight.GetSize: radius in playfield units. */
export function flashlightTargetSize(settings: FlashlightSettings, combo: number, inBreak: boolean): number {
    let size = FLASHLIGHT_DEFAULT_SIZE * settings.sizeMultiplier;
    if (inBreak) size *= BREAK_TIME_SCALE;
    else if (settings.comboBasedSize) size *= comboScaleFor(combo);
    return size;
}

/** osu-framework's Easing.Out (OutQuad). */
function easeOut(t: number): number {
    return t * (2 - t);
}

export interface FlashlightFrame {
    /** Cursor position (playfield units). */
    cursorX: number;
    cursorY: number;
    combo: number;
    inBreak: boolean;
    /** A started slider is being tracked (held) right now. */
    sliderTracking: boolean;
}

export class FlashlightState {
    /** Flashlight centre (playfield units). */
    x = 0;
    y = 0;
    /** Current radius (playfield units); animates towards the target. */
    size: number;
    /** 0..1 mix towards black over the visible area. */
    dim = 0;
    private placed = false;

    constructor(readonly settings: FlashlightSettings) {
        // lazer starts at GetSize() with no transition (combo 0, not in a break).
        this.size = flashlightTargetSize(settings, 0, false);
    }

    /**
     * Advance by `dt` gameplay ms.
     *
     * Position: OsuFlashlight.OnMouseMove eases towards the cursor every
     * frame, covering Easing.Out(min(|elapsed|, followDelay) / followDelay)
     * of the remaining distance (a seek or long frame snaps).
     *
     * Size: UpdateFlashlightSize runs a linear transform whose duration is
     * |Δsize| / DefaultFlashlightSize / scale_animation_speed, restarted on
     * every combo or break change; that is a constant approach speed of
     * DefaultFlashlightSize × 1.875 / 1000 units per ms.
     */
    update(dt: number, f: FlashlightFrame): void {
        if (!this.placed) {
            this.placed = true;
            this.x = f.cursorX;
            this.y = f.cursorY;
        } else {
            const delay = this.settings.followDelay;
            const t = delay > 0 ? Math.min(Math.abs(dt), delay) / delay : 1;
            const k = easeOut(t);
            this.x += (f.cursorX - this.x) * k;
            this.y += (f.cursorY - this.y) * k;
        }
        const target = flashlightTargetSize(this.settings, f.combo, f.inBreak);
        const step = Math.abs(dt) * FLASHLIGHT_DEFAULT_SIZE * SCALE_ANIMATION_SPEED;
        if (Math.abs(target - this.size) <= step) this.size = target;
        else this.size += Math.sign(target - this.size) * step;
        this.dim = f.sliderTracking ? SLIDER_DIM : 0;
    }
}
