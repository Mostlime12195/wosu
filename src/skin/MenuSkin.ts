import { Bindable } from '../core/Bindable';
import type { ModAcronym } from '../gameplay/mods';
import type { LegacySkin, SkinTexture } from './LegacySkin';
import { modIconElement } from './modIcons';

/**
 * The osu! skin the menus draw from, like osu!stable (where a skin also
 * changes the menus): the selected imported skin while Settings → Skin →
 * "Use skin in menus" is on, otherwise null (wosu!'s own lazer-style
 * menus). Game keeps it in sync; menu components read it and follow its
 * changes. Only the parts that fit wosu!'s lazer layout use it: the menu
 * cursor, interface sounds, the menu background, MenuGlow, mod icons and
 * the carousel text colours.
 */
export const menuSkin = new Bindable<LegacySkin | null>(null);

/** The menu skin's icon for a mod (selection-mod-*), or null for wosu!'s badge. */
export function menuModIcon(acronym: ModAcronym, skin: LegacySkin | null = menuSkin.value): SkinTexture | null {
    const name = modIconElement(acronym);
    return name && skin ? skin.texture(name) : null;
}
