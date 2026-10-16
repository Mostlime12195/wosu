import type { Grade } from '../../storage/ScoreStore';

/**
 * Pure helpers for osu!stable's ranking screen (an imported skin's
 * ranking-panel and friends) and for skinned grade letters elsewhere.
 * Positions are in stable's 1024×768 interface space; items anchored to
 * the right edge give their distance from it (`right`).
 */

/**
 * The skin element of a grade's letter: ranking-XH … ranking-D, or the
 * -small variant (song select, leaderboards). A failed play (F) has no
 * stable image (stable doesn't rank failed plays): null.
 */
export function rankingGradeElement(grade: Grade, small = false): string | null {
    if (grade === 'F') return null;
    return small ? `ranking-${grade}-small` : `ranking-${grade}`;
}

/**
 * Elements to try for a grade, best first: a skin without the silver
 * letters (XH / SH) uses its gold ones.
 */
export function rankingGradeElements(grade: Grade, small = false): string[] {
    const own = rankingGradeElement(grade, small);
    if (!own) return [];
    const gold = grade === 'XH' ? 'X' : grade === 'SH' ? 'S' : null;
    return gold ? [own, rankingGradeElement(gold, small) as string] : [own];
}

/**
 * Whether a skin's grade image (its visible part, in display units) is a
 * letter that fits wosu!'s accuracy circle: stable's letters are about
 * 370×420, while some skins paint a whole ranking-screen composition
 * into them (meant for stable's position), which would be lost in the
 * circle.
 */
export function isGradeLetterSized(width: number, height: number): boolean {
    return width > 0 && height > 0 && width <= 760 && height <= 860;
}

/** Stable's "new layout" (skin.ini Version 2.0 and up) vs Version 1 positions. */
export function usesNewRankingLayout(version: number | undefined): boolean {
    return (version ?? 1) >= 2;
}

/** Width of the classic default skin's score digits (score-0@2x is 66×92), in stable units. */
export const DEFAULT_DIGIT_WIDTH = 33;

export interface Point {
    x: number;
    y: number;
}

/** A point measured from the right edge (x = distance from it). */
export interface RightPoint {
    right: number;
    y: number;
}

export interface LegacyRankingLayout {
    /** ranking-panel, top-left origin. */
    panel: Point;
    /** Total score, top-left of the text; `scoreHeight` is the default font's digit width at stable's scale (see DEFAULT_DIGIT_WIDTH). */
    score: Point;
    scoreHeight: number;
    /** The same for the hit counts, combo and accuracy digits. */
    numberHeight: number;
    /** Centre of the first judgement image (hit300); columns and rows step by these. */
    hitImage: Point;
    /** Judgement images are drawn at this fraction of their size. */
    hitImageScale: number;
    /** Top-left of the first count ("123x" beside hit300). */
    hitCount: Point;
    column: number;
    row: number;
    /** ranking-maxcombo / ranking-accuracy, top-left origin. */
    maxComboLabel: Point;
    accuracyLabel: Point;
    /** Top-left of the max combo and accuracy values. */
    maxCombo: Point;
    accuracy: Point;
    /** ranking-graph, top-left origin, and the plotting box inside it. */
    graph: Point;
    graphBox: { x: number; y: number; w: number; h: number };
    /** ranking-perfect, centre origin. */
    perfect: Point;
    /** The big grade letter, centre origin. */
    grade: RightPoint;
    /** ranking-title, top-right origin. */
    title: RightPoint;
    /** The dark bar behind the title and the song info. */
    headerHeight: number;
    /** ranking-retry / ranking-replay, right origin at the screen's right edge (centre y). */
    retryY: number;
    replayY: number;
    /** Where ranking-replay goes when there's no retry button. */
    replayAloneY: number;
    /** Mod icons: the first one's right edge and top; each next one `modStep` to the left. */
    mods: RightPoint;
    modStep: number;
}

/**
 * osu!stable's ranking screen positions for a skin.ini Version, from the
 * osu! wiki (Skinning/Interface: ranking-panel at (0,102) in Version 2+
 * and (0,74) in Version 1, the grade 192px from the right at a height of
 * 320 / 272, ranking-graph at (256,608) / (256,576) with its 301×141 box
 * 7px in and v1's graph 8px lower, ranking-maxcombo (8,480) / (8,500),
 * ranking-accuracy (291,480) / (291,500), ranking-perfect (416,688) /
 * (320,688), ranking-retry at 576 and ranking-replay at 672 or 576). The
 * score and the hit count grid inside the panel follow McOsu's measured
 * reproduction of stable (scaled from its 640×480 units).
 */
export function legacyRankingLayout(version: number | undefined): LegacyRankingLayout {
    const v2 = usesNewRankingLayout(version);
    const panel = { x: 0, y: v2 ? 102 : 74 };
    // McOsu: the score font at 1.3× (v2) / 1.05× (v1) of a 20 (score) or 17 (counts) unit digit.
    const fontScale = (v2 ? 1.3 : 1.05) * 1.6;
    const labelY = v2 ? 480 : 500;
    // McOsu: combo and accuracy values 269 of its units (×1.6) below the panel's top in both layouts.
    const valueY = panel.y + 430;
    const graph = { x: 256, y: v2 ? 608 : 576 };
    return {
        panel,
        score: { x: 178, y: panel.y + 16 },
        scoreHeight: 20 * fontScale,
        numberHeight: 17 * fontScale,
        hitImage: { x: 64, y: panel.y + 158 },
        hitImageScale: 0.5,
        // Counts sit beside their image, a little higher on v1 panels.
        hitCount: { x: 128, y: panel.y + (v2 ? 133 : 118) },
        column: 320,
        row: 96,
        maxComboLabel: { x: 8, y: labelY },
        accuracyLabel: { x: 291, y: labelY },
        maxCombo: { x: 24, y: valueY },
        accuracy: { x: 312, y: valueY },
        graph,
        graphBox: { x: graph.x + 7, y: graph.y + 7 + (v2 ? 0 : 8), w: 301, h: 141 },
        perfect: { x: v2 ? 416 : 320, y: 688 },
        grade: { right: 192, y: v2 ? 320 : 272 },
        title: { right: 32, y: 0 },
        headerHeight: v2 ? 96 : 70,
        retryY: 576,
        replayY: 672,
        replayAloneY: 576,
        mods: { right: 32, y: 416 },
        modStep: 32,
    };
}

/**
 * Scale that fits stable's 1024×768 space into a screen: the height
 * decides (stable widens the space on widescreen, keeping right-anchored
 * items at the right edge); a screen narrower than 4:3 scales by width.
 */
export function legacyRankingScale(w: number, h: number): number {
    return Math.max(0.1, Math.min(h / 768, w / 1024));
}

/** Stable's accuracy text on the ranking screen ("98.76%"). */
export function formatLegacyAccuracy(accuracy: number): string {
    const pct = Number.isFinite(accuracy) ? Math.max(0, Math.min(1, accuracy)) * 100 : 0;
    return `${pct.toFixed(2)}%`;
}

/**
 * The HP graph's polyline in its box: points (x, y) with y down, and
 * whether each segment is at or above half health (stable draws those
 * green, the rest red). Times map linearly over the samples' span, in
 * time order.
 */
export function healthGraphPoints(
    unsorted: readonly (readonly [number, number])[],
    box: { x: number; y: number; w: number; h: number },
): { points: Point[]; high: boolean[] } {
    // Samples can arrive out of order (the end-of-map sample after a seek past it).
    const samples = unsorted.filter(s => Number.isFinite(s[0])).sort((a, b) => a[0] - b[0]);
    if (!samples.length) return { points: [], high: [] };
    const t0 = samples[0][0];
    const t1 = samples[samples.length - 1][0];
    const span = Math.max(1, t1 - t0);
    const hpOf = (hp: number) => (Number.isFinite(hp) ? Math.max(0, Math.min(1, hp)) : 0);
    const points = samples.map(([t, hp]) => ({ x: box.x + ((t - t0) / span) * box.w, y: box.y + (1 - hpOf(hp)) * box.h }));
    const high: boolean[] = [];
    for (let i = 1; i < samples.length; i++) high.push((hpOf(samples[i - 1][1]) + hpOf(samples[i][1])) / 2 >= 0.5);
    return { points, high };
}

/**
 * The judgement image beside each hit count, in panel order (300, 100,
 * 50 in the left column; geki, katu, miss in the right), with stable's
 * fallbacks for skins that lack the combo-end images.
 */
export const HIT_COUNT_IMAGES: readonly (readonly string[])[] = [
    ['hit300'], ['hit100'], ['hit50'],
    ['hit300g', 'hit300'], ['hit100k', 'hit100'], ['hit0'],
];

/** What legacyRankingSource needs of a skin chain layer. */
export interface RankingLayer<S> {
    skin: S | null;
    textures?: boolean;
}

/**
 * The skin whose stable ranking screen to show: the first layer (beatmap
 * skin, then the selected skin) that provides ranking-panel, never
 * wosu!'s own default skin (which keeps the lazer-style results). null =
 * show wosu!'s results.
 */
export function legacyRankingSource<S extends { texture(name: string): unknown }>(
    layers: readonly RankingLayer<S>[],
    defaultSkin: S | null,
): S | null {
    for (const l of layers) {
        if (!l.skin || l.skin === defaultSkin || l.textures === false) continue;
        if (l.skin.texture('ranking-panel')) return l.skin;
    }
    return null;
}

/**
 * The first of `names` an imported skin layer provides (not wosu!'s
 * default skin), e.g. a grade letter only an imported skin would have.
 */
export function importedSkinElement<T>(
    layers: readonly RankingLayer<{ texture(name: string): T | null }>[],
    defaultSkin: unknown,
    names: readonly string[],
): T | null {
    for (const name of names) {
        for (const l of layers) {
            if (!l.skin || l.skin === defaultSkin || l.textures === false) continue;
            const t = l.skin.texture(name);
            if (t) return t;
        }
    }
    return null;
}
