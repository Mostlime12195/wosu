import type { Game } from '../../app/Game';
import type { ConfineMouseMode } from '../../settings/Settings';
import type { Slider } from '../../ui/Slider';
import { checkboxRow, dropdownRow, keyBindRow, sliderRow } from './rows';
import type { SectionDef } from './types';
import { actionBindingSubsections } from './ActionBindings';

/** lazer's `{v:0.##}x`. */
const sensitivity = (v: number): string => `${Number(v.toFixed(2))}x`;

export function inputSection(game: Game): SectionDef {
    const s = game.settings;
    const sensitivityRow = sliderRow('Cursor sensitivity', s.cursorSensitivity, sensitivity, {
        keywords: 'speed velocity mouse raw',
    });
    // lazer disables sensitivity unless high precision (relative) mode is on.
    s.highPrecisionMouse.bind(on => ((sensitivityRow.control as Slider).enabled = on), true);
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
                        description: 'Attempts to bypass any operating system mouse acceleration. During gameplay the pointer is locked to the game; Esc pauses and frees it. Tablets and touch keep absolute positioning.',
                    }),
                    sensitivityRow,
                    dropdownRow<ConfineMouseMode>('Confine mouse cursor to window', [
                        { value: 'never', label: 'Never' },
                        { value: 'duringGameplay', label: 'During Gameplay' },
                    ], s.confineMouse, {
                        keywords: 'pointer lock capture monitor',
                        description: 'Keeps the cursor inside the game while playing (pointer lock). High precision mouse always does.',
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
