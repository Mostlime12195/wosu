import type { SkinConfig } from '../SkinIni';
import { generateWosuSkin } from './elements';
import type { WosuSkinOptions } from './options';
import { encodePng } from './png';

const rgb = (c: number): string => `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}`;
const flag = (b: boolean | undefined): string => (b ? '1' : '0');

/** A skin.ini for a generated skin's config (what osu! would read from it). */
export function skinIniText(c: SkinConfig): string {
    const lines = [
        '[General]',
        `Name: ${c.name ?? 'wosu!'}`,
        `Author: ${c.author ?? ''}`,
        `Version: ${c.version ?? 2.7}`,
        `AnimationFramerate: ${c.animationFramerate ?? -1}`,
        `AllowSliderBallTint: ${flag(c.allowSliderBallTint)}`,
        `SliderBallFlip: ${flag(c.sliderBallFlip)}`,
        `CursorRotate: ${flag(c.cursorRotate)}`,
        `CursorExpand: ${flag(c.cursorExpand)}`,
        `CursorCentre: ${flag(c.cursorCentre)}`,
        `HitCircleOverlayAboveNumber: ${flag(c.hitCircleOverlayAboveNumber)}`,
        '',
        '[Colours]',
        ...(c.comboColours ?? []).map((col, i) => `Combo${i + 1}: ${rgb(col)}`),
        ...(c.sliderBorder !== undefined ? [`SliderBorder: ${rgb(c.sliderBorder)}`] : []),
        ...(c.sliderTrackOverride !== undefined ? [`SliderTrackOverride: ${rgb(c.sliderTrackOverride)}`] : []),
        '',
        '[Fonts]',
        `HitCirclePrefix: ${c.hitCirclePrefix ?? 'default'}`,
        `HitCircleOverlap: ${c.hitCircleOverlap ?? 0}`,
        `ScorePrefix: ${c.scorePrefix ?? 'score'}`,
        `ScoreOverlap: ${c.scoreOverlap ?? 0}`,
        `ComboPrefix: ${c.comboPrefix ?? 'score'}`,
        `ComboOverlap: ${c.comboOverlap ?? 0}`,
        '',
    ];
    return lines.join('\n');
}

/**
 * The generated skin as osu!-format files (name → bytes): every image as
 * a PNG (@2x, or normal resolution for the big soft spinner layers) plus
 * skin.ini. Hitsounds aren't included (they're files in
 * public/assets/skins/default).
 */
export function wosuSkinFiles(o: WosuSkinOptions): Record<string, Uint8Array> {
    const skin = generateWosuSkin(o);
    const out: Record<string, Uint8Array> = {};
    for (const [name, r] of skin.images) out[r.scale === 0.5 ? `${name}@2x.png` : `${name}.png`] = encodePng(r);
    out['skin.ini'] = new TextEncoder().encode(skinIniText(skin.config));
    return out;
}
