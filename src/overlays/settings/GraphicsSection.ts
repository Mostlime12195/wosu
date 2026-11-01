import type { RendererPreference } from '../../app/App';
import type { Game } from '../../app/Game';
import { frameLimitOptions } from '../../app/frameLimit';
import { Colors } from '../../ui/theme';
import { checkboxRow, dropdownRow, mult, noticeRow, pct, sliderRow, textRow } from './rows';
import type { SectionDef } from './types';

export function graphicsSection(game: Game): SectionDef {
    const s = game.settings;
    const kind = game.app.rendererKind === 'webgpu' ? 'WebGPU' : 'WebGL';
    const fallback = game.app.fellBackFrom === 'webgpu' ? ' (WebGPU was requested but is unavailable here)' : '';
    const latency = game.app.lowLatency ? ', low latency'
        : game.app.lowLatencyUnsupported ? '; this browser can\'t do low latency mode' : '';
    return {
        id: 'graphics',
        title: 'Graphics',
        icon: 'desktop',
        subsections: [
            {
                title: 'Renderer',
                rows: [
                    dropdownRow<RendererPreference>('Renderer', [
                        { value: 'auto', label: 'Automatic (WebGPU, else WebGL)' },
                        { value: 'webgl', label: 'WebGL' },
                        { value: 'webgpu', label: 'WebGPU' },
                    ], s.renderer, { keywords: 'webgpu webgl gpu', description: 'Requires a restart.' }),
                    textRow(`Currently rendering with ${kind}${fallback}${latency}.`, { color: Colors.grayA, size: 12 }).row,
                    noticeRow('Some graphics changes take effect after a restart.', Colors.yellow, 'warning', {
                        visibleWhen: s.restartRequired,
                        action: { text: 'Restart now', onClick: () => game.restart() },
                        keywords: 'restart reload',
                    }),
                    dropdownRow('Frame limiter', frameLimitOptions(), s.frameLimit, {
                        keywords: 'fps framerate vsync unlimited uncapped',
                        description: 'Browsers show one frame per display refresh, so limits above your refresh rate only take effect '
                            + 'with low latency mode (during gameplay), where the browser supports it. For truly unlimited frame rates, '
                            + 'quit Chrome or Edge and start it with --disable-frame-rate-limit --disable-gpu-vsync, then pick VSync or '
                            + 'Unlimited (expect tearing and more power use).',
                    }),
                    checkboxRow('Low latency mode', s.lowLatency, {
                        keywords: 'latency input lag desynchronized tearing vsync',
                        description: 'Draws straight to the screen instead of through the browser\'s compositor, which can save a frame '
                            + 'of input lag and lets the frame limiter go above your refresh rate. May show screen tearing. Chrome and '
                            + 'Edge on Windows, ChromeOS and Android; other browsers ignore it. Uses WebGL. Requires a restart.',
                    }),
                    checkboxRow('Uncapped frame rate in menus', s.uncappedInMenus, {
                        keywords: 'fps framerate power battery',
                        description: 'Off: the frame limiter only goes above your refresh rate during gameplay, saving power in menus.',
                    }),
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
