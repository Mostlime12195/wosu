import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packEntries } from '../src/core/assetPacks';
import { PACK_ALIASES, PACKS, buildPack } from '../tools/assetPacks';

const ROOT = new URL('..', import.meta.url).pathname;

function unpack(name: string): Map<string, Uint8Array> {
    const spec = PACKS.find(p => p.name === name)!;
    return packEntries(unzipSync(buildPack(ROOT, spec).bytes));
}

function contents(name: string): string[] {
    return [...unpack(name).keys()].sort();
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

    it('stores identical files once and restores them under every name', () => {
        const spec = PACKS.find(p => p.name === 'default-hitsounds')!;
        const raw = unzipSync(buildPack(ROOT, spec).bytes);
        // The three sample sets share one spinnerbonus WAV.
        expect(raw[PACK_ALIASES]).toBeDefined();
        expect(Object.keys(raw).filter(f => f.endsWith('-spinnerbonus.wav'))).toHaveLength(1);
        const files = unpack('default-hitsounds');
        expect(files.has(PACK_ALIASES)).toBe(false);
        const bonus = ['normal', 'soft', 'drum'].map(set => files.get(`${set}-spinnerbonus.wav`));
        expect(bonus.every(b => b && b.length > 0 && b === bonus[0])).toBe(true);
    });

    it('builds the same bytes every time (stable hashed names)', () => {
        const spec = PACKS[0];
        expect(buildPack(ROOT, spec).fileName).toBe(buildPack(ROOT, spec).fileName);
    });
});
