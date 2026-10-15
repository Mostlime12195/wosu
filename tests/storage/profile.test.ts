import { describe, expect, it } from 'vitest';
import {
    AVATAR_SIZE, clampCropCentre, cropRect, displayPlayerName, outputSize, panCrop, PLAYER_NAME_MAX, validatePlayerName,
} from '../../src/storage/profile';

describe('display name validation', () => {
    it('trims and accepts 1–15 characters', () => {
        expect(validatePlayerName('  peppy  ')).toEqual({ ok: true, name: 'peppy' });
        expect(validatePlayerName('a')).toEqual({ ok: true, name: 'a' });
        expect(validatePlayerName('x'.repeat(PLAYER_NAME_MAX)).ok).toBe(true);
        expect(validatePlayerName('Hack Club').ok).toBe(true);
    });

    it('rejects empty, too long and control characters', () => {
        expect(validatePlayerName('   ').ok).toBe(false);
        expect(validatePlayerName('').ok).toBe(false);
        expect(validatePlayerName('x'.repeat(PLAYER_NAME_MAX + 1)).ok).toBe(false);
        expect(validatePlayerName('bad\u0007name').ok).toBe(false);
    });

    it('collapses inner whitespace and counts what you see', () => {
        expect(validatePlayerName('a   b\tc')).toEqual({ ok: true, name: 'a b c' });
        // 15 emoji are 15 characters (30 UTF-16 code units).
        expect(validatePlayerName('😀'.repeat(15)).ok).toBe(true);
    });

    it('falls back to Guest only for blank stored names', () => {
        expect(displayPlayerName('')).toBe('Guest');
        expect(displayPlayerName(null)).toBe('Guest');
        expect(displayPlayerName(' WhiteCat ')).toBe('WhiteCat');
        expect(displayPlayerName('an older twenty-char')).toBe('an older twenty-char');
    });
});

describe('crop maths', () => {
    it('centre-crops a landscape image to a square', () => {
        expect(cropRect(400, 200)).toEqual({ x: 100, y: 0, w: 200, h: 200 });
    });

    it('centre-crops a portrait image to a square', () => {
        expect(cropRect(300, 900)).toEqual({ x: 0, y: 300, w: 300, h: 300 });
    });

    it('crops a banner aspect', () => {
        expect(cropRect(1000, 1000, 4)).toEqual({ x: 0, y: 375, w: 1000, h: 250 });
        expect(cropRect(800, 100, 4)).toEqual({ x: 200, y: 0, w: 400, h: 100 });
    });

    it('zooms in around the chosen centre and stays inside the image', () => {
        expect(cropRect(400, 400, 1, 2)).toEqual({ x: 100, y: 100, w: 200, h: 200 });
        expect(cropRect(400, 400, 1, 2, 0, 0)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
        expect(cropRect(400, 400, 1, 2, 1000, 390)).toEqual({ x: 200, y: 200, w: 200, h: 200 });
        // Zoom is clamped to the editor's range.
        expect(cropRect(400, 400, 1, 0.5).w).toBe(400);
        expect(cropRect(400, 400, 1, 100).w).toBe(100);
    });

    it('keeps the centre in range on axes the crop fills', () => {
        expect(clampCropCentre(400, 200, 200, 200, 0, 0)).toEqual({ x: 100, y: 100 });
        expect(clampCropCentre(400, 200, 200, 200, Number.NaN, 50)).toEqual({ x: 200, y: 100 });
    });

    it('pans opposite to the drag, scaled to image pixels', () => {
        const crop = cropRect(1000, 1000, 1, 2);
        // A 250 px frame shows 500 image px: dragging right by 50 px moves the centre 100 px left.
        expect(panCrop(crop, 250, 50, 0, 1000, 1000)).toEqual({ x: 400, y: 500 });
        expect(panCrop(crop, 250, -10000, 0, 1000, 1000)).toEqual({ x: 750, y: 500 });
    });

    it('downscales the output but never upscales', () => {
        expect(outputSize({ x: 0, y: 0, w: 1024, h: 1024 }, AVATAR_SIZE, AVATAR_SIZE)).toEqual({ w: 256, h: 256 });
        expect(outputSize({ x: 0, y: 0, w: 100, h: 100 }, AVATAR_SIZE, AVATAR_SIZE)).toEqual({ w: 100, h: 100 });
        expect(outputSize({ x: 0, y: 0, w: 2400, h: 600 }, 1200, 300)).toEqual({ w: 1200, h: 300 });
    });
});
