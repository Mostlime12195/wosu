import type { ModAcronym } from '../gameplay/mods';

/**
 * osu!stable's mod icon images (selection-mod-*.png), by mod. Mods stable
 * never had (Daycore, Difficulty Adjust) have none and keep wosu!'s badge.
 * Autopilot is "relax2" in stable's naming.
 */
export const MOD_ICON_ELEMENTS: Readonly<Partial<Record<ModAcronym, string>>> = {
    EZ: 'selection-mod-easy',
    NF: 'selection-mod-nofail',
    HT: 'selection-mod-halftime',
    HR: 'selection-mod-hardrock',
    SD: 'selection-mod-suddendeath',
    PF: 'selection-mod-perfect',
    DT: 'selection-mod-doubletime',
    NC: 'selection-mod-nightcore',
    HD: 'selection-mod-hidden',
    FL: 'selection-mod-flashlight',
    RX: 'selection-mod-relax',
    AP: 'selection-mod-relax2',
    SO: 'selection-mod-spunout',
    AT: 'selection-mod-autoplay',
};

/** The selection-mod-* images wosu! reads from a skin (only its own mods' icons get decoded). */
export const MOD_ICON_IMAGE_NAMES: readonly string[] = Object.values(MOD_ICON_ELEMENTS);

/** The stable image name of a mod's icon, or null when stable has none. */
export function modIconElement(acronym: ModAcronym): string | null {
    return MOD_ICON_ELEMENTS[acronym] ?? null;
}
