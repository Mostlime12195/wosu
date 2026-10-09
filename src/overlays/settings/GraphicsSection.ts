import type { RendererPreference } from '../../app/App';
import type { Game } from '../../app/Game';
import { Colors } from '../../ui/theme';
import { checkboxRow, dropdownRow, mult, noticeRow, pct, sliderRow, textRow } from './rows';
import type { SectionDef } from './types';

export function graphicsSection(game: Game): SectionDef {
    const s = game.settings;
    const kind = game.app.rendererKind === 'webgpu' ? 'WebGPU' : 'WebGL';
    const fallback = game.app.fellBackFrom === 'webgpu' ? ' (WebGPU was requested but is unavailable here)' : '';
    return {
        id: 'graphics',
        title: 'Graphics',
        icon: 'desktop',
        subsections: [
            {
                title: 'Renderer',
                rows: [
                    dropdownRow<RendererPreference>('Renderer', [
                        { value: 'auto', label: 'Automatic (WebGL)' },
                        { value: 'webgl', label: 'WebGL' },
                        { value: 'webgpu', label: 'WebGPU (experimental)' },
                    ], s.renderer, { keywords: 'webgpu webgl gpu' }),
                    textRow(`Currently rendering with ${kind}${fallback}.`, { color: Colors.grayA, size: 12 }).row,
                    noticeRow('Some graphics changes take effect after a restart.', Colors.yellow, 'warning', {
                        visibleWhen: s.restartRequired,
                        action: { text: 'Restart now', onClick: () => game.restart() },
                        keywords: 'restart reload',
                    }),
                    dropdownRow('Frame limiter', [
                        { value: 0, label: 'VSync' },
                        { value: 30, label: '30 fps' },
                        { value: 60, label: '60 fps' },
                        { value: 120, label: '120 fps' },
                        { value: 144, label: '144 fps' },
                        { value: 240, label: '240 fps' },
                    ], s.frameLimit, { keywords: 'fps framerate' }),
                    checkboxRow('Show FPS counter', s.showFps, { keywords: 'framerate frame time' }),
                    checkboxRow('Anti-aliasing (MSAA)', s.antialias, { keywords: 'msaa smooth edges', description: 'Smooths shape edges. Requires a restart.' }),
                ],
            },
            {
                title: 'Layout',
                rows: [
                    sliderRow('Render resolution', s.resolutionScale, pct, { description: 'Lower values improve performance on slow devices.' }),
                    sliderRow('UI scale', s.uiScale, mult, { keywords: 'size interface' }),
                    checkboxRow('Background parallax', s.parallax, { keywords: 'parallax motion' }),
                ],
            },
        ],
    };
}
