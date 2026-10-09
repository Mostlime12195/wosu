import { Texture } from 'pixi.js';

/**
 * Decode an image Blob into a texture without touching the DOM. The
 * texture owns the ImageBitmap; destroy(true) releases it.
 */
export async function textureFromBlob(blob: Blob, maxSize = 2048): Promise<Texture | null> {
    try {
        let bitmap = await createImageBitmap(blob);
        if (bitmap.width > maxSize || bitmap.height > maxSize) {
            const s = maxSize / Math.max(bitmap.width, bitmap.height);
            const scaled = await createImageBitmap(bitmap, {
                resizeWidth: Math.round(bitmap.width * s),
                resizeHeight: Math.round(bitmap.height * s),
                resizeQuality: 'high',
            });
            bitmap.close();
            bitmap = scaled;
        }
        const tex = Texture.from(bitmap);
        tex.source.autoGenerateMipmaps = false;
        return tex;
    } catch (e) {
        console.warn('image decode failed', e);
        return null;
    }
}

/**
 * Fetch a CORS-enabled image URL into a texture. Only hosts that send
 * Access-Control-Allow-Origin can be textured by WebGL/WebGPU (Sayobot's
 * CDN does; assets.ppy.sh does not).
 */
export async function textureFromUrl(url: string, signal?: AbortSignal, maxSize = 2048): Promise<Texture | null> {
    try {
        const res = await fetch(url, { mode: 'cors', signal });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (signal?.aborted) return null;
        return textureFromBlob(blob, maxSize);
    } catch {
        return null;
    }
}

/**
 * Small LRU of remote textures (beatmap covers) shared across screens,
 * so scrolling a listing back and forth doesn't refetch/re-upload.
 */
export class TextureCache {
    private readonly map = new Map<string, Promise<Texture | null>>();
    private readonly settled = new Map<string, Texture | null>();

    constructor(private readonly capacity = 120) {}

    get(url: string, load: () => Promise<Texture | null> = () => textureFromUrl(url, undefined, 1024)): Promise<Texture | null> {
        const hit = this.map.get(url);
        if (hit) {
            // Refresh LRU position.
            this.map.delete(url);
            this.map.set(url, hit);
            return hit;
        }
        const p = load().then(t => {
            this.settled.set(url, t);
            return t;
        });
        this.map.set(url, p);
        this.evict();
        return p;
    }

    /** Synchronous peek for already-loaded textures. */
    peek(url: string): Texture | null | undefined {
        return this.settled.get(url);
    }

    private evict(): void {
        while (this.map.size > this.capacity) {
            const oldest = this.map.keys().next().value as string;
            this.map.delete(oldest);
            // Only drop our reference: a sprite may still display it. Pixi's
            // texture GC unloads GPU memory for textures that stop rendering,
            // and JS GC reclaims the bitmap once nothing references it.
            this.settled.delete(oldest);
        }
    }
}
