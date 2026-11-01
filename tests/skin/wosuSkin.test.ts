import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { Bindable } from '../../src/core/Bindable';
import { Signal } from '../../src/core/Signal';
import { LEGACY_SLIDER_PROFILE, sliderLutData } from '../../src/graphics/slider/sliderGeometry';
import { NotificationManager } from '../../src/overlays/notifications/Notifications';
import { LegacySkin } from '../../src/skin/LegacySkin';
import { SkinChain } from '../../src/skin/SkinChain';
import { SkinManager } from '../../src/skin/SkinManager';
import { MemoryDatabase } from '../../src/storage/idb';
import { SKIN_STORES, SkinStore } from '../../src/storage/SkinStore';
import { generateWosuSkin, type SkinCache } from '../../src/skin/wosu/elements';
import { skinIniText, wosuSkinFiles } from '../../src/skin/wosu/export';
import { textWidth } from '../../src/skin/wosu/font';
import {
    DEFAULT_WOSU_SKIN, PRESETS, comboColours, matchPreset, parseColours, sanitizeWosuSkin, type PresetId, type WosuSkinOptions,
} from '../../src/skin/wosu/options';
import { encodePng } from '../../src/skin/wosu/png';
import { Raster, circle } from '../../src/skin/wosu/raster';
import { parseSkinIni } from '../../src/skin/SkinIni';

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** Any visible pixel. */
const inked = (r: Raster): boolean => r.data.some((v, i) => i % 4 === 3 && v > 0.05);

describe('wosu! skin options', () => {
    it('sanitizes stored options: bad types, unknown values and out-of-range numbers', () => {
        const o = sanitizeWosuSkin({
            circleStyle: 'triangle', palette: 'neon', comboNumbers: 'yes', approachWidth: 99, numberSize: -1,
            cursorColour: 0x1ff00ff, junk: 1,
        });
        expect(o.circleStyle).toBe(DEFAULT_WOSU_SKIN.circleStyle);
        expect(o.palette).toBe('neon');
        expect(o.comboNumbers).toBe(DEFAULT_WOSU_SKIN.comboNumbers);
        expect(o.approachWidth).toBe(8);
        expect(o.numberSize).toBe(0.6);
        expect(o.cursorColour).toBe(0xff00ff);
        expect('junk' in o).toBe(false);
        expect(sanitizeWosuSkin(null)).toEqual(DEFAULT_WOSU_SKIN);
    });

    it('recognises presets, ignoring unused custom colours', () => {
        for (const id of PRESET_IDS) expect(matchPreset(PRESETS[id])).toBe(id);
        expect(matchPreset({ ...PRESETS.clean, customColours: '#123456' })).toBe('clean');
        expect(matchPreset({ ...PRESETS.clean, show300: true })).toBeNull();
    });

    it('reads custom colours, falling back to wosu!\'s palette', () => {
        expect(parseColours('#ff66aa, 66ccff;#abc  nope')).toEqual([0xff66aa, 0x66ccff, 0xaabbcc]);
        expect(parseColours(Array(10).fill('#fff').join(','))).toHaveLength(8);
        expect(comboColours({ ...DEFAULT_WOSU_SKIN, palette: 'custom', customColours: '#010203' })).toEqual([0x010203]);
        expect(comboColours({ ...DEFAULT_WOSU_SKIN, palette: 'custom', customColours: '' })).toEqual(comboColours({ ...DEFAULT_WOSU_SKIN, palette: 'wosu' }));
    });
});

describe('generated skin', () => {
    const REQUIRED = [
        'hitcircle', 'hitcircleoverlay', 'approachcircle', 'sliderendcircle', 'sliderb', 'sliderfollowcircle', 'sliderscorepoint',
        'reversearrow', 'hit0', 'hit50', 'hit100', 'hit300', 'spinner-bottom', 'spinner-glow', 'spinner-top', 'spinner-approachcircle',
        'spinner-spin', 'spinner-clear', 'spinner-rpm', 'cursor', 'cursormiddle', 'cursor-smoke', 'scorebar-bg', 'scorebar-colour',
        'scorebar-marker', 'scorebar-ki', 'score-dot', 'score-percent', 'score-x',
        ...Array.from({ length: 10 }, (_, i) => [`default-${i}`, `score-${i}`]).flat(),
    ];

    it.each(PRESET_IDS)('draws every element at osu!\'s sizes (%s)', id => {
        const skin = generateWosuSkin(PRESETS[id]);
        for (const name of REQUIRED) expect(skin.images.has(name), name).toBe(true);
        const img = (n: string) => skin.images.get(n)!;
        // A 256px @2x hit circle spans one diameter (bigger only to fit a glow).
        expect(img('hitcircle').width).toBeGreaterThanOrEqual(256);
        expect(img('approachcircle').width).toBe(256);
        expect(img('sliderfollowcircle').width).toBe(614);
        // Slider ends stay hidden: a blank placeholder.
        expect(img('sliderendcircle').width).toBe(2);
        expect(inked(img('sliderendcircle'))).toBe(false);
        for (const n of ['hitcircleoverlay', 'approachcircle', 'sliderb', 'cursor', 'score-0', 'spinner-top', 'hit0']) {
            expect(inked(img(n)), n).toBe(true);
        }
        // Score glyphs share the height the HUD layout was tuned for.
        expect(img('score-5').height).toBe(92);
        expect(skin.config.version).toBe(2.7);
        expect(skin.config.comboColours).toEqual(comboColours(PRESETS[id]));
    });

    it('follows the options: 300s, lighting, follow points, trail, numbers', () => {
        const base: WosuSkinOptions = { ...PRESETS.clean };
        const off = generateWosuSkin({ ...base, show300: false, hitLighting: false, followPoints: 'off', trail: 'off', comboNumbers: false });
        expect(inked(off.images.get('hit300')!)).toBe(false);
        expect(off.images.has('lighting')).toBe(false);
        expect(off.images.has('followpoint')).toBe(false);
        expect(off.images.has('cursortrail')).toBe(false);
        expect(inked(off.images.get('default-3')!)).toBe(false);
        const on = generateWosuSkin({ ...base, show300: true, hitLighting: true, followPoints: 'arrows', trail: 'long' });
        expect(inked(on.images.get('hit300')!)).toBe(true);
        expect(on.images.has('lighting')).toBe(true);
        expect(on.images.has('followpoint')).toBe(true);
        expect(on.extras.trailFade).toBeGreaterThan(generateWosuSkin({ ...base, trail: 'short' }).extras.trailFade);
    });

    it('describes slider bodies skin.ini can\'t (and keeps track override for dark bodies)', () => {
        const dark = generateWosuSkin({ ...PRESETS.clean, sliderBody: 'dark', sliderBorder: 'combo', sliderBorderWidth: 0.2 });
        expect(dark.config.sliderTrackOverride).toBeDefined();
        expect(dark.extras.slider).toMatchObject({ borderWidth: 0.2, comboBorder: true });
        const accent = generateWosuSkin({ ...PRESETS.clean, sliderBorder: 'accent', cursorColour: 0x123456 });
        expect(accent.config.sliderBorder).toBe(0x123456);
    });

    it('only redraws the groups an option affects', () => {
        const cache: SkinCache = new Map();
        const a = generateWosuSkin(PRESETS.clean, cache);
        const b = generateWosuSkin({ ...PRESETS.clean, approachWidth: 5 }, cache);
        expect(b.images.get('hitcircle')).toBe(a.images.get('hitcircle'));
        expect(b.images.get('spinner-bottom')).toBe(a.images.get('spinner-bottom'));
        expect(b.images.get('approachcircle')).not.toBe(a.images.get('approachcircle'));
    });

    it('is deterministic and exports as osu! files', () => {
        const a = wosuSkinFiles(PRESETS.neon);
        const b = wosuSkinFiles(PRESETS.neon);
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
        for (const k of Object.keys(a)) expect(Buffer.from(a[k]).equals(Buffer.from(b[k])), k).toBe(true);
        expect(a['hitcircle@2x.png']).toBeDefined();
        // A normal-resolution image keeps its plain name.
        expect(a['spinner-bottom.png']).toBeDefined();
        const ini = parseSkinIni(new TextDecoder().decode(a['skin.ini']));
        expect(ini.comboColours).toEqual(comboColours(PRESETS.neon));
        expect(ini.hitCirclePrefix).toBe('default');
    });

    it('writes valid PNGs', () => {
        const r = new Raster(5, 3);
        r.shape(circle(2.5, 1.5, 1.2), 0xff0000);
        const png = encodePng(r);
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer, png.byteOffset);
        expect(view.getUint32(16)).toBe(5);
        expect(view.getUint32(20)).toBe(3);
        const idatLen = view.getUint32(33);
        const raw = inflateSync(png.subarray(41, 41 + idatLen));
        expect(raw.length).toBe(3 * (5 * 4 + 1));
    });

    it('measures text', () => {
        const style = { size: 50, weight: 8 };
        expect(textWidth('100', style)).toBeGreaterThan(textWidth('10', style));
        expect(skinIniText({ name: 'x', comboColours: [0x010203] })).toContain('Combo1: 1,2,3');
    });
});

describe('slider body profile', () => {
    it('keeps osu!\'s profile by default and can use combo-coloured borders and shading', () => {
        const legacy = sliderLutData([0xff0000], null, null);
        expect(sliderLutData([0xff0000], null, null, LEGACY_SLIDER_PROFILE).data).toEqual(legacy.data);
        const combo = sliderLutData([0x00ff00], null, 0xffffff, { ...LEGACY_SLIDER_PROFILE, comboBorder: true, shade: 0.5 });
        const last = (combo.width - 4) * 4; // inside the border band
        expect(combo.data[last]).toBe(0);
        expect(combo.data[last + 1]).toBeGreaterThan(200);
    });
});

describe('the default skin in the chain', () => {
    const generated = () => {
        const g = generateWosuSkin(PRESETS.clean);
        return LegacySkin.fromImages(g.config, [...g.images].map(([name, r]) => ({ name, width: r.width, height: r.height, scale: r.scale, data: r.rgba8(true) })), g.extras);
    };

    it('applies its extras only when no imported skin is above it', async () => {
        const base = generated();
        const imported = await LegacySkin.load({ files: [], readBytes: async () => new Uint8Array() }, null);
        expect(new SkinChain([{ skin: base }]).wosuExtras()).toBe(base.extras);
        // A beatmap skin (with its own config) doesn't count.
        expect(new SkinChain([{ skin: imported, config: {} }, { skin: base }]).wosuExtras()).toBe(base.extras);
        expect(new SkinChain([{ skin: imported }, { skin: base }]).wosuExtras()).toBeNull();
        expect(base.texture('hitcircle')?.scale).toBe(0.5);
        expect(base.texture('spinner-bottom')?.scale).toBe(1);
    });

    it('is drawn from the settings, redrawn when they change, and keeps its colours away from imported skins', async () => {
        const wosuSkin = new Bindable<Readonly<WosuSkinOptions>>({ ...PRESETS.neon });
        const m = new SkinManager(new SkinStore(new MemoryDatabase(SKIN_STORES)));
        await m.attach({
            settings: { skin: new Bindable(''), wosuSkin },
            notifications: new NotificationManager(),
            audio: { context: {} as BaseAudioContext },
            screens: { screens: [], changed: new Signal() },
        });
        await m.loadDefault();
        const first = m.default;
        expect(first.config.comboColours).toEqual(comboColours(PRESETS.neon));
        expect(m.chain().config('comboColours')).toEqual(comboColours(PRESETS.neon));

        const changed = vi.fn();
        m.defaultChanged.add(changed);
        wosuSkin.value = { ...PRESETS.classic };
        await vi.waitFor(() => expect(changed).toHaveBeenCalled());
        expect(m.default).not.toBe(first);
        expect(m.default.config.comboColours).toEqual(comboColours(PRESETS.classic));

        // Under an imported skin without colours, the old fallback colours apply.
        const imported = await LegacySkin.load({ files: [], readBytes: async () => new Uint8Array() }, null);
        m.current.value = imported;
        expect(m.chain().config('comboColours')).toEqual([0x609f9f, 0xc0c0c0, 0x80ffff, 0x8bbfde]);
        expect(m.chain().config('sliderBorder')).toBe(0xffffff);
        // Its images still fill in what the imported skin leaves out.
        expect(m.chain().texture('hitcircle')).toBe(m.default.texture('hitcircle'));
    });
});
