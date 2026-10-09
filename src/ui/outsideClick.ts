import type { Container } from 'pixi.js';

/**
 * Call `fn` for every pointer press that lands outside all `targets`
 * (lazer's focused-overlay "click outside to close"). Listens on the
 * window in the capture phase, so presses on empty, non-interactive
 * parts of the scene count too. Returns an unsubscribe function.
 */
export function onPointerDownOutside(
    canvas: HTMLCanvasElement,
    targets: () => readonly (Container | null | undefined)[],
    fn: () => void,
): () => void {
    const handler = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        // Pixi's global space is CSS pixels relative to the canvas.
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        for (const t of targets()) {
            if (t && !t.destroyed && t.visible && t.getBounds().containsPoint(x, y)) return;
        }
        fn();
    };
    window.addEventListener('pointerdown', handler, true);
    return () => window.removeEventListener('pointerdown', handler, true);
}
