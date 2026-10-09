import { Container, Graphics } from 'pixi.js';
import type { Game } from '../app/Game';
import { Overlay } from '../app/Overlay';
import { tween } from '../core/Tweener';
import type { Action } from '../input/bindings';
import { resolveProviders, type OnlineSet, type ProviderId } from '../online/providers';
import { ScrollContainer } from '../ui/ScrollContainer';
import { ColorProvider } from '../ui/theme';
import { CardGrid } from './listing/CardGrid';
import { DetailsPanel } from './listing/DetailsPanel';
import { ListingController } from './listing/ListingController';
import { ListingFooter, type FooterState } from './listing/ListingFooter';
import { ListingHeader, type QueryPatch } from './listing/ListingHeader';
import {
    genreChoices,
    languageChoices,
    ListingPager,
    sameQuery,
    type ListingQuery,
    type ListingTab,
    type PagerSource,
} from './listing/ListingPager';

/** Start loading the next page this close to the end of the content. */
const LOAD_AHEAD = 700;
/** Keys that would otherwise reach the screen behind (song select, menu). */
const SWALLOWED: ReadonlySet<Action> = new Set<Action>([
    'select', 'up', 'down', 'left', 'right', 'toggleMods', 'random', 'randomRewind', 'skip', 'quickRetry', 'deleteItem',
]);

/**
 * osu!lazer's beatmap listing (osu!direct): category tabs, search and
 * filters over a virtualized, infinitely scrolling grid of beatmap cards
 * with previews, favourites and one-click downloads; clicking a card
 * opens its difficulties. Slides in behind lazer's coloured waves.
 */
export class BeatmapListingOverlay extends Overlay {
    private readonly colors = new ColorProvider('blue');
    private readonly waves: Graphics[] = [];
    private readonly panel = new Container();
    private readonly panelBg = new Graphics();
    private readonly scroll = new ScrollContainer();
    private readonly controller: ListingController;
    private readonly header: ListingHeader;
    private readonly grid: CardGrid;
    private readonly footer: ListingFooter;
    private readonly details: DetailsPanel;
    private readonly source: PagerSource;
    private pager: ListingPager | null = null;
    private query: ListingQuery = { tab: 'latest', keyword: '', genre: 1, lang: 1, status: 'any' };
    private lastBrowseTab: ListingTab = 'latest';
    private provider: ProviderId;
    private viewW = 0;
    private viewH = 0;
    private layoutDirty = true;
    private coverSid = -1;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.4;
        this.provider = this.browseProvider();
        this.controller = new ListingController(game);
        this.controller.isActive = () => this.isOpen;
        this.source = {
            list: (kind, opts) => game.api.list(kind, opts),
            setInfo: (sid, signal) => game.api.setInfo(sid, signal),
            favourites: () => game.favourites.list(),
            fallback: sid => this.fallbackSet(sid),
        };
        this.header = new ListingHeader(this.colors, this.query);
        this.header.setQuery(this.query, this.provider);
        this.grid = new CardGrid({ game, controller: this.controller, colors: this.colors, onOpen: set => this.details.show(set) });
        this.footer = new ListingFooter(this.colors);
        this.footer.onRetry = () => this.pager?.retry();
        this.details = new DetailsPanel(game, this.controller, this.colors);

        const c = this.colors;
        for (const color of [c.light4, c.light3, c.dark4, c.dark3]) {
            const wave = new Graphics();
            wave.tint = color;
            wave.visible = false;
            this.waves.push(wave);
        }
        this.scroll.padBottom = 20;
        this.scroll.content.addChild(this.header, this.grid.layer, this.footer);
        this.panel.addChild(this.panelBg, this.scroll);
        this.panel.eventMode = 'static';
        this.addChild(...this.waves, this.panel, this.details);

        this.header.patched.add(p => this.applyPatch(p));
        this.controller.changed.add(sid => this.grid.refresh(sid));
        this.scroll.scrolled.add(() => this.updateGrid());
        game.settings.browseProvider.bind(() => this.onProviderChanged());
        // Favourites changed elsewhere while that tab is open: show them.
        game.favourites.changed.add(() => {
            if (!this.isOpen && this.query.tab === 'favourites') this.dropPager();
        });
    }

    /** Open the listing searching for `query` (a set id works too). */
    search(query: string): void {
        const keyword = query.trim();
        this.header.search.setValue(keyword, false);
        this.setQuery({ ...this.query, tab: keyword ? 'search' : this.lastBrowseTab, keyword }, true);
        this.show();
    }

    // ------------------------------------------------------------------
    // Query
    // ------------------------------------------------------------------

    private browseProvider(): ProviderId {
        const s = this.game.settings;
        return resolveProviders(s.browseProvider.value, s.downloadProvider.value).browseId;
    }

    private applyPatch(p: QueryPatch): void {
        const q: ListingQuery = { ...this.query, ...p };
        // Clearing the search box returns to the tab browsed before.
        if (p.tab === undefined && p.keyword === '' && q.tab === 'search') q.tab = this.lastBrowseTab;
        if (q.tab !== 'search') {
            q.keyword = '';
            this.lastBrowseTab = q.tab;
        } else if (!q.keyword) {
            this.header.search.focus();
        }
        this.setQuery(q);
    }

    private setQuery(q: ListingQuery, force = false): void {
        if (!force && this.pager && sameQuery(q, this.query)) return;
        this.query = q;
        this.header.setQuery(q, this.provider);
        this.restart();
    }

    private onProviderChanged(): void {
        const id = this.browseProvider();
        if (id === this.provider) return;
        this.provider = id;
        const q = { ...this.query };
        // Drop filters the new mirror can't apply.
        if (!genreChoices(id).some(g => g.value === q.genre)) q.genre = 1;
        if (!languageChoices(id).some(l => l.value === q.lang)) q.lang = 1;
        this.query = q;
        this.header.setQuery(q, id);
        if (this.isOpen) this.restart();
        else this.dropPager();
    }

    /** Forget the results (and stop their requests); the next show reloads. */
    private dropPager(): void {
        this.pager?.dispose();
        this.pager = null;
    }

    private restart(): void {
        this.pager?.dispose();
        const pager = new ListingPager(this.source, this.query);
        this.pager = pager;
        pager.changed.add(() => this.onPagerChanged(pager));
        this.grid.setItems(pager.sets, true);
        // Keep the filters in view but don't leave the user deep in old results.
        const gridTop = this.grid.top;
        if (this.scroll.scrollY > gridTop) this.scroll.scrollTo(Math.max(0, gridTop - 60), false);
        this.layoutDirty = true;
        this.footer.setState(this.footerState());
        void pager.loadMore();
    }

    private onPagerChanged(pager: ListingPager): void {
        if (pager !== this.pager) return;
        this.grid.setItems(pager.sets, false);
        this.footer.setState(this.footerState());
        this.layoutDirty = true;
        this.updateCover();
    }

    private footerState(): FooterState {
        const p = this.pager;
        if (!p) return { kind: 'none' };
        switch (p.state) {
            case 'loading': return { kind: 'loading', initial: p.sets.length === 0 };
            case 'error': return { kind: 'error', message: p.error };
            case 'end':
                if (p.sets.length) return { kind: 'none' };
                if (this.query.tab === 'search' && !this.query.keyword) {
                    return { kind: 'empty', icon: 'search', message: 'search for beatmaps', detail: 'type a title, artist, mapper or a beatmap set id' };
                }
                if (this.query.tab === 'favourites' && this.query.status === 'any') {
                    return { kind: 'empty', icon: 'heart', message: 'no favourites yet', detail: 'tap the heart on any beatmap to keep it here' };
                }
                return { kind: 'empty', icon: 'search', message: '... nope, nothing found.', detail: 'try other keywords or filters' };
            default: return { kind: 'none' };
        }
    }

    private updateCover(): void {
        const first = this.grid.firstSet;
        if (!first || first.sid === this.coverSid) return;
        const sid = first.sid;
        this.coverSid = sid;
        void this.game.covers.get(this.controller.cover(sid)).then(tex => {
            if (this.coverSid === sid && tex) this.header.setCover(tex);
        });
    }

    private fallbackSet(sid: number): OnlineSet {
        const lib = this.controller.librarySet(sid);
        return {
            sid,
            title: lib?.title ?? `beatmap set #${sid}`,
            artist: lib?.artist ?? 'unknown artist',
            creator: lib?.creator ?? '',
            approved: -3,
            modes: 1,
            video: lib?.hasVideo ?? false,
            playCount: 0,
        };
    }

    // ------------------------------------------------------------------
    // Layout / frame
    // ------------------------------------------------------------------

    protected layout(w: number, h: number): void {
        this.viewW = w;
        this.viewH = h;
        const top = this.game.toolbarOffset;
        const ph = Math.max(0, h - top);
        this.panel.y = top;
        this.panel.hitArea = { contains: (x: number, y: number) => x >= 0 && x <= w && y >= 0 && y <= ph };
        this.panelBg.clear().rect(0, 0, w, ph).fill(this.colors.background4);
        this.scroll.resize(w, ph);
        for (const [i, wave] of this.waves.entries()) {
            const angle = [0.12, -0.08, 0.05, -0.025][i];
            wave.clear().rect(-w * 0.8, 0, w * 1.6, h * 1.6).fill(0xffffff);
            wave.pivot.set(0, 0);
            wave.rotation = angle;
            wave.x = w / 2;
        }
        this.details.resize(w, h);
        this.layoutDirty = true;
        this.layoutContent();
    }

    private layoutContent(): void {
        this.layoutDirty = false;
        const w = this.viewW;
        if (w <= 0) return;
        const pad = w >= 900 ? 50 : 20;
        this.header.pad = pad;
        const hh = this.header.preferredHeight(w);
        if (this.header.w === w && this.header.h === hh) this.header.relayout();
        else this.header.resize(w, hh);
        this.grid.top = hh + 20;
        this.grid.layout(w, pad);
        const gridH = this.grid.height;
        this.footer.position.set(0, this.grid.top + gridH);
        this.footer.resize(w, this.footer.preferredHeight);
        this.scroll.contentHeight = this.footer.y + this.footer.h;
        this.updateGrid();
    }

    private updateGrid(): void {
        this.grid.update(this.scroll.scrollY, this.scroll.h);
    }

    override update(dt: number): void {
        if (this.layoutDirty) this.layoutContent();
        const p = this.pager;
        if (p && p.state === 'idle' && this.scroll.scrollY + this.scroll.h > this.scroll.contentHeight - LOAD_AHEAD) void p.loadMore();
        this.grid.tick(dt);
        this.details.tick(dt);
    }

    // ------------------------------------------------------------------
    // Show / hide
    // ------------------------------------------------------------------

    protected popIn(): void {
        this.relayout();
        if (!this.pager) this.restart();
        const h = this.viewH;
        const top = this.game.toolbarOffset;
        this.waves.forEach((wave, i) => {
            wave.visible = true;
            wave.y = h + 40;
            tween(wave, { y: top - 30 + i * 8 }, { duration: 700, delay: i * 60, ease: 'OutQuint' });
        });
        this.panel.y = h;
        tween(this.panel, { y: top }, { duration: 800, delay: 180, ease: 'OutQuint' }).finished.then(() => {
            // Hidden behind the opaque panel: stop paying for their fill.
            if (this.isOpen) for (const wave of this.waves) wave.visible = false;
        });
    }

    protected async popOut(): Promise<void> {
        this.header.search.blur();
        this.details.close(true);
        // A "download, then show" still running must not navigate later.
        this.controller.pendingOpen = null;
        this.controller.releaseAudio();
        const h = this.viewH;
        tween(this.panel, { y: h + 40 }, { duration: 500, ease: 'InQuad' });
        let last: Promise<void> = Promise.resolve();
        this.waves.forEach((wave, i) => {
            wave.visible = true;
            last = tween(wave, { y: h + 40 }, { duration: 500, delay: (this.waves.length - i) * 50, ease: 'InQuad' }).finished;
        });
        await last;
        // Reopened mid-animation: popIn owns the waves now.
        if (!this.isOpen) for (const wave of this.waves) wave.visible = false;
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        const printable = !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1;
        if (this.details.isOpen) {
            if (action === 'back') {
                this.details.close();
                return true;
            }
            // Letters would reach menu hotkeys behind the overlay.
            return printable || (action !== null && SWALLOWED.has(action));
        }
        if (super.onKey(e, action)) return true;
        const search = this.header.search;
        // Type-to-search, like lazer.
        if (!search.isFocused && printable && e.key !== ' ') {
            search.focus();
            search.setValue(search.value + e.key);
            this.scroll.scrollTo(0);
            return true;
        }
        switch (action) {
            case 'pageUp': this.scroll.scrollTo(this.scroll.scrollY - this.scroll.h * 0.8); return true;
            case 'pageDown': this.scroll.scrollTo(this.scroll.scrollY + this.scroll.h * 0.8); return true;
            case 'home': this.scroll.scrollTo(0); return true;
            case 'end': this.scroll.scrollTo(this.scroll.maxScroll); return true;
            default: return action !== null && SWALLOWED.has(action);
        }
    }
}
