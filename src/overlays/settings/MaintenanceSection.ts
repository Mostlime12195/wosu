import type { Game } from '../../app/Game';
import { Colors } from '../../ui/theme';
import { buttonRow, textRow } from './rows';
import type { SectionDef } from './types';

function formatBytes(n: number): string {
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function maintenanceSection(game: Game): SectionDef {
    const stats = textRow('', { color: Colors.grayA, size: 12, keywords: 'library storage' });
    let scoreCount = 0;
    const refresh = () => {
        const sets = game.library.sets;
        const bytes = sets.reduce((a, s) => a + (s.sizeBytes || 0), 0);
        const diffs = sets.reduce((a, s) => a + s.difficulties.length, 0);
        stats.block.content = `${sets.length} beatmap sets (${diffs} difficulties, ${formatBytes(bytes)}) and ${scoreCount} local scores.`;
        // The line can wrap differently now: re-measure the row.
        stats.row.onLayoutChange?.();
    };
    const countScores = () => game.scores.all().then(all => {
        scoreCount = all.length;
        refresh();
    }).catch(() => {});
    game.library.changed.add(refresh);
    game.scores.changed.add(() => void countScores());
    game.scores.removed.add(() => void countScores());
    refresh();
    void countScores();

    const deleteAll = async () => {
        const n = game.library.sets.length;
        if (!n) {
            game.notifications.info('Your library is already empty.');
            return;
        }
        const ok = await game.dialog.confirm({
            title: 'Delete all beatmaps?',
            text: `This removes all ${n} beatmap sets stored in this browser. Scores are kept.`,
            confirmText: 'Delete everything',
            danger: true,
        });
        if (!ok) return;
        // The library may have changed while the dialog was up (or a queued
        // second request already emptied it): delete what is there now.
        const sets = [...game.library.sets];
        if (!sets.length) return;
        const note = game.notifications.progress(`Deleting ${sets.length} beatmap sets…`);
        let done = 0, deleted = 0;
        for (const set of sets) {
            try {
                await game.library.delete(set.key);
                deleted++;
            } catch (e) {
                console.warn('delete failed', set.key, e);
            }
            note.progress.value = ++done / sets.length;
        }
        if (deleted === sets.length) note.complete(`Deleted ${deleted} beatmap sets.`);
        else note.fail(`Deleted ${deleted} of ${sets.length} beatmap sets; the rest could not be removed.`);
    };

    const clearScores = async () => {
        const ok = await game.dialog.confirm({
            title: 'Clear all scores?',
            text: 'Every local score and play history entry will be permanently removed.',
            confirmText: 'Clear scores',
            danger: true,
        });
        if (!ok) return;
        try {
            await game.scores.clear();
        } catch (e) {
            console.warn('clearing scores failed', e);
            game.notifications.error('Could not clear scores.');
            return;
        }
        scoreCount = 0;
        refresh();
        game.notifications.success('All scores cleared.');
    };

    const resetSettings = async () => {
        const ok = await game.dialog.confirm({
            title: 'Reset all settings?',
            text: 'Every setting returns to its default value. Your beatmaps and scores are not affected.',
            confirmText: 'Reset settings',
            danger: true,
        });
        if (!ok) return;
        game.settings.resetAll();
        game.notifications.success('Settings reset to defaults.');
    };

    return {
        id: 'maintenance',
        title: 'Maintenance',
        icon: 'wrench',
        subsections: [
            {
                title: 'Beatmaps',
                rows: [
                    stats.row,
                    buttonRow('Import beatmaps (.osz)', () => game.pickFiles(), { icon: 'fileImport', color: Colors.purple, keywords: 'add file drop' }),
                    buttonRow('Delete all beatmaps', () => void deleteAll(), { icon: 'trash', color: Colors.redDark, keywords: 'remove library clear' }),
                ],
            },
            {
                title: 'Scores',
                rows: [buttonRow('Clear all scores', () => void clearScores(), { icon: 'eraser', color: Colors.redDark, keywords: 'history delete' })],
            },
            {
                title: 'Settings',
                rows: [buttonRow('Reset all settings', () => void resetSettings(), { icon: 'refresh', color: Colors.gray4, keywords: 'defaults restore' })],
            },
        ],
    };
}
