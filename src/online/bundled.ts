/**
 * Beatmaps downloaded on first launch, like osu!lazer's bundled beatmaps:
 * all Featured Artist sets (licensed for use in osu!) with a spread of
 * osu!standard difficulties. lazer's tutorial (nekodex - new beginnings,
 * mapped by pishifat) and cYsmix - triangles always come first; the
 * rest is a weekly-seeded pick, so new players in the same week get the
 * same selection (lazer does the same).
 */
export interface BundledSet {
    sid: number;
    artist: string;
    title: string;
}

export const ALWAYS_BUNDLED: readonly BundledSet[] = [
    { sid: 1841885, artist: 'cYsmix', title: 'triangles' },
    { sid: 1011011, artist: 'nekodex', title: 'new beginnings' },
];

const POOL: readonly BundledSet[] = [
    { sid: 2412232, artist: 'Will Stetson', title: 'Of Our Time' },
    { sid: 2412331, artist: 'takehirotei', title: 'Haiboku no Altra Vita' },
    { sid: 2412244, artist: 'Kry.exe', title: 'Rift Walker' },
    { sid: 1971987, artist: 'James Landino', title: "Aresene's Bazaar" },
    { sid: 2412328, artist: 'Akiri', title: 'Vespera Stella' },
    { sid: 2412292, artist: 'ArXe', title: 'Locus Amoenus (feat. Megurine Luka)' },
    { sid: 2412260, artist: 'Koto Spirit', title: 'Locus of Hexagram' },
    { sid: 1388906, artist: 'Raphlesia & BilliumMoto', title: 'My Love' },
    { sid: 456054, artist: 'IAHN', title: 'Candy Luv (Short Ver.)' },
    { sid: 241526, artist: 'Soleily', title: 'Renatus' },
    { sid: 151878, artist: 'Chasers', title: 'Lost' },
    { sid: 123593, artist: 'Rostik', title: 'Liquid (Paul Rosenthal Remix)' },
];

/** How many sets a first launch downloads (the always-included ones counted). */
export const BUNDLED_COUNT = 5;

/** The sets to download, in order. `now` only picks the week. */
export function bundledSelection(now: Date = new Date(), count = BUNDLED_COUNT): BundledSet[] {
    const start = Date.UTC(now.getUTCFullYear(), 0, 1);
    const dayOfYear = Math.floor((now.getTime() - start) / 86_400_000);
    const rand = mulberry32(now.getUTCFullYear() * 100 + Math.floor(dayOfYear / 7));
    const pool = [...POOL];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return [...ALWAYS_BUNDLED, ...pool.slice(0, Math.max(0, count - ALWAYS_BUNDLED.length))];
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
