import { describe, expect, it } from 'vitest';
import { menuButtonSounds, resolveSkinSound, STABLE_UI_SAMPLE_NAMES, STABLE_UI_SOUNDS } from '../../src/audio/stableUISounds';
import { UI_SAMPLES, UISounds, type UISampleName } from '../../src/audio/UISounds';
import { MODS } from '../../src/gameplay/mods';
import { LegacySkin, type SkinFiles } from '../../src/skin/LegacySkin';
import { menuModIcon } from '../../src/skin/MenuSkin';
import { MOD_ICON_ELEMENTS, MOD_ICON_IMAGE_NAMES, modIconElement } from '../../src/skin/modIcons';
import { parseSkinIni } from '../../src/skin/SkinIni';
import { makeEngine } from '../audio/stubs';

/** A test engine whose context decodes with promises (as UISounds and LegacySkin call it). */
function promiseEngine() {
    const made = makeEngine();
    (made.ctx as unknown as { decodeAudioData: (d: ArrayBuffer) => Promise<unknown> }).decodeAudioData =
        async (d: ArrayBuffer) => ({ tag: String(d.byteLength) });
    return made;
}

describe('stable interface sounds', () => {
    it('maps onto real lazer sample slots', () => {
        for (const slot of Object.keys(STABLE_UI_SOUNDS)) expect(UI_SAMPLES).toContain(slot);
    });

    it('maps the documented sounds to where they play', () => {
        expect(STABLE_UI_SOUNDS['UI/default-hover']).toEqual(['click-short']);
        expect(STABLE_UI_SOUNDS['UI/button-select']).toEqual(['click-short-confirm']);
        expect(STABLE_UI_SOUNDS['UI/check-on']).toEqual(['check-on']);
        expect(STABLE_UI_SOUNDS['UI/check-off']).toEqual(['check-off']);
        expect(STABLE_UI_SOUNDS['UI/notch-tick']).toEqual(['sliderbar']);
        expect(STABLE_UI_SOUNDS['UI/screen-back']).toEqual(['menuback']);
        expect(STABLE_UI_SOUNDS['SongSelect/confirm-selection']).toEqual(['menuhit']);
        expect(STABLE_UI_SOUNDS['SongSelect/select-expand']).toEqual(['select-expand']);
        expect(STABLE_UI_SOUNDS['SongSelect/select-difficulty']).toEqual(['select-difficulty']);
        expect(STABLE_UI_SOUNDS['Keyboard/key-press-3']).toEqual(['key-press-3']);
        expect(menuButtonSounds('freeplay')).toEqual({ hover: 'menu-freeplay-hover', click: 'menu-freeplay-click' });
    });

    it('lists every name the skin loader must decode', () => {
        for (const n of ['menuclick', 'menuback', 'menuhit', 'click-short', 'click-short-confirm', 'check-on', 'check-off',
            'sliderbar', 'select-expand', 'select-difficulty', 'menu-play-click', 'menu-exit-hover', 'back-button-click',
            'back-button-hover', 'heartbeat', 'welcome', 'seeya', 'shutter', 'key-press-1', 'key-delete']) {
            expect(STABLE_UI_SAMPLE_NAMES).toContain(n);
        }
    });

    it('resolves the first sound the skin has; null silences', () => {
        const buf = {} as AudioBuffer;
        const lookup = (n: string) => (n === 'b' ? buf : n === 'muted' ? null : undefined);
        expect(resolveSkinSound(['a', 'b'], lookup)).toEqual({ name: 'b', buffer: buf });
        expect(resolveSkinSound(['muted', 'b'], lookup)).toEqual({ name: 'muted', buffer: null });
        expect(resolveSkinSound(['a'], lookup)).toBeUndefined();
    });

    it("plays the skin's version of a slot, else lazer's", async () => {
        const { engine, ctx } = promiseEngine();
        const sounds = new UISounds(engine, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) as Response);
        await sounds.load('x/');
        const skinBuf = { tag: 'skin' } as unknown as AudioBuffer;
        const played = () => (ctx.sources[ctx.sources.length - 1].buffer as { tag: string }).tag;
        expect(sounds.play('UI/check-on')).toBe(true);
        expect(played()).toBe('4');
        sounds.skinSamples = n => (n === 'check-on' ? skinBuf : n === 'menuback' ? null : undefined);
        expect(sounds.play('UI/check-on')).toBe(true);
        expect(played()).toBe('skin');
        // Not in the skin: lazer's.
        expect(sounds.play('UI/check-off')).toBe(true);
        expect(played()).toBe('4');
        // Silenced by the skin.
        expect(sounds.play('UI/screen-back' as UISampleName)).toBe(false);
        // An explicit list replaces the slot's mapping; skin-only sounds need the skin.
        expect(sounds.play('UI/button-hover', { skin: ['check-on'] })).toBe(true);
        expect(played()).toBe('skin');
        expect(sounds.playSkin(['heartbeat'])).toBe(false);
        expect(sounds.playSkin(['heartbeat', 'check-on'])).toBe(true);
    });
});

describe('stable mod icons', () => {
    it('names an icon for every mod stable had', () => {
        expect(modIconElement('AP')).toBe('selection-mod-relax2');
        expect(modIconElement('NC')).toBe('selection-mod-nightcore');
        expect(modIconElement('SO')).toBe('selection-mod-spunout');
        expect(modIconElement('DC')).toBeNull();
        expect(modIconElement('DA')).toBeNull();
        const withIcons = MODS.filter(m => modIconElement(m.acronym)).map(m => m.acronym);
        expect(withIcons).toHaveLength(Object.keys(MOD_ICON_ELEMENTS).length);
        for (const name of Object.values(MOD_ICON_ELEMENTS)) expect(MOD_ICON_IMAGE_NAMES).toContain(name);
    });

    it('reads the menu skin icon only when the skin has it', () => {
        const tex = { texture: {}, scale: 0.5 };
        const skin = { texture: (n: string) => (n === 'selection-mod-hidden' ? tex : null) } as unknown as LegacySkin;
        expect(menuModIcon('HD', skin)).toBe(tex);
        expect(menuModIcon('HR', skin)).toBeNull();
        expect(menuModIcon('HD', null)).toBeNull();
    });
});

describe('menu skin.ini colours', () => {
    it('reads MenuGlow', () => {
        expect(parseSkinIni('[Colours]\nMenuGlow: 255, 0, 128').menuGlow).toBe(0xff0080);
        expect(parseSkinIni('[Colours]\nCombo1: 1,2,3').menuGlow).toBeUndefined();
    });

    it('decodes interface sounds with the skin', async () => {
        const map: Record<string, Uint8Array> = {
            'menuhit.wav': new Uint8Array(200), 'click-short.ogg': new Uint8Array(200), 'random.wav': new Uint8Array(200),
        };
        const files: SkinFiles = { files: Object.keys(map), readBytes: async p => map[p] };
        const { ctx } = promiseEngine();
        const skin = await LegacySkin.load(files, ctx as unknown as BaseAudioContext, { textures: false });
        expect(skin.sample('menuhit')).toBeTruthy();
        expect(skin.sample('click-short')).toBeTruthy();
        expect(skin.sample('random')).toBeUndefined();
    });
});
