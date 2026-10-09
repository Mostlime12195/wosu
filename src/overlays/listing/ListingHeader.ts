import { Container, FillGradient, Graphics, type Text, type Texture } from 'pixi.js';
import { Signal } from '../../core/Signal';
import { tween } from '../../core/Tweener';
import type { ProviderId } from '../../online/providers';
import { fillCover } from '../../ui/coverFill';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { Colors, type ColorProvider } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import {
    genreChoices,
    languageChoices,
    STATUSES,
    supportsGenreFilter,
    TABS,
    type ListingQuery,
    type ListingTab,
    type StatusChoice,
} from './ListingPager';
import { TabStrip, type TabStripStyle } from './TabStrip';

const TITLE_H = 64;
const TABS_H = 40;
const SEARCH_H = 44;
const ROW_H = 26;
const LABEL_W = 96;
/** Keystrokes settle for this long before a search runs. */
const DEBOUNCE_MS = 450;

let coverShade: FillGradient | null = null;
/** Darkens the search area's cover more toward the bottom. */
function shadeGradient(): FillGradient {
    coverShade ??= new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0.55)' },
            { offset: 1, color: 'rgba(0,0,0,0.85)' },
        ],
        textureSpace: 'local',
    });
    return coverShade;
}

/** Caption + filter tabs (lazer's BeatmapSearchFilterRow). */
class FilterRow<T> extends Container {
    readonly caption: Text;
    readonly tabs: TabStrip<T>;

    constructor(caption: string, strip: TabStrip<T>, colors: ColorProvider) {
        super();
        this.caption = label(caption, { size: 13, weight: '700', color: colors.light1 });
        this.tabs = strip;
        this.addChild(this.caption, strip);
    }

    /** Lay out at `width`; returns the height used. */
    layout(width: number): number {
        const h = this.tabs.measure(width - LABEL_W);
        this.caption.position.set(0, Math.round((ROW_H - this.caption.height) / 2));
        this.tabs.position.set(LABEL_W, 0);
        this.tabs.resize(width - LABEL_W, h);
        return h;
    }
}

export type QueryPatch = Partial<ListingQuery>;

/**
 * Top of the beatmap listing (lazer's BeatmapListingOverlay header and
 * BeatmapListingSearchControl): title, category tabs, then a search box
 * and filter rows over the first result's cover. Emits query patches;
 * the overlay owns the actual query.
 */
export class ListingHeader extends UIComponent {
    readonly patched = new Signal<[patch: QueryPatch]>();
    readonly search: TextBox;
    private readonly titleBg = new Graphics();
    private readonly tabsBg = new Graphics();
    private readonly searchBg = new Graphics();
    private readonly cover = new Graphics();
    private readonly titleIcon: Text;
    private readonly titleText: Text;
    private readonly tabs: TabStrip<ListingTab>;
    private readonly status: FilterRow<StatusChoice>;
    private readonly genre: FilterRow<number>;
    private readonly lang: FilterRow<number>;
    private readonly hint: Text;
    private coverTex: Texture | null = null;
    private debounce: ReturnType<typeof setTimeout> | null = null;
    private provider: ProviderId | null = null;
    private tab: ListingTab = 'latest';
    pad = 50;

    constructor(private readonly colors: ColorProvider, query: ListingQuery) {
        super();
        this.titleIcon = icon('download', 22, colors.highlight1);
        this.titleText = label('beatmap listing', { size: 26, weight: '300' });
        this.titleText.anchor.set(0, 0.5);
        this.tabs = new TabStrip(TABS, query.tab, {
            size: 15, weight: '600', gap: 26, rowHeight: TABS_H,
            idle: colors.light3, hover: colors.content2, active: 0xffffff,
            bar: { color: colors.highlight1, height: 3 },
        });
        this.search = new TextBox({
            placeholder: 'type in keywords or a beatmap set id…',
            icon: 'search', fontSize: 18, color: colors.background6, alpha: 0.85,
            accent: colors.highlight1, keepFocusOnCommit: true, maxLength: 120,
        });
        this.search.setValue(query.keyword, false);
        const filter = (): TabStripStyle => ({
            size: 13, weight: '600', gap: 16, rowHeight: ROW_H,
            idle: colors.light3, hover: colors.content2, active: colors.highlight1,
        });
        this.status = new FilterRow('Status', new TabStrip(STATUSES, query.status, filter()), colors);
        this.genre = new FilterRow('Genre', new TabStrip(genreChoices('sayobot'), query.genre, filter()), colors);
        this.lang = new FilterRow('Language', new TabStrip(languageChoices('sayobot'), query.lang, filter()), colors);
        this.hint = label('', { size: 12, weight: '500', color: colors.light4 });
        this.addChild(this.titleBg, this.tabsBg, this.searchBg, this.cover, this.titleIcon, this.titleText, this.tabs,
            this.search, this.status, this.genre, this.lang, this.hint);
        this.eventMode = 'passive';

        this.tabs.changed.add(tab => this.patched.emit(tab === 'search' ? { tab, keyword: this.search.value.trim() } : { tab, keyword: '' }));
        this.status.tabs.changed.add(status => this.patched.emit({ status }));
        this.genre.tabs.changed.add(genre => this.patched.emit({ genre }));
        this.lang.tabs.changed.add(lang => this.patched.emit({ lang }));
        this.search.changed.add(() => this.queueSearch());
        this.search.committed.add(() => this.commitSearch());
        this.tab = query.tab;
    }

    /** Mirror a query applied by the overlay (tab switch, search(), provider change). */
    setQuery(q: ListingQuery, provider: ProviderId): void {
        if (provider !== this.provider) {
            this.provider = provider;
            this.genre.tabs.setChoices(genreChoices(provider), q.genre);
            this.lang.tabs.setChoices(languageChoices(provider), q.lang);
        }
        this.tabs.value = q.tab;
        this.status.tabs.value = q.status;
        this.genre.tabs.value = q.genre;
        this.lang.tabs.value = q.lang;
        if (!this.search.isFocused && this.search.value !== q.keyword) this.search.setValue(q.keyword, false);
        if (q.tab !== this.tab) {
            this.tab = q.tab;
            this.relayout();
        }
    }

    private queueSearch(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.commitSearch(), DEBOUNCE_MS);
    }

    private commitSearch(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = null;
        const keyword = this.search.value.trim();
        this.patched.emit(keyword ? { tab: 'search', keyword } : { keyword: '' });
    }

    /** Backdrop of the search area: the first result's cover. */
    setCover(tex: Texture | null): void {
        if (tex === this.coverTex) return;
        this.coverTex = tex;
        this.drawCover();
        if (tex) {
            this.cover.alpha = 0;
            tween(this.cover, { alpha: 1 }, { duration: 600 });
        }
    }

    private drawCover(): void {
        const g = this.cover.clear();
        const y = TITLE_H + TABS_H;
        const h = this._h - y;
        if (!this.coverTex || h <= 0) return;
        fillCover(g, this.coverTex, 0, y, this._w, h, 0, { alignY: 0.35 });
        g.rect(0, y, this._w, h).fill(shadeGradient());
    }

    /** Height for `width` (filter rows wrap and some hide per tab). */
    preferredHeight(width: number): number {
        const inner = width - this.pad * 2;
        let h = TITLE_H + TABS_H + 20 + SEARCH_H + 14;
        h += this.status.tabs.measure(inner - LABEL_W) + 4;
        if (supportsGenreFilter(this.tab)) {
            h += this.genre.tabs.measure(inner - LABEL_W) + 4;
            h += this.lang.tabs.measure(inner - LABEL_W) + 4;
        } else {
            h += 20;
        }
        return h + 14;
    }

    protected override onResize(w: number, h: number): void {
        const pad = this.pad;
        const inner = w - pad * 2;
        this.titleBg.clear().rect(0, 0, w, TITLE_H).fill(this.colors.background4);
        this.tabsBg.clear().rect(0, TITLE_H, w, TABS_H).fill(this.colors.background5);
        this.searchBg.clear().rect(0, TITLE_H + TABS_H, w, h - TITLE_H - TABS_H).fill(this.colors.background6);
        this.titleIcon.position.set(pad + 12, TITLE_H / 2);
        this.titleText.position.set(pad + 34, TITLE_H / 2);
        this.tabs.position.set(pad, TITLE_H);
        this.tabs.resize(inner, TABS_H);
        let y = TITLE_H + TABS_H + 20;
        this.search.position.set(pad, y);
        this.search.resize(inner, SEARCH_H);
        y += SEARCH_H + 14;
        this.status.position.set(pad, y);
        y += this.status.layout(inner) + 4;
        const genres = supportsGenreFilter(this.tab);
        this.genre.visible = this.lang.visible = genres;
        this.hint.visible = !genres;
        if (genres) {
            this.genre.position.set(pad, y);
            y += this.genre.layout(inner) + 4;
            this.lang.position.set(pad, y);
            this.lang.layout(inner);
        } else {
            this.hint.text = this.tab === 'favourites'
                ? 'Your favourites are kept in this browser. Use the heart on any beatmap to add it here.'
                : 'Genre and language filters apply to latest, popular and random.';
            this.hint.position.set(pad + LABEL_W, y + 2);
            this.hint.tint = Colors.white;
        }
        this.drawCover();
    }
}
