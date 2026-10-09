import { Container, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import { formatNumber } from '../../core/math';
import { ModIconRow } from '../../overlays/mods/ModIcon';
import { beatmapKeyOf, type ScoreRecord } from '../../storage/ScoreStore';
import { icon } from '../../ui/icons';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { label, fitText } from '../../ui/text';
import { Colors, gradeColor, gradeLabel } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { relativeDate } from './visuals';

const ROW_HEIGHT = 58;
const ROW_SPACING = 5;
const TAB_HEIGHT = 34;
const MAX_ROWS = 50;

/** The leaderboard key a saved score would use for this difficulty. */
export function scoreKeyFor(set: LibrarySet, diff: DifficultySummary): string {
    return beatmapKeyOf({ beatmapId: diff.beatmapId, title: set.title, version: diff.version, setId: set.onlineSetId ?? 0 });
}

/**
 * lazer's LeaderboardScore, local flavour: position, grade badge, player
 * and stats on a dark rounded strip, total score and mods on the right.
 */
class ScoreRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly badge = new Graphics();
    private readonly position_: Text;
    private readonly grade: Text;
    private readonly player: Text;
    private readonly stats: Text;
    private readonly date: Text;
    private readonly score: Text;
    private readonly mods = new ModIconRow(17, 2);
    private record: ScoreRecord | null = null;

    constructor() {
        super();
        this.position_ = label('', { size: 17, weight: '700', color: 0xffffff });
        this.position_.anchor.set(0.5);
        this.grade = label('', { size: 15, weight: '800', italic: true, color: 0xffffff });
        this.grade.anchor.set(0.5);
        this.player = label('', { size: 17, weight: '700' });
        this.stats = label('', { size: 13, weight: '600', color: Colors.grayC });
        this.date = label('', { size: 12, weight: '600', color: Colors.gray9 });
        this.date.anchor.set(1, 0);
        this.score = label('', { size: 22, weight: '600' });
        this.score.anchor.set(1, 0);
        this.addChild(this.bg, this.position_, this.badge, this.grade, this.player, this.stats, this.date, this.score, this.mods);
        this.eventMode = 'none';
    }

    assign(r: ScoreRecord, rank: number): void {
        this.record = r;
        this.position_.text = String(rank);
        this.grade.text = gradeLabel(r.grade);
        this.player.text = r.player || 'Guest';
        this.score.text = formatNumber(r.score);
        this.stats.text = `${(r.accuracy * 100).toFixed(2)}%  ·  ${formatNumber(r.maxCombo)}x${r.passed ? '' : '  ·  failed'}`;
        this.date.text = r.date ? relativeDate(r.date) : '';
        this.mods.setMods(r.mods);
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const r = this.record;
        if (!r) return;
        const boxX = 36;
        this.bg.clear().roundRect(boxX, 0, w - boxX, h, 6).fill({ color: 0x000000, alpha: 0.5 });
        this.position_.position.set(boxX / 2, h / 2);
        // Grade: a pill in the grade colour (lazer's DrawableRank).
        const gc = gradeColor(r.grade);
        this.badge.clear().roundRect(boxX + 10, h / 2 - 12, 46, 24, 12).fill(gc);
        this.grade.tint = r.grade.endsWith('H') || r.grade === 'F' ? 0x222222 : 0x2a1a00;
        this.grade.position.set(boxX + 33, h / 2);
        const textX = boxX + 68;
        this.score.position.set(w - 12, 6);
        this.mods.position.set(w - 12 - this.mods.rowWidth, h - 24);
        const rightW = Math.max(this.score.width, this.mods.rowWidth) + 24;
        fitText(this.player, Math.max(40, w - textX - rightW), r.player || 'Guest');
        this.player.position.set(textX, 8);
        this.stats.position.set(textX, 33);
        this.date.position.set(w - 12 - this.mods.rowWidth - (this.mods.rowWidth ? 10 : 0), h - 22);
        this.date.visible = this.date.x - this.date.width > this.stats.x + this.stats.width + 8;
    }
}

/**
 * Local leaderboard under the info wedge (lazer's BeatmapLeaderboard with
 * the "Local" scope): best score first, an empty state when nobody has
 * played the difficulty yet.
 */
export class LocalLeaderboard extends UIComponent {
    private readonly tabBg = new Graphics();
    private readonly tab: Text;
    private readonly countText: Text;
    private readonly scroll = new ScrollContainer();
    private readonly rows: ScoreRow[] = [];
    private readonly empty = new Container();
    private readonly emptyTitle: Text;
    private readonly emptyBody: Text;
    private readonly spinner = new LoadingSpinner(14);
    private key: string | null = null;
    private token = 0;
    private records: ScoreRecord[] = [];

    constructor(private readonly game: Game) {
        super();
        this.tab = label('Local Ranking', { size: 15, weight: '700', shadow: true });
        this.countText = label('', { size: 13, weight: '600', color: Colors.grayC, shadow: true });
        this.countText.anchor.set(1, 0);
        const glyph = icon('trophy', 30, 0xffffff);
        glyph.alpha = 0.35;
        this.emptyTitle = label('No scores yet', { size: 18, weight: '700', shadow: true });
        this.emptyBody = label('Play this difficulty to set the first score!', { size: 13, weight: '600', color: Colors.grayD, shadow: true });
        for (const t of [this.emptyTitle, this.emptyBody]) t.anchor.set(0.5, 0);
        glyph.position.set(0, 0);
        this.emptyTitle.position.set(0, 28);
        this.emptyBody.position.set(0, 54);
        this.empty.addChild(glyph, this.emptyTitle, this.emptyBody);
        this.empty.visible = false;
        this.spinner.visible = false;
        this.addChild(this.tabBg, this.tab, this.countText, this.scroll, this.empty, this.spinner);
        this.eventMode = 'passive';
        this.disposer.add(game.scores.changed.add(rec => {
            if (rec.beatmapKey === this.key) this.refresh();
        }));
        this.disposer.add(game.scores.removed.add(() => this.refresh()));
    }

    /** Show scores for a difficulty (null clears). */
    setBeatmap(set: LibrarySet | null, diff: DifficultySummary | null): void {
        const key = set && diff ? scoreKeyFor(set, diff) : null;
        if (key === this.key) return;
        this.key = key;
        this.refresh();
    }

    /** Reload the current difficulty's scores (after gameplay, deletions). */
    refresh(): void {
        const token = ++this.token;
        const key = this.key;
        if (!key) {
            this.show([]);
            return;
        }
        this.spinner.visible = true;
        this.game.scores.forBeatmap(key).then(list => {
            if (token !== this.token || this.destroyed) return;
            this.spinner.visible = false;
            this.show(list);
        }).catch(() => {
            if (token === this.token && !this.destroyed) this.show([]);
        });
    }

    /** Scores currently listed (e.g. to clear them). */
    get scores(): readonly ScoreRecord[] {
        return this.records;
    }

    private show(list: ScoreRecord[]): void {
        this.spinner.visible = false;
        this.records = list;
        const shown = list.slice(0, MAX_ROWS);
        while (this.rows.length < shown.length) {
            const row = new ScoreRow();
            this.rows.push(row);
            this.scroll.content.addChild(row);
        }
        this.rows.forEach((row, i) => {
            row.visible = i < shown.length;
            if (row.visible) row.assign(shown[i], i + 1);
        });
        this.countText.text = list.length ? `${list.length} score${list.length === 1 ? '' : 's'}` : '';
        this.empty.visible = !!this.key && list.length === 0;
        this.scroll.scrollTo(0, false);
        this.layoutRows();
        // lazer cascades scores in; a short staggered fade reads the same.
        shown.forEach((_, i) => {
            const row = this.rows[i];
            row.alpha = 0;
            row.x = -20;
            tween(row, { alpha: 1, x: 0 }, { duration: 400, delay: Math.min(i, 10) * 40, ease: 'OutQuint' });
        });
        if (this.empty.visible) {
            this.empty.alpha = 0;
            tween(this.empty, { alpha: 1 }, { duration: 300 });
        }
    }

    private layoutRows(): void {
        const w = this._w;
        let y = 0;
        for (const row of this.rows) {
            if (!row.visible) continue;
            row.resize(w - 8, ROW_HEIGHT);
            row.y = y;
            y += ROW_HEIGHT + ROW_SPACING;
        }
        this.scroll.contentHeight = Math.max(0, y - ROW_SPACING);
    }

    protected override onResize(w: number, h: number): void {
        this.tabBg.clear().rect(0, TAB_HEIGHT - 2, w, 2).fill({ color: 0xffffff, alpha: 0.12 })
            .rect(0, TAB_HEIGHT - 3, this.tab.width + 4, 3).fill(Colors.yellow);
        this.tab.position.set(2, 6);
        this.countText.position.set(w - 4, 8);
        const top = TAB_HEIGHT + 8;
        this.scroll.position.set(0, top);
        this.scroll.resize(w, Math.max(0, h - top));
        this.empty.position.set(w / 2, top + Math.min(70, Math.max(10, (h - top) / 2 - 50)));
        this.spinner.position.set(w / 2 - 14, top + 20);
        this.layoutRows();
    }
}
