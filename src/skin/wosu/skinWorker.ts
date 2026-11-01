/// <reference lib="webworker" />
import { generateWosuSkin, type SkinCache } from './elements';
import { packSkin, type GenerateRequest } from './generate';

/**
 * Draws wosu!'s skin off the main thread (src/skin/wosu/generate.ts),
 * remembering what it drew so an option change only redraws what it affects.
 */
const cache: SkinCache = new Map();

self.onmessage = (e: MessageEvent<GenerateRequest>) => {
    const { id, options } = e.data;
    try {
        const packed = packSkin(generateWosuSkin(options, cache));
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, skin: packed }, packed.images.map(i => i.data.buffer));
    } catch (err) {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
};
