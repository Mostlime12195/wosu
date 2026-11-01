/**
 * wosu!'s replacement for pixi.js's internal `getTextureBatchBindGroup`
 * (pixi.js 8.22, `lib/rendering/batcher/gpu/getTextureBatchBindGroup.mjs`),
 * swapped in by tools/pixiBindGroupCache.ts (a resolveId hook in
 * vite.config.ts, used by the build and the dev dependency pre-bundle), so
 * no patch has to survive `npm ci`. In dev, edits here only apply after the
 * pre-bundle is rebuilt (`npx vite --force`).
 *
 * Pixi caches one texture-batch BindGroup per ordered combination of up to
 * 16 textures, in a module-level object that is never evicted. Batch
 * texture order follows draw order, so gameplay keeps producing new
 * combinations (hundreds per play, more with every retry); each cached
 * group listens to all its textures (`Texture.EMPTY` collected thousands of
 * listeners) and kept destroyed textures alive, and every destroyed texture
 * made the cached groups print "[BindGroup] a 'textureSource' was destroyed
 * while still bound".
 *
 * This version builds the same groups (same key hash, same resource layout)
 * but bounds the cache:
 * - a group leaves the cache as soon as one of its textures is destroyed
 *   (its key, a hash of those textures' uids, can never be looked up again);
 * - groups unused for UNUSED_MS are swept out when new ones are created.
 * An evicted group stops listening to its textures, so nothing keeps it
 * alive but the batches still holding it. If such a batch uses it again it
 * re-subscribes and rebuilds its key first, so it behaves exactly like
 * pixi's own group (a destroyed slot is nulled, as pixi does).
 *
 * When upgrading pixi.js, diff its getTextureBatchBindGroup.mjs against
 * this file (the hash and the resource layout must stay the same).
 */
import { BindGroup, Texture, type BindResource, type TextureSource } from 'pixi.js';

/** A cached group nobody drew with for this long is dropped (ms). */
export const UNUSED_MS = 10_000;
/** Sweep for unused groups after this many new ones. */
const SWEEP_EVERY = 64;

interface CachedGroup extends BindGroup {
    lastUsed: number;
    /** Drop from the cache and stop listening (idempotent). */
    evict(): void;
}

const cache = new Map<number, CachedGroup>();
let created = 0;

/** Cached texture-batch bind groups (diagnostics and tests). */
export function textureBatchBindGroupCount(): number {
    return cache.size;
}

/** Drop every cached group not used in the last `unusedMs` (all of them with 0). */
export function evictTextureBatchBindGroups(unusedMs = UNUSED_MS, now = performance.now()): number {
    let n = 0;
    for (const group of [...cache.values()]) {
        if (now - group.lastUsed >= unusedMs) {
            group.evict();
            n++;
        }
    }
    return n;
}

// For the console and the perf harness.
(globalThis as Record<symbol, unknown>)[Symbol.for('wosu.textureBatchBindGroups')] = { size: textureBatchBindGroupCount, evict: evictTextureBatchBindGroups };

type GroupCtor = new (resources: Record<number, BindResource>, key: number) => CachedGroup;
let groupCtor: GroupCtor | null = null;

/**
 * Defined on first use: this module is evaluated inside pixi's own import
 * graph, before `BindGroup` is initialised.
 */
function cachedGroupClass(): GroupCtor {
    return (groupCtor ??= class TextureBatchBindGroup extends BindGroup implements CachedGroup {
        lastUsed = performance.now();
        private listening = true;

        constructor(resources: Record<number, BindResource>, private readonly cacheKey: number) {
            super(resources);
        }

        /** Read by pixi on every use of the group (WebGPU), before the GPU bind group lookup. */
        override get _key(): string {
            this.used();
            return super._key;
        }

        override _touch(now: number): void {
            this.used();
            super._touch(now);
        }

        evict(): void {
            if (cache.get(this.cacheKey) === this) cache.delete(this.cacheKey);
            if (!this.listening || !this.resources) return;
            this.listening = false;
            for (const k in this.resources) this.resources[k]?.off?.('change', this.onResourceChange, this);
        }

        protected override onResourceChange(resource: BindResource): void {
            if (!resource.destroyed) {
                super.onResourceChange(resource);
                return;
            }
            // Pixi's handling, minus its warning: the cache (not a live draw) held it.
            this.evict();
            const resources = this.resources as Record<string, BindResource | null>;
            for (const k in resources) if (resources[k] === resource) resources[k] = null;
            this.markDirty();
        }

        private used(): void {
            this.lastUsed = performance.now();
            if (this.listening || !this.resources) return;
            // Evicted but drawn again: follow resource changes again and rebuild the key,
            // which may be stale if a texture was resized or reuploaded meanwhile.
            this.listening = true;
            for (const k in this.resources) this.resources[k]?.on?.('change', this.onResourceChange, this);
            this.markDirty();
        }

        private markDirty(): void {
            (this as unknown as { _dirty: boolean })._dirty = true;
        }
    });
}

export function getTextureBatchBindGroup(textures: TextureSource[], size: number, maxTextures: number): BindGroup {
    let uid = 2166136261;
    for (let i = 0; i < size; i++) {
        uid ^= textures[i].uid;
        uid = Math.imul(uid, 16777619);
        uid >>>= 0;
    }
    return cache.get(uid) ?? generateTextureBatchBindGroup(textures, size, uid, maxTextures);
}

function generateTextureBatchBindGroup(textures: TextureSource[], size: number, key: number, maxTextures: number): BindGroup {
    if (++created % SWEEP_EVERY === 0) evictTextureBatchBindGroups();
    const resources: Record<number, BindResource> = {};
    let bindIndex = 0;
    for (let i = 0; i < maxTextures; i++) {
        const texture = i < size ? textures[i] : Texture.EMPTY.source;
        resources[bindIndex++] = texture.source;
        resources[bindIndex++] = texture.style;
    }
    const Group = cachedGroupClass();
    const group = new Group(resources, key);
    cache.set(key, group);
    return group;
}
