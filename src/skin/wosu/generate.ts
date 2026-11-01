import type { SkinConfig } from '../SkinIni';
import { generateWosuSkin, type GeneratedSkin, type SkinCache, type WosuSkinExtras } from './elements';
import type { WosuSkinOptions } from './options';

/** One generated image, ready to upload: premultiplied RGBA bytes. */
export interface PackedImage {
    name: string;
    width: number;
    height: number;
    /** 0.5 for @2x images. */
    scale: number;
    data: Uint8Array;
}

export interface PackedSkin {
    config: SkinConfig;
    extras: WosuSkinExtras;
    images: PackedImage[];
}

export interface GenerateRequest {
    id: number;
    options: WosuSkinOptions;
}

type GenerateReply = { id: number; skin: PackedSkin } | { id: number; error: string };

export function packSkin(skin: GeneratedSkin): PackedSkin {
    return {
        config: skin.config,
        extras: skin.extras,
        images: [...skin.images].map(([name, r]) => ({ name, width: r.width, height: r.height, scale: r.scale, data: r.rgba8(true) })),
    };
}

/**
 * Generates wosu!'s skin from its options, in a worker when the browser
 * has them (drawing every image takes a few hundred ms; the menus keep
 * running meanwhile), else right here. Requests are answered in order;
 * a newer request doesn't cancel an older one.
 */
export class WosuSkinGenerator {
    private worker: Worker | null = null;
    private failed = false;
    private nextId = 1;
    private readonly pending = new Map<number, { options: WosuSkinOptions; resolve: (s: PackedSkin) => void; reject: (e: Error) => void }>();
    private readonly cache: SkinCache = new Map();

    generate(options: WosuSkinOptions): Promise<PackedSkin> {
        const worker = this.ensureWorker();
        if (!worker) return Promise.resolve(packSkin(generateWosuSkin(options, this.cache)));
        const id = this.nextId++;
        return new Promise<PackedSkin>((resolve, reject) => {
            this.pending.set(id, { options, resolve, reject });
            worker.postMessage({ id, options } satisfies GenerateRequest);
        });
    }

    private ensureWorker(): Worker | null {
        if (this.worker || this.failed) return this.worker;
        if (typeof Worker === 'undefined') {
            this.failed = true;
            return null;
        }
        try {
            const w = new Worker(new URL('./skinWorker.ts', import.meta.url), { type: 'module', name: 'wosu-skin' });
            w.onmessage = (e: MessageEvent<GenerateReply>) => {
                const p = this.pending.get(e.data.id);
                if (!p) return;
                this.pending.delete(e.data.id);
                if ('skin' in e.data) p.resolve(e.data.skin);
                else p.reject(new Error(e.data.error));
            };
            // A worker that can't start (blocked, unsupported): draw on the main thread from now on.
            w.onerror = e => {
                console.warn('[skins] skin worker failed; drawing on the main thread', e.message);
                e.preventDefault();
                this.failed = true;
                this.worker = null;
                w.terminate();
                const waiting = [...this.pending.values()];
                this.pending.clear();
                for (const p of waiting) {
                    try {
                        p.resolve(packSkin(generateWosuSkin(p.options, this.cache)));
                    } catch (err) {
                        p.reject(err instanceof Error ? err : new Error(String(err)));
                    }
                }
            };
            this.worker = w;
        } catch (e) {
            console.warn('[skins] no skin worker; drawing on the main thread', e);
            this.failed = true;
        }
        return this.worker;
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
    }
}
