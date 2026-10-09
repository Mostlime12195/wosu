import { describe, expect, it } from 'vitest';
import { BUNDLED_COUNT, bundledSelection } from '../../src/online/bundled';

describe('bundled beatmaps', () => {
    it('always starts with triangles and picks distinct sets', () => {
        const sel = bundledSelection(new Date(Date.UTC(2026, 9, 9)));
        expect(sel).toHaveLength(BUNDLED_COUNT);
        expect(sel[0].sid).toBe(1841885);
        expect(new Set(sel.map(s => s.sid)).size).toBe(sel.length);
    });

    it('keeps the same pick for a week', () => {
        // 2026-10-05 and 2026-10-07 share a week of the year (day 277 / 7 = 279 / 7).
        const a = bundledSelection(new Date(Date.UTC(2026, 9, 5)));
        const b = bundledSelection(new Date(Date.UTC(2026, 9, 7)));
        expect(b.map(s => s.sid)).toEqual(a.map(s => s.sid));
    });
});
