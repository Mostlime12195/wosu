import type { Game } from '../../app/Game';
import { browseProviders, downloadProviders, type ProviderId } from '../../online/providers';
import { Colors } from '../../ui/theme';
import { dropdownRow, textBoxRow, textRow } from './rows';
import type { SectionDef } from './types';

export function onlineSection(game: Game): SectionDef {
    const s = game.settings;
    const items = (list: { id: ProviderId; name: string }[]) => list.map(p => ({ value: p.id, label: p.name }));
    return {
        id: 'online',
        title: 'Online',
        icon: 'globe',
        subsections: [
            {
                title: 'Beatmap mirrors',
                rows: [
                    dropdownRow('Browse beatmaps with', items(browseProviders()), s.browseProvider, { keywords: 'provider sayobot mino search listing' }),
                    dropdownRow('Download beatmaps with', items(downloadProviders()), s.downloadProvider, { keywords: 'provider mino nerinyan mirror' }),
                    textRow('Covers and audio previews always come from SayoBot, the only mirror whose images can be drawn by the GPU (it sends CORS headers).', { color: Colors.gray9, size: 12 }).row,
                ],
            },
            {
                title: 'Profile',
                rows: [textBoxRow('Player name', s.playerName, { placeholder: 'Guest', maxLength: 24, keywords: 'username nickname' })],
            },
        ],
    };
}
