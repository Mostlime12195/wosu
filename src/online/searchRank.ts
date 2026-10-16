import type { OnlineSet } from './providers';

/**
 * Re-ranks beatmap search results. The mirrors return matches in their
 * own order (SayoBot's put a 42-million-play map 7th behind a 715-play
 * one), so a batch is sorted here by how well the query matches the
 * title and artist first, then by how popular the set is, the way the
 * osu! website's relevance order feels.
 */

/** Lowercase, accents stripped, punctuation as spaces ("FREEDOM DiVE↓" → "freedom dive"). */
export function normalizeText(s: string | undefined): string {
    return (s ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function tokens(s: string): string[] {
    return s ? s.split(' ').filter(Boolean) : [];
}

/** How much of `query` a field covers: the share of query words that start a word in it. */
function coverage(words: readonly string[], field: string): number {
    if (!words.length || !field) return 0;
    const fieldWords = tokens(field);
    let hit = 0;
    for (const w of words) if (fieldWords.some(f => f.startsWith(w))) hit++;
    return hit / words.length;
}

const RANKED_LIKE = new Set([1, 2, 3, 4]); // ranked, approved, qualified, loved

/** Text relevance: title and artist matter most, then mapper, source and tags; whole-phrase titles on top. */
export function textRelevance(set: OnlineSet, query: string): number {
    const q = normalizeText(query);
    const words = tokens(q);
    if (!words.length) return 0;
    const title = normalizeText(`${set.title} ${set.titleUnicode ?? ''}`);
    const artist = normalizeText(`${set.artist} ${set.artistUnicode ?? ''}`);
    const main = `${title} ${artist}`;
    const any = `${main} ${normalizeText(set.creator)} ${normalizeText(set.source)} ${normalizeText(set.tags)}`;
    let score = 2 * coverage(words, main) + coverage(words, any);
    // The whole query as a phrase in the title or artist ("blue zenith" in "Blue Zenith (Cut Ver.)",
    // "camellia" as the artist): artist searches rank like title searches.
    if (` ${title} `.includes(` ${q} `) || ` ${artist} `.includes(` ${q} `)) score += 1;
    // …and the title or artist being exactly it, ignoring a trailing "(Cut Ver.)"-style note.
    const bare = (v: string) => normalizeText(v.replace(/\s*[([].*[)\]]\s*$/, ''));
    if (bare(set.title) === q || bare(set.artist) === q || normalizeText(set.artistUnicode) === q) score += 0.5;
    // Mapper searches ("sotarks") should surface that mapper's sets.
    if (normalizeText(set.creator) === q) score += 1.5;
    return score;
}

/** Popularity on a log scale: plays (≈0–8), favourites a little, ranked/loved sets a step up. */
export function popularity(set: OnlineSet): number {
    const plays = Math.log10(Math.max(0, set.playCount) + 1);
    const favs = Math.log10(Math.max(0, set.favouriteCount ?? 0) + 1);
    return plays + 0.5 * favs + (RANKED_LIKE.has(set.approved) ? 1 : 0);
}

/**
 * The ranking score: relevance weighs 3× popularity, so a set that
 * matches the query clearly beats a more popular set that only mentions
 * it in its tags, while among equally good matches the popular one wins.
 */
export function searchScore(set: OnlineSet, query: string): number {
    return 3 * textRelevance(set, query) + popularity(set);
}

/** Sort a batch of results best first (stable for ties, keeping the mirror's order). */
export function rankSearchResults<T extends OnlineSet>(sets: readonly T[], query: string): T[] {
    return sets
        .map((s, i) => ({ s, i, score: searchScore(s, query) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map(e => e.s);
}
