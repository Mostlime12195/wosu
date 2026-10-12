import { Graphics, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Bindable } from '../../core/Bindable';
import { collections } from '../../storage/Collections';
import { formatNumber } from '../../core/math';
import type { SongSort } from '../../settings/Settings';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { SHEAR } from '../../ui/ShearedButton';
import { label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { EDGE_HIDE, WEDGE_RADIUS } from './visuals';

export const FILTER_HEIGHT = 96;

/** lazer's ManageCollectionsFilterMenuItem: never selected, opens the dialog. */
const MANAGE_ITEM = '\u0000manage';

const SORT_ITEMS: DropdownItem<SongSort>[] = [
    { value: 'title', label: 'Title' },
    { value: 'artist', label: 'Artist' },
    { value: 'creator', label: 'Author' },
    { value: 'difficulty', label: 'Difficulty' },
    { value: 'length', label: 'Length' },
    { value: 'bpm', label: 'BPM' },
    { value: 'dateAdded', label: 'Date Added' },
    { value: 'lastPlayed', label: 'Last Played' },
];

/**
 * Song select's search box. Plain ←/→ change beatmap sets (like lazer,
 * the carousel keeps them) instead of moving the caret; modified arrows
 * still edit text.
 */
export class SearchTextBox extends TextBox {
    onArrow: ((dir: -1 | 1) => void) | null = null;

    override onSpecialKey(e: KeyboardEvent): boolean {
        const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (plain && this.onArrow && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            this.onArrow(e.key === 'ArrowLeft' ? -1 : 1);
            return true;
        }
        return super.onSpecialKey(e);
    }
}

/**
 * lazer's FilterControl (top right of song select): search box, sort
 * dropdown bound to the setting, and how many beatmaps are shown.
 */
export class FilterControl extends UIComponent {
    readonly search: SearchTextBox;
    private readonly sort: Dropdown<SongSort>;
    /** lazer's CollectionDropdown: "All beatmaps", each collection, "Manage collections…". */
    private readonly collection: Dropdown<string>;
    private readonly collectionValue = new Bindable<string>('');
    /** Picked "Manage collections…" in the collection dropdown. */
    onManageCollections: (() => void) | null = null;
    private readonly bg = new Graphics();
    private readonly sortCaption: Text;
    private readonly count: Text;
    /**
     * Wide layout: pinned to the top-right corner, leaning left edge with
     * the global SHEAR (parallel to the info wedge's right edge) and only
     * the free bottom-left corner rounded. Narrow layout (below the
     * wedge, edge to edge): a plain band.
     */
    private fullWidth = false;

    constructor(game: Game) {
        super();
        this.search = new SearchTextBox({
            placeholder: 'type to search',
            icon: 'search',
            color: 0x000000,
            alpha: 0.55,
            keepFocusOnCommit: true,
            maxLength: 200,
            fontSize: 17,
        });
        this.sort = new Dropdown(SORT_ITEMS, game.settings.songSort, Colors.blue, { shear: SHEAR });
        const store = collections();
        this.collection = new Dropdown(this.collectionItems(), this.collectionValue, Colors.blue, { shear: SHEAR });
        this.disposer.add(store.filter.bind(v => (this.collectionValue.value = v), true));
        this.disposer.add(this.collectionValue.bind((v, prev) => {
            if (v === MANAGE_ITEM) {
                // Roll back like lazer, then open the dialog.
                this.collectionValue.value = prev === MANAGE_ITEM ? '' : prev;
                this.onManageCollections?.();
                return;
            }
            store.filter.value = v;
        }));
        this.disposer.add(store.changed.add(() => this.collection.setItems(this.collectionItems())));
        this.sortCaption = label('sort by', { size: 13, weight: '700', color: Colors.blueLight });
        this.sortCaption.anchor.set(0, 0.5);
        this.count = label('', { size: 13, weight: '600', color: Colors.grayC });
        this.count.anchor.set(1, 0.5);
        this.addChild(this.bg, this.search, this.sortCaption, this.sort, this.collection, this.count);
        // Clicks on the backdrop shouldn't fall through to the carousel.
        this.eventMode = 'static';
        this.resize(600, FILTER_HEIGHT);
    }

    /** Narrow screens: span the full width under the wedge instead of hanging from the top-right corner. */
    setFullWidth(v: boolean): void {
        if (v === this.fullWidth) return;
        this.fullWidth = v;
        this.relayout();
    }

    private collectionItems(): DropdownItem<string>[] {
        return [
            { value: '', label: 'All beatmaps' },
            ...collections().all.map(c => ({ value: c.id, label: c.name })),
            { value: MANAGE_ITEM, label: 'Manage collections…' },
        ];
    }

    /** Close the sort/collection menus (they live in the popup layer, above every screen). */
    closeMenus(): void {
        this.sort.closeMenu();
        this.collection.closeMenu();
    }

    /** `shown`: difficulties currently listed; `filtered`: a query is active. */
    setCount(shown: number, filtered: boolean): void {
        this.count.text = `${formatNumber(shown)} ${filtered ? (shown === 1 ? 'match' : 'matches') : shown === 1 ? 'beatmap' : 'beatmaps'}`;
    }

    protected override onResize(w: number, h: number): void {
        const skew = this.fullWidth ? 0 : h * SHEAR;
        const g = this.bg.clear();
        if (this.fullWidth) {
            g.rect(-EDGE_HIDE, 0, w + EDGE_HIDE * 2, h);
        } else {
            g.roundShape([
                { x: skew + EDGE_HIDE * SHEAR, y: -EDGE_HIDE, radius: 0 },
                { x: w + EDGE_HIDE, y: -EDGE_HIDE, radius: 0 },
                { x: w + EDGE_HIDE, y: h, radius: 0 },
                { x: 0, y: h, radius: WEDGE_RADIUS },
            ], 0);
        }
        g.fill({ color: 0x000000, alpha: 0.6 });
        this.hitArea = { contains: (x: number, y: number) => y >= 0 && y <= h && x >= skew * (1 - y / h) && x <= w };
        const left = this.fullWidth ? 16 : 24;
        const right = 20;
        this.search.position.set(left, 12);
        this.search.resize(w - left - right, 40);
        const rowY = 12 + 40 + 10 + 13;
        this.sortCaption.position.set(left + 2, rowY);
        this.sort.position.set(left + this.sortCaption.width + 10, rowY - 13);
        this.sort.resize(Math.min(180, Math.max(110, w * 0.27)), 26);
        // Collection dropdown fills what the count leaves (lazer puts it beside sort/group).
        const colX = this.sort.x + this.sort.w + 10;
        let colW = Math.min(220, w - right - Math.max(90, this.count.width) - 12 - colX);
        // Narrow: the filter matters more than the count.
        this.count.visible = colW >= 100;
        if (!this.count.visible) colW = Math.min(220, w - right - colX);
        this.collection.position.set(colX, rowY - 13);
        this.collection.resize(Math.max(80, colW), 26);
        this.count.position.set(w - right, rowY);
    }
}
