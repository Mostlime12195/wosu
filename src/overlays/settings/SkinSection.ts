import type { Game } from '../../app/Game';
import { Bindable } from '../../core/Bindable';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { Colors } from '../../ui/theme';
import { buttonRow, checkboxRow, dropdownRow, mult, sliderRow, textRow, type SettingsRow } from './rows';
import type { SectionDef } from './types';

/** Dropdown entry that picks a random skin (lazer's "<Random skin>"). */
const RANDOM = '\u0000random';
const DEFAULT_LABEL = 'wosu! (default)';

function skinItems(game: Game): DropdownItem<string>[] {
    const imported = game.skins.imported;
    // Same-named skins by different authors stay tellable apart.
    const named = new Map<string, number>();
    for (const s of imported) named.set(s.name.toLowerCase(), (named.get(s.name.toLowerCase()) ?? 0) + 1);
    const labelFor = (s: { name: string; author: string }) => ((named.get(s.name.toLowerCase()) ?? 0) > 1 ? `${s.name} (${s.author})` : s.name);
    return [
        ...(imported.length ? [{ value: RANDOM, label: '<Random skin>' }] : []),
        { value: '', label: DEFAULT_LABEL },
        ...imported.map(s => ({ value: s.id, label: labelFor(s) })),
    ];
}

function dropdownIn(row: SettingsRow): Dropdown<string> | null {
    return (row.control.children.find(c => c instanceof Dropdown) as Dropdown<string> | undefined) ?? null;
}

/**
 * lazer's skin section: the current skin (with a random pick), import,
 * export and delete, then the beatmap skin toggles and cursor settings.
 */
export function skinSection(game: Game): SectionDef {
    const s = game.settings;
    const skins = game.skins;

    // The dropdown edits a proxy so "<Random skin>" never lands in settings.
    const choice = new Bindable<string>('');
    s.skin.bind(v => (choice.value = v), true);
    choice.bind(v => {
        if (v === RANDOM) {
            choice.value = s.skin.value;
            skins.selectRandom();
        } else {
            s.skin.value = v;
        }
    });
    const current = dropdownRow('Current skin', skinItems(game), choice, { keywords: 'skin osk select theme' });
    const dropdown = dropdownIn(current);

    const about = textRow('', { color: Colors.grayA, size: 12, keywords: 'skin author' });
    const describe = () => {
        const info = skins.currentInfo.value;
        const id = s.skin.value;
        const pending = id ? skins.store.get(id) : undefined;
        if (skins.loading.value && pending) about.block.content = `Loading ${pending.name}…`;
        else if (info) about.block.content = `${info.name} by ${info.author}, imported ${new Date(info.addedAt).toLocaleDateString()}.`;
        else about.block.content = "wosu!'s built-in skin. Drop an .osk file anywhere, or import one below, to add a skin.";
        about.row.onLayoutChange?.();
    };

    const importSkin = buttonRow('Import skin', () => game.pickFiles('.osk,.zip'), {
        icon: 'fileImport', color: Colors.purple, keywords: 'skin osk add file drop',
    });
    const exportSkin = buttonRow('Export skin', () => {
        const info = skins.currentInfo.value;
        if (!info) return;
        skins.exportSkin(info.id).then(
            () => game.notifications.success(`Exported ${info.name}.`),
            e => game.notifications.error(`Couldn't export ${info.name}: ${e instanceof Error ? e.message : String(e)}`),
        );
    }, { icon: 'download', color: Colors.blueDark, keywords: 'skin osk save download' });
    const deleteSkin = buttonRow('Delete skin', () => {
        const info = skins.currentInfo.value;
        if (!info) return;
        void game.dialog.confirm({
            title: 'Delete skin?',
            text: `Are you sure you want to delete "${info.name}"? It is removed from this browser.`,
            confirmText: 'Yes. Totally. Delete it.',
            danger: true,
            icon: 'trash',
        }).then(async ok => {
            if (!ok) return;
            try {
                await skins.deleteSkin(info.id);
                game.notifications.success(`Deleted ${info.name}.`);
            } catch (e) {
                console.warn('skin delete failed', e);
                game.notifications.error(`Couldn't delete ${info.name}.`);
            }
        });
    }, { icon: 'trash', color: Colors.redDark, keywords: 'skin remove' });

    // Export and delete only apply to imported skins (lazer: not the protected built-ins).
    const sync = () => {
        const imported = !!skins.currentInfo.value && !skins.loading.value;
        exportSkin.control.enabled = imported;
        deleteSkin.control.enabled = imported;
        describe();
    };
    skins.store.changed.add(() => {
        dropdown?.setItems(skinItems(game));
        sync();
    });
    skins.currentInfo.bind(sync);
    skins.loading.bind(sync);
    sync();

    return {
        id: 'skin',
        title: 'Skin',
        icon: 'brush',
        subsections: [
            {
                title: 'Current skin',
                rows: [current, about.row, importSkin, exportSkin, deleteSkin],
            },
            {
                title: 'Beatmap',
                rows: [
                    checkboxRow('Beatmap skins', s.beatmapSkin, {
                        description: "Use the hit circles, numbers, slider and judgement images that a beatmap ships with. Its own hitsounds are under Audio → Beatmap hitsounds.",
                        keywords: 'skin custom elements images',
                    }),
                    checkboxRow('Beatmap colours', s.beatmapColours, {
                        description: 'Use the combo and slider colours that a beatmap defines instead of the skin\'s.',
                        keywords: 'skin custom colours colors combo',
                    }),
                ],
            },
            {
                title: 'Cursor',
                rows: [
                    sliderRow('Menu cursor size', s.menuCursorSize, mult, { keywords: 'cursor scale' }),
                    sliderRow('Gameplay cursor size', s.cursorSize, mult, { keywords: 'cursor scale' }),
                    checkboxRow('Adjust gameplay cursor size based on current beatmap', s.autoCursorSize, { keywords: 'cursor circle size auto' }),
                    checkboxRow('Show cursor trail', s.cursorTrail, { keywords: 'cursor trail' }),
                    checkboxRow('Expand cursor when pressed', s.cursorExpand, { keywords: 'cursor pulse click' }),
                    checkboxRow('Rotate cursor when dragging', s.cursorRotation, { keywords: 'cursor rotation drag' }),
                    checkboxRow('Show gameplay cursor during touch input', s.gameplayCursorDuringTouch, { keywords: 'cursor touchscreen mobile' }),
                    checkboxRow('Use hardware cursor in menus', s.hardwareCursor, { keywords: 'cursor system mouse pointer' }),
                ],
            },
        ],
    };
}
