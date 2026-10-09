import type { Game } from '../../app/Game';
import { checkboxRow, keyBindRow } from './rows';
import type { SectionDef } from './types';

export function inputSection(game: Game): SectionDef {
    const s = game.settings;
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
                ],
            },
            {
                title: 'Mouse',
                rows: [
                    checkboxRow('Mouse buttons in gameplay', s.mouseButtons, { keywords: 'click m1 m2', description: 'Turn off to only hit with the keyboard.' }),
                    checkboxRow('Mouse wheel changes volume in gameplay', s.wheelVolumeInGameplay, { keywords: 'scroll' }),
                ],
            },
        ],
    };
}
