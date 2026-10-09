import { Container, FillGradient, Graphics, Rectangle, type FederatedPointerEvent, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import { formatTime, lerpColor } from '../../core/math';
import { tween } from '../../core/Tweener';
import type { OnlineDifficulty, OnlineSet } from '../../online/providers';
import { drawRoundedRect } from '../../ui/Box';
import { Button, IconButton } from '../../ui/Button';
import { fillCover } from '../../ui/coverFill';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { fitText, label } from '../../ui/text';
import { Colors, type ColorProvider } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { formatCount, Statistic, StarPill, StatusPill } from './drawing';
import type { ListingController } from './ListingController';
import { PreviewButton } from './PreviewButton';

const MAX_W = 760;
const HEADER_H = 190;
const ACTIONS_H = 66;
const ROW_H = 44;
const RADIUS = 10;

let headerShade: FillGradient | null = null;
function shadeGradient(): FillGradient {
    headerShade ??= new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0.1)' },
            { offset: 1, color: 'rgba(0,0,0,0.85)' },
        ],
        textureSpace: 'local',
    });
    return headerShade;
}

const fmt = (v: number | undefined): string => (v === undefined ? '-' : String(Math.round(v * 10) / 10));

/** One difficulty: star pill, name, length/BPM and CS/AR/OD/HP. Click to play. */
class DifficultyRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly star = new StarPill(20);
    private readonly versionText: Text;
    private readonly info: Text;
    private readonly attrs: Text;
    private readonly spinner = new LoadingSpinner(8, 0xffffff, 2);

    constructor(readonly diff: OnlineDifficulty, private readonly colors: ColorProvider) {
        super();
        this.bg.alpha = 0;
        this.star.setStars(diff.stars);
        this.versionText = label(diff.version, { size: 14, weight: '700' });
        this.info = label(`${formatTime(diff.length * 1000)}  ·  ${Math.round(diff.bpm)} bpm`, { size: 12, weight: '600', color: colors.light2 });
        this.attrs = label(`CS ${fmt(diff.cs)}   AR ${fmt(diff.ar)}   OD ${fmt(diff.od)}   HP ${fmt(diff.hp)}`, { size: 12, weight: '600', color: colors.content2 });
        this.spinner.visible = false;
        this.addChild(this.bg, this.star, this.versionText, this.info, this.attrs, this.spinner);
        this.makeInteractive();
        this.cursor = 'pointer';
        this.tooltip = 'play this difficulty';
    }

    set pending(v: boolean) {
        this.spinner.visible = v;
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().roundRect(0, 2, w, h - 4, 6).fill(0xffffff);
        this.star.position.set(10, (h - 20) / 2);
        const nameX = 10 + 78;
        this.attrs.position.set(w - 12 - this.attrs.width, (h - this.attrs.height) / 2);
        this.info.position.set(this.attrs.x - 18 - this.info.width, (h - this.info.height) / 2);
        fitText(this.versionText, Math.max(40, this.info.x - nameX - 12), this.diff.version);
        this.versionText.position.set(nameX, (h - this.versionText.height) / 2);
        this.spinner.position.set(nameX + this.versionText.width + 8, h / 2 - 8);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.bg, { alpha: hovered ? 0.08 : 0 }, { duration: 150 });
        this.bg.tint = lerpColor(this.colors.light1, 0xffffff, 0.5);
    }
}

/**
 * Popover for one set (a pocket version of lazer's BeatmapSetOverlay):
 * cover header with title / artist / mapper / status and statistics, a
 * preview + favourite + download (or play) action row, then every
 * osu!standard difficulty — clicking one downloads the set if needed and
 * opens it in song select.
 */
export class DetailsPanel extends UIComponent {
    private readonly backdrop = new Graphics();
    private readonly card = new Container();
    private readonly cardBg = new Graphics();
    private readonly cover = new Graphics();
    private readonly closeButton: IconButton;
    private readonly title: Text;
    private readonly artist: Text;
    private readonly mappedBy: Text;
    private readonly statusPill = new StatusPill(20, 11);
    private readonly favStat = new Statistic('heart', 13);
    private readonly playStat = new Statistic('play', 13);
    private readonly previewButton: PreviewButton;
    private readonly favButton: IconButton;
    private readonly downloadButton: Button;
    private readonly playButton: Button;
    private readonly summary: Text;
    private readonly listCaption: Text;
    private readonly list = new ScrollContainer();
    private readonly listSpinner = new LoadingSpinner(14, 0xffffff, 3);
    private readonly listMessage: Text;
    private rows: DifficultyRow[] = [];
    private set: OnlineSet | null = null;
    private diffs: OnlineDifficulty[] | null = null;
    private coverTex: Texture | null = null;
    private loading: AbortController | null = null;
    private cardW = MAX_W;
    private lastCaption = '';
    /** Untruncated summary line (fitText shortens the Text itself). */
    private summaryText = '';
    private open_ = false;
    onClosed: (() => void) | null = null;

    constructor(private readonly game: Game, private readonly controller: ListingController, private readonly colors: ColorProvider) {
        super();
        this.backdrop.eventMode = 'static';
        this.backdrop.on('pointertap', () => this.close());
        this.title = label('', { size: 26, weight: '700', shadow: true });
        this.artist = label('', { size: 17, weight: '600', shadow: true });
        this.mappedBy = label('', { size: 13, weight: '600', color: Colors.grayD, shadow: true });
        this.closeButton = new IconButton('close', { size: 32, iconSize: 14, circle: true });
        this.closeButton.onActivate = () => this.close();
        this.previewButton = new PreviewButton(21, 15, 0.4, colors.highlight1);
        this.previewButton.onActivate = () => this.set && controller.togglePreview(this.set);
        this.favButton = new IconButton('heart', { size: 42, iconSize: 17, circle: true });
        this.favButton.onActivate = () => this.set && controller.toggleFavourite(this.set.sid);
        this.downloadButton = new Button('download', { color: Colors.blueDarker, width: 190, height: 40, fontSize: 15, triangles: game.skin.tex('triangle') });
        this.downloadButton.onActivate = () => this.set && void controller.download(this.set);
        this.playButton = new Button('play', { color: Colors.pink, width: 190, height: 40, fontSize: 15, icon: 'play', triangles: game.skin.tex('triangle') });
        this.playButton.onActivate = () => this.set && void controller.open(this.set);
        this.summary = label('', { size: 13, weight: '600', color: colors.light2 });
        this.listCaption = label('DIFFICULTIES', { size: 12, weight: '800', color: colors.highlight1, letterSpacing: 1 });
        this.listMessage = label('', { size: 13, weight: '600', color: colors.light3 });
        this.list.padBottom = 8;
        this.listMessage.eventMode = 'static';
        this.listMessage.cursor = 'pointer';
        this.listMessage.on('pointertap', (e: FederatedPointerEvent) => {
            e.stopPropagation();
            if (this.set && !this.diffs) this.loadDiffs(this.set);
        });

        this.card.addChild(this.cardBg, this.cover, this.title, this.artist, this.mappedBy, this.statusPill, this.favStat, this.playStat,
            this.closeButton, this.previewButton, this.favButton, this.downloadButton, this.playButton, this.summary,
            this.listCaption, this.list, this.listSpinner, this.listMessage);
        this.card.eventMode = 'static';
        this.addChild(this.backdrop, this.card);
        this.visible = false;
        this.eventMode = 'none';
        controller.changed.add(sid => {
            if (this.set && (sid === null || sid === this.set.sid)) this.refreshState();
        });
    }

    get isOpen(): boolean {
        return this.open_;
    }

    show(set: OnlineSet): void {
        this.loading?.abort();
        this.set = set;
        this.open_ = true;
        this.visible = true;
        this.eventMode = 'passive';
        this.coverTex = this.game.covers.peek(this.controller.cover(set.sid)) ?? null;
        if (!this.coverTex) {
            void this.game.covers.get(this.controller.cover(set.sid)).then(tex => {
                if (this.set !== set || !tex) return;
                this.coverTex = tex;
                this.drawCover();
            });
        }
        this.statusPill.setStatus(set.approved);
        this.playStat.set(formatCount(set.playCount));
        this.playStat.visible = set.playCount > 0;
        this.favStat.visible = set.favouriteCount !== undefined;
        this.setDiffs(this.controller.difficulties(set));
        if (!this.diffs) this.loadDiffs(set);
        this.refreshState();
        this.relayout();
        this.backdrop.alpha = 0;
        tween(this.backdrop, { alpha: 1 }, { duration: 250 });
        this.card.alpha = 0;
        this.card.scale.set(0.95);
        tween(this.card, { alpha: 1, scale: 1 }, { duration: 400, ease: 'OutQuint' });
    }

    close(silent = false): void {
        if (!this.open_) return;
        this.open_ = false;
        this.loading?.abort();
        this.loading = null;
        this.eventMode = 'none';
        if (!silent) this.game.uiSounds.back();
        tween(this.backdrop, { alpha: 0 }, { duration: 200 });
        tween(this.card, { alpha: 0, scale: 0.97 }, { duration: 200, ease: 'OutQuint' }).finished.then(() => {
            if (!this.open_) this.visible = false;
        });
        this.onClosed?.();
    }

    private loadDiffs(set: OnlineSet): void {
        const ac = new AbortController();
        this.loading = ac;
        this.listMessage.visible = false;
        this.listSpinner.visible = true;
        this.controller.loadDifficulties(set, ac.signal).then(d => {
            if (this.set !== set || ac.signal.aborted) return;
            this.setDiffs(d);
            this.relayout();
        }).catch(() => {
            if (this.set !== set || ac.signal.aborted) return;
            this.listSpinner.visible = false;
            this.listMessage.text = "couldn't load difficulties (click to retry)";
            this.listMessage.visible = true;
        });
    }

    private setDiffs(diffs: OnlineDifficulty[] | null): void {
        this.diffs = diffs;
        for (const r of this.rows) r.destroy();
        this.rows = [];
        this.listSpinner.visible = !diffs;
        this.listMessage.visible = !!diffs && !diffs.length;
        if (diffs && !diffs.length) this.listMessage.text = 'no osu!standard difficulties';
        for (const d of diffs ?? []) {
            const row = new DifficultyRow(d, this.colors);
            row.onActivate = () => this.set && void this.controller.open(this.set, d);
            this.list.content.addChild(row);
            this.rows.push(row);
        }
        const set = this.set;
        if (!set) return;
        const lengths = (diffs ?? []).map(d => d.length);
        const bpm = set.bpm ?? (diffs?.length ? diffs[diffs.length - 1].bpm : undefined);
        const parts: string[] = [];
        if (lengths.length) parts.push(`length ${formatTime(Math.max(...lengths) * 1000)}`);
        if (bpm) parts.push(`${Math.round(bpm)} bpm`);
        if (diffs) parts.push(`${diffs.length} difficult${diffs.length === 1 ? 'y' : 'ies'}`);
        if (set.source) parts.push(set.source);
        this.summaryText = parts.join('  ·  ');
        this.summary.text = this.summaryText;
    }

    /** Favourite / preview / download state. */
    private refreshState(): void {
        const set = this.set;
        if (!set) return;
        const fav = this.controller.isFavourite(set.sid);
        this.favButton.active = fav;
        this.favButton.tooltip = fav ? 'unfavourite' : 'favourite';
        this.favStat.set(formatCount((set.favouriteCount ?? 0) + (fav ? 1 : 0)), 'heart', fav ? Colors.pink : 0xffffff);
        this.previewButton.setState(this.controller.previewState(set.sid));
        const st = this.controller.status(set.sid);
        const local = st.phase === 'local';
        this.playButton.visible = local;
        this.downloadButton.visible = !local;
        let caption = 'download';
        if (st.phase === 'queued') caption = 'queued…';
        else if (st.phase === 'downloading') caption = Number.isFinite(st.progress) ? `downloading ${Math.floor(st.progress * 100)}%` : 'downloading…';
        else if (st.phase === 'importing') caption = 'importing…';
        if (caption !== this.lastCaption) {
            this.lastCaption = caption;
            this.downloadButton.caption = caption;
        }
        this.downloadButton.enabled = st.phase === 'none';
        const pending = this.controller.pendingOpen;
        for (const r of this.rows) r.pending = !!pending && pending.sid === set.sid && pending.bid === r.diff.bid;
        this.layoutStats();
    }

    tick(dt: number): void {
        if (!this.open_) return;
        if (this.previewButton.previewState !== 'idle') this.previewButton.tick(dt, this.controller.previewProgress(), this.controller.previewDuration());
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    protected override onResize(w: number, h: number): void {
        this.backdrop.clear().rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.6 });
        const set = this.set;
        if (!set) return;
        const cw = this.cardW = Math.min(MAX_W, w - 40);
        const listH = Math.max(ROW_H * 2, Math.min((this.diffs?.length ?? 3) * ROW_H, h - 80 - HEADER_H - ACTIONS_H - 40));
        const ch = HEADER_H + ACTIONS_H + 30 + listH + 12;
        this.card.pivot.set(cw / 2, ch / 2);
        this.card.position.set(w / 2, h / 2);
        this.card.hitArea = new Rectangle(0, 0, cw, ch);
        this.cardBg.clear().roundRect(0, 0, cw, ch, RADIUS).fill(this.colors.background4);
        this.drawCover();

        const pad = 24;
        this.closeButton.position.set(cw - 32 - 10, 10);
        this.statusPill.position.set(pad, HEADER_H - 100);
        fitText(this.title, cw - pad * 2, set.title || set.titleUnicode || 'unknown title');
        this.title.position.set(pad, HEADER_H - 76);
        fitText(this.artist, cw - pad * 2, set.artist || set.artistUnicode || 'unknown artist');
        this.artist.position.set(pad, HEADER_H - 44);
        fitText(this.mappedBy, cw * 0.55, `mapped by ${set.creator || 'unknown'}`);
        this.mappedBy.position.set(pad, HEADER_H - 22);
        this.layoutStats();

        const ay = HEADER_H + (ACTIONS_H - 42) / 2;
        this.previewButton.position.set(pad, ay);
        this.favButton.position.set(pad + 52, ay);
        this.downloadButton.position.set(pad + 106, ay + 1);
        this.playButton.position.set(pad + 106, ay + 1);
        fitText(this.summary, cw - (pad + 106 + 190 + 20) - pad, this.summaryText);
        this.summary.position.set(pad + 106 + 190 + 20, HEADER_H + (ACTIONS_H - this.summary.height) / 2);

        const ly = HEADER_H + ACTIONS_H;
        this.listCaption.position.set(pad, ly + 4);
        this.list.position.set(pad - 10, ly + 26);
        this.list.resize(cw - pad * 2 + 20, listH);
        let y = 0;
        for (const r of this.rows) {
            r.resize(cw - pad * 2 + 10, ROW_H);
            r.position.set(0, y);
            y += ROW_H;
        }
        this.list.contentHeight = y;
        this.listSpinner.position.set(cw / 2 - 14, ly + 26 + 20);
        this.listMessage.position.set(pad, ly + 34);
    }

    private drawCover(): void {
        const g = this.cover.clear();
        const w = this.cardW;
        drawRoundedRect(g, 0, 0, w, HEADER_H, RADIUS, 'top').fill(this.colors.background2);
        if (this.coverTex) fillCover(g, this.coverTex, 0, 0, w, HEADER_H, RADIUS, { corners: 'top', color: 0xbbbbbb });
        drawRoundedRect(g, 0, 0, w, HEADER_H, RADIUS, 'top').fill(shadeGradient());
    }

    private layoutStats(): void {
        let x = this.cardW - 24;
        for (const s of [this.playStat, this.favStat]) {
            if (!s.visible) continue;
            x -= s.statWidth;
            s.position.set(x, HEADER_H - 14);
            x -= 16;
        }
    }
}
