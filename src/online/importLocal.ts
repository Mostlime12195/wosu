/**
 * Bringing this device's local scores into a wosu! account: offered right
 * after signing up, and available later from the profile card.
 */
import type { Game } from '../app/Game';
import type { ScoreRecord } from '../storage/ScoreStore';
import { ApiError, type ImportSummary } from './Account';

/** Local scores the server would accept: passed, on a downloaded beatmap, with real hit counts. */
export function importable(records: readonly ScoreRecord[]): ScoreRecord[] {
    return records.filter(r => r.passed && r.beatmapId > 0 && !r.legacy && r.count300 + r.count100 + r.count50 + r.countMiss > 0);
}

/** "3 scores", "1 score". */
export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Ask, then upload. `prompt: false` skips the question (a button the player
 * already pressed). Resolves once done or declined; never throws.
 */
export async function offerLocalImport(game: Game, { prompt = true }: { prompt?: boolean } = {}): Promise<void> {
    if (!game.account.signedIn) return;
    let all: ScoreRecord[];
    try {
        all = importable(await game.scores.all());
    } catch {
        return;
    }
    if (!all.length) {
        if (!prompt) game.notifications.info('There are no local scores on downloaded beatmaps to upload.');
        return;
    }
    if (prompt) {
        const ok = await game.dialog.confirm({
            title: 'Upload your local scores?',
            text: `${plural(all.length, 'passed play')} on downloaded beatmaps ${all.length === 1 ? 'is' : 'are'} saved on this device. Add ${all.length === 1 ? 'it' : 'them'} to your account's leaderboards? Plays already on the account are skipped, and local copies stay as they are.`,
            confirmText: 'Upload them',
            cancelText: 'Not now',
            icon: 'upload',
        });
        if (!ok) return;
    }
    const toast = game.notifications.progress(`Uploading ${plural(all.length, 'score')}…`, 'Local scores');
    let summary: ImportSummary;
    try {
        summary = await game.account.importScores(all, id => game.scores.replay(id), done => (toast.progress.value = done / all.length));
    } catch (e) {
        console.warn('local score upload failed', e);
        toast.fail(e instanceof ApiError ? `Upload stopped: ${e.message}` : 'Upload stopped: the wosu! server could not be reached.');
        return;
    }
    const parts = [`${plural(summary.imported, 'score')} uploaded`];
    if (summary.skipped) parts.push(`${summary.skipped} already there`);
    if (summary.invalid) parts.push(`${summary.invalid} not accepted`);
    toast.complete(parts.join(', ') + '.');
}
