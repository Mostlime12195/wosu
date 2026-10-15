/// <reference types="vite/client" />

/** Short build description (commit hash or "dev"), injected by Vite. */
declare const __BUILD_INFO__: string;

/** Hashed asset pack paths (tools/assetPacks.ts), injected by Vite. */
declare const __ASSET_PACKS__: Record<'default-skin' | 'default-hitsounds' | 'ui-samples', string>;
