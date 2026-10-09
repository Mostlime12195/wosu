import type { Game } from '../../app/Game';
import { Colors } from '../../ui/theme';
import { buttonRow, textRow } from './rows';
import type { SectionDef } from './types';

const REPO = 'https://github.com/mostlime12195/wosu';

const SHORTCUTS = [
    'Ctrl+O — settings',
    'Ctrl+D — beatmap listing',
    'Ctrl+N — notifications',
    'F6 — now playing',
    'F1 / F2 — mods / random (song select)',
    'Alt + wheel, Alt+↑/↓ — volume',
    'Ctrl+Shift+F — FPS counter',
    'F11 or Alt+Enter — fullscreen',
    'F12 — screenshot',
].join('\n');

export function generalSection(game: Game): SectionDef {
    const renderer = game.app.rendererKind === 'webgpu' ? 'WebGPU' : 'WebGL';
    return {
        id: 'general',
        title: 'General',
        icon: 'gear',
        subsections: [
            {
                title: 'About',
                rows: [
                    textRow(`wosu! · build ${__BUILD_INFO__} · rendering with ${renderer}`, { color: Colors.white, size: 14, keywords: 'version build' }).row,
                    textRow('An unofficial, open-source osu!standard client that runs entirely in your browser, drawn with PixiJS.', { keywords: 'about' }).row,
                    buttonRow('View source on GitHub', () => window.open(REPO, '_blank', 'noopener'), { icon: 'codeBranch', color: Colors.gray4, keywords: 'github source code' }),
                    textRow('osu! is a trademark of ppy Pty Ltd. Beatmaps come from community mirrors (SayoBot, Mino, NeriNyan). PixiJS (MIT), Exo 2 (OFL), Font Awesome Free (CC BY 4.0 / OFL), Signalsmith Stretch (MIT).', { color: Colors.gray9, size: 12, keywords: 'credits licences licenses' }).row,
                ],
            },
            {
                title: 'Shortcuts',
                rows: [textRow(SHORTCUTS, { keywords: 'keyboard shortcuts hotkeys fps' }).row],
            },
        ],
    };
}
