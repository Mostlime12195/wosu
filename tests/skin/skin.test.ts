import { describe, expect, it } from 'vitest';
import { LegacySkin, type SkinFiles } from '../../src/skin/LegacySkin';
import { SkinChain } from '../../src/skin/SkinChain';
import { parseSkinIni, SKIN_DEFAULTS } from '../../src/skin/SkinIni';

const files = (map: Record<string, string>): SkinFiles => ({
    files: Object.keys(map),
    readBytes: async p => new TextEncoder().encode(map[p]),
});

describe('skin.ini', () => {
    it('reads general, colours and fonts', () => {
        const c = parseSkinIni([
            '// comment', '[General]', 'Name: My Skin', 'Author: me', 'Version: latest',
            'CursorRotate: 0', 'AnimationFramerate: 24', 'HitCircleOverlayAboveNumer: 0',
            '[Colours]', 'Combo2: 0,255,0', 'Combo1: 255,0,0', 'SliderBorder: 10,20,30,255', 'Combo3: bad',
            '[Fonts]', 'HitCirclePrefix: fonts\\default', 'HitCircleOverlap: 3', 'ScorePrefix: score',
        ].join('\r\n'));
        expect(c).toMatchObject({
            name: 'My Skin', author: 'me', version: 2.7, cursorRotate: false, animationFramerate: 24,
            hitCircleOverlayAboveNumber: false, comboColours: [0xff0000, 0x00ff00], sliderBorder: 0x0a141e,
            hitCirclePrefix: 'fonts/default', hitCircleOverlap: 3, scorePrefix: 'score',
        });
        expect(c.cursorExpand).toBeUndefined();
    });
});

describe('legacy skins and the chain', () => {
    it('finds skin.ini in a skin zipped inside one folder', async () => {
        const skin = await LegacySkin.load(files({ 'My Skin/skin.ini': '[General]\nName: Nested', 'My Skin/hitcircle.png': '' }), null, { textures: false });
        expect(skin.config.name).toBe('Nested');
    });

    it('reads font glyphs from subfolders (ScorePrefix: fonts\\score) but elements only from the root', async () => {
        const read: string[] = [];
        const src: SkinFiles = {
            files: ['skin.ini', 'fonts/score-0.png', 'fonts/hitcircle.png', 'hitcircle.png', 'readme.txt'],
            readBytes: async p => {
                read.push(p);
                return new TextEncoder().encode(p === 'skin.ini' ? '[Fonts]\nScorePrefix: fonts\\score' : '');
            },
        };
        await LegacySkin.load(src, null, { samples: false });
        expect(read.sort()).toEqual(['fonts/score-0.png', 'hitcircle.png', 'skin.ini']);
    });

    it('falls through layers per setting, and skips disabled config', async () => {
        const top = await LegacySkin.load(files({ 'skin.ini': '[General]\nCursorRotate: 0' }), null, { textures: false });
        const mid = await LegacySkin.load(files({ 'skin.ini': '[General]\nCursorRotate: 1\nCursorExpand: 0\n[Colours]\nCombo1: 1,2,3' }), null, { textures: false });
        const chain = new SkinChain([
            { skin: null, config: { comboColours: [0xabcdef] }, useConfig: false },
            { skin: top },
            { skin: mid },
        ]);
        expect(chain.config('cursorRotate')).toBe(false);
        expect(chain.config('cursorExpand')).toBe(false);
        expect(chain.config('comboColours')).toEqual([0x010203]);
        expect(chain.config('hitCirclePrefix')).toBe(SKIN_DEFAULTS.hitCirclePrefix);
        const withMap = new SkinChain([{ skin: null, config: { comboColours: [0xabcdef] } }, { skin: mid }]);
        expect(withMap.config('comboColours')).toEqual([0xabcdef]);
        // An empty colour list (a map without colours) doesn't hide the skin's.
        const empty = new SkinChain([{ skin: null, config: { comboColours: [] } }, { skin: mid }]);
        expect(empty.config('comboColours')).toEqual([0x010203]);
    });

    it('times animations by AnimationFramerate', () => {
        const chain = new SkinChain([{ skin: null, config: { animationFramerate: 20 } }]);
        expect(chain.frameDuration(4)).toBe(50);
        expect(new SkinChain([]).frameDuration(4)).toBe(250);
    });
});
