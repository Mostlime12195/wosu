import { fileURLToPath, URL } from 'node:url';

const replacement = fileURLToPath(new URL('../src/graphics/textureBatchBindGroup.ts', import.meta.url));

/**
 * Swaps pixi.js's internal `getTextureBatchBindGroup` module (a WebGPU bind
 * group cache that never evicts) for src/graphics/textureBatchBindGroup.ts.
 * Pixi imports it by relative path from its own files, which `resolve.alias`
 * doesn't reach in the dependency pre-bundle, so this resolveId hook is
 * registered both as a Vite plugin (build) and in optimizeDeps (dev).
 * Being plain config, it survives `npm ci` (no postinstall patching).
 */
export const pixiBindGroupCache = {
    name: 'wosu:pixi-bind-group-cache',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined): string | null {
        if (!importer || !/getTextureBatchBindGroup\.mjs$/.test(source)) return null;
        return /[\\/]node_modules[\\/]pixi\.js[\\/]/.test(importer) ? replacement : null;
    },
};
