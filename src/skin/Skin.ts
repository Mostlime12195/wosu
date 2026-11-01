import { Assets, BufferImageSource, Texture } from 'pixi.js';
import { BALL_SIZE, makeSliderBallData } from './ballData';

const BASE = import.meta.env.BASE_URL;

/**
 * wosu!'s own UI textures: procedurally generated shapes (drawn once with
 * Canvas 2D for clean anti-aliased edges, then uploaded), the default
 * menu background and the Venera bitmap font.
 *
 * Only the generated textures exist before the intro: the intro shows no
 * background (it is fully dimmed) and Venera is a gameplay/results font,
 * so their downloads wait until after the first screen (loadDeferred).
 */
export class Skin {
    readonly generated = new Map<string, Texture>();
    defaultBackground: Texture = Texture.EMPTY;
    private background: Promise<Texture> | null = null;
    private deferred: Promise<void> | null = null;

    load(): void {
        this.generate();
    }

    /** The default menu background (the main menu needs it first). Idempotent. */
    loadBackground(): Promise<Texture> {
        this.background ??= Assets.load<Texture>(`${BASE}assets/skin/defaultbg.jpg`)
            .catch(() => Texture.EMPTY)
            .then(t => (this.defaultBackground = t));
        return this.background;
    }

    /** The default background and Venera; resolves once both settled. Idempotent. */
    loadDeferred(): Promise<void> {
        this.deferred ??= Promise.all([
            this.loadBackground(),
            Assets.load(`${BASE}assets/fonts/venera.fnt`).catch(e => console.warn('venera font failed to load', e)),
        ]).then(() => undefined);
        return this.deferred;
    }

    /** Generated texture by name (e.g. "sliderb.png"). */
    get(name: string): Texture {
        return this.generated.get(name) ?? Texture.EMPTY;
    }

    has(name: string): boolean {
        return this.generated.has(name);
    }

    tex(name: GeneratedTexture): Texture {
        return this.generated.get(name) ?? Texture.WHITE;
    }

    private generate(): void {
        const ball = makeSliderBallData();
        this.generated.set('sliderb.png', premultipliedTexture(ball.data, BALL_SIZE, BALL_SIZE));

        this.generated.set('triangle', canvasTexture(256, 222, (g, w, h) => {
            g.beginPath();
            g.moveTo(w / 2, 1);
            g.lineTo(w - 1, h - 1);
            g.lineTo(1, h - 1);
            g.closePath();
            g.fillStyle = '#fff';
            g.fill();
        }));
        this.generated.set('circle', canvasTexture(256, 256, (g, w) => {
            g.beginPath();
            g.arc(w / 2, w / 2, w / 2 - 1, 0, Math.PI * 2);
            g.fillStyle = '#fff';
            g.fill();
        }));
        this.generated.set('ring', canvasTexture(256, 256, (g, w) => {
            g.beginPath();
            g.arc(w / 2, w / 2, w / 2 - 10, 0, Math.PI * 2);
            g.lineWidth = 16;
            g.strokeStyle = '#fff';
            g.stroke();
        }));
        this.generated.set('glow', canvasTexture(256, 256, (g, w) => {
            const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, w, w);
        }));
        // Horizontal/vertical alpha ramps for fades and panel shading.
        this.generated.set('fadeRight', canvasTexture(256, 4, (g, w, h) => {
            const grad = g.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, w, h);
        }));
        this.generated.set('fadeDown', canvasTexture(4, 256, (g, w, h) => {
            const grad = g.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(0, 0, w, h);
        }));
        // Flashlight: transparent hole with a soft rim in an opaque field.
        this.generated.set('flashlight', canvasTexture(512, 512, (g, w) => {
            const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(0.7, 'rgba(0,0,0,0)');
            grad.addColorStop(1, 'rgba(0,0,0,1)');
            g.fillStyle = grad;
            g.fillRect(0, 0, w, w);
        }));
    }
}

export type GeneratedTexture =
    | 'triangle' | 'circle' | 'ring' | 'glow' | 'fadeRight' | 'fadeDown' | 'flashlight' | 'sliderb.png';

function premultipliedTexture(data: Uint8Array, width: number, height: number): Texture {
    return new Texture({
        // RGBA bytes: Pixi's default BGRA format would swap channels on WebGPU.
        source: new BufferImageSource({ resource: data, width, height, alphaMode: 'premultiplied-alpha', format: 'rgba8unorm' }),
    });
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return Texture.WHITE;
    draw(g, w, h);
    return Texture.from(canvas);
}
