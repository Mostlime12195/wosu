/**
 * osu!stable's interface sounds (https://osu.ppy.sh/wiki/Skinning/Sounds)
 * mapped onto the lazer UI sample slots wosu! plays them in. A skin that
 * has one of these replaces lazer's sample in that slot (when skins apply
 * to menus); otherwise lazer's own sample plays.
 */
import type { UISampleName } from './UISounds';

/** Per lazer slot: the stable sounds to try, in order. */
export const STABLE_UI_SOUNDS: Readonly<Partial<Record<UISampleName, readonly string[]>>> = {
    // click-short: hovering over selectable boxes, buttons and tabs.
    'UI/default-hover': ['click-short'],
    'UI/button-hover': ['click-short'],
    'UI/button-sidebar-hover': ['click-short'],
    'UI/toolbar-hover': ['click-short'],
    // click-short-confirm: confirming a button, dropdown option or tab.
    'UI/default-select': ['click-short-confirm'],
    'UI/button-select': ['click-short-confirm'],
    'UI/button-sidebar-select': ['click-short-confirm'],
    'UI/toolbar-select': ['click-short-confirm'],
    'UI/tabselect-select': ['click-short-confirm'],
    'UI/submit-select': ['click-short-confirm'],
    'UI/dialog-ok-select': ['click-short-confirm'],
    'UI/dialog-dangerous-select': ['click-short-confirm'],
    'UI/dialog-cancel-select': ['click-short-confirm'],
    // Checkboxes and mods.
    'UI/check-on': ['check-on'],
    'UI/check-off': ['check-off'],
    // Slider bars.
    'UI/notch-tick': ['sliderbar'],
    // select-expand: opening dropdowns (and menus like them).
    'UI/dropdown-open': ['select-expand'],
    'UI/menu-open': ['select-expand'],
    // menuback: returning to the previous screen.
    'UI/screen-back': ['menuback'],
    // menuhit: confirming a selection that switches screens (the osu! cookie, starting a beatmap).
    'Menu/osu-logo-select': ['menuhit'],
    'SongSelect/confirm-selection': ['menuhit'],
    // Song select carousel.
    'SongSelect/select-expand': ['select-expand'],
    'SongSelect/select-difficulty': ['select-difficulty'],
    // Typing (stable's names are lazer's).
    'Keyboard/key-press-1': ['key-press-1'],
    'Keyboard/key-press-2': ['key-press-2'],
    'Keyboard/key-press-3': ['key-press-3'],
    'Keyboard/key-press-4': ['key-press-4'],
    'Keyboard/key-delete': ['key-delete'],
    'Keyboard/key-confirm': ['key-confirm'],
    'Keyboard/key-movement': ['key-movement'],
};

/** Main menu buttons: stable has a hover and a click sound for each (menu-<name>-hover / -click). */
export type StableMenuButton = 'play' | 'freeplay' | 'multiplayer' | 'edit' | 'direct' | 'options' | 'exit' | 'back';

export function menuButtonSounds(button: StableMenuButton): { hover: string; click: string } {
    return { hover: `menu-${button}-hover`, click: `menu-${button}-click` };
}

const MENU_BUTTONS: readonly StableMenuButton[] = ['play', 'freeplay', 'multiplayer', 'edit', 'direct', 'options', 'exit', 'back'];

/** Sounds wosu! plays only from a skin (lazer has no sample for them). */
export const STABLE_SKIN_ONLY_SOUNDS = {
    /** Hovering the osu! cookie. */
    heartbeat: 'heartbeat',
    /** The client starting (the intro). */
    welcome: 'welcome',
    /** The client closing (the main menu's exit). */
    seeya: 'seeya',
    /** Taking a screenshot. */
    shutter: 'shutter',
    /** Hovering a difficulty in song select (instead of click-short). */
    menuclick: 'menuclick',
    /** The back button. */
    backButtonHover: 'back-button-hover',
    backButtonClick: 'back-button-click',
} as const;

/** Every stable interface sound name a skin may provide (for the skin loader). */
export const STABLE_UI_SAMPLE_NAMES: readonly string[] = [
    ...new Set([
        ...Object.values(STABLE_UI_SOUNDS).flat(),
        ...MENU_BUTTONS.flatMap(b => Object.values(menuButtonSounds(b))),
        ...Object.values(STABLE_SKIN_ONLY_SOUNDS),
        'click-close',
    ]),
];

/**
 * The skin's version of a sound: the first of `names` the skin has.
 * `buffer: null` means the skin silences it deliberately (a blank file);
 * undefined (no result) means none of them is in the skin.
 */
export function resolveSkinSound(
    names: readonly string[],
    lookup: (name: string) => AudioBuffer | null | undefined,
): { name: string; buffer: AudioBuffer | null } | undefined {
    for (const name of names) {
        const buffer = lookup(name);
        if (buffer !== undefined) return { name, buffer };
    }
    return undefined;
}
