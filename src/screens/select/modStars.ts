import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import { calculateDifficulty } from '../../beatmap/difficulty';
import { buildPlayableBeatmap } from '../../beatmap/processing';
import type { DifficultySummary } from '../../beatmap/types';
import { NO_MODS, modsString, playbackRate, sanitizeMods, type ModSet } from '../../gameplay/mods';

/** Mods that change the star rating (Hidden/Flashlight don't, in the classic model). */
const RATING_MODS = ['EZ', 'HR', 'HT', 'DC', 'DT', 'NC'] as const;
const cache = new Map<string, Promise<number | null>>();
const CACHE_LIMIT = 200;

/** The subset of `mods` that affects difficulty, or null when none does. */
export function ratingMods(mods: ModSet): ModSet | null {
    const relevant = RATING_MODS.filter(m => mods.has(m));
    return relevant.length ? sanitizeMods(relevant) : null;
}

/**
 * Star rating with mods applied, like lazer's song select. The local
 * calculator's mod/nomod ratio scales the shown rating, so official
 * (online) ratings stay the reference. Resolves null when unknown.
 */
export function modAdjustedStars(game: Game, set: LibrarySet, diff: DifficultySummary, mods: ModSet): Promise<number | null> {
    const relevant = ratingMods(mods);
    if (!relevant || diff.stars === null) return Promise.resolve(diff.stars);
    const key = `${set.key}|${diff.file}|${diff.stars}|${modsString(relevant)}`;
    let hit = cache.get(key);
    if (!hit) {
        hit = game.library.loadBeatmap(set.key, diff.file).then(data => {
            const base = calculateDifficulty(buildPlayableBeatmap(data, NO_MODS)).stars;
            const modded = calculateDifficulty(buildPlayableBeatmap(data, relevant), playbackRate(relevant)).stars;
            if (!(base > 0)) return diff.stars;
            return Math.round((diff.stars as number) * (modded / base) * 100) / 100;
        }).catch(() => diff.stars);
        cache.set(key, hit);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    }
    return hit;
}
