import { Container, Sprite } from 'pixi.js';
import { ModIcon } from '../../overlays/mods/ModIcon';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { modIconElement } from '../../skin/modIcons';
import { extendedModInfo, modSettingsOf, sortedMods, type ModAcronym, type ModSet } from '../mods';
import type { Rect } from './layout/HudLayout';

/** wosu!'s badges: pill height in HUD units (about lazer's ModIcon at ModDisplay.MOD_ICON_SCALE). */
const BADGE_HEIGHT = 24;
/** lazer's expanded ModDisplay spacing. */
const BADGE_GAP = 5;
/** A skin's selection-mod image at lazer's MOD_ICON_SCALE of its legacy size (64 units for a 64px SD image). */
const SKIN_ICON_SCALE = 0.6;
const SKIN_ICON_GAP = 2;
/** What the skin editor shows when no mods are selected, so the component can be found and placed. */
const PREVIEW_MODS: readonly ModAcronym[] = ['HD', 'HR'];

/**
 * The first osu! skin in the chain with this mod's selection-mod image
 * (beatmap skins may provide them), or null: wosu!'s default skin has
 * none, so it keeps wosu!'s own badges.
 */
export function skinModIcon(chain: SkinChain, acronym: ModAcronym): SkinTexture | null {
    const name = modIconElement(acronym);
    if (!name) return null;
    const last = chain.layers.length - 1;
    for (let i = 0; i < last; i++) {
        const l = chain.layers[i];
        if (!l.skin || l.textures === false) continue;
        const t = l.skin.texture(name);
        if (t) return t;
    }
    return null;
}

/** Left edges and the total width of a row of icons `widths` wide, `gap` apart. */
export function rowLayout(widths: readonly number[], gap: number): { xs: number[]; width: number } {
    const xs: number[] = [];
    let x = 0;
    for (const w of widths) {
        xs.push(x);
        x += w + gap;
    }
    return { xs, width: Math.max(0, x - (widths.length ? gap : 0)) };
}

/**
 * lazer's ModDisplay as a HUD component: the mods in play in a row, in
 * lazer's mod order. Each mod is the skin's selection-mod-* image where an
 * osu! skin has one (osu!stable's gameplay mod icons), else wosu!'s badge
 * (with a custom rate beside it). Its origin is the row's top-right
 * corner, so it grows leftwards like stable's and lazer's top-right row.
 */
export class ModDisplay extends Container {
    private readonly row = new Container();
    box: Rect = { x: 0, y: 0, w: 0, h: BADGE_HEIGHT };

    constructor(chain: SkinChain, mods: ModSet, editor = false) {
        super();
        this.eventMode = 'none';
        this.addChild(this.row);
        let list = sortedMods(mods);
        if (!list.length && editor) {
            list = [...PREVIEW_MODS];
            this.row.alpha = 0.5;
        }
        const settings = modSettingsOf(mods);
        const views: { view: Container; w: number; h: number }[] = [];
        for (const m of list) {
            const t = skinModIcon(chain, m);
            if (t) {
                const s = new Sprite(t.texture);
                const k = t.scale * SKIN_ICON_SCALE;
                s.scale.set(k);
                s.eventMode = 'none';
                views.push({ view: s, w: t.texture.width * k, h: t.texture.height * k });
            } else {
                const icon = new ModIcon(m, BADGE_HEIGHT, extendedModInfo(m, settings));
                views.push({ view: icon, w: icon.iconWidth, h: BADGE_HEIGHT });
            }
        }
        const skinned = views.some(v => v.view instanceof Sprite);
        const { xs, width } = rowLayout(views.map(v => v.w), skinned ? SKIN_ICON_GAP : BADGE_GAP);
        const h = Math.max(BADGE_HEIGHT, ...views.map(v => v.h));
        views.forEach((v, i) => {
            // Right-aligned row, each icon centred on the row's height.
            v.view.position.set(xs[i] - width, (h - v.h) / 2);
            this.row.addChild(v.view);
        });
        this.box = { x: -width, y: 0, w: width, h };
    }
}
