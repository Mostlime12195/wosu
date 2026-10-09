import { Container, Graphics, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import { adjustDifficulty, playbackRate, type ModSet } from '../../gameplay/mods';
import { icon, type IconName } from '../../ui/icons';
import { label, fitText } from '../../ui/text';
import { Colors, starColor, starTextColor } from '../../ui/theme';
import { SHEAR } from '../../ui/ShearedButton';
import { UIComponent } from '../../ui/UIComponent';
import { effectiveAr, effectiveOd } from './filter';
import { modAdjustedStars, ratingMods } from './modStars';
import { coverFill, EDGE_HIDE, formatBpm, formatLength, formatStars, setBackground, shadeGradient, WEDGE_RADIUS, wedgeShade } from './visuals';

export const WEDGE_HEIGHT = 210;
const HARDER = 0xff6666;
const EASIER = 0x66ccff;

interface Bar {
    caption: Text;
    value: Text;
    g: Graphics;
}

/**
 * lazer's BeatmapInfoWedge: a sheared card showing the selected
 * difficulty over its background, plus attribute bars that reflect the
 * active mods (red = harder, blue = easier than the map's base values).
 */
export class BeatmapInfoWedge extends UIComponent {
    private readonly shape = new Graphics();
    private readonly content = new Container();
    private readonly version: Text;
    private readonly title: Text;
    private readonly artist: Text;
    private readonly mapper: Text;
    private readonly starText: Text;
    private readonly starPill = new Graphics();
    private readonly stats: { glyph: Text; text: Text }[] = [];
    private readonly bars: Bar[] = [];
    private readonly barsLayer = new Container();
    private set: LibrarySet | null = null;
    private diff: DifficultySummary | null = null;
    private mods: ModSet = new Set();
    private texture: Texture | null = null;
    private token = 0;
    /** Mod-adjusted rating (null = show the difficulty's own). */
    private shownStars: number | null = null;
    private starsKey = '';

    constructor(private readonly game: Game) {
        super();
        this.version = label('', { size: 16, weight: '700', italic: true, color: Colors.yellowLight, shadow: true });
        this.title = label('', { size: 28, weight: '700', italic: true, shadow: true });
        this.artist = label('', { size: 18, weight: '600', italic: true, shadow: true });
        this.mapper = label('', { size: 13, weight: '500', color: Colors.grayD, shadow: true });
        this.starText = label('', { size: 13, weight: '800', color: 0xffffff });
        this.starText.anchor.set(0.5);
        this.content.addChild(this.version, this.title, this.artist, this.mapper, this.starPill, this.starText);
        const statIcons: IconName[] = ['clock', 'music', 'circle', 'sliders'];
        for (const name of statIcons) {
            const glyph = icon(name, 13, Colors.yellow);
            const text = label('', { size: 14, weight: '600', shadow: true });
            text.anchor.set(0, 0.5);
            this.content.addChild(glyph, text);
            this.stats.push({ glyph, text });
        }
        for (const cap of ['CS', 'HP', 'OD', 'AR', '★']) {
            const caption = label(cap, { size: 12, weight: '700', color: Colors.grayD, shadow: true });
            caption.anchor.set(0, 0.5);
            const value = label('', { size: 12, weight: '700', shadow: true });
            value.anchor.set(1, 0.5);
            const g = new Graphics();
            this.barsLayer.addChild(g, caption, value);
            this.bars.push({ caption, value, g });
        }
        this.content.addChild(this.barsLayer);
        this.addChild(this.shape, this.content);
        this.eventMode = 'none';
        this.resize(640, WEDGE_HEIGHT);
    }

    setBeatmap(set: LibrarySet | null, diff: DifficultySummary | null): void {
        const setChanged = set !== this.set;
        this.set = set;
        this.diff = diff;
        if (setChanged) {
            this.texture = null;
            const token = ++this.token;
            if (set) {
                setBackground(this.game, set).then(tex => {
                    if (token !== this.token || this.destroyed) return;
                    this.texture = tex;
                    this.drawShape();
                });
            }
            this.content.alpha = 0;
            this.content.x = 16;
            tween(this.content, { alpha: 1, x: 0 }, { duration: 400, ease: 'OutQuint' });
        }
        this.refresh();
    }

    setMods(mods: ModSet): void {
        this.mods = mods;
        this.refresh();
    }

    protected override onResize(): void {
        this.refresh();
    }

    private get shear(): number {
        return this._h * SHEAR;
    }

    /**
     * Pinned to the top-left corner (under the toolbar): the top and left
     * edges run past the screen edge (EDGE_HIDE), so only the free
     * bottom-right corner is rounded. The right edge leans with the
     * global SHEAR, parallel to the filter control's left edge.
     */
    private drawShape(): void {
        const w = this._w, h = this._h, s = this.shear;
        const g = this.shape;
        const top = -EDGE_HIDE, left = -60;
        const pts = [
            { x: left, y: top, radius: 0 },
            { x: w + s + EDGE_HIDE * SHEAR, y: top, radius: 0 },
            { x: w, y: h, radius: WEDGE_RADIUS },
            { x: left, y: h, radius: 0 },
        ];
        const fullW = w + s + EDGE_HIDE * SHEAR - left, fullH = h - top;
        g.clear();
        if (this.texture) g.roundShape(pts, 0).fill(coverFill(this.texture, left, top, fullW, fullH));
        else g.roundShape(pts, 0).fill(0x2c2c38);
        // Light shading: the art stays bright, text keeps its shadows.
        g.roundShape(pts, 0).fill(wedgeShade());
        g.roundShape(pts, 0).fill(shadeGradient(0, 0.3, true));
        const accent = this.diff ? starColor(this.stars) : Colors.gray6;
        g.roundShape(pts, 0).stroke({ width: 3, color: accent, alpha: 0.9 });
    }

    /** Recompute the mod-adjusted rating when the beatmap or rating mods change. */
    private updateStars(set: LibrarySet, d: DifficultySummary): void {
        const relevant = ratingMods(this.mods);
        const key = relevant ? `${set.key}|${d.file}|${d.stars}|${[...relevant].sort().join('')}` : '';
        if (key === this.starsKey) return;
        this.starsKey = key;
        this.shownStars = null;
        if (!relevant) return;
        void modAdjustedStars(this.game, set, d, this.mods).then(stars => {
            if (this.starsKey !== key || this.destroyed) return;
            this.shownStars = stars;
            this.refresh();
        });
    }

    private get stars(): number | null {
        return this.shownStars ?? this.diff?.stars ?? null;
    }

    private refresh(): void {
        if (!this.version) return;
        const set = this.set, d = this.diff;
        if (set && d) this.updateStars(set, d);
        this.drawShape();
        this.content.visible = !!(set && d);
        if (!set || !d) return;
        const w = this._w, h = this._h;
        const textW = Math.max(120, w * 0.6 - 40);
        fitText(this.version, textW, d.version);
        fitText(this.title, textW, set.title);
        fitText(this.artist, textW, set.artist);
        fitText(this.mapper, textW, `mapped by ${set.creator}`);
        this.version.position.set(28, 18);
        this.title.position.set(26, 42);
        this.artist.position.set(26, 78);
        this.mapper.position.set(28, 108);

        const rate = playbackRate(this.mods);
        const values = [formatLength(d.length / rate), formatBpm(d.bpmMin, d.bpmMax, d.bpm, rate), String(d.circles), String(d.sliders)];
        let x = 28;
        const y = h - 30;
        this.stats.forEach((st, i) => {
            st.glyph.position.set(x + 7, y);
            st.text.text = values[i];
            st.text.position.set(x + 18, y);
            x += 18 + st.text.width + 22;
        });

        // Star pill at the top-right (inside the shear).
        const stars = this.stars;
        this.starText.text = `★ ${formatStars(stars)}`;
        this.starText.tint = starTextColor(stars);
        const pillW = this.starText.width + 18;
        const px = w - pillW - 18;
        this.starPill.clear().roundRect(px, 16, pillW, 22, 11).fill(starColor(stars));
        this.starText.position.set(px + pillW / 2, 27);
        this.drawBars(rate);
    }

    private drawBars(rate: number): void {
        const d = this.diff!;
        const w = this._w;
        const adj = adjustDifficulty({ cs: d.cs, ar: d.ar, od: d.od, hp: d.hp }, this.mods);
        const rows: [number, number, number][] = [
            [d.cs, adj.cs, 10],
            [d.hp, adj.hp, 10],
            [d.od, effectiveOd(adj.od, rate), 11],
            [d.ar, effectiveAr(adj.ar, rate), 11],
            [d.stars ?? 0, this.stars ?? 0, 10],
        ];
        const left = Math.max(w * 0.6, w - 270);
        const barX = left + 28;
        const barW = Math.max(40, w - barX - 70);
        const top = 56;
        rows.forEach(([base, eff, max], i) => {
            const bar = this.bars[i];
            const y = top + i * 24;
            bar.caption.position.set(left, y);
            const isStars = i === 4;
            bar.value.text = isStars ? formatStars(this.stars) : eff.toFixed(Math.abs(eff - Math.round(eff)) < 0.05 ? 0 : 1);
            bar.value.position.set(barX + barW + 36, y);
            const g = bar.g;
            g.clear().roundRect(barX, y - 3, barW, 6, 3).fill({ color: 0x000000, alpha: 0.4 });
            const baseT = Math.min(1, Math.max(0, base / max));
            const effT = Math.min(1, Math.max(0, eff / max));
            const color = isStars ? starColor(this.stars) : 0xffffff;
            if (Math.abs(eff - base) < 0.01) {
                if (baseT > 0) g.roundRect(barX, y - 3, Math.max(6, barW * baseT), 6, 3).fill(color);
                bar.value.tint = 0xffffff;
            } else if (eff > base) {
                g.roundRect(barX, y - 3, Math.max(6, barW * effT), 6, 3).fill(HARDER);
                if (baseT > 0) g.roundRect(barX, y - 3, Math.max(6, barW * baseT), 6, 3).fill(0xffffff);
                bar.value.tint = HARDER;
            } else {
                if (baseT > 0) g.roundRect(barX, y - 3, Math.max(6, barW * baseT), 6, 3).fill({ color: 0xffffff, alpha: 0.35 });
                if (effT > 0) g.roundRect(barX, y - 3, Math.max(6, barW * effT), 6, 3).fill(EASIER);
                bar.value.tint = EASIER;
            }
        });
    }
}
