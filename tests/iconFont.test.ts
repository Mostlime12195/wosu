import { describe, expect, it } from 'vitest';
import { Icons } from '../src/ui/icons';
import { buildIconFont, iconCharacters } from '../tools/iconFont';

const ROOT = new URL('..', import.meta.url).pathname;

describe('icon font subset', () => {
    it('keeps every glyph the Icons table draws, and nothing else', () => {
        const chars = iconCharacters(ROOT);
        for (const glyph of Object.values(Icons)) for (const c of glyph) expect(chars).toContain(c);
        // Only icon strings: nothing else from icons.ts (style values and the like).
        expect(chars).not.toMatch(/[a-z]/);
    });

    it('builds a small WOFF2 with a content-hashed name', async () => {
        const font = await buildIconFont(ROOT);
        expect(new TextDecoder().decode(font.bytes.subarray(0, 4))).toBe('wOF2');
        expect(font.bytes.length).toBeLessThan(20_000);
        expect(font.fileName).toMatch(/^assets\/fa-solid\.[0-9a-f]{10}\.woff2$/);
    });
});
