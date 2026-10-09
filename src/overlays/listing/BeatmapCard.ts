import { Container, FillGradient, Graphics, Rectangle, type FederatedPointerEvent, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import { tween, tweener } from '../../core/Tweener';
import type { OnlineDifficulty, OnlineSet } from '../../online/providers';
import { IconButton } from '../../ui/Button';
import { fillCover } from '../../ui/coverFill';
import { icon } from '../../ui/icons';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { fitText, label } from '../../ui/text';
import { Colors, type ColorProvider } from '../../ui/theme';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { gesture } from '../../ui/UIContext';
import { drawDifficultySpectrum, formatCount, Statistic, StatusPill } from './drawing';
import type { DownloadStatus, ListingController } from './ListingController';
import { PreviewButton } from './PreviewButton';

export const CARD_H = 100;
const THUMB = 100;
const RADIUS = 10;
const BUTTONS_W = 30;
const PAD = 10;
const TEXT_X = THUMB + PAD;
/** Visible this long before covers/difficulties load (skips fast scroll-bys). */
const LOAD_DELAY = 120;

export interface CardContext {
    game: Game;
    controller: ListingController;
    colors: ColorProvider;
    onOpen(set: OnlineSet): void;
}

const fades = new Map<number, FillGradient>();
/** Cover fades into the card colour toward the right (lazer's content background). */
function fadeGradient(color: number): FillGradient {
    let g = fades.get(color);
    if (!g) {
        const r = (color >> 16) & 255, gr = (color >> 8) & 255, b = color & 255;
        g = new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 1, y: 0 },
            colorStops: [
                { offset: 0, color: `rgba(${r},${gr},${b},0.35)` },
                { offset: 1, color: `rgba(${r},${gr},${b},0.92)` },
            ],
            textureSpace: 'local',
        });
        fades.set(color, g);
    }
    return g;
}

/**
 * lazer's BeatmapCardNormal: cover thumbnail with a preview button, title
 * / artist / mapper over the dimmed cover, statistics top-right, status
 * pill and difficulty spectrum at the bottom. Hovering slides the content
 * aside to reveal favourite and download buttons; a progress bar runs
 * along the bottom while downloading. Cards are pooled: `bind` swaps the
 * set shown and every visual is redrawn only when something changes.
 */
export class BeatmapCard extends UIComponent {
    set: OnlineSet | null = null;
    index = -1;
    private readonly base = new Graphics();
    private readonly contentBg = new Graphics();
    private readonly coverG = new Graphics();
    private readonly fade = new Graphics();
    private readonly thumb = new Graphics();
    private readonly thumbDim = new Graphics();
    private readonly previewButton: PreviewButton;
    private readonly title: Text;
    private readonly artist: Text;
    private readonly mappedBy: Text;
    private readonly mapper: Text;
    private readonly favStat = new Statistic('heart');
    private readonly playStat = new Statistic('play');
    private readonly statusPill = new StatusPill(18, 10);
    private readonly videoPill = new Container();
    private readonly spectrumBox = new Container();
    private readonly spectrum = new Graphics();
    private readonly spectrumCount: Text;
    private readonly progressBar = new Graphics();
    private readonly buttons = new Container();
    private readonly favButton: IconButton;
    private readonly dlButton: IconButton;
    private readonly dlSpinner = new LoadingSpinner(7, 0xffffff, 2);
    private coverTex: Texture | null = null;
    private diffs: OnlineDifficulty[] | null = null;
    private expand = 0;
    private readonly expandProxy = { e: 0 };
    private isHovered = false;
    private lastStatsWidth = 0;
    private age = 0;
    private loading: AbortController | null = null;
    private loadsStarted = false;
    private dl: DownloadStatus = { phase: 'none', progress: 0 };
    private previewing = false;
    private pulse = 0;

    constructor(private readonly ctx: CardContext) {
        super();
        const c = ctx.colors;
        this.previewButton = new PreviewButton(22, 18, 0.35, c.highlight1);
        this.previewButton.alpha = 0;
        this.previewButton.onActivate = () => this.set && ctx.controller.togglePreview(this.set);
        this.title = label('', { size: 19, weight: '700' });
        this.artist = label('', { size: 15, weight: '600' });
        this.mappedBy = label('mapped by', { size: 13, weight: '500', color: c.content2 });
        this.mapper = label('', { size: 13, weight: '700' });
        this.spectrumCount = label('', { size: 12, weight: '700' });
        this.spectrumBox.addChild(this.spectrum, this.spectrumCount);
        const film = new Graphics().roundRect(0, 0, 24, 18, 9).fill({ color: 0x000000, alpha: 0.5 });
        const filmIcon = icon('film', 9, 0xffffff);
        filmIcon.position.set(12, 9);
        this.videoPill.addChild(film, filmIcon);

        this.favButton = new IconButton('heart', { size: BUTTONS_W, iconSize: 12 });
        this.dlButton = new IconButton('download', { size: BUTTONS_W, iconSize: 12 });
        this.favButton.onActivate = () => this.set && ctx.controller.toggleFavourite(this.set.sid);
        this.dlButton.onActivate = () => this.onDownloadButton();
        for (const b of [this.favButton, this.dlButton]) b.on('pointertap', (e: FederatedPointerEvent) => e.stopPropagation());
        this.dlSpinner.visible = false;
        this.buttons.addChild(this.favButton, this.dlButton, this.dlSpinner);
        this.buttons.alpha = 0;

        this.thumbDim.alpha = 0;
        this.addChild(
            this.base, this.buttons, this.contentBg, this.coverG, this.fade, this.thumb, this.thumbDim, this.previewButton,
            this.title, this.artist, this.mappedBy, this.mapper, this.favStat, this.playStat,
            this.videoPill, this.statusPill, this.spectrumBox, this.progressBar,
        );
        this.coverG.tint = 0x707070;
        this.eventMode = 'static';
        this.cursor = 'pointer';
        this.hitArea = new Rectangle(0, 0, 0, CARD_H);
        this.on('pointerenter', () => this.setHover(true));
        this.on('pointerleave', () => this.setHover(false));
        this.on('pointertap', (e: FederatedPointerEvent) => {
            if (gesture.suppressClicks || e.button > 0 || !this.set) return;
            ctx.game.uiSounds.click();
            ctx.onOpen(this.set);
        });
        this.visible = false;
    }

    // ------------------------------------------------------------------
    // Binding
    // ------------------------------------------------------------------

    bind(set: OnlineSet, index: number, fresh: boolean): void {
        this.index = index;
        if (this.set === set) return;
        this.release();
        this.set = set;
        this.visible = true;
        this.age = 0;
        this.loadsStarted = false;
        this.coverTex = this.ctx.game.covers.peek(this.ctx.controller.cover(set.sid)) ?? null;
        this.diffs = this.ctx.controller.difficulties(set);
        this.statusPill.setStatus(set.approved);
        this.videoPill.visible = set.video || this.ctx.game.knownVideos.has(set.sid);
        this.playStat.set(formatCount(set.playCount));
        this.playStat.visible = set.playCount > 0;
        this.favStat.visible = set.favouriteCount !== undefined;
        this.drawThumb();
        this.drawContent();
        this.layoutText();
        this.drawSpectrum();
        this.refreshState();
        if (fresh) {
            this.alpha = 0;
            tween(this, { alpha: 1 }, { duration: 300, ease: 'OutQuint' });
        } else {
            tween(this, { alpha: 1 }, { duration: 0 });
        }
    }

    /** Return to the pool. */
    unbind(): void {
        this.release();
        this.set = null;
        this.index = -1;
        this.visible = false;
        if (this.isHovered) this.setHover(false, true);
    }

    private release(): void {
        this.loading?.abort();
        this.loading = null;
    }

    private startLoads(): void {
        const set = this.set;
        if (!set) return;
        this.loadsStarted = true;
        const ac = new AbortController();
        this.loading = ac;
        if (!this.coverTex) {
            void this.ctx.game.covers.get(this.ctx.controller.cover(set.sid)).then(tex => {
                if (this.set !== set || !tex || this.destroyed) return;
                this.coverTex = tex;
                this.drawThumb();
                this.drawContent();
                this.thumb.alpha = this.coverG.alpha = 0;
                tween(this.thumb, { alpha: 1 }, { duration: 400 });
                tween(this.coverG, { alpha: 1 }, { duration: 400 });
            });
        }
        if (!this.diffs) {
            this.ctx.controller.loadDifficulties(set, ac.signal).then(d => {
                if (this.set !== set || this.destroyed) return;
                this.diffs = d;
                this.drawSpectrum();
            }).catch(() => { /* aborted or offline: keep the bare glyph */ });
        }
    }

    // ------------------------------------------------------------------
    // State (favourite / preview / download)
    // ------------------------------------------------------------------

    refreshState(): void {
        const set = this.set;
        if (!set) return;
        const ctl = this.ctx.controller;
        const fav = ctl.isFavourite(set.sid);
        this.favButton.active = fav;
        this.favButton.tooltip = fav ? 'unfavourite' : 'favourite';
        const favCount = (set.favouriteCount ?? 0) + (fav ? 1 : 0);
        this.favStat.set(formatCount(favCount), 'heart', fav ? Colors.pink : 0xffffff);

        const preview = ctl.previewState(set.sid);
        this.previewButton.setState(preview);
        this.previewing = preview !== 'idle';
        this.syncPreviewVisibility();

        const dl = ctl.status(set.sid);
        const changedPhase = dl.phase !== this.dl.phase;
        this.dl = dl;
        if (changedPhase) {
            const busy = dl.phase === 'queued' || dl.phase === 'downloading' || dl.phase === 'importing';
            this.dlButton.glyph.visible = !busy;
            this.dlSpinner.visible = busy;
            this.dlButton.setIcon(dl.phase === 'local' ? 'anglesRight' : 'download');
            this.dlButton.tooltip = dl.phase === 'local' ? 'go to beatmap' : busy ? 'downloading…' : 'download';
        }
        const sw = this.statsWidth();
        if (sw !== this.lastStatsWidth) {
            this.lastStatsWidth = sw;
            this.layoutText();
        }
        this.layoutStats();
        this.drawProgress();
    }

    private onDownloadButton(): void {
        const set = this.set;
        if (!set) return;
        if (this.dl.phase === 'local') void this.ctx.controller.open(set);
        else if (this.dl.phase === 'none') void this.ctx.controller.download(set);
    }

    // ------------------------------------------------------------------
    // Frame
    // ------------------------------------------------------------------

    tick(dt: number): void {
        if (!this.set) return;
        this.age += dt;
        if (!this.loadsStarted && this.age > LOAD_DELAY) this.startLoads();
        if (this.previewing) this.previewButton.tick(dt, this.ctx.controller.previewProgress(), this.ctx.controller.previewDuration());
        if (this.dl.phase === 'importing' || this.dl.phase === 'queued' || (this.dl.phase === 'downloading' && !Number.isFinite(this.dl.progress))) {
            this.pulse += dt;
            this.drawProgress();
        }
    }

    // ------------------------------------------------------------------
    // Layout / drawing
    // ------------------------------------------------------------------

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        this.base.clear().roundRect(0, 0, w, h, RADIUS).fill(this.ctx.colors.background3);
        this.buttons.position.set(w - BUTTONS_W, 0);
        this.favButton.resize(BUTTONS_W, h / 2);
        this.dlButton.resize(BUTTONS_W, h / 2);
        this.dlButton.y = h / 2;
        this.dlSpinner.position.set(BUTTONS_W / 2 - 7, h * 0.75 - 7);
        this.drawContent();
        if (this.set) this.layoutText();
    }

    private get contentWidth(): number {
        return this._w - BUTTONS_W * this.expand;
    }

    private drawThumb(): void {
        const g = this.thumb.clear();
        g.roundRect(0, 0, THUMB, CARD_H, RADIUS).fill(this.ctx.colors.background1);
        if (this.coverTex) fillCover(g, this.coverTex, 0, 0, THUMB, CARD_H, RADIUS);
        this.thumbDim.clear().roundRect(0, 0, THUMB, CARD_H, RADIUS).fill(0x000000);
        this.previewButton.position.set(THUMB / 2 - 22, CARD_H / 2 - 22);
    }

    private drawContent(): void {
        const w = this.contentWidth, h = CARD_H;
        if (w <= 0) return;
        const bg = this.ctx.colors.background2;
        this.contentBg.clear().roundRect(0, 0, w, h, RADIUS).fill(bg);
        this.coverG.clear();
        if (this.coverTex) fillCover(this.coverG, this.coverTex, 0, 0, w, h, RADIUS);
        this.fade.clear().roundRect(0, 0, w, h, RADIUS).fill(fadeGradient(bg));
        this.layoutStats();
        this.drawProgress();
    }

    private layoutText(): void {
        const set = this.set!;
        const textW = this._w - TEXT_X - PAD - BUTTONS_W;
        fitText(this.title, textW - this.statsWidth() - 8, set.title || set.titleUnicode || 'unknown title');
        fitText(this.artist, textW, `by ${set.artist || set.artistUnicode || 'unknown artist'}`);
        this.title.position.set(TEXT_X, 6);
        this.artist.position.set(TEXT_X, 31);
        this.mappedBy.position.set(TEXT_X, 54);
        fitText(this.mapper, textW - this.mappedBy.width - 4, set.creator || 'unknown');
        this.mapper.position.set(TEXT_X + this.mappedBy.width + 4, 54);
        let x = TEXT_X;
        const cy = CARD_H - 17;
        if (this.videoPill.visible) {
            this.videoPill.position.set(x, cy - 9);
            x += 24 + 5;
        }
        this.statusPill.position.set(x, cy - 9);
        this.spectrumBox.x = x + this.statusPill.pillWidth + 8;
    }

    private drawSpectrum(): void {
        this.spectrum.clear();
        drawDifficultySpectrum(this.spectrum, this.spectrumCount, 0, CARD_H - 17, this.diffs);
    }

    private statsWidth(): number {
        let w = 0;
        if (this.favStat.visible) w += this.favStat.statWidth + 10;
        if (this.playStat.visible) w += this.playStat.statWidth + 10;
        return w;
    }

    private layoutStats(): void {
        let x = this.contentWidth - PAD;
        for (const s of [this.playStat, this.favStat]) {
            if (!s.visible) continue;
            x -= s.statWidth;
            s.position.set(x, 15);
            x -= 10;
        }
    }

    private drawProgress(): void {
        const g = this.progressBar.clear();
        const p = this.dl;
        if (p.phase !== 'downloading' && p.phase !== 'importing' && p.phase !== 'queued') return;
        const x = TEXT_X, w = this.contentWidth - TEXT_X - PAD, y = CARD_H - 5, h = 3;
        g.roundRect(x, y, w, h, 1.5).fill({ color: 0x000000, alpha: 0.4 });
        if (p.phase === 'downloading' && Number.isFinite(p.progress)) {
            g.roundRect(x, y, Math.max(h, w * p.progress), h, 1.5).fill(this.ctx.colors.highlight1);
        } else {
            // Queued / importing / unknown size: pulse the whole bar.
            const a = 0.45 + 0.35 * Math.sin(this.pulse / 180);
            g.roundRect(x, y, w, h, 1.5).fill({ color: p.phase === 'importing' ? Colors.yellow : this.ctx.colors.highlight1, alpha: a });
        }
    }

    // ------------------------------------------------------------------
    // Hover
    // ------------------------------------------------------------------

    private setHover(on: boolean, instant = false): void {
        if (on === this.isHovered) return;
        this.isHovered = on;
        if (on) this.ctx.game.uiSounds.hover();
        const proxy = this.expandProxy;
        if (instant) {
            tweener.kill(proxy);
            proxy.e = this.expand = on ? 1 : 0;
            this.drawContent();
        } else {
            tween(proxy, { e: on ? 1 : 0 }, {
                owner: this,
                duration: 400,
                ease: 'OutQuint',
                onUpdate: () => {
                    this.expand = proxy.e;
                    this.drawContent();
                },
            });
        }
        tween(this.buttons, { alpha: on ? 1 : 0 }, { duration: instant ? 0 : 200 });
        this.buttons.eventMode = on ? 'passive' : 'none';
        tweenTint(this.coverG, on ? 0xa0a0a0 : 0x707070, instant ? 0 : 300);
        this.syncPreviewVisibility(instant);
    }

    private syncPreviewVisibility(instant = false): void {
        const show = this.isHovered || this.previewing;
        tween(this.previewButton, { alpha: show ? 1 : 0 }, { duration: instant ? 0 : 200 });
        tween(this.thumbDim, { alpha: show ? 0.4 : 0 }, { duration: instant ? 0 : 200 });
        this.previewButton.eventMode = show ? 'static' : 'none';
    }
}
