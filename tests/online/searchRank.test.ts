import { describe, expect, it } from 'vitest';
import type { OnlineSet } from '../../src/online/providers';
import { normalizeText, rankSearchResults, textRelevance } from '../../src/online/searchRank';

function set(title: string, artist: string, creator: string, playCount: number, approved = 1, extra: Partial<OnlineSet> = {}): OnlineSet {
    return { sid: Math.floor(Math.random() * 1e7) + 1, title, artist, creator, approved, modes: 1, video: false, playCount, ...extra };
}

describe('search ranking', () => {
    it('normalises case, accents and punctuation', () => {
        expect(normalizeText('FREEDOM DiVE↓')).toBe('freedom dive');
        expect(normalizeText('Pokémon: Théme!')).toBe('pokemon theme');
    });

    it('puts the popular exact match first (SayoBot\'s real "blue zenith" order)', () => {
        // In the order the mirror returned them.
        const rows = [
            set('Blue Zenith', 'xi', 'Camo', 715, 3),
            set('Blue Zenith (Cut Ver.)', 'xi', 'Sotarks', 4_329_587),
            set('Songs Compilation III', 'Various Artists', 'Sotarks', 1_646_298, 1, { tags: 'blue zenith' }),
            set('osu!memories', 'SakiZ', 'DeRandom Otaku', 9_215_162, 1, { tags: 'blue zenith freedom dive' }),
            set('Blue Zenith', 'xi', 'Asphyxia', 41_942_950),
            set('Yo Te Propongo (Cut Ver.)', 'Rombai', 'TheUYGovernment', 44, 0),
        ];
        const ranked = rankSearchResults(rows, 'blue zenith').map(s => s.creator);
        expect(ranked.slice(0, 3)).toEqual(['Asphyxia', 'Sotarks', 'Camo']);
        // A huge compilation that only mentions it in its tags stays below real matches.
        expect(ranked.indexOf('DeRandom Otaku')).toBeGreaterThan(ranked.indexOf('Camo'));
        expect(ranked[ranked.length - 1]).toBe('TheUYGovernment');
    });

    it('orders equally good matches by plays ("freedom dive")', () => {
        const rows = [
            set('FREEDOM DiVE (Short Ver.)', 'xi', 'Bloxi', 243_758),
            set('FREEDOM DiVE', 'xi', 'Bloxi', 2_743_373),
            set('Slider', 'Koji Kondo', 'YokesPai', 3_032_793),
            set('FREEDOM DiVE', 'xi', 'Aistre', 1_462_581),
            set('FREEDOM DiVE', 'xi', 'FrenZ396', 9_096_367),
        ];
        expect(rankSearchResults(rows, 'freedom dive').map(s => s.creator)).toEqual(['FrenZ396', 'Bloxi', 'Aistre', 'Bloxi', 'YokesPai']);
    });

    it('surfaces a mapper\'s sets when the query is their name', () => {
        const mapped = set('Some Song', 'Someone', 'Sotarks', 10_000);
        const unrelated = set('Unrelated Hit', 'Popular Artist', 'other', 5_000_000);
        expect(textRelevance(mapped, 'sotarks')).toBeGreaterThan(0);
        expect(rankSearchResults([unrelated, mapped], 'sotarks')[0]).toBe(mapped);
    });

    it('ranks an artist search like a title search ("camellia")', () => {
        const rows = [
            set('CAMELLIA', 'Kano', 'Kana Arima', 50_000),
            set('THE WORLD REVOLVING (Camellia Remix)', 'Toby Fox', 'Ilay', 220_000),
            set('Flamewall', 'Camellia', 'Sotarks', 10_420_000),
        ];
        expect(rankSearchResults(rows, 'camellia')[0].title).toBe('Flamewall');
    });

    it('falls back to popularity for an empty query', () => {
        const rows = [set('A', 'x', 'm', 1), set('B', 'x', 'm', 100)];
        expect(rankSearchResults(rows, '   ').map(s => s.title)).toEqual(['B', 'A']);
    });
});
