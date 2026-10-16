import { describe, expect, it } from 'vitest';
import {
    formatLegacyAccuracy,
    healthGraphPoints,
    importedSkinElement,
    isGradeLetterSized,
    legacyRankingLayout,
    legacyRankingScale,
    legacyRankingSource,
    rankingGradeElement,
    rankingGradeElements,
    usesNewRankingLayout,
} from '../../src/screens/results/rankingLayout';

/** A stand-in skin: the element names it has. */
const skin = (...names: string[]) => ({ texture: (n: string) => (names.includes(n.toLowerCase()) ? n : null) });

describe('grade elements', () => {
    it('maps every grade to its ranking image', () => {
        expect(rankingGradeElement('XH')).toBe('ranking-XH');
        expect(rankingGradeElement('X')).toBe('ranking-X');
        expect(rankingGradeElement('SH')).toBe('ranking-SH');
        expect(rankingGradeElement('S')).toBe('ranking-S');
        expect(rankingGradeElement('A')).toBe('ranking-A');
        expect(rankingGradeElement('D')).toBe('ranking-D');
        expect(rankingGradeElement('B', true)).toBe('ranking-B-small');
        expect(rankingGradeElement('XH', true)).toBe('ranking-XH-small');
    });

    it('has no image for a failed play', () => {
        expect(rankingGradeElement('F')).toBeNull();
        expect(rankingGradeElements('F')).toEqual([]);
    });

    it('falls back from the silver letters to the gold ones', () => {
        expect(rankingGradeElements('XH')).toEqual(['ranking-XH', 'ranking-X']);
        expect(rankingGradeElements('SH', true)).toEqual(['ranking-SH-small', 'ranking-S-small']);
        expect(rankingGradeElements('A')).toEqual(['ranking-A']);
    });
});

describe('isGradeLetterSized', () => {
    it('accepts letter-sized images and rejects whole-screen compositions', () => {
        expect(isGradeLetterSized(369, 422)).toBe(true);
        expect(isGradeLetterSized(2349, 1527)).toBe(false);
        expect(isGradeLetterSized(0, 0)).toBe(false);
    });
});

describe('legacyRankingLayout', () => {
    it('treats Version 2.0 and up as the new layout', () => {
        expect(usesNewRankingLayout(undefined)).toBe(false);
        expect(usesNewRankingLayout(1)).toBe(false);
        expect(usesNewRankingLayout(1.9)).toBe(false);
        expect(usesNewRankingLayout(2)).toBe(true);
        expect(usesNewRankingLayout(2.7)).toBe(true);
    });

    it('uses the wiki positions for Version 2+', () => {
        const l = legacyRankingLayout(2.7);
        expect(l.panel).toEqual({ x: 0, y: 102 });
        expect(l.grade).toEqual({ right: 192, y: 320 });
        expect(l.graph).toEqual({ x: 256, y: 608 });
        expect(l.graphBox).toEqual({ x: 263, y: 615, w: 301, h: 141 });
        expect(l.maxComboLabel).toEqual({ x: 8, y: 480 });
        expect(l.accuracyLabel).toEqual({ x: 291, y: 480 });
        expect(l.perfect).toEqual({ x: 416, y: 688 });
        expect(l.retryY).toBe(576);
        expect(l.replayY).toBe(672);
        expect(l.replayAloneY).toBe(576);
        expect(l.title.right).toBe(32);
    });

    it('uses the wiki positions for Version 1', () => {
        const l = legacyRankingLayout(1);
        expect(l.panel).toEqual({ x: 0, y: 74 });
        expect(l.grade).toEqual({ right: 192, y: 272 });
        expect(l.graph).toEqual({ x: 256, y: 576 });
        // v1's graph is drawn 8px lower inside its image.
        expect(l.graphBox.y).toBe(576 + 7 + 8);
        expect(l.maxComboLabel).toEqual({ x: 8, y: 500 });
        expect(l.accuracyLabel).toEqual({ x: 291, y: 500 });
        expect(l.perfect).toEqual({ x: 320, y: 688 });
    });

    it('keeps the panel contents with the panel and scales the font by version', () => {
        const v1 = legacyRankingLayout(1), v2 = legacyRankingLayout(2);
        expect(v2.score.y - v2.panel.y).toBe(v1.score.y - v1.panel.y);
        expect(v2.hitImage.y - v2.panel.y).toBe(v1.hitImage.y - v1.panel.y);
        expect(v2.scoreHeight).toBeGreaterThan(v1.scoreHeight);
        expect(v2.scoreHeight / v1.scoreHeight).toBeCloseTo(1.3 / 1.05);
        // Values sit below their labels, above the graph.
        for (const l of [v1, v2]) {
            expect(l.maxCombo.y).toBeGreaterThan(l.maxComboLabel.y);
            expect(l.maxCombo.y + l.numberHeight).toBeLessThanOrEqual(l.graph.y + 8);
        }
    });

    it('fits the 1024×768 space by height, by width when narrower than 4:3', () => {
        expect(legacyRankingScale(1920, 1080)).toBeCloseTo(1080 / 768);
        expect(legacyRankingScale(1024, 768)).toBe(1);
        expect(legacyRankingScale(800, 1000)).toBeCloseTo(800 / 1024);
    });
});

describe('legacyRankingSource', () => {
    const def = skin('ranking-panel');

    it('picks the first imported layer with a ranking panel', () => {
        const map = skin('hitcircle');
        const user = skin('ranking-panel');
        expect(legacyRankingSource([{ skin: map }, { skin: user }, { skin: def }], def)).toBe(user);
    });

    it("never uses wosu!'s default skin", () => {
        expect(legacyRankingSource([{ skin: null }, { skin: def }], def)).toBeNull();
    });

    it('skips a beatmap skin whose textures are off', () => {
        const map = skin('ranking-panel');
        expect(legacyRankingSource([{ skin: map, textures: false }, { skin: def }], def)).toBeNull();
    });

    it('finds grade letters only in imported skins', () => {
        const user = skin('ranking-x');
        expect(importedSkinElement([{ skin: user }, { skin: def }], def, ['ranking-XH', 'ranking-X'])).toBe('ranking-X');
        expect(importedSkinElement([{ skin: def }], def, ['ranking-panel'])).toBeNull();
    });
});

describe('ranking screen values', () => {
    it('formats accuracy like stable', () => {
        expect(formatLegacyAccuracy(0.98765)).toBe('98.77%');
        expect(formatLegacyAccuracy(1)).toBe('100.00%');
        expect(formatLegacyAccuracy(NaN)).toBe('0.00%');
    });

    it('plots the HP graph across its box, green above half health', () => {
        const box = { x: 10, y: 20, w: 100, h: 50 };
        const { points, high } = healthGraphPoints([[1000, 1], [2000, 0.6], [3000, 0.2]], box);
        expect(points[0]).toEqual({ x: 10, y: 20 });
        expect(points[1].x).toBeCloseTo(60);
        expect(points[1].y).toBeCloseTo(40);
        expect(points[2]).toEqual({ x: 110, y: 60 });
        expect(high).toEqual([true, false]);
        expect(healthGraphPoints([], box)).toEqual({ points: [], high: [] });
        // Out-of-order samples stay inside the box.
        const late = healthGraphPoints([[0, 1], [5000, 0.5], [4000, 0.8]], box).points;
        expect(Math.max(...late.map(p => p.x))).toBe(110);
        expect(late[2]).toEqual({ x: 110, y: 45 });
    });
});
