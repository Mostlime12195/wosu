import { describe, expect, it } from 'vitest';
import { SampleBank } from '../../src/audio/SampleBank';
import { LEAVE_FADE_MS, SILENT_SOUND, playOneShot } from '../../src/audio/SoundHandle';
import { UISounds } from '../../src/audio/UISounds';
import { makeContext, makeEngine, type SourceStub } from './stubs';

/** Record the time each source is told to stop at. */
function trackStops(src: SourceStub): { at: (number | undefined)[] } {
    const log = { at: [] as (number | undefined)[] };
    const stop = src.stop.bind(src);
    src.stop = (when?: number) => {
        log.at.push(when);
        stop();
    };
    return log;
}

const buffer = { duration: 120 } as unknown as AudioBuffer;

describe('stoppable sounds (skin failsound, applause, pause-loop)', () => {
    it('fades out and stops at the end of the fade', () => {
        const ctx = makeContext({ currentTime: 10 });
        const dest = ctx.createGain();
        const h = playOneShot(ctx as unknown as BaseAudioContext, buffer, 0.8, dest as unknown as AudioNode)!;
        const src = ctx.sources[0];
        const stops = trackStops(src);
        expect(src.started).not.toBeNull();
        expect(h.playing).toBe(true);
        h.stop(LEAVE_FADE_MS);
        expect(h.playing).toBe(false);
        expect(stops.at).toEqual([10 + LEAVE_FADE_MS / 1000]);
        // The gain ramps to silence over the fade.
        const gain = (src.connections[0] as { gain: { value: number } }).gain;
        expect(gain.value).toBe(0);
        // Stopping again (another exit route) does nothing.
        h.stop(LEAVE_FADE_MS);
        expect(stops.at.length).toBe(1);
    });

    it('cuts at once without a fade, and knows when it ended by itself', () => {
        const ctx = makeContext({ currentTime: 5 });
        const h = playOneShot(ctx as unknown as BaseAudioContext, buffer, 1, ctx.createGain() as unknown as AudioNode)!;
        const stops = trackStops(ctx.sources[0]);
        h.stop();
        expect(stops.at).toEqual([5]);

        const ended = playOneShot(ctx as unknown as BaseAudioContext, buffer, 1, ctx.createGain() as unknown as AudioNode)!;
        ctx.sources[1].onended?.();
        expect(ended.playing).toBe(false);
        const late = trackStops(ctx.sources[1]);
        ended.stop(LEAVE_FADE_MS);
        expect(late.at).toEqual([]);
    });

    it('SampleBank gives handles for skin buffers and fades loops out', () => {
        const { engine, ctx } = makeEngine({ currentTime: 2 });
        const bank = new SampleBank(engine);
        expect(bank.playStoppable(buffer, 0)).toBe(SILENT_SOUND);
        const h = bank.playStoppable(buffer, 1);
        const stops = trackStops(ctx.sources[0]);
        h.stop(LEAVE_FADE_MS);
        expect(stops.at).toEqual([2 + LEAVE_FADE_MS / 1000]);

        const loop = bank.startLoopBuffer(buffer, 1);
        const loopStops = trackStops(ctx.sources[1]);
        loop.stop(200);
        expect(loopStops.at).toEqual([2.2]);
        loop.stop(200);
        expect(loopStops.at.length).toBe(1);
    });

    it("UISounds gives handles for lazer's applause and failsound", async () => {
        const { engine, ctx } = makeEngine({ currentTime: 1 });
        (ctx as unknown as { decodeAudioData: (d: ArrayBuffer) => Promise<unknown> }).decodeAudioData = async () => ({ tag: 'x' });
        const sounds = new UISounds(engine, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response);
        await sounds.load('x/', n => n === 'Results/applause-s');
        expect(sounds.playStoppable('Gameplay/failsound')).toBeNull(); // not loaded
        const h = sounds.playStoppable('Results/applause-s', { volume: 0.8 })!;
        expect(h.playing).toBe(true);
        const stops = trackStops(ctx.sources[ctx.sources.length - 1]);
        h.stop(LEAVE_FADE_MS);
        expect(stops.at).toEqual([1 + LEAVE_FADE_MS / 1000]);
        sounds.enabled = false;
        expect(sounds.playStoppable('Results/applause-s')).toBeNull();
    });
});
