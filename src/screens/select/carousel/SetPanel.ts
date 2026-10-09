import { Graphics, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../../app/Game';
import { label, fitText } from '../../../ui/text';
import { Colors, starColor } from '../../../ui/theme';
import { UIComponent } from '../../../ui/UIComponent';
import type { FilterEntry } from '../filter';
import { coverFill, setThumbnail, shadeGradient } from '../visuals';

export const SET_HEIGHT = 80;
const RADIUS = 10;
const MAX_DOTS = 18;

/**
 * lazer's DrawableCarouselBeatmapSet: thumbnail panel with title, artist,
 * mapper and one dot per difficulty in its star colour. Instances are
 * pooled by the carousel and re-pointed at different sets while scrolling.
 */
export class SetPanel extends UIComponent {
    entry: FilterEntry | null = null;
    private readonly bg = new Graphics();
    private readonly glow = new Graphics();
    private readonly border = new Graphics();
    private readonly hoverWash = new Graphics();
    private readonly dots = new Graphics();
    private readonly title: Text;
    private readonly artist: Text;
    private readonly mapper: Text;
    private readonly badge: Text;
    private texture: Texture | null = null;
    private loadToken = 0;
    /** Animated by the carousel: 0 = idle, 1 = selected. */
    selectProgress = 0;
    private drawnSelect = -1;
    /** Animated in update: horizontal offset applied by the carousel. */
    xOffset = 0;
    onClickPanel: ((entry: FilterEntry) => void) | null = null;

    constructor(private readonly game: Game) {
        super();
        this.title = label('', { size: 21, weight: '700', shadow: true });
        this.artist = label('', { size: 15, weight: '600', shadow: true });
        this.mapper = label('', { size: 12, weight: '500', color: Colors.grayC, shadow: true });
        this.badge = label('VIDEO', { size: 10, weight: '800', color: 0x000000 });
        this.hoverWash.alpha = 0;
        this.addChild(this.glow, this.bg, this.hoverWash, this.border, this.title, this.artist, this.mapper, this.dots, this.badge);
        this.makeInteractive();
        this.resize(500, SET_HEIGHT);
    }

    assign(entry: FilterEntry): void {
        if (this.entry === entry) return;
        // Re-filtering creates new entries for the same set: keep the art.
        const sameSet = this.entry?.set === entry.set;
        this.entry = entry;
        if (!sameSet) {
            const set = entry.set;
            this.texture = null;
            const token = ++this.loadToken;
            setThumbnail(this.game, set).then(tex => {
                if (token !== this.loadToken || this.destroyed) return;
                this.texture = tex;
                this.drawBg();
            });
            this.badge.visible = set.hasVideo;
            this.layoutTexts();
            this.drawBg();
        }
        this.drawDots();
    }

    release(): void {
        // Pooled panels get re-pointed; don't carry a stale hover over.
        this.hovered = false;
        this.hoverWash.alpha = 0;
        this.entry = null;
        this.loadToken++;
        this.texture = null;
    }

    protected override onResize(): void {
        this.drawBg();
        this.layoutTexts();
        this.drawDots();
        this.hoverWash.clear().roundRect(0, 0, this._w, this._h, RADIUS).fill(0xffffff);
    }

    private layoutTexts(): void {
        const e = this.entry;
        if (!e || !this.title) return;
        const maxW = Math.min(this._w - 40, 520);
        fitText(this.title, maxW, e.set.title);
        fitText(this.artist, maxW, e.set.artist);
        fitText(this.mapper, maxW, `mapped by ${e.set.creator}`);
        this.title.position.set(18, 7);
        this.artist.position.set(18, 31);
        this.mapper.position.set(18 + this.artist.width + 8, 34);
        if (this.mapper.x + this.mapper.width > this._w - 30) this.mapper.visible = false;
        else this.mapper.visible = true;
    }

    private drawBg(): void {
        if (!this.bg) return;
        const w = this._w, h = this._h;
        const g = this.bg;
        g.clear();
        if (this.texture) g.roundRect(0, 0, w, h, RADIUS).fill(coverFill(this.texture, 0, 0, w, h));
        else g.roundRect(0, 0, w, h, RADIUS).fill(0x3a3a4a);
        // Light shading (lazer: 0.5 → 0.2): the art shows, text keeps its shadow.
        g.roundRect(0, 0, w, h, RADIUS).fill(shadeGradient(0.6, 0.12));
        this.drawnSelect = -1;
        this.drawSelection();
    }

    private drawDots(): void {
        const e = this.entry;
        if (!e || !this.dots) return;
        const g = this.dots;
        g.clear();
        const n = Math.min(MAX_DOTS, e.diffs.length);
        const y = this._h - 15;
        for (let i = 0; i < n; i++) {
            const c = starColor(e.diffs[i].stars);
            const x = 26 + i * 18;
            g.circle(x, y, 6.5).fill(c);
            g.circle(x, y, 6.5).stroke({ width: 1.5, color: 0xffffff, alpha: 0.85 });
        }
        if (e.diffs.length > MAX_DOTS) g.circle(26 + n * 18, y, 2).fill(0xffffff);
        this.badge.position.set(26 + Math.min(n, MAX_DOTS) * 18 + 8, y - 6);
        if (this.badge.visible) {
            // Badge pill behind the "VIDEO" text.
            g.roundRect(this.badge.x - 5, this.badge.y - 1, this.badge.width + 10, 14, 7).fill(Colors.yellow);
        }
    }

    /** Border/glow reflect selectProgress; redrawn only when it changes visibly. */
    drawSelection(): void {
        const p = Math.round(this.selectProgress * 20) / 20;
        if (p === this.drawnSelect) return;
        this.drawnSelect = p;
        const w = this._w, h = this._h;
        this.border.clear().roundRect(1, 1, w - 2, h - 2, RADIUS)
            .stroke({ width: 1 + 2 * p, color: p > 0 ? Colors.yellow : 0xffffff, alpha: 0.18 + 0.82 * p });
        this.glow.clear();
        if (p > 0) {
            for (let i = 1; i <= 3; i++) {
                this.glow.roundRect(-i * 3, -i * 3, w + i * 6, h + i * 6, RADIUS + i * 3)
                    .stroke({ width: 3, color: Colors.yellow, alpha: (0.18 / i) * p });
            }
        }
    }

    protected override onHoverChange(hovered: boolean): void {
        this.hoverWash.alpha = hovered ? 0.08 : 0;
    }

    protected override onClick(): void {
        if (this.entry) this.onClickPanel?.(this.entry);
    }
}
