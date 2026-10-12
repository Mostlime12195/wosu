import { Container, Graphics, Rectangle, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import type { BeatmapCollection } from '../../beatmap/collections';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { collections } from '../../storage/Collections';
import { IconButton } from '../../ui/Button';
import { icon } from '../../ui/icons';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { fitText, label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { Colors } from '../../ui/theme';
import { UIComponent, tweenTint } from '../../ui/UIComponent';

// lazer's OsuColour.GreySeaFoam* (ManageCollectionsDialog / DrawableCollectionListItem).
const SEAFOAM_DARK = 0x2c3532;
const SEAFOAM_DARKER = 0x1e2422;
const ITEM_H = 45;
const BUTTON_W = ITEM_H * 0.75;
const GAP = 6;

export interface ManageCollectionsOptions {
    /**
     * Opened from a context menu's "New collection…": focus the new
     * collection box; these difficulties join the collection created.
     */
    addOnCreate?: { keys: string[]; label: string };
}

/** lazer's DeleteButton: red slab with a trash icon at the row's right end. */
class DeleteButton extends UIComponent {
    private readonly bg = new Graphics();
    private readonly glyph: Text;

    constructor() {
        super();
        this.glyph = icon('trash', 13, 0xffffff);
        this.bg.tint = Colors.red;
        this.addChild(this.bg, this.glyph);
        this.makeInteractive({ sounds: 'button' });
        this.resize(BUTTON_W, ITEM_H);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().roundRect(0, 0, w, h, 10).fill(0xffffff);
        this.glyph.position.set(w / 2, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        tweenTint(this.bg, hovered ? 0xff4455 : Colors.red, 150);
    }
}

/** One collection: its name in an editable box (rename in place), item count, delete. */
class CollectionRow extends UIComponent {
    readonly box: TextBox;
    private readonly countText: Text;
    readonly remove: DeleteButton | null;

    constructor(readonly collection: BeatmapCollection | null) {
        super();
        this.box = new TextBox({
            placeholder: collection ? '' : 'Create a new collection',
            color: collection ? lerpDark(SEAFOAM_DARKER) : SEAFOAM_DARKER,
            alpha: 1,
            fontSize: 16,
            maxLength: 100,
            accent: Colors.yellow,
        });
        this.countText = label('', { size: 11, weight: '600', color: Colors.yellow });
        this.countText.anchor.set(1, 0.5);
        this.remove = collection ? new DeleteButton() : null;
        this.addChild(this.box, this.countText);
        if (this.remove) this.addChild(this.remove);
        if (collection) this.box.setValue(collection.name, false);
        this.eventMode = 'passive';
        this.refresh();
    }

    refresh(): void {
        const c = this.collection;
        this.countText.visible = !!c;
        if (c) {
            this.countText.text = `${c.items.length} item${c.items.length === 1 ? '' : 's'}`;
            if (!this.box.isFocused) this.box.setValue(c.name, false);
        }
    }

    protected override onResize(w: number, h: number): void {
        const boxW = this.remove ? w - BUTTON_W - GAP : w;
        this.box.resize(boxW, h);
        this.countText.position.set(boxW - 14, h / 2);
        this.remove?.position.set(w - BUTTON_W, 0);
    }
}

function lerpDark(c: number): number {
    // GreySeaFoamDarker.Darken(0.5): every channel ÷ 1.5.
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    return (Math.round(r / 1.5) << 16) | (Math.round(g / 1.5) << 8) | Math.round(b / 1.5);
}

/**
 * osu!lazer's ManageCollectionsDialog: a centred sea-foam card listing
 * every collection as a rename-in-place text box with its item count
 * and a delete button, plus a "Create a new collection" box at the
 * bottom. Deleting a non-empty collection asks first.
 */
export class ManageCollectionsDialog extends Overlay {
    override readonly exclusive = false;
    private readonly card = new Container();
    private readonly cardBg = new Graphics();
    private readonly inner = new Graphics();
    private readonly title: Text;
    private readonly closeButton: IconButton;
    private readonly scroll = new ScrollContainer();
    private readonly newRow = new CollectionRow(null);
    private readonly emptyText: Text;
    private rows: CollectionRow[] = [];
    private cardW = 0;
    private cardH = 0;
    private pendingAdd: ManageCollectionsOptions['addOnCreate'] | null = null;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.5;
        this.title = label('Manage collections', { size: 26, weight: '500' });
        this.title.anchor.set(0.5);
        this.closeButton = new IconButton('close', { size: 34, color: 0xffffff });
        this.closeButton.onActivate = () => this.hide();
        this.emptyText = label('No collections yet. Name one below to create it.', { size: 14, weight: '500', color: Colors.grayA });
        this.emptyText.anchor.set(0.5, 0);
        this.card.eventMode = 'static';
        this.card.addChild(this.cardBg, this.inner, this.title, this.closeButton, this.scroll, this.emptyText, this.newRow);
        this.addChild(this.card);
        this.newRow.box.committed.add(v => this.createFrom(v));
        const store = collections();
        this.disposer.add(store.changed.add(() => {
            if (this.visible) this.sync();
        }));
    }

    open(opts: ManageCollectionsOptions = {}): void {
        this.pendingAdd = opts.addOnCreate ?? null;
        this.newRow.box.setValue('', false);
        this.sync();
        this.show();
        if (this.pendingAdd) this.newRow.box.focus();
    }

    /** Rebuild rows to match the store (keeps rows, and their focus, where it can). */
    private sync(): void {
        const list = collections().all;
        const keep = new Map(this.rows.map(r => [r.collection!.id, r]));
        const next: CollectionRow[] = [];
        for (const c of list) {
            let row = keep.get(c.id);
            if (row && row.collection !== c) row = undefined;
            if (row) {
                keep.delete(c.id);
            } else {
                row = this.createRow(c);
            }
            row.refresh();
            next.push(row);
        }
        for (const r of keep.values()) r.destroy({ children: true });
        this.rows = next;
        this.layoutRows();
    }

    private createRow(c: BeatmapCollection): CollectionRow {
        const row = new CollectionRow(c);
        // lazer renames as you type; an emptied name snaps back on blur.
        row.box.changed.add(v => {
            if (v.trim()) collections().rename(c.id, v);
        });
        row.box.focusChanged.add(f => {
            if (!f) row.refresh();
        });
        row.box.committed.add(() => row.box.blur());
        if (row.remove) row.remove.onActivate = () => void this.deleteCollection(c);
        this.scroll.content.addChild(row);
        return row;
    }

    private async deleteCollection(c: BeatmapCollection): Promise<void> {
        if (c.items.length > 0) {
            const ok = await this.game.dialog.confirm({
                title: 'Confirm deletion of',
                text: `${c.name} (${c.items.length} beatmap${c.items.length === 1 ? '' : 's'})`,
                confirmText: 'Yes, delete it',
                cancelText: 'No, keep it',
                danger: true,
                icon: 'trash',
            });
            if (!ok) return;
        }
        collections().remove(c.id);
    }

    private createFrom(value: string): void {
        const pending = this.pendingAdd;
        const c = collections().create(value, pending?.keys ?? []);
        if (!c) return;
        this.newRow.box.setValue('', false);
        if (pending) {
            this.pendingAdd = null;
            this.game.notifications.success(`Added ${pending.label} to "${c.name}"`);
            this.hide();
            return;
        }
        // Keep typing more names, like lazer's always-present new entry.
        this.newRow.box.focus();
        const row = this.rows.find(r => r.collection?.id === c.id);
        if (row) this.scroll.scrollIntoView(row.y, row.y + ITEM_H, 10);
    }

    private layoutRows(): void {
        const w = this.scroll.w;
        let y = 0;
        for (const r of this.rows) {
            r.position.set(0, y);
            r.resize(w, ITEM_H);
            y += ITEM_H + GAP;
        }
        this.scroll.contentHeight = Math.max(0, y - GAP);
        this.emptyText.visible = this.rows.length === 0;
    }

    protected layout(w: number, h: number): void {
        this.cardW = Math.round(Math.min(Math.max(w * 0.5, Math.min(340, w - 24)), 640));
        this.cardH = Math.round(Math.min(h * 0.8, 620));
        const cw = this.cardW, ch = this.cardH;
        this.card.pivot.set(cw / 2, ch / 2);
        this.card.position.set(w / 2, h / 2);
        this.card.hitArea = new Rectangle(0, 0, cw, ch);
        this.cardBg.clear().roundRect(0, 0, cw, ch, 10).fill(SEAFOAM_DARK);
        const headerH = 56;
        this.inner.clear().roundRect(0, headerH, cw, ch - headerH, 10).fill(SEAFOAM_DARKER).rect(0, headerH, cw, 10).fill(SEAFOAM_DARKER);
        this.title.position.set(cw / 2, headerH / 2);
        fitText(this.title, cw - 120, 'Manage collections');
        this.closeButton.position.set(cw - 10 - this.closeButton.w, (headerH - this.closeButton.h) / 2);
        const pad = 10;
        const listTop = headerH + pad;
        const newY = ch - pad - ITEM_H;
        this.scroll.position.set(pad, listTop);
        this.scroll.resize(cw - pad * 2, Math.max(0, newY - pad - listTop));
        this.emptyText.position.set(cw / 2, listTop + 20);
        this.newRow.position.set(pad, newY);
        this.newRow.resize(cw - pad * 2, ITEM_H);
        this.layoutRows();
    }

    protected popIn(): void {
        this.card.scale.set(0.9);
        this.card.alpha = 0;
        tween(this.card, { scale: 1, alpha: 1 }, { duration: 400, ease: 'OutQuint' });
    }

    protected async popOut(): Promise<void> {
        for (const r of [...this.rows, this.newRow]) r.box.blur();
        this.pendingAdd = null;
        await tween(this.card, { scale: 0.95, alpha: 0 }, { duration: 200, ease: 'OutQuint' }).finished;
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (super.onKey(e, action)) return true;
        // Modal: keep type-to-search and hotkeys from reaching song select.
        return true;
    }
}
