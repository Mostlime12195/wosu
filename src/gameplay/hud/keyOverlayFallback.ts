import { Texture } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';

/**
 * wosu!'s own stand-ins for osu!'s inputoverlay-key and
 * inputoverlay-background (drawn here, not copied), at @2x and the
 * suggested sizes (43×46 and 193×55 units), so the legacy HUD layout
 * always has stable's key overlay even when a skin ships neither image.
 * The key is near-white so stable's press tints and the skin's
 * InputOverlayText colour (black by default) read on it.
 */
let key: SkinTexture | null = null;
let background: SkinTexture | null = null;

export function fallbackKeyTexture(): SkinTexture {
    key ??= { texture: draw(86, 92, (g, w, h) => {
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(1, '#d9d9e0');
        rounded(g, 3, 3, w - 6, h - 6, 14);
        g.fillStyle = grad;
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(40, 40, 60, 0.45)';
        g.stroke();
        // A soft top sheen, like a keycap.
        rounded(g, 9, 8, w - 18, (h - 16) * 0.45, 9);
        g.fillStyle = 'rgba(255, 255, 255, 0.55)';
        g.fill();
    }), scale: 0.5 };
    return key;
}

export function fallbackBackgroundTexture(): SkinTexture {
    // Drawn unrotated: x runs down the screen, y = 0 is the screen's right edge.
    background ??= { texture: draw(386, 110, (g, w, h) => {
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(w, 0);
        g.lineTo(w, h - 18);
        g.quadraticCurveTo(w, h, w - 18, h);
        g.lineTo(18, h);
        g.quadraticCurveTo(0, h, 0, h - 18);
        g.closePath();
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(20, 20, 32, 0.55)');
        grad.addColorStop(1, 'rgba(20, 20, 32, 0.75)');
        g.fillStyle = grad;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        g.stroke();
    }), scale: 0.5 };
    return background;
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
}

function draw(w: number, h: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return Texture.WHITE;
    paint(g, w, h);
    const tex = Texture.from(canvas);
    tex.source.autoGenerateMipmaps = false;
    return tex;
}
