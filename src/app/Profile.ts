import type { Texture } from 'pixi.js';
import { Bindable } from '../core/Bindable';
import { textureFromBlob } from '../graphics/textures';
import type { GameSettings } from '../settings/Settings';
import { openAppDatabase, type AppDatabase } from '../storage/idb';
import {
    AVATAR_SIZE, COVER_HEIGHT, COVER_WIDTH, cropRect, DEFAULT_PLAYER_NAME, displayPlayerName, MAX_UPLOAD_BYTES, outputSize, validatePlayerName,
    type CropRect, type NameCheck,
} from '../storage/profile';

const AVATAR_KEY = 'profile.avatar';
const COVER_KEY = 'profile.cover';

/**
 * The local player's profile (lazer's local user, offline): the display
 * name (persisted with the settings) plus a profile picture and banner
 * kept as image blobs in the app database. Pictures are exposed as
 * textures that every place showing the player binds to; replaced
 * textures are destroyed once those have switched over.
 */
export class LocalProfile {
    /** The name to show (never blank: "Guest" until one is chosen). */
    readonly name = new Bindable(DEFAULT_PLAYER_NAME);
    /** Profile picture, or null for the default avatar. */
    readonly avatar = new Bindable<Texture | null>(null);
    /** Profile banner, or null for the default. */
    readonly cover = new Bindable<Texture | null>(null);
    private db: Promise<AppDatabase> | null = null;

    constructor(private readonly settings: GameSettings, private readonly dbSource: () => Promise<AppDatabase> = openAppDatabase) {
        settings.playerName.bind(v => (this.name.value = displayPlayerName(v)), true);
    }

    /** Load the stored pictures (the name comes with the settings). */
    async init(): Promise<void> {
        const db = await this.database();
        const [avatar, cover] = await Promise.all([db.kv.get(AVATAR_KEY), db.kv.get(COVER_KEY)]);
        if (avatar instanceof Blob) this.replace(this.avatar, await textureFromBlob(avatar, AVATAR_SIZE));
        if (cover instanceof Blob) this.replace(this.cover, await textureFromBlob(cover, COVER_WIDTH));
    }

    /** Validate and save a new display name. */
    rename(raw: string): NameCheck {
        const check = validatePlayerName(raw);
        if (check.ok) this.settings.playerName.value = check.name;
        return check;
    }

    /** Save a cropped profile picture (`crop` in image pixels; default: centre square). */
    async setAvatar(image: ImageBitmap, crop: CropRect = cropRect(image.width, image.height)): Promise<void> {
        const blob = await renderCrop(image, crop, AVATAR_SIZE, AVATAR_SIZE, 'image/png');
        await (await this.database()).kv.put(blob, AVATAR_KEY);
        this.replace(this.avatar, await textureFromBlob(blob, AVATAR_SIZE));
    }

    async removeAvatar(): Promise<void> {
        await (await this.database()).kv.delete(AVATAR_KEY);
        this.replace(this.avatar, null);
    }

    /** Save a banner, centre-cropped to the profile's wide strip. */
    async setCover(image: ImageBitmap): Promise<void> {
        const crop = cropRect(image.width, image.height, COVER_WIDTH / COVER_HEIGHT);
        const blob = await renderCrop(image, crop, COVER_WIDTH, COVER_HEIGHT, 'image/jpeg');
        await (await this.database()).kv.put(blob, COVER_KEY);
        this.replace(this.cover, await textureFromBlob(blob, COVER_WIDTH));
    }

    async removeCover(): Promise<void> {
        await (await this.database()).kv.delete(COVER_KEY);
        this.replace(this.cover, null);
    }

    private database(): Promise<AppDatabase> {
        this.db ??= this.dbSource();
        return this.db;
    }

    private replace(b: Bindable<Texture | null>, tex: Texture | null): void {
        const old = b.value;
        b.value = tex;
        // Everything showing it has switched to the new one (Bindable listeners run synchronously).
        if (old && old !== tex) old.destroy(true);
    }
}

/** Decode a picked image file; null (with a reason) when it isn't a usable image. */
export async function decodeImageFile(file: Blob): Promise<{ image: ImageBitmap } | { error: string }> {
    if (file.type && !file.type.startsWith('image/')) return { error: 'That file is not an image.' };
    if (file.size > MAX_UPLOAD_BYTES) return { error: 'That image is too large (20 MB at most).' };
    try {
        const image = await createImageBitmap(file);
        if (image.width < 1 || image.height < 1) return { error: 'That image is empty.' };
        return { image };
    } catch {
        return { error: 'That image could not be read.' };
    }
}

/** Open the browser's file dialog for one image. */
export function pickImageFile(): Promise<File | null> {
    return new Promise(resolve => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
        el.onchange = () => resolve(el.files?.[0] ?? null);
        el.oncancel = () => resolve(null);
        el.click();
    });
}

/** Draw `crop` of the image downscaled into at most maxW × maxH and encode it. */
async function renderCrop(image: ImageBitmap, crop: CropRect, maxW: number, maxH: number, type: string): Promise<Blob> {
    const { w, h } = outputSize(crop, maxW, maxH);
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality: 0.9 });
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.9));
}
