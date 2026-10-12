import type { PlayableHitObject } from '../../beatmap/types';
import type { HitResult } from './ScoreProcessor';

/**
 * osu!stable's combo-end judgements (osu! wiki, Gameplay/Judgement/osu!,
 * "Geki and Katu"): the last object of a combo gives
 *  - geki (hit300g) for a GREAT when every object in the combo was a GREAT;
 *  - katu for a GREAT (hit300k) or an OK (hit100k) when every object in
 *    the combo was at least an OK (no MEH or miss).
 * Counted on the score as gekis / katus (the .osr's counts in osu!).
 */
export type ComboEndVariant = 'geki' | 'katu';

const RANK: Record<HitResult, number> = { great: 0, ok: 1, meh: 2, miss: 3 };

/** The variant for a combo's last judgement `last`, given the worst judgement of the whole combo (`last` included). */
export function comboEndVariant(worst: HitResult, last: HitResult): ComboEndVariant | null {
    if (worst === 'great') return 'geki';
    if (worst === 'ok' && (last === 'great' || last === 'ok')) return 'katu';
    return null;
}

/**
 * Tracks the worst judgement per combo (objects from one new combo to the
 * next) and classifies each combo's last object. Combos are keyed by
 * group, so a long slider ending its combo after the next combo's first
 * circle was judged still counts only its own combo.
 */
export class ComboEndTracker {
    private readonly worst = new Map<number, HitResult>();

    constructor(private readonly group: readonly number[], private readonly last: readonly boolean[]) {}

    static forObjects(objects: readonly PlayableHitObject[]): ComboEndTracker {
        const group: number[] = [];
        let g = -1;
        for (const h of objects) {
            if (h.newCombo || g < 0) g++;
            group.push(g);
        }
        return new ComboEndTracker(group, objects.map(h => h.lastInCombo));
    }

    /** Record object `index`'s main judgement; the variant it shows (only for a combo's last object). */
    apply(index: number, result: HitResult): ComboEndVariant | null {
        const g = this.group[index] ?? -1;
        const prev = this.worst.get(g);
        const worst = prev !== undefined && RANK[prev] > RANK[result] ? prev : result;
        if (!this.last[index]) {
            this.worst.set(g, worst);
            return null;
        }
        this.worst.delete(g);
        return comboEndVariant(worst, result);
    }
}
