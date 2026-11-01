import type { Game } from '../../app/Game';
import type { ConfineMouseMode } from '../../settings/Settings';
import type { Slider } from '../../ui/Slider';
import type { UIComponent } from '../../ui/UIComponent';
import { checkboxRow, dropdownRow, keyBindRow, sliderRow } from './rows';
import type { SectionDef } from './types';
import { actionBindingSubsections } from './ActionBindings';

/** lazer's `{v:0.##}x`. */
const sensitivity = (v: number): string => `${Number(v.toFixed(2))}x`;

export function inputSection(game: Game): SectionDef {
    const s = game.settings;
    const sensitivityRow = sliderRow('Cursor sensitivity', s.cursorSensitivity, sensitivity, {
        keywords: 'speed velocity mouse raw',
        description: 'Applies everywhere, menus included, while High precision mouse is on (a browser can only scale the cursor while it holds the pointer). With raw input, 1x moves the cursor like your system cursor with acceleration off (osu!\'s raw input); without it, your system\'s speed and acceleration times this.',
    });
    const rawRow = checkboxRow('Raw input', s.rawInput, {
        keywords: 'acceleration unadjusted enhance pointer precision',
        description: 'Ignore your operating system\'s mouse acceleration, like osu!. Fast flicks then travel exactly as far as slow ones, so with macOS\'s strong default acceleration the cursor can feel slower until you raise the sensitivity. Turn off to keep your system\'s acceleration (scaled by the sensitivity).',
    });
    // lazer disables sensitivity unless high precision (relative) mode is on.
    s.highPrecisionMouse.bind(on => {
        (sensitivityRow.control as Slider).enabled = on;
        const raw = rawRow.control as UIComponent;
        raw.enabled = on;
        raw.alpha = on ? 1 : 0.5;
    }, true);
    return {
        id: 'input',
        title: 'Input',
        icon: 'keyboard',
        subsections: [
            {
                title: 'Keyboard',
                rows: [
                    keyBindRow('Left button', s.keyLeft, { keywords: 'k1 z' }),
                    keyBindRow('Right button', s.keyRight, { keywords: 'k2 x' }),
                    keyBindRow('Smoke', s.keySmoke, { keywords: 'smoke c draw' }),
                ],
            },
            {
                title: 'Mouse',
                rows: [
                    checkboxRow('High precision mouse', s.highPrecisionMouse, {
                        keywords: 'raw input relative cursor sensitivity speed velocity pointer lock',
                        description: 'Takes the pointer so Cursor sensitivity (and Raw input) apply. The game takes the pointer on your next click, in menus too, and draws its own cursor. Esc frees it (and pauses gameplay); click to take it back. Tablets and touch keep absolute positioning.',
                        tooltip: 'Uses the browser\'s pointer lock, like lazer\'s relative mouse mode. In fullscreen, hold Esc to leave.',
                    }),
                    rawRow,
                    sensitivityRow,
                    dropdownRow<ConfineMouseMode>('Confine mouse cursor to window', [
                        { value: 'never', label: 'Never' },
                        { value: 'duringGameplay', label: 'During Gameplay' },
                        { value: 'always', label: 'Always' },
                    ], s.confineMouse, {
                        keywords: 'pointer lock capture monitor',
                        description: 'Keeps the cursor inside the game (pointer lock), moving exactly like your system cursor. High precision mouse always confines it.',
                    }),
                    checkboxRow('Mouse buttons in gameplay', s.mouseButtons, { keywords: 'click m1 m2', description: 'Turn off to only hit with the keyboard.' }),
                    checkboxRow('Mouse wheel changes volume in gameplay', s.wheelVolumeInGameplay, { keywords: 'scroll' }),
                ],
            },
            // lazer's global action bindings (song select, in game, replay…), each rebindable.
            ...actionBindingSubsections(game),
        ],
    };
}
