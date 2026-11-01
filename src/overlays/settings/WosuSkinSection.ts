import { zipSync, type Zippable } from 'fflate';
import type { Game } from '../../app/Game';
import { Bindable, BindableNumber } from '../../core/Bindable';
import { wosuSkinFiles } from '../../skin/wosu/export';
import {
    CURSOR_COLOURS, DEFAULT_WOSU_SKIN, PRESETS, RANGES, matchPreset,
    type CircleStyle, type CursorStyle, type FollowPointStyle, type JudgementStyle, type PaletteId, type PresetId,
    type SliderBodyStyle, type SliderBorderColour, type TrailLength, type WosuSkinOptions,
} from '../../skin/wosu/options';
import { Colors } from '../../ui/theme';
import { SettingsRow, buttonRow, checkboxRow, dropdownRow, mult, sliderRow, textBoxRow } from './rows';
import type { SubsectionDef } from './types';
import { WosuSkinPreview } from './WosuSkinPreview';

type Custom = 'custom';

/**
 * Settings → Skin → wosu! skin: the options wosu!'s generated default
 * skin is drawn from, shown while it's the selected skin. Each row edits
 * one field of the `wosuSkin` setting through its own bindable (so each
 * gets its restore-default pill); the skin redraws live.
 */
export function wosuSkinSubsection(game: Game, visible: Bindable<boolean>): SubsectionDef {
    const s = game.settings;
    const opts = s.wosuSkin;

    /** A bindable for one option, kept in sync with the setting both ways. */
    function field<K extends keyof WosuSkinOptions>(key: K, b: Bindable<WosuSkinOptions[K]> = new Bindable(DEFAULT_WOSU_SKIN[key])): Bindable<WosuSkinOptions[K]> {
        b.value = opts.value[key];
        b.changed.add(v => {
            if (opts.value[key] !== v) opts.value = { ...opts.value, [key]: v };
        });
        opts.changed.add(o => (b.value = o[key]));
        return b;
    }
    const number = (key: 'numberSize' | 'approachWidth' | 'sliderBorderWidth') => {
        const r = RANGES[key];
        return field(key, new BindableNumber(DEFAULT_WOSU_SKIN[key], r.min, r.max, r.step)) as BindableNumber;
    };

    // The preset shows which one the options match ("Custom" once changed); picking one applies it
    // (keeping any custom colours typed in).
    const preset = new Bindable<PresetId | Custom>('clean');
    const syncPreset = () => (preset.value = matchPreset(opts.value) ?? 'custom');
    opts.changed.add(syncPreset);
    syncPreset();
    preset.changed.add(id => {
        if (id === 'custom' || matchPreset(opts.value) === id) return;
        opts.value = { ...PRESETS[id], customColours: opts.value.customColours };
    });

    const palette = field('palette');
    const customVisible = new Bindable(false);
    const syncCustom = () => (customVisible.value = visible.value && palette.value === 'custom');
    palette.changed.add(syncCustom);
    visible.changed.add(syncCustom);
    syncCustom();

    const when = { visibleWhen: visible };
    const exportSkin = () => {
        try {
            const files = wosuSkinFiles(opts.value);
            const zip: Zippable = {};
            for (const [name, bytes] of Object.entries(files)) zip[name] = [bytes, { level: name.endsWith('.png') ? 0 : 6 }];
            const url = URL.createObjectURL(new Blob([zipSync(zip) as Uint8Array<ArrayBuffer>], { type: 'application/x-osu-skin' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `wosu! (${matchPreset(opts.value) ?? 'custom'}).osk`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            game.notifications.success('Exported the wosu! skin. Its images and skin.ini work in osu! too.');
        } catch (e) {
            console.warn('wosu! skin export failed', e);
            game.notifications.error("Couldn't export the wosu! skin.");
        }
    };

    const rows: SettingsRow[] = [
        dropdownRow<PresetId | Custom>('Preset', [
            { value: 'clean', label: 'Clean (flat circles, no 300s)' },
            { value: 'classic', label: 'Classic (osu!-style, everything shown)' },
            { value: 'neon', label: 'Neon (glowing rings, dark sliders)' },
            { value: 'minimal', label: 'Minimal (outlines, no numbers)' },
            { value: 'custom', label: 'Custom' },
        ], preset, { ...when, keywords: 'wosu skin preset style look theme', description: 'Sets every option below at once. Change any of them to make it your own.' }),
        new SettingsRow(new WosuSkinPreview(game.skins), 'wosu skin preview', null, when),
        dropdownRow<CircleStyle>('Hit circles', [
            { value: 'flat', label: 'Flat (filled, white rim)' },
            { value: 'ring', label: 'Ring (coloured ring, see-through centre)' },
            { value: 'outline', label: 'Outline (white rim only)' },
            { value: 'glossy', label: 'Glossy (classic shading)' },
            { value: 'neon', label: 'Neon (glowing ring)' },
        ], field('circleStyle'), { ...when, keywords: 'wosu skin hitcircle circle style overlay' }),
        dropdownRow<PaletteId>('Combo colours', [
            { value: 'wosu', label: 'wosu! (pink, sky, lavender, yellow)' },
            { value: 'classic', label: 'osu! classic (orange, green, blue, red)' },
            { value: 'pastel', label: 'Pastel' },
            { value: 'neon', label: 'Neon' },
            { value: 'mono', label: 'Mono (white and grey)' },
            { value: 'custom', label: 'Custom' },
        ], palette, { ...when, keywords: 'wosu skin combo colour color palette', description: 'Beatmap colours (below) still win when a map has its own and that option is on.' }),
        textBoxRow('Custom combo colours', field('customColours'), {
            visibleWhen: customVisible, placeholder: '#ff66aa, #66ccff, #b388ff', maxLength: 80,
            keywords: 'wosu skin combo colour color custom hex', description: 'Up to eight hex colours, separated by commas.',
        }),
        checkboxRow('Combo numbers', field('comboNumbers'), { ...when, keywords: 'wosu skin numbers digits default font' }),
        sliderRow('Combo number size', number('numberSize'), mult, { ...when, keywords: 'wosu skin numbers digits size' }),
        sliderRow('Approach circle thickness', number('approachWidth'), v => `${v.toFixed(1)}px`, { ...when, keywords: 'wosu skin approach circle ring width thin thick' }),
        dropdownRow<SliderBodyStyle>('Slider body', [
            { value: 'combo', label: 'Combo colour' },
            { value: 'dark', label: 'Dark' },
            { value: 'gradient', label: 'Gradient (osu! classic)' },
            { value: 'hollow', label: 'Hollow (see-through)' },
        ], field('sliderBody'), { ...when, keywords: 'wosu skin slider body track transparent' }),
        dropdownRow<SliderBorderColour>('Slider border', [
            { value: 'white', label: 'White' },
            { value: 'combo', label: 'Combo colour' },
            { value: 'accent', label: 'Cursor colour' },
        ], field('sliderBorder'), { ...when, keywords: 'wosu skin slider border edge colour color' }),
        sliderRow('Slider border width', number('sliderBorderWidth'), v => `${Math.round(v * 100)}%`, { ...when, keywords: 'wosu skin slider border width thick' }),
        dropdownRow<FollowPointStyle>('Follow points', [
            { value: 'dots', label: 'Dots' },
            { value: 'arrows', label: 'Arrows' },
            { value: 'off', label: 'Off' },
        ], field('followPoints'), { ...when, keywords: 'wosu skin follow points connecting lines' }),
        dropdownRow<JudgementStyle>('Judgements', [
            { value: 'numbers', label: 'Numbers (100, 50, ✕)' },
            { value: 'words', label: 'Words (GREAT, OK, MEH, MISS)' },
            { value: 'minimal', label: 'Minimal (small dots, ✕ for misses)' },
        ], field('judgements'), { ...when, keywords: 'wosu skin judgements hit100 hit50 miss text' }),
        checkboxRow('Show 300s', field('show300'), { ...when, keywords: 'wosu skin 300 great judgement hide' }),
        checkboxRow('Hit lighting', field('hitLighting'), { ...when, keywords: 'wosu skin lighting glow flash' }),
        dropdownRow<CursorStyle>('Cursor', [
            { value: 'dot', label: 'Dot' },
            { value: 'ring', label: 'Ring' },
            { value: 'classic', label: 'Classic (glowing)' },
        ], field('cursorStyle'), { ...when, keywords: 'wosu skin cursor style' }),
        dropdownRow<number>('Cursor colour', CURSOR_COLOURS.map(c => ({ value: c.value, label: c.label })), field('cursorColour'), {
            ...when, keywords: 'wosu skin cursor colour color accent health bar', description: 'Also the health bar\'s colour.',
        }),
        dropdownRow<TrailLength>('Cursor trail', [
            { value: 'short', label: 'Short' },
            { value: 'long', label: 'Long' },
            { value: 'off', label: 'Off' },
        ], field('trail'), { ...when, keywords: 'wosu skin cursor trail length' }),
        buttonRow('Export wosu! skin', exportSkin, {
            ...when, icon: 'download', color: Colors.blueDark, keywords: 'wosu skin export osk download',
            description: 'Download the skin as it looks now as an .osk, to play it in osu! or edit it.',
        }),
    ];
    return { title: 'wosu! skin', rows };
}
