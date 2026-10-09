import type { Game } from '../../app/Game';
import { checkboxRow, mult, sliderRow } from './rows';
import type { SectionDef } from './types';

export function skinSection(game: Game): SectionDef {
    const s = game.settings;
    return {
        id: 'skin',
        title: 'Skin',
        icon: 'brush',
        subsections: [
            {
                title: 'Beatmap',
                rows: [
                    checkboxRow('Beatmap skins', s.beatmapSkin, {
                        description: "Use the hit circles, numbers, slider and judgement images and the colours that a beatmap ships with. Its own hitsounds are under Audio → Beatmap hitsounds.",
                        keywords: 'skin custom colours colors',
                    }),
                ],
            },
            {
                title: 'Cursor',
                rows: [
                    sliderRow('Menu cursor size', s.menuCursorSize, mult, { keywords: 'cursor scale' }),
                    sliderRow('Gameplay cursor size', s.cursorSize, mult, { keywords: 'cursor scale' }),
                    checkboxRow('Adjust gameplay cursor size based on current beatmap', s.autoCursorSize, { keywords: 'cursor circle size auto' }),
                    checkboxRow('Show cursor trail', s.cursorTrail, { keywords: 'cursor trail' }),
                    checkboxRow('Expand cursor when pressed', s.cursorExpand, { keywords: 'cursor pulse click' }),
                    checkboxRow('Rotate cursor when dragging', s.cursorRotation, { keywords: 'cursor rotation drag' }),
                    checkboxRow('Show gameplay cursor during touch input', s.gameplayCursorDuringTouch, { keywords: 'cursor touchscreen mobile' }),
                    checkboxRow('Use hardware cursor in menus', s.hardwareCursor, { keywords: 'cursor system mouse pointer' }),
                ],
            },
        ],
    };
}
