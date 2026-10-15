/**
 * The local player's profile rules, kept free of the DOM and Pixi so they
 * can be tested: display name validation (osu!'s 15-character usernames)
 * and the square / banner crop maths used when a picture is uploaded.
 */

/** osu! usernames are at most 15 characters. */
export const PLAYER_NAME_MAX = 15;
/** What the player is called before choosing a name. */
export const DEFAULT_PLAYER_NAME = 'Guest';
/** Stored avatar size (px, square); bigger uploads are downscaled. */
export const AVATAR_SIZE = 256;
/** Stored banner size (px); lazer's profile cover is a wide strip. */
export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 300;
/** Uploads larger than this are refused before decoding (bytes). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** The crop editor's zoom range. */
export const CROP_ZOOM_MIN = 1;
export const CROP_ZOOM_MAX = 4;

export type NameCheck = { ok: true; name: string } | { ok: false; name: string; error: string };

/**
 * Validate a display name: trimmed, 1–15 characters (counted as the
 * characters a player sees, so an emoji is one), no control characters.
 */
export function validatePlayerName(raw: string): NameCheck {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const length = [...name].length;
    if (length === 0) return { ok: false, name, error: 'Your name cannot be empty.' };
    if (length > PLAYER_NAME_MAX) return { ok: false, name, error: `Your name can be at most ${PLAYER_NAME_MAX} characters.` };
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return { ok: false, name, error: 'Your name contains characters that cannot be shown.' };
    return { ok: true, name };
}

/** A stored or loaded name as it should be shown (anything invalid falls back to "Guest"). */
export function displayPlayerName(stored: string | null | undefined): string {
    const check = validatePlayerName(stored ?? '');
    if (check.ok) return check.name;
    // Older versions allowed up to 24 characters: keep those (trimmed), only blank becomes Guest.
    return check.name || DEFAULT_PLAYER_NAME;
}

export interface CropRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * The part of an image (imgW × imgH) shown in a crop frame of the given
 * aspect (w / h): the largest such rectangle (cover fit) shrunk by `zoom`,
 * centred on (cx, cy) in image pixels (default: the image's centre) and
 * kept inside the image.
 */
export function cropRect(imgW: number, imgH: number, aspect = 1, zoom = 1, cx = imgW / 2, cy = imgH / 2): CropRect {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
    const z = clampZoom(zoom);
    let w = imgW, h = imgW / a;
    if (h > imgH) {
        h = imgH;
        w = imgH * a;
    }
    w /= z;
    h /= z;
    const c = clampCropCentre(imgW, imgH, w, h, cx, cy);
    return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/** Keep a w × h crop centred on (cx, cy) inside the image. */
export function clampCropCentre(imgW: number, imgH: number, w: number, h: number, cx: number, cy: number): { x: number; y: number } {
    const clampAxis = (c: number, size: number, max: number) => {
        if (!Number.isFinite(c)) c = max / 2;
        if (size >= max) return max / 2;
        return Math.min(max - size / 2, Math.max(size / 2, c));
    };
    return { x: clampAxis(cx, w, imgW), y: clampAxis(cy, h, imgH) };
}

export function clampZoom(zoom: number): number {
    return Number.isFinite(zoom) ? Math.min(CROP_ZOOM_MAX, Math.max(CROP_ZOOM_MIN, zoom)) : CROP_ZOOM_MIN;
}

/**
 * Pan the crop by a drag of (dx, dy) screen pixels in a frame `frameW`
 * pixels wide: the picture follows the pointer, so the centre moves the
 * other way, scaled from screen to image pixels.
 */
export function panCrop(crop: CropRect, frameW: number, dx: number, dy: number, imgW: number, imgH: number): { x: number; y: number } {
    const k = frameW > 0 ? crop.w / frameW : 0;
    return clampCropCentre(imgW, imgH, crop.w, crop.h, crop.x + crop.w / 2 - dx * k, crop.y + crop.h / 2 - dy * k);
}

/** Output size for a crop: downscaled to fit `maxW × maxH`, never upscaled, at least 1 px. */
export function outputSize(crop: CropRect, maxW: number, maxH: number): { w: number; h: number } {
    const s = Math.min(1, maxW / crop.w, maxH / crop.h);
    return { w: Math.max(1, Math.round(crop.w * s)), h: Math.max(1, Math.round(crop.h * s)) };
}
