import { Container, Graphics, Sprite, type FederatedPointerEvent, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { Bindable, type ReadonlyBindable } from '../../core/Bindable';
import { tween } from '../../core/Tweener';
import { formatNumber } from '../../core/math';
import { sanitizeMods } from '../../gameplay/mods';
import { ApiError, toScoreRecord } from '../../online/Account';
import { ModIconRow } from '../../overlays/mods/ModIcon';
import type { LegacySkin } from '../../skin/LegacySkin';
import { beatmapKeyOf, type ScoreRecord } from '../../storage/ScoreStore';
import { Avatar } from '../../ui/Avatar';
import { ContextMenu, MENU_SPACER, type MenuEntry } from '../../ui/ContextMenu';
import { icon } from '../../ui/icons';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { label, fitText } from '../../ui/text';
import { Colors, gradeColor, gradeLabel } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { smallGradeTexture } from './carousel/RankBadge';
import { relativeDate } from './visuals';

const ROW_HEIGHT = 58;
const ROW_SPACING = 5;
const TAB_HEIGHT = 34;
const MAX_ROWS = 50;

/** lazer's BeatmapLeaderboardScope, the two wosu! has. */
export type LeaderboardScope = 'local' | 'global';

/** The scope stays selected across song select visits. */
let lastScope: LeaderboardScope = 'local';

/** The leaderboard key a saved score would use for this difficulty. */
export function scoreKeyFor(set: LibrarySet, diff: DifficultySummary): string {
    return beatmapKeyOf({ beatmapId: diff.beatmapId, title: set.title, version: diff.version, setId: set.onlineSetId ?? 0 });
}

/** The online beatmap id a leaderboard key refers to, or 0 for a local-only difficulty. */
export function onlineIdOf(key: string): number {
    return key.startsWith('bid:') ? Number(key.slice(4)) || 0 : 0;
}

/**
 * lazer's LeaderboardScore, local flavour: position, grade badge, the
 * player's avatar, name and stats on a dark rounded strip, total score and
 * mods on the right.
 */
class ScoreRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly badge = new Graphics();
    private readonly position_: Text;
    private readonly grade: Text;
    /** An imported skin's ranking-*-small image, in place of the badge. */
    private readonly gradeImage = new Sprite();
    private readonly player: Text;
    private readonly stats: Text;
    private readonly date: Text;
    private readonly score: Text;
    private readonly mods = new ModIconRow(17, 2);
    private readonly replayGlyph: Text;
    private readonly avatar: Avatar;
    private record: ScoreRecord | null = null;
    /** Drawn as the player's own row (global scope). */
    private own = false;
    /** Right-click / long-press on the row: (record, global x, y). */
    onMenu: ((r: ScoreRecord, x: number, y: number) => void) | null = null;

    constructor(avatar: ReadonlyBindable<Texture | null>, private readonly skin: () => LegacySkin | null = () => null) {
        super();
        this.avatar = new Avatar(40, avatar, { radius: 6 });
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
        this.replayGlyph = icon('circlePlay', 12, Colors.grayC);
        this.replayGlyph.anchor.set(0, 0.5);
        this.gradeImage.anchor.set(0.5);
        this.addChild(this.bg, this.position_, this.badge, this.grade, this.gradeImage, this.avatar, this.player, this.replayGlyph, this.stats, this.date, this.score, this.mods);
        // lazer's LeaderboardScore: click to view the score (here: watch its replay), right-click for its menu.
        this.makeInteractive();
        this.on('rightclick', (e: FederatedPointerEvent) => {
            if (this.record) this.onMenu?.(this.record, e.global.x, e.global.y);
        });
    }

    get scoreRecord(): ScoreRecord | null {
        return this.record;
    }

    protected override onHoverChange(): void {
        this.relayout();
    }

    assign(r: ScoreRecord, rank: number, own = false): void {
        this.record = r;
        this.own = own;
        this.position_.text = String(rank);
        this.grade.text = gradeLabel(r.grade);
        this.player.text = r.player || 'Guest';
        this.score.text = formatNumber(r.score);
        const pp = r.pp != null ? `  ·  ${Math.round(r.pp)}pp` : '';
        this.stats.text = `${(r.accuracy * 100).toFixed(2)}%  ·  ${formatNumber(r.maxCombo)}x${r.passed ? '' : '  ·  failed'}${pp}`;
        this.date.text = r.date ? relativeDate(r.date) : '';
        this.mods.setMods(r.mods, r.modSettings);
        this.replayGlyph.visible = !!r.hasReplay;
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const r = this.record;
        if (!r) return;
        const boxX = 36;
        this.bg.clear().roundRect(boxX, 0, w - boxX, h, 6).fill({ color: this.own ? 0x3a2a00 : 0x000000, alpha: this.hovered && r.hasReplay ? 0.7 : 0.5 });
        this.position_.position.set(boxX / 2, h / 2);
        // Grade: a pill in the grade colour (lazer's DrawableRank), or the skin's small grade image.
        const skinned = smallGradeTexture(this.skin(), r.grade);
        this.gradeImage.visible = !!skinned;
        this.badge.visible = this.grade.visible = !skinned;
        if (skinned) {
            const k = Math.min(34 / skinned.texture.height, 46 / skinned.texture.width);
            this.gradeImage.texture = skinned.texture;
            this.gradeImage.scale.set(k);
            this.gradeImage.position.set(boxX + 33, h / 2);
        }
        const gc = gradeColor(r.grade);
        this.badge.clear().roundRect(boxX + 10, h / 2 - 12, 46, 24, 12).fill(gc);
        this.grade.tint = r.grade.endsWith('H') || r.grade === 'F' ? 0x222222 : 0x2a1a00;
        this.grade.position.set(boxX + 33, h / 2);
        this.avatar.position.set(boxX + 66, (h - this.avatar.h) / 2);
        const textX = boxX + 66 + this.avatar.w + 10;
        this.score.position.set(w - 12, 6);
        this.mods.position.set(w - 12 - this.mods.rowWidth, h - 24);
        const rightW = Math.max(this.score.width, this.mods.rowWidth) + 24;
        const glyphW = r.hasReplay ? 18 : 0;
        fitText(this.player, Math.max(40, w - textX - rightW - glyphW), r.player || 'Guest');
        this.player.position.set(textX, 8);
        this.replayGlyph.position.set(textX + this.player.width + 6, 8 + this.player.height / 2);
        this.stats.position.set(textX, 33);
        this.date.position.set(w - 12 - this.mods.rowWidth - (this.mods.rowWidth ? 10 : 0), h - 22);
        this.date.visible = this.date.x - this.date.width > this.stats.x + this.stats.width + 8;
    }
}

/** A scope tab ("Local", "Global"): a label that switches the board. */
class ScopeTab extends UIComponent {
    private readonly text: Text;
    private active_ = false;

    constructor(text: string) {
        super();
        this.text = label(text, { size: 15, weight: '700', shadow: true });
        this.addChild(this.text);
        this.makeInteractive();
        this.resize(this.text.width + 4, TAB_HEIGHT);
    }

    set active(v: boolean) {
        this.active_ = v;
        this.text.alpha = v ? 1 : 0.6;
    }

    get active(): boolean {
        return this.active_;
    }

    protected override onHoverChange(): void {
        this.text.alpha = this.active_ || this.hovered ? 1 : 0.6;
    }

    protected override onResize(): void {
        this.text.position.set(2, 6);
    }
}

/**
 * Leaderboard under the info wedge (lazer's BeatmapLeaderboard): this
 * device's scores or, for beatmaps downloaded from a mirror, the global
 * board from the wosu! server. Best score first, an empty state when
 * nobody has played the difficulty yet.
 */
export class LocalLeaderboard extends UIComponent {
    private readonly tabBg = new Graphics();
    private readonly localTab = new ScopeTab('Local');
    private readonly globalTab = new ScopeTab('Global');
    private readonly countText: Text;
    private readonly scroll = new ScrollContainer();
    private readonly rows: ScoreRow[] = [];
    private readonly empty = new Container();
    private readonly emptyTitle: Text;
    private readonly emptyBody: Text;
    private readonly spinner = new LoadingSpinner(14);
    /** Rows show the device's own avatar on the local board, the default on the global one. */
    private readonly rowAvatar = new Bindable<Texture | null>(null);
    private key: string | null = null;
    private token = 0;
    private scope: LeaderboardScope = lastScope;
    private records: ScoreRecord[] = [];
    private abort: AbortController | null = null;
    /** Watch a score's replay (song select checks it's still current). */
    onWatchReplay: ((r: ScoreRecord) => void) | null = null;
    /** Download a score's replay as .osr. */
    onExport: ((r: ScoreRecord) => void) | null = null;
    /** Delete one score (song select confirms first). */
    onDelete: ((r: ScoreRecord) => void) | null = null;

    constructor(private readonly game: Game) {
        super();
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
        this.localTab.onActivate = () => this.setScope('local');
        this.globalTab.onActivate = () => this.setScope('global');
        this.addChild(this.tabBg, this.localTab, this.globalTab, this.countText, this.scroll, this.empty, this.spinner);
        this.eventMode = 'passive';
        this.disposer.add(game.scores.changed.add(rec => {
            if (this.scope === 'local' && rec.beatmapKey === this.key) this.refresh();
        }));
        this.disposer.add(game.scores.removed.add(() => {
            if (this.scope === 'local') this.refresh();
        }));
        // The global board follows the account: a submitted play, signing in or out.
        this.disposer.add(game.account.submitted.add(r => {
            if (this.scope === 'global' && this.key && onlineIdOf(this.key) === r.score.beatmapId) this.refresh();
        }));
        this.disposer.add(game.account.user.bind(() => {
            if (this.scope === 'global') this.refresh();
        }));
        this.disposer.add(game.profile.avatar.bind(t => {
            if (this.scope === 'local') this.rowAvatar.value = t;
        }, true));
        // Grades follow the selected skin's ranking-*-small images.
        const regrade = () => {
            for (const row of this.rows) if (row.visible) row.relayout();
        };
        this.disposer.add(game.skins.current.bind(regrade));
        this.disposer.add(game.settings.skinInMenus.bind(regrade));
        this.applyScope();
    }

    /** The imported skin whose small grade images rows use (null = wosu!'s badges). */
    private gradeSkin(): LegacySkin | null {
        return this.game.settings.skinInMenus.value ? this.game.skins.current.value : null;
    }

    /** Show scores for a difficulty (null clears). */
    setBeatmap(set: LibrarySet | null, diff: DifficultySummary | null): void {
        const key = set && diff ? scoreKeyFor(set, diff) : null;
        if (key === this.key) return;
        this.key = key;
        this.refresh();
    }

    get currentScope(): LeaderboardScope {
        return this.scope;
    }

    setScope(scope: LeaderboardScope): void {
        if (scope === this.scope) return;
        this.scope = lastScope = scope;
        this.applyScope();
        this.refresh();
    }

    private applyScope(): void {
        this.localTab.active = this.scope === 'local';
        this.globalTab.active = this.scope === 'global';
        this.rowAvatar.value = this.scope === 'local' ? this.game.profile.avatar.value : null;
        this.relayout();
    }

    /** Reload the current difficulty's scores (after gameplay, deletions, a scope change). */
    refresh(): void {
        const token = ++this.token;
        const key = this.key;
        this.abort?.abort();
        this.abort = null;
        if (!key) {
            this.show([]);
            return;
        }
        this.spinner.visible = true;
        if (this.scope === 'local') {
            this.game.scores.forBeatmap(key).then(list => {
                if (token !== this.token || this.destroyed) return;
                this.show(list);
            }).catch(() => {
                if (token === this.token && !this.destroyed) this.show([]);
            });
            return;
        }
        const beatmapId = onlineIdOf(key);
        if (!beatmapId) {
            this.show([], { title: 'No global leaderboard', body: 'Only beatmaps downloaded from a mirror have one.' });
            return;
        }
        const abort = (this.abort = new AbortController());
        this.game.account.leaderboard(beatmapId, undefined, abort.signal).then(board => {
            if (token !== this.token || this.destroyed) return;
            const mine = board.mine;
            this.show(board.scores.map(toScoreRecord), { title: 'No scores yet', body: 'Sign in and pass this difficulty to set the first one!' }, mine ? `you: #${mine.rank}` : '');
        }).catch(e => {
            if (token !== this.token || this.destroyed || abort.signal.aborted) return;
            const offline = !(e instanceof ApiError);
            this.show([], { title: offline ? 'Global leaderboards are offline' : 'Could not load the leaderboard', body: offline ? 'Check your connection and try again.' : String(e.message ?? e) });
        });
    }

    /** Scores currently listed on the local board (e.g. to clear them); the global board is never cleared from here. */
    get scores(): readonly ScoreRecord[] {
        return this.scope === 'local' ? this.records : [];
    }

    private show(list: ScoreRecord[], empty: { title: string; body: string } = { title: 'No scores yet', body: 'Play this difficulty to set the first score!' }, note = ''): void {
        this.spinner.visible = false;
        this.records = list;
        const shown = list.slice(0, MAX_ROWS);
        const me = this.scope === 'global' ? this.game.account.user.value?.name ?? null : null;
        while (this.rows.length < shown.length) {
            const row = new ScoreRow(this.rowAvatar, () => this.gradeSkin());
            row.onActivate = () => {
                const r = row.scoreRecord;
                if (r?.hasReplay) this.onWatchReplay?.(r);
            };
            row.onMenu = (r, x, y) => ContextMenu.open(this.menuFor(r), x, y);
            this.rows.push(row);
            this.scroll.content.addChild(row);
        }
        this.rows.forEach((row, i) => {
            row.visible = i < shown.length;
            if (row.visible) row.assign(shown[i], i + 1, me !== null && shown[i].player === me);
        });
        const count = list.length ? `${list.length} score${list.length === 1 ? '' : 's'}` : '';
        this.countText.text = note ? (count ? `${count}  ·  ${note}` : note) : count;
        this.emptyTitle.text = empty.title;
        this.emptyBody.text = empty.body;
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

    /** lazer's LeaderboardScore.ContextMenuItems. */
    private menuFor(r: ScoreRecord): MenuEntry[] {
        const entries: MenuEntry[] = [];
        if (r.hasReplay) entries.push({ text: 'Watch replay', type: 'highlighted', action: () => this.onWatchReplay?.(r) });
        if (r.mods.length) entries.push({ text: 'Use these mods', action: () => (this.game.mods.value = sanitizeMods(r.mods, r.modSettings)) });
        if (r.hasReplay) entries.push({ text: 'Export replay (.osr)', action: () => this.onExport?.(r) });
        if (r.id !== undefined) {
            if (entries.length) entries.push(MENU_SPACER);
            entries.push({ text: 'Delete', type: 'destructive', action: () => this.onDelete?.(r) });
        }
        return entries;
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
        this.localTab.position.set(0, 0);
        this.globalTab.position.set(this.localTab.w + 18, 0);
        const active = this.scope === 'local' ? this.localTab : this.globalTab;
        this.tabBg.clear().rect(0, TAB_HEIGHT - 2, w, 2).fill({ color: 0xffffff, alpha: 0.12 })
            .rect(active.x, TAB_HEIGHT - 3, active.w, 3).fill(Colors.yellow);
        this.countText.position.set(w - 4, 8);
        const top = TAB_HEIGHT + 8;
        this.scroll.position.set(0, top);
        this.scroll.resize(w, Math.max(0, h - top));
        this.empty.position.set(w / 2, top + Math.min(70, Math.max(10, (h - top) / 2 - 50)));
        this.spinner.position.set(w / 2 - 14, top + 20);
        this.layoutRows();
    }
}
