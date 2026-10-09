import type { Game } from '../../app/Game';
import type { HudVisibility, KeyOverlayStyle } from '../../settings/Settings';
import { checkboxRow, dropdownRow, mult, pct, sliderRow } from './rows';
import type { SectionDef } from './types';

export function gameplaySection(game: Game): SectionDef {
    const s = game.settings;
    return {
        id: 'gameplay',
        title: 'Gameplay',
        icon: 'circlePlay',
        subsections: [
            {
                title: 'Background',
                rows: [
                    sliderRow('Background dim', s.backgroundDim, pct, { keywords: 'dark' }),
                    sliderRow('Background blur', s.backgroundBlur, pct),
                    checkboxRow('Background video', s.backgroundVideo, { description: 'Plays map videos behind the playfield. Affects maps downloaded after enabling (SayoBot downloads never include video).', keywords: 'storyboard' }),
                ],
            },
            {
                title: 'Hit objects',
                rows: [
                    checkboxRow('Snaking sliders in', s.snakingIn, { keywords: 'slider snake' }),
                    checkboxRow('Snaking sliders out', s.snakingOut, { keywords: 'slider snake' }),
                    checkboxRow('Hit lighting', s.hitLighting, { keywords: 'glow flash' }),
                    checkboxRow('Hide combo numbers', s.hideNumbers),
                    checkboxRow('Hide "Great" judgements', s.hideGreat, { keywords: '300' }),
                    checkboxRow('Hide follow points', s.hideFollowPoints, { keywords: 'connecting lines' }),
                    checkboxRow('Kiai flashes on hit objects', s.kiaiFlash, {
                        description: "lazer's default skin flashes circles on every beat of a kiai section. osu!stable never does this.",
                        keywords: 'beat pulse flash kiai',
                    }),
                ],
            },
            {
                title: 'HUD',
                rows: [
                    dropdownRow<HudVisibility>('HUD visibility mode', [
                        { value: 'always', label: 'Always' },
                        { value: 'hideDuringGameplay', label: 'Hide during gameplay' },
                        { value: 'never', label: 'Never' },
                    ], s.hudVisibility, {
                        description: '"Hide during gameplay" still shows it in breaks and while paused. Shift+Tab cycles the modes in game; hold Ctrl to peek.',
                        keywords: 'interface overlay show hide hud',
                    }),
                    sliderRow('HUD scale', s.hudScale, mult, { keywords: 'interface size' }),
                    checkboxRow('Score', s.hudScore, { keywords: 'hud counter' }),
                    checkboxRow('Accuracy', s.hudAccuracy, { keywords: 'hud percent' }),
                    checkboxRow('Combo counter', s.hudCombo, { keywords: 'hud' }),
                    checkboxRow('Health bar', s.hudHealthBar, { keywords: 'hp hud' }),
                    checkboxRow('Show health bar even when you can\'t fail', s.hudHealthWhenCantFail, { keywords: 'hp no fail autoplay relax hud' }),
                    checkboxRow('Song progress bar', s.progressBar, { keywords: 'time hud' }),
                    checkboxRow('Show difficulty graph on progress bar', s.progressGraph, { keywords: 'density strain hud' }),
                    checkboxRow('Hit error meter', s.hitErrorMeter, { keywords: 'timing unstable rate hud' }),
                    checkboxRow('Key overlay', s.keyOverlay, { keywords: 'keys counter hud' }),
                    dropdownRow<KeyOverlayStyle>('Key overlay style', [
                        { value: 'lazer', label: 'lazer (2 keys, keyboard + mouse combined)' },
                        { value: 'stable', label: 'stable (K1 K2 M1 M2)' },
                    ], s.keyOverlayStyle, { keywords: 'keys counter mouse hud' }),
                    checkboxRow('Break overlay', s.hudBreakOverlay, { keywords: 'countdown rest hud' }),
                ],
            },
            {
                title: 'General',
                rows: [checkboxRow('Fullscreen when playing', s.fullscreenOnPlay)],
            },
        ],
    };
}
