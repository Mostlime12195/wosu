import type { Game } from '../../app/Game';
import { checkboxRow, ms, pct, sliderRow } from './rows';
import type { SectionDef } from './types';

export function audioSection(game: Game): SectionDef {
    const s = game.settings;
    return {
        id: 'audio',
        title: 'Audio',
        icon: 'volumeHigh',
        subsections: [
            {
                title: 'Volume',
                rows: [
                    sliderRow('Master', s.masterVolume, pct, { keywords: 'volume' }),
                    sliderRow('Music', s.musicVolume, pct, { keywords: 'volume song' }),
                    sliderRow('Effects', s.effectsVolume, pct, { keywords: 'volume hitsounds sfx' }),
                ],
            },
            {
                title: 'Offset',
                rows: [
                    sliderRow('Audio offset', s.audioOffset, ms, {
                        description: 'Positive values delay hit timing to compensate for audio latency. If every map feels early, increase it; if late, decrease it.',
                        keywords: 'latency sync delay',
                    }),
                ],
            },
            {
                title: 'Sounds',
                rows: [
                    checkboxRow('Interface sounds', s.uiSounds, { keywords: 'ui click hover' }),
                    checkboxRow('Menu music', s.menuMusic, { keywords: 'background song' }),
                    checkboxRow('Beatmap hitsounds', s.beatmapHitsounds, { keywords: 'whistle clap finish' }),
                ],
            },
        ],
    };
}
