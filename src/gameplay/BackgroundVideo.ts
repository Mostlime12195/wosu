import { Sprite, Texture, VideoSource } from 'pixi.js';
import type { OszArchive } from '../beatmap/archive';
import { mimeForFile } from '../beatmap/archive';

/** Re-seek when the video drifts further than this from the song. */
const MAX_DRIFT_MS = 150;

/**
 * A beatmap's background video as a Pixi texture (never a DOM overlay),
 * slaved to the song clock: it starts at the map's video offset, follows
 * pauses and rate mods, and re-seeks when it drifts. Browsers can't play
 * every format maps ship (old .avi/.flv); those quietly do nothing.
 */
export class BackgroundVideo {
    readonly sprite = new Sprite();
    private video: HTMLVideoElement | null = null;
    private url: string | null = null;
    private ready = false;
    private failed = false;
    private disposed = false;

    constructor(private readonly offset: number) {
        this.sprite.anchor.set(0.5);
        this.sprite.visible = false;
        this.sprite.eventMode = 'none';
    }

    async load(archive: OszArchive, filename: string): Promise<boolean> {
        const name = archive.find(filename);
        if (!name) return false;
        try {
            const blob = await archive.readBlob(name, mimeForFile(name));
            if (this.disposed) return false;
            this.url = URL.createObjectURL(blob);
            const v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.preload = 'auto';
            v.src = this.url;
            this.video = v;
            await new Promise<void>((resolve, reject) => {
                v.addEventListener('loadeddata', () => resolve(), { once: true });
                v.addEventListener('error', () => reject(new Error('unsupported video')), { once: true });
                setTimeout(() => reject(new Error('video load timeout')), 15000);
            });
            if (this.disposed) return false;
            const source = new VideoSource({ resource: v, autoPlay: false, autoLoad: true });
            this.sprite.texture = new Texture({ source });
            this.ready = true;
            return true;
        } catch (e) {
            console.warn('background video unavailable', e);
            this.failed = true;
            return false;
        }
    }

    cover(w: number, h: number): void {
        const v = this.video;
        if (!v || !v.videoWidth) return;
        const s = Math.max(w / v.videoWidth, h / v.videoHeight);
        this.sprite.scale.set(s);
        this.sprite.position.set(w / 2, h / 2);
    }

    /** Follow the song: `time` in song ms, `playing` false while paused. */
    sync(time: number, playing: boolean, rate: number): void {
        const v = this.video;
        if (!v || !this.ready || this.failed) return;
        const local = (time - this.offset) / 1000;
        const inRange = local >= 0 && (!Number.isFinite(v.duration) || local < v.duration);
        this.sprite.visible = local >= 0;
        if (!inRange || !playing) {
            if (!v.paused) v.pause();
            if (!inRange && local < 0 && v.currentTime !== 0) v.currentTime = 0;
            return;
        }
        if (v.playbackRate !== rate) v.playbackRate = rate;
        if (Math.abs(v.currentTime - local) * 1000 > MAX_DRIFT_MS) v.currentTime = local;
        if (v.paused) void v.play().catch(() => (this.failed = true));
    }

    dispose(): void {
        this.disposed = true;
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        if (this.url) URL.revokeObjectURL(this.url);
        if (!this.sprite.destroyed) this.sprite.destroy({ texture: this.ready, textureSource: this.ready });
        this.video = null;
    }
}
