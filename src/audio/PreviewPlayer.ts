/**
 * Online preview clips (beatmap listing, menu music fallback).
 *
 * Clips stream through an HTMLAudioElement that is never attached to the
 * document. With CORS (sayobot sends `Access-Control-Allow-Origin: *`) the
 * element is routed through a MediaElementAudioSourceNode into the music
 * bus, so volume settings and the menu visualiser apply. Without CORS the
 * crossOrigin load fails; we then retry unrouted and drive element.volume
 * ourselves (no visualiser data for that clip).
 */
import { Signal } from '../core/Signal';
import type { AudioEngine } from './AudioEngine';
import { rampParam } from './base';

interface Clip {
    el: HTMLAudioElement;
    url: string;
    source: MediaElementAudioSourceNode | null;
    gain: GainNode | null;
    /** Unrouted fallback: element volume animation. */
    fadeTimer: ReturnType<typeof setInterval> | null;
    level: number;
    disposed: boolean;
}

export interface PreviewPlayOptions {
    fadeInMs?: number;
    /** Clip volume (0..1) on top of the music/master buses. */
    volume?: number;
}

type AudioCtor = new () => HTMLAudioElement;

export class PreviewPlayer {
    readonly ended = new Signal<[]>();
    /** Factory for media elements; overridable for tests. */
    createElement: () => HTMLAudioElement = () => new ((globalThis as unknown as { Audio: AudioCtor }).Audio)();

    private readonly engine: AudioEngine;
    private current: Clip | null = null;
    private generation = 0;

    constructor(engine: AudioEngine) {
        this.engine = engine;
    }

    get playing(): boolean {
        const c = this.current;
        return !!c && !c.el.paused && !c.el.ended;
    }

    /** Current clip time in ms (0 when idle). */
    get currentTime(): number {
        return this.current ? (this.current.el.currentTime || 0) * 1000 : 0;
    }

    /** Clip duration in ms; NaN until the metadata is known. */
    get duration(): number {
        const d = this.current?.el.duration;
        return d !== undefined && Number.isFinite(d) ? d * 1000 : NaN;
    }

    get url(): string | null {
        return this.current?.url ?? null;
    }

    /**
     * Play `url`, fading out whatever was playing. Resolves once playback
     * has started; rejects when the clip cannot play (network, autoplay
     * policy) or was superseded by a newer call.
     */
    async play(url: string, opts: PreviewPlayOptions = {}): Promise<void> {
        const gen = ++this.generation;
        const fadeInMs = opts.fadeInMs ?? 200;
        const volume = Math.max(0, Math.min(1, opts.volume ?? 1));
        if (this.current) {
            const old = this.current;
            this.current = null;
            this.fadeOutAndDispose(old, 250);
        }
        let clip: Clip;
        try {
            clip = await this.startClip(url, true, gen);
        } catch (e) {
            if (gen !== this.generation) throw new Error('preview superseded');
            // Likely a CORS failure on the routed attempt: retry unrouted.
            clip = await this.startClip(url, false, gen).catch(err => {
                throw err instanceof Error ? err : new Error(String(e));
            });
        }
        if (gen !== this.generation) {
            this.disposeClip(clip);
            throw new Error('preview superseded');
        }
        this.current = clip;
        this.fadeClip(clip, volume, fadeInMs);
    }

    stop(fadeOutMs = 300): void {
        this.generation++;
        const c = this.current;
        this.current = null;
        if (c) this.fadeOutAndDispose(c, fadeOutMs);
    }

    dispose(): void {
        this.generation++;
        if (this.current) this.disposeClip(this.current);
        this.current = null;
        this.ended.clear();
    }

    private startClip(url: string, routed: boolean, gen: number): Promise<Clip> {
        const el = this.createElement();
        const clip: Clip = { el, url, source: null, gain: null, fadeTimer: null, level: 0, disposed: false };
        el.preload = 'auto';
        if (routed) {
            el.crossOrigin = 'anonymous';
            try {
                const ctx = this.engine.context as AudioContext;
                clip.source = ctx.createMediaElementSource(el);
                clip.gain = ctx.createGain();
                clip.gain.gain.value = 0;
                clip.source.connect(clip.gain);
                clip.gain.connect(this.engine.musicBus);
            } catch {
                clip.source = null;
                clip.gain = null;
            }
        }
        if (!clip.gain) el.volume = 0;
        el.addEventListener('ended', () => {
            if (this.current === clip) {
                this.current = null;
                this.disposeClip(clip);
                this.ended.emit();
            }
        });

        return new Promise<Clip>((resolve, reject) => {
            const onError = (): void => {
                cleanupListeners();
                this.disposeClip(clip);
                reject(new Error(`preview failed to load: ${url}`));
            };
            const cleanupListeners = (): void => el.removeEventListener('error', onError);
            el.addEventListener('error', onError);
            el.src = url;
            let p: Promise<void> | undefined;
            try {
                p = el.play();
            } catch (e) {
                cleanupListeners();
                this.disposeClip(clip);
                reject(e instanceof Error ? e : new Error('preview play failed'));
                return;
            }
            Promise.resolve(p).then(() => {
                cleanupListeners();
                if (gen !== this.generation) {
                    this.disposeClip(clip);
                    reject(new Error('preview superseded'));
                    return;
                }
                resolve(clip);
            }, err => {
                cleanupListeners();
                this.disposeClip(clip);
                reject(err instanceof Error ? err : new Error('preview play failed'));
            });
        });
    }

    /** Effective element volume for unrouted clips (buses don't apply to them). */
    private busLevel(): number {
        const v = this.engine.getVolumes();
        return v.master * v.music;
    }

    private fadeClip(clip: Clip, target: number, ms: number): void {
        if (clip.disposed) return;
        if (clip.gain) {
            rampParam(clip.gain.gain, target, this.engine.context.currentTime, Math.max(0, ms) / 1000);
            clip.level = target;
            return;
        }
        if (clip.fadeTimer) clearInterval(clip.fadeTimer);
        const from = clip.level;
        const start = Date.now();
        const apply = (level: number): void => {
            clip.level = level;
            try { clip.el.volume = Math.max(0, Math.min(1, level * this.busLevel())); } catch { /* ignore */ }
        };
        if (ms <= 0) {
            apply(target);
            return;
        }
        clip.fadeTimer = setInterval(() => {
            const t = Math.min(1, (Date.now() - start) / ms);
            apply(from + (target - from) * t);
            if (t >= 1 && clip.fadeTimer) {
                clearInterval(clip.fadeTimer);
                clip.fadeTimer = null;
            }
        }, 16);
    }

    private fadeOutAndDispose(clip: Clip, ms: number): void {
        this.fadeClip(clip, 0, ms);
        // Hard deadline: never leave a preview playing.
        setTimeout(() => this.disposeClip(clip), Math.max(0, ms) + 30);
    }

    private disposeClip(clip: Clip): void {
        if (clip.disposed) return;
        clip.disposed = true;
        if (clip.fadeTimer) clearInterval(clip.fadeTimer);
        clip.fadeTimer = null;
        const el = clip.el;
        try { el.pause(); } catch { /* ignore */ }
        try {
            el.removeAttribute('src');
            el.load();
        } catch { /* ignore */ }
        try { clip.source?.disconnect(); } catch { /* ignore */ }
        try { clip.gain?.disconnect(); } catch { /* ignore */ }
    }
}
