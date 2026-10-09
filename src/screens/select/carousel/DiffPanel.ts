import { FillGradient, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../../app/Game';
import type { DifficultySummary } from '../../../beatmap/types';
import { lerpColor, scaleColor } from '../../../core/math';
import { label, fitText } from '../../../ui/text';
import { Colors, starColor, starTextColor } from '../../../ui/theme';
import { Triangles } from '../../../ui/Triangles';
import { UIComponent } from '../../../ui/UIComponent';
import type { FilterEntry } from '../filter';
import { drawStarRow, formatStars } from '../visuals';

export const DIFF_HEIGHT = 56;
const RADIUS = 8;

/** White → clear, tinted with the star colour per panel (one shared texture). */
let washGradient: FillGradient | null = null;
function starWash(): FillGradient {
    washGradient ??= new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        colorStops: [
            { offset: 0, color: 'rgba(255,255,255,0.55)' },
            { offset: 0.6, color: 'rgba(255,255,255,0.12)' },
            { offset: 1, color: 'rgba(255,255,255,0)' },
        ],
        textureSpace: 'local',
    });
    return washGradient;
}

/**
 * lazer's DrawableCarouselBeatmap: difficulty icon in the star colour,
 * version + mapper, star rating pill and a ten-star counter. The selected
 * difficulty lights up with triangles in its star colour.
 */
export class DiffPanel extends UIComponent {
    entry: FilterEntry | null = null;
    diff: DifficultySummary | null = null;
    private readonly bg = new Graphics();
    /** Star-colour wash from the left, so panels read as their difficulty, not as dark bars. */
    private readonly wash = new Graphics();
    private readonly border = new Graphics();
    private readonly hoverWash = new Graphics();
    private readonly decor = new Graphics();
    private readonly version: Text;
    private readonly mapper: Text;
    private readonly starText: Text;
    private triangles: Triangles | null = null;
    selectProgress = 0;
    private drawnSelect = -1;
    onClickPanel: ((entry: FilterEntry, diff: DifficultySummary) => void) | null = null;

    constructor(private readonly game: Game) {
        super();
        this.version = label('', { size: 16, weight: '700' });
        this.mapper = label('', { size: 12, weight: '500', color: Colors.grayB });
        // White + tint: label styles are shared, so never mutate style.fill.
        this.starText = label('', { size: 12, weight: '800', color: 0xffffff });
        this.starText.anchor.set(0.5);
        this.hoverWash.alpha = 0;
        this.addChild(this.bg, this.wash, this.hoverWash, this.decor, this.border, this.version, this.mapper, this.starText);
        this.makeInteractive();
        this.resize(460, DIFF_HEIGHT);
    }

    assign(entry: FilterEntry, diff: DifficultySummary): void {
        if (this.entry === entry && this.diff === diff) return;
        this.entry = entry;
        this.diff = diff;
        this.drawnSelect = -1;
        this.redraw();
    }

    release(): void {
        this.hovered = false;
        this.hoverWash.alpha = 0;
        this.entry = null;
        this.diff = null;
        if (this.triangles) this.triangles.visible = false;
    }

    protected override onResize(): void {
        this.hoverWash?.clear().roundRect(0, 0, this._w, this._h, RADIUS).fill(0xffffff);
        this.drawnSelect = -1;
        this.redraw();
    }

    private redraw(): void {
        const d = this.diff;
        if (!d || !this.decor) return;
        const color = starColor(d.stars);
        const h = this._h;
        const g = this.decor;
        g.clear();
        // Difficulty icon: ring in the star colour around a soft core.
        g.circle(28, h / 2, 14).fill({ color: 0x000000, alpha: 0.35 });
        g.circle(28, h / 2, 12).stroke({ width: 4, color });
        g.circle(28, h / 2, 4).fill(color);
        fitText(this.version, this._w - 220, d.version);
        this.version.position.set(54, 8);
        fitText(this.mapper, Math.max(20, this._w - 120 - this.version.width - 54), `mapped by ${this.entry?.set.creator ?? ''}`);
        this.mapper.position.set(54 + this.version.width + 8, 11);
        // Star pill + ten-star row on the second line.
        this.starText.text = `★ ${formatStars(d.stars)}`;
        this.starText.tint = starTextColor(d.stars);
        const pillW = this.starText.width + 14;
        g.roundRect(54, 32, pillW, 16, 8).fill(color);
        this.starText.position.set(54 + pillW / 2, 40);
        drawStarRow(g, 54 + pillW + 8, 40, d.stars, 5, 0xffffff);
        this.drawSelection();
    }

    drawSelection(): void {
        const d = this.diff;
        if (!d) return;
        const p = Math.round(this.selectProgress * 20) / 20;
        if (p === this.drawnSelect) return;
        this.drawnSelect = p;
        const w = this._w, h = this._h;
        const color = starColor(d.stars);
        this.bg.clear().roundRect(0, 0, w, h, RADIUS)
            .fill(lerpColor(0x30303e, scaleColor(color, 0.6), p));
        this.bg.alpha = 0.78 + 0.17 * p;
        this.wash.clear().roundRect(0, 0, w, h, RADIUS).fill(starWash());
        this.wash.tint = color;
        this.wash.alpha = 1 - 0.5 * p;
        this.border.clear().roundRect(1, 1, w - 2, h - 2, RADIUS)
            .stroke({ width: 1 + 1.5 * p, color: p > 0.5 ? 0xffffff : color, alpha: 0.25 + 0.75 * p });
        if (p > 0.05) {
            if (!this.triangles) {
                this.triangles = new Triangles(this.game.skin.tex('triangle'), {
                    colorLight: scaleColor(color, 0.65),
                    colorDark: scaleColor(color, 0.4),
                    maskRadius: RADIUS,
                    density: 1.2,
                    velocity: 0.5,
                    scale: 0.8,
                });
                this.addChildAt(this.triangles, 1);
            }
            this.triangles.setColors(scaleColor(color, 0.65), scaleColor(color, 0.4));
            this.triangles.resize(w, h);
            this.triangles.visible = true;
            this.triangles.alpha = p;
        } else if (this.triangles) {
            this.triangles.visible = false;
        }
    }

    protected override onHoverChange(hovered: boolean): void {
        this.hoverWash.alpha = hovered ? 0.07 : 0;
    }

    protected override onClick(): void {
        if (this.entry && this.diff) this.onClickPanel?.(this.entry, this.diff);
    }
}
