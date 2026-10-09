import { describe, expect, it } from 'vitest';
import { PreviewPlayer } from '../../src/audio/PreviewPlayer';
import { UISounds } from '../../src/audio/UISounds';
import { makeEngine, tick } from './stubs';

describe('AudioEngine', () => {
    it('routes music through the analyser (before its volume) and both buses into master', () => {
        const { engine, ctx } = makeEngine();
        const music = engine.musicBus as unknown as { connections: unknown[] };
        expect(music.connections).toContain(engine.musicVolume);
        expect(music.connections).toContain(engine.analyser);
        expect((engine.musicVolume as unknown as { connections: unknown[] }).connections).toContain(engine.master);
        expect((engine.effectsBus as unknown as { connections: unknown[] }).connections).toContain(engine.master);
        expect((engine.master as unknown as { connections: unknown[] }).connections).toContain(ctx.destination);
    });

    it('clamps and applies volumes', () => {
        const { engine } = makeEngine();
        engine.setVolumes({ master: 1.5, music: -1, effects: 0.25 });
        expect(engine.getVolumes()).toEqual({ master: 1, music: 0, effects: 0.25 });
        expect(engine.master.gain.value).toBe(1);
        expect(engine.musicVolume.gain.value).toBe(0);
        expect(engine.effectsBus.gain.value).toBe(0.25);
        engine.setVolumes({ music: Number.NaN });
        expect(engine.getVolumes().music).toBe(0);
    });

    it('computes band levels allocation-free', () => {
        const { engine } = makeEngine();
        const data = (engine.analyser as unknown as { data: Uint8Array }).data;
        data.fill(0);
        data.fill(255, 0, 11); // bass bins only (48 kHz / 2048 ≈ 23 Hz per bin, 20–250 Hz)
        const a = engine.getLevels();
        expect(a.bass).toBeGreaterThan(0.9);
        expect(a.treble).toBe(0);
        const b = engine.getLevels();
        expect(b).toBe(a); // same object reused
        for (const v of [b.bass, b.mid, b.treble, b.overall]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it('reports output latency with sane clamping', () => {
        expect(makeEngine({ outputLatency: 0.02, baseLatency: 0.005 }).engine.outputLatencyMs).toBeCloseTo(25, 6);
        expect(makeEngine({ outputLatency: 5 }).engine.outputLatencyMs).toBe(0);
        expect(makeEngine({}).engine.outputLatencyMs).toBe(0);
    });

    it('unlock resumes a suspended context once', async () => {
        const { engine, ctx } = makeEngine({ state: 'suspended' });
        expect(engine.unlocked).toBe(false);
        const p1 = engine.unlock();
        const p2 = engine.unlock();
        expect(p1).toBe(p2);
        await p1;
        expect(engine.unlocked).toBe(true);
        expect(ctx.resumed).toBe(1);
        await engine.unlock();
        expect(ctx.resumed).toBe(1);
    });
});

class FakeAudioElement {
    static created: FakeAudioElement[] = [];
    crossOrigin: string | null = null;
    preload = '';
    volume = 1;
    paused = true;
    ended = false;
    currentTime = 0;
    duration = Number.NaN;
    src = '';
    removed = false;
    private listeners = new Map<string, ((e?: unknown) => void)[]>();
    /** Simulate a host without CORS headers: crossOrigin loads fail. */
    static corsBlocked = false;

    constructor() { FakeAudioElement.created.push(this); }
    addEventListener(type: string, fn: () => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(type: string, fn: () => void): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn));
    }
    emit(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
    play(): Promise<void> {
        if (FakeAudioElement.corsBlocked && this.crossOrigin) {
            setTimeout(() => this.emit('error'), 0);
            return Promise.reject(new Error('NotSupportedError'));
        }
        this.paused = false;
        return Promise.resolve();
    }
    pause(): void { this.paused = true; }
    removeAttribute(name: string): void { if (name === 'src') { this.src = ''; this.removed = true; } }
    load(): void {}
}

describe('PreviewPlayer', () => {
    function makePlayer() {
        const { engine } = makeEngine();
        const player = new PreviewPlayer(engine);
        player.createElement = () => new FakeAudioElement() as unknown as HTMLAudioElement;
        return player;
    }

    it('routes CORS-enabled clips through the music bus', async () => {
        FakeAudioElement.created = [];
        FakeAudioElement.corsBlocked = false;
        const player = makePlayer();
        await player.play('https://cdn.example/preview/1.mp3', { fadeInMs: 0 });
        expect(player.playing).toBe(true);
        expect(FakeAudioElement.created.length).toBe(1);
        expect(FakeAudioElement.created[0].crossOrigin).toBe('anonymous');
        player.stop(0);
        expect(player.playing).toBe(false);
        await tick(50);
        expect(FakeAudioElement.created[0].paused).toBe(true);
        expect(FakeAudioElement.created[0].removed).toBe(true);
    });

    it('retries unrouted when the host has no CORS headers', async () => {
        FakeAudioElement.created = [];
        FakeAudioElement.corsBlocked = true;
        const player = makePlayer();
        await player.play('https://b.example/preview/1.mp3', { fadeInMs: 0 });
        expect(FakeAudioElement.created.length).toBe(2);
        expect(FakeAudioElement.created[1].crossOrigin).toBeNull();
        expect(player.playing).toBe(true);
        expect(FakeAudioElement.created[1].volume).toBeGreaterThan(0);
        player.dispose();
        expect(FakeAudioElement.created[1].paused).toBe(true);
        FakeAudioElement.corsBlocked = false;
    });

    it('a new clip replaces the old one and ended fires once', async () => {
        FakeAudioElement.created = [];
        const player = makePlayer();
        let ended = 0;
        player.ended.add(() => ended++);
        await player.play('a.mp3', { fadeInMs: 0 });
        await player.play('b.mp3', { fadeInMs: 0 });
        await tick(300);
        expect(FakeAudioElement.created[0].paused).toBe(true);
        expect(player.url).toBe('b.mp3');
        FakeAudioElement.created[1].emit('ended');
        expect(ended).toBe(1);
        expect(player.url).toBeNull();
    });
});

describe('UISounds', () => {
    it('is silent and safe when the context is not running or disabled', () => {
        const { engine } = makeEngine({ state: 'suspended' });
        const ui = new UISounds(engine);
        expect(() => { ui.hover(); ui.click(); ui.select(); ui.back(); ui.notify(); ui.error(); }).not.toThrow();
        ui.enabled = false;
        expect(() => ui.toggleOn()).not.toThrow();
    });
});
