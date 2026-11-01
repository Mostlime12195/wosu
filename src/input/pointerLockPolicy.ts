import type { ConfineMouseMode } from '../settings/Settings';

export interface PointerLockDemand {
    /** "High precision mouse" (lazer's relative mode with raw input). */
    highPrecision: boolean;
    /** "Confine mouse cursor to window". */
    confine: ConfineMouseMode;
    /** "Use system cursor in menus": the OS cursor can only show while the pointer is free. */
    systemCursorInMenus: boolean;
    /** A gameplay screen is up (playing, paused, failed…). */
    gameplay: boolean;
    /** The player is aiming (lazer's LocalUserPlaying): what "During gameplay" confines to. */
    aiming: boolean;
}

/**
 * Whether the game wants the pointer locked, the browser's stand-in for
 * lazer's relative mouse mode and its cursor confinement:
 *
 * - High precision mouse: everywhere (menus too, like lazer), so the
 *   cursor sensitivity applies everywhere.
 * - Confine "Always": everywhere, the cursor moving 1:1 with the OS's.
 * - Confine "During gameplay": while the player aims.
 *
 * The system cursor in menus needs a free pointer, so with it on, menus
 * stay unlocked and only gameplay locks.
 */
export function pointerLockWanted(d: PointerLockDemand): boolean {
    const everywhere = d.highPrecision || d.confine === 'always';
    if (everywhere) return d.gameplay || !d.systemCursorInMenus;
    return d.confine === 'duringGameplay' && d.aiming;
}
