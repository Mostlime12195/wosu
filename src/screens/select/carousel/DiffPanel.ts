import { FillGradient, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../../app/Game';
import type { DifficultySummary } from '../../../beatmap/types';
import { lerpColor, scaleColor } from '../../../core/math';
import { label, fitText } from '../../../ui/text';
import { Colors, starColor, starTextColor } from '../../../ui/theme';
import { Triangles } from '../../../ui/Triangles';
import { UIComponent } from '../../../ui/UIComponent';
import type { LegacySkin } from '../../../skin/LegacySkin';
import type { Grade } from '../../../storage/ScoreStore';
import type { FilterEntry } from '../filter';
import { scoreKeyFor } from '../Leaderboard';
import { drawStarRow, formatStars } from '../visuals';
import { RANK_BADGE_W, RankBadge } from './RankBadge';

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
 * version + mapper, the best local grade (TopLocalRank), star rating pill
 * and a ten-star counter. The rating follows the selected mods (computed
 * lazily by the carousel). The selected difficulty lights up with
 * triangles in its star colour.
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
    private readonly rank = new RankBadge();
    private triangles: Triangles | null = null;
    /** Local scores key (beatmapKeyOf) of the assigned difficulty. */
    scoreKey = '';
    /** Shown rating: mod-adjusted when known, else the base one. */
    private stars: number | null = null;
    private starsPending = false;
    private grade: Grade | null = null;
    /** The skin whose small grade images the badge uses (null = wosu!'s badge). */
    private gradeSkin: LegacySkin | null = null;
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
        this.addChild(this.bg, this.wash, this.hoverWash, this.decor, this.border, this.version, this.mapper, this.starText, this.rank);
        // osu!stable skins: menuclick when hovering beatmaps (instead of click-short).
        this.makeInteractive({ skinSounds: { hover: ['menuclick'] } });
        this.resize(460, DIFF_HEIGHT);
    }

    assign(entry: FilterEntry, diff: DifficultySummary): void {
        if (this.entry === entry && this.diff === diff) return;
        if (this.diff !== diff || this.entry?.set !== entry.set) this.scoreKey = scoreKeyFor(entry.set, diff);
        this.entry = entry;
        this.diff = diff;
        this.stars = diff.stars;
        this.starsPending = false;
        this.drawnSelect = -1;
        this.redraw();
    }

    /**
     * Per frame from the carousel: the rating to show (mods) and the best
     * local grade. Redraws only when either changed.
     */
    sync(stars: number | null, pending: boolean, grade: Grade | null): void {
        const g = this.game;
        const skin = g.settings.skinInMenus.value ? g.skins.current.value : null;
        if (stars === this.stars && pending === this.starsPending && grade === this.grade && skin === this.gradeSkin) return;
        this.gradeSkin = skin;
        const recolour = starColor(stars) !== starColor(this.stars);
        this.stars = stars;
        this.starsPending = pending;
        this.grade = grade;
        if (recolour) this.drawnSelect = -1;
        this.redraw();
    }

    release(): void {
        this.hovered = false;
        this.hoverWash.alpha = 0;
        this.entry = null;
        this.diff = null;
        this.grade = null;
        this.rank.setGrade(null);
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
        const stars = this.stars;
        const color = starColor(stars);
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
        // Best local grade, then the star pill + ten-star row on the second line.
        this.rank.setGrade(this.grade, this.gradeSkin);
        this.rank.position.set(54, 31);
        const pillX = this.grade ? 54 + RANK_BADGE_W + 8 : 54;
        this.starText.text = `★ ${formatStars(stars)}`;
        this.starText.tint = starTextColor(stars);
        const pillW = this.starText.width + 14;
        // Still computing the mod-adjusted rating: the base one, dimmed.
        const pillAlpha = this.starsPending ? 0.55 : 1;
        g.roundRect(pillX, 32, pillW, 16, 8).fill({ color, alpha: pillAlpha });
        this.starText.alpha = pillAlpha;
        this.starText.position.set(pillX + pillW / 2, 40);
        drawStarRow(g, pillX + pillW + 8, 40, stars, 5, 0xffffff);
        this.drawSelection();
    }

    drawSelection(): void {
        const d = this.diff;
        if (!d) return;
        const p = Math.round(this.selectProgress * 20) / 20;
        if (p === this.drawnSelect) return;
        this.drawnSelect = p;
        const w = this._w, h = this._h;
        const color = starColor(this.stars);
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
