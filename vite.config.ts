/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { assetPacks } from './tools/assetPacks';
import { iconFont } from './tools/iconFont';
import { pixiBindGroupCache } from './tools/pixiBindGroupCache';

function buildInfo(): string {
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA)?.slice(0, 7);
    if (sha) return sha;
    try {
        return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
        return 'dev';
    }
}

const root = fileURLToPath(new URL('.', import.meta.url));
const packs = assetPacks(root);
const icons = await iconFont(root);

export default defineConfig({
    // Relative base: the build works from the site root and from any
    // sub-path preview without rebuilding.
    base: './',
    define: {
        __BUILD_INFO__: JSON.stringify(buildInfo()),
        ...packs.define,
        ...icons.define,
    },
    plugins: [packs.plugin, icons.plugin, pixiBindGroupCache],
    // The dependency pre-bundle resolves pixi's internal imports itself (dev only).
    optimizeDeps: { rolldownOptions: { plugins: [pixiBindGroupCache] } },
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
        target: 'es2022',
        sourcemap: true,
        chunkSizeWarningLimit: 1500,
        rollupOptions: {
            output: {
                // Keep the renderer library in its own long-cached chunk.
                manualChunks(id) {
                    if (id.includes('node_modules/pixi.js')) return 'pixi';
                    return undefined;
                },
            },
        },
    },
    server: {
        host: true,
        // The online API (server/) during development: `node server/index.mjs` on :3100.
        proxy: { '/api': 'http://127.0.0.1:3100' },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
