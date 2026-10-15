import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PACKS, buildPack } from '../tools/assetPacks';

const ROOT = new URL('..', import.meta.url).pathname;

function contents(name: string): string[] {
    const spec = PACKS.find(p => p.name === name)!;
    return Object.keys(unzipSync(buildPack(ROOT, spec).bytes)).sort();
}

describe('asset packs', () => {
    it('packs the default skin images without its sounds', () => {
        const files = contents('default-skin');
        expect(files).toContain('skin.ini');
        expect(files).toContain('hitcircle@2x.png');
        expect(files.some(f => /\.(wav|ogg|mp3)$/.test(f))).toBe(false);
        expect(files).not.toContain('manifest.json');
    });

    it('packs each hitsound once, as Vorbis when there is one', () => {
        const files = contents('default-hitsounds');
        expect(files).toContain('soft-hitclap.ogg');
        expect(files).not.toContain('soft-hitclap.wav');
        // Only a WAV exists for these.
        expect(files).toContain('soft-spinnerspin.wav');
        expect(files).not.toContain('restart.wav');
    });

    it('packs the UI sounds with their folders', () => {
        const files = contents('ui-samples');
        expect(files.length).toBeGreaterThan(50);
        expect(files.every(f => f.endsWith('.mp3'))).toBe(true);
        expect(files.some(f => f.startsWith('UI/'))).toBe(true);
    });

    it('builds the same bytes every time (stable hashed names)', () => {
        const spec = PACKS[0];
        expect(buildPack(ROOT, spec).fileName).toBe(buildPack(ROOT, spec).fileName);
    });
});
