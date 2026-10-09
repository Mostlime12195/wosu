import { describe, expect, it } from 'vitest';
import {
    approvedText,
    coverUrl,
    downloadUrl,
    isStandardSet,
    minoGenreIds,
    minoLangIds,
    parseMaskSum,
    previewUrl,
    PROVIDERS,
    resolveProviders,
    statusFilter,
    type ListRequest,
} from '../../src/online/providers';

function v2set(over: Record<string, unknown> = {}) {
    return {
        id: 11, title: 'T', title_unicode: 'Ｔ', artist: 'A', artist_unicode: '', creator: 'C', ranked: 1,
        genre_id: 3, language_id: 3, play_count: 10, video: false, bpm: 180,
        beatmaps: [
            { id: 101, mode_int: 0, difficulty_rating: 4.2, version: 'Insane', total_length: 100, bpm: 180, cs: 4, ar: 9, accuracy: 8, drain: 6, max_combo: 900 },
            { id: 102, mode_int: 3, difficulty_rating: 2.1, version: 'Mania', total_length: 100, bpm: 180 },
        ],
        ...over,
    };
}

const req = (o: Partial<ListRequest & { fetchSize: number }>) => ({
    kind: 'latest' as const, offset: 0, limit: 20, keyword: '', fetchSize: 20, ...o,
});

describe('sayobot', () => {
    const s = PROVIDERS.sayobot;

    it('reproduces the legacy URLs', () => {
        expect(s.listUrl(req({ offset: 40 })).url).toBe('https://api.sayobot.cn/beatmaplist?0=20&1=40&2=2&5=1');
        expect(s.listUrl(req({ kind: 'search', keyword: 'a b' })).url)
            .toBe('https://api.sayobot.cn/beatmaplist?0=20&1=0&2=4&3=a%20b&5=1');
        expect(s.listUrl(req({ kind: 'popular' })).url).toBe('https://api.sayobot.cn/beatmaplist?0=20&1=0&2=1&5=1');
        expect(s.listUrl(req({ kind: 'genre', genre: 8, lang: 4 })).url)
            .toBe('https://api.sayobot.cn/beatmaplist?0=20&1=0&2=4&5=1&7=8&8=4');
        expect(s.infoUrl(7)).toBe('https://api.sayobot.cn/beatmapinfo?1=7');
        expect(s.setInfoUrl(7)).toBe('https://api.sayobot.cn/v2/beatmapinfo?0=7');
        expect(s.downloadUrl(7, false)).toBe('https://txy1.sayobot.cn/beatmaps/download/mini/7');
        expect(s.downloadUrl(7, true)).toBe('https://txy1.sayobot.cn/beatmaps/download/mini/7');
    });

    it('normalizes list rows and difficulties', () => {
        const json = {
            status: 0,
            data: [
                { sid: 1, title: 'Loser', titleU: '', artist: 'X', artistU: 'エックス', creator: 'c', approved: 3, modes: 1, play_count: 817, favourite_count: 25 },
                { sid: 0, title: 'bad' },
                'junk',
            ],
        };
        const rows = s.normalizeList(json, req({}));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sid: 1, title: 'Loser', artistUnicode: 'エックス', approved: 3, modes: 1, playCount: 817, video: false });
        expect(rows[0].titleUnicode).toBeUndefined();
        expect(s.rawCount(json)).toBe(3);
        expect(s.normalizeList({}, req({}))).toEqual([]);

        const diffs = s.normalizeDifficulties({
            status: 0,
            data: [{ bid: 75, mode: 0, star: 2.41, version: 'Normal', creator: 'peppy', length: 142, BPM: 119.999, CS: 4, AR: 6, HP: 6, OD: 6, maxcombo: 314 }],
        });
        expect(diffs[0]).toEqual({ bid: 75, mode: 0, stars: 2.41, version: 'Normal', creator: 'peppy', length: 142, bpm: 119.999, cs: 4, ar: 6, od: 6, hp: 6, maxCombo: 314 });
    });

    it('normalizes v2 set info with bid_data', () => {
        const set = s.normalizeSet({
            status: 0,
            data: {
                sid: 1, title: 'DISCO PRINCE', titleU: '', artist: 'Kenji Ninuma', creator: 'peppy', approved: 1,
                genre: 2, language: 3, bpm: 120, video: 1, tags: 'katamari', favourite_count: 1765,
                bid_data: [
                    { bid: 75, mode: 0, star: 2.414, version: 'Normal', length: 142, CS: 4, AR: 6, HP: 6, OD: 6, maxcombo: 314, playcount: 100 },
                    { bid: 76, mode: 1, star: 1, version: 'Taiko', length: 142, playcount: 5 },
                ],
            },
        })!;
        expect(set.sid).toBe(1);
        expect(set.video).toBe(true);
        expect(set.modes).toBe(0b11);
        expect(set.playCount).toBe(105);
        expect(set.genreId).toBe(2);
        expect(set.difficulties).toHaveLength(2);
        expect(set.difficulties![0].creator).toBe('peppy'); // inherited from the set
        expect(s.normalizeSet({ status: -1, data: null })).toBeNull();
        expect(s.normalizeSet('x')).toBeNull();
    });
});

describe('mino', () => {
    const m = PROVIDERS.mino;

    it('normalizes v2 sets incl. video, modes and difficulties', () => {
        const out = m.normalizeList([v2set({ video: true }), v2set({ id: 12, video: false })], req({}));
        expect(out).toHaveLength(2);
        expect(out[0].sid).toBe(11);
        expect(out[0].video).toBe(true);
        expect(out[1].video).toBe(false);
        expect(out[0].modes & 1).toBe(1);
        expect(out[0].modes & 8).toBe(8);
        expect(out[0].approved).toBe(1);
        expect(out[0].titleUnicode).toBe('Ｔ');
        expect(out[0].difficulties![0]).toEqual({
            bid: 101, mode: 0, stars: 4.2, version: 'Insane', creator: 'C', length: 100, bpm: 180,
            cs: 4, ar: 9, od: 8, hp: 6, maxCombo: 900,
        });
        expect(m.normalizeDifficulties(v2set())).toHaveLength(2);
        expect(m.normalizeDifficulties([v2set()])[0].bid).toBe(101);
        expect(m.normalizeSet(v2set())!.difficulties).toHaveLength(2);
        expect(m.normalizeSet({ error: 'x' })).toBeNull();
        expect(m.normalizeList({ beatmapsets: [v2set()] }, req({}))).toHaveLength(1);
    });

    it('sorts popular by plays and filters genre/language client-side', () => {
        const rows = [v2set({ id: 1, play_count: 5 }), v2set({ id: 2, play_count: 500 }), v2set({ id: 3, play_count: 50 })];
        expect(m.normalizeList(rows, req({ kind: 'popular', limit: 3, fetchSize: 3 })).map(s => s.sid)).toEqual([2, 3, 1]);
        const g = m.normalizeList([v2set({ id: 1, genre_id: 3 }), v2set({ id: 2, genre_id: 4 })], req({ kind: 'genre', genre: 8, lang: 1 }));
        expect(g.map(s => s.sid)).toEqual([1]);
        const l = m.normalizeList([v2set({ id: 1, language_id: 3 }), v2set({ id: 2, language_id: 2 })], req({ kind: 'genre', genre: 1, lang: 4 }));
        expect(l.map(s => s.sid)).toEqual([2]);
    });

    it('pages popular from 100-row batches', () => {
        const u = m.listUrl(req({ kind: 'popular', offset: 120 }));
        expect(u.fetchSize).toBe(100);
        expect(u.url).toBe('https://catboy.best/api/v2/search?limit=100&p=1&mode=0');
        const rows = Array.from({ length: 100 }, (_, i) => v2set({ id: i + 1, play_count: 1000 - i }));
        // offset 120 within the 100-row page starting at 100 -> rows 20..39
        expect(m.normalizeList(rows, req({ kind: 'popular', offset: 120, fetchSize: 100 })).map(s => s.sid)[0]).toBe(21);
        expect(m.listUrl(req({ kind: 'search', keyword: 'x y' })).url).toContain('&query=x%20y');
        expect(m.listUrl(req({ kind: 'random' })).url).toMatch(/p=\d+/);
    });
});

describe('downloads and routing', () => {
    it('builds download variants incl. no-video forms', () => {
        expect(downloadUrl(PROVIDERS.mino, 9, true)).toBe('https://catboy.best/d/9');
        expect(downloadUrl(PROVIDERS.mino, 9, false)).toBe('https://catboy.best/d/9n');
        expect(downloadUrl(PROVIDERS.nerinyan, 9, true)).toBe('https://api.nerinyan.moe/d/9');
        expect(downloadUrl(PROVIDERS.nerinyan, 9, false)).toBe('https://api.nerinyan.moe/d/9?noVideo=1');
    });

    it('routes like the old currentProviders', () => {
        expect(resolveProviders().browseId).toBe('sayobot');
        expect(resolveProviders().downloadId).toBe('mino');
        expect(resolveProviders('nerinyan', 'nerinyan').browseId).toBe('sayobot');
        expect(resolveProviders('nerinyan', 'nerinyan').downloadId).toBe('nerinyan');
        expect(resolveProviders('mino', 'bogus').downloadId).toBe('sayobot');
        expect(resolveProviders('mino', 'mino').browse).toBe(PROVIDERS.mino);
        expect(resolveProviders('__proto__', 'constructor').browseId).toBe('sayobot');
        expect(() => PROVIDERS.nerinyan.listUrl(req({}))).toThrow();
    });

    it('always serves covers and previews from the CORS-enabled CDN', () => {
        expect(coverUrl(5)).toBe('https://cdn.sayobot.cn:25225/beatmaps/5/covers/cover.webp');
        expect(coverUrl(5, 'jpg')).toBe('https://cdn.sayobot.cn:25225/beatmaps/5/covers/cover.jpg');
        expect(previewUrl(5)).toBe('https://cdn.sayobot.cn:25225/preview/5.mp3');
    });
});

describe('helpers', () => {
    it('parseMaskSum handles sums, singles, junk', () => {
        expect(parseMaskSum('2+64+256')).toBe(322);
        expect(parseMaskSum('8')).toBe(8);
        expect(parseMaskSum(16)).toBe(16);
        expect(parseMaskSum(null)).toBeNull();
        expect(parseMaskSum('abc')).toBeNull();
        expect(parseMaskSum('')).toBeNull();
    });

    it('maps genre/language masks', () => {
        expect(minoGenreIds(8)).toEqual([3]);
        expect(minoGenreIds(1)).toBeNull();
        expect(minoLangIds(8)).toEqual([3]);
        expect(minoLangIds(322)).toBeNull();
    });

    it('filters status and std sets', () => {
        const f = statusFilter('4')!;
        expect(f({ approved: 4 } as never)).toBe(true);
        expect(f({ approved: 1 } as never)).toBe(false);
        expect(statusFilter('any')).toBeNull();
        expect(statusFilter('x')).toBeNull();
        expect(isStandardSet({ modes: 5 } as never)).toBe(true);
        expect(isStandardSet({ modes: 4 } as never)).toBe(false);
        expect(approvedText(-2)).toBe('GRAVEYARD');
        expect(approvedText(99)).toBe('UNKNOWN');
    });
});
