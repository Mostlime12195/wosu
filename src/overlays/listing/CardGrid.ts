import { Container } from 'pixi.js';
import type { OnlineSet } from '../../online/providers';
import { BeatmapCard, CARD_H, type CardContext } from './BeatmapCard';

const GAP = 10;
const MIN_CARD_W = 380;
/** Rows built beyond each edge of the viewport (smooth scrolling, early loads). */
const OVERSCAN_ROWS = 1;

/**
 * Virtualized grid of beatmap cards: only rows intersecting the viewport
 * (plus a row of overscan) have cards; cards scrolling out return to a
 * pool and are rebound to whatever scrolls in.
 */
export class CardGrid {
    readonly layer = new Container();
    private readonly pool: BeatmapCard[] = [];
    private readonly active = new Map<number, BeatmapCard>();
    private readonly shown = new Set<number>();
    private items: readonly OnlineSet[] = [];
    private cols = 1;
    private cardW = MIN_CARD_W;
    private left = 0;
    private first = 0;
    private last = -1;

    constructor(private readonly ctx: CardContext) {
        this.layer.eventMode = 'passive';
    }

    get top(): number {
        return this.layer.y;
    }

    set top(y: number) {
        this.layer.y = y;
    }

    get height(): number {
        const rows = Math.ceil(this.items.length / this.cols);
        return rows ? rows * (CARD_H + GAP) - GAP : 0;
    }

    /** New result list; `reset` drops every bound card (new query). */
    setItems(items: readonly OnlineSet[], reset: boolean): void {
        this.items = items;
        if (reset) {
            for (const card of this.active.values()) this.recycle(card);
            this.active.clear();
            this.shown.clear();
            this.first = 0;
            this.last = -1;
        }
    }

    /** Fit columns to `width` (cards stretch to fill the row). */
    layout(width: number, pad: number): void {
        const avail = Math.max(MIN_CARD_W * 0.6, width - pad * 2);
        const cols = Math.max(1, Math.floor((avail + GAP) / (MIN_CARD_W + GAP)));
        const cardW = Math.floor((avail - GAP * (cols - 1)) / cols);
        const changed = cols !== this.cols || cardW !== this.cardW;
        this.cols = cols;
        this.cardW = cardW;
        this.left = Math.round((width - (cardW * cols + GAP * (cols - 1))) / 2);
        if (changed) {
            for (const card of this.active.values()) this.recycle(card);
            this.active.clear();
            this.first = 0;
            this.last = -1;
        }
    }

    /** Bind cards for the visible window (content-space scroll position). */
    update(scrollY: number, viewH: number): void {
        const rowH = CARD_H + GAP;
        const rows = Math.ceil(this.items.length / this.cols);
        const y0 = scrollY - this.top, y1 = y0 + viewH;
        const firstRow = Math.max(0, Math.floor(y0 / rowH) - OVERSCAN_ROWS);
        const lastRow = Math.min(rows - 1, Math.floor(y1 / rowH) + OVERSCAN_ROWS);
        const first = firstRow * this.cols;
        const last = Math.min(this.items.length - 1, (lastRow + 1) * this.cols - 1);
        if (first === this.first && last === this.last && this.allBound(first, last)) return;
        this.first = first;
        this.last = last;
        for (const [i, card] of this.active) {
            if (i < first || i > last || this.items[i] !== card.set) {
                this.active.delete(i);
                this.recycle(card);
            }
        }
        for (let i = first; i <= last; i++) {
            if (this.active.has(i)) continue;
            const set = this.items[i];
            const card = this.pool.pop() ?? this.create();
            card.resize(this.cardW, CARD_H);
            const col = i % this.cols, row = Math.floor(i / this.cols);
            card.position.set(this.left + col * (this.cardW + GAP), row * rowH);
            const fresh = !this.shown.has(set.sid);
            this.shown.add(set.sid);
            card.bind(set, i, fresh);
            this.active.set(i, card);
        }
    }

    private allBound(first: number, last: number): boolean {
        return this.active.size === Math.max(0, last - first + 1);
    }

    private create(): BeatmapCard {
        const card = new BeatmapCard(this.ctx);
        this.layer.addChild(card);
        return card;
    }

    private recycle(card: BeatmapCard): void {
        card.unbind();
        this.pool.push(card);
    }

    tick(dt: number): void {
        for (const card of this.active.values()) card.tick(dt);
    }

    /** Re-read favourite / preview / download state (one set, or all for null). */
    refresh(sid: number | null): void {
        for (const card of this.active.values()) if (sid === null || card.set?.sid === sid) card.refreshState();
    }

    /** First visible set (drives the header backdrop). */
    get firstSet(): OnlineSet | null {
        return this.items[0] ?? null;
    }
}
