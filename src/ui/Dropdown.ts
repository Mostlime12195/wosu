import { Container, Graphics, Rectangle, type Text } from 'pixi.js';
import type { Bindable } from '../core/Bindable';
import { tween } from '../core/Tweener';
import { Box } from './Box';
import { icon } from './icons';
import { label, fitText } from './text';
import { Colors } from './theme';
import { UIComponent } from './UIComponent';
import { ui, uiSounds } from './UIContext';
import { ScrollContainer } from './ScrollContainer';
import { drawSheared, shearedHitArea } from './ShearedButton';

export interface DropdownItem<T> {
    value: T;
    label: string;
}

export interface DropdownOptions {
    /**
     * lazer's ShearedDropdown: lean (horizontal offset per pixel of height,
     * e.g. SHEAR) for a parallelogram header and menu. The menu continues
     * the header's slanted edges, its rows step along the slant and its
     * scrollbar leans with it. 0 (default) is the plain rounded dropdown.
     */
    shear?: number;
}

const ROW_H = 32;
const MENU_PAD = 4;
const MENU_GAP = 4;

/**
 * osu!lazer's OsuDropdown: a header showing the current value; clicking
 * opens a menu in the popup layer (so scroll masks never clip it).
 */
export class Dropdown<T> extends UIComponent {
    /** Plain look: a rounded box. */
    private readonly header: Box | null = null;
    /** Sheared look: a parallelogram (fill + hover border). */
    private readonly shBg: Graphics | null = null;
    private readonly shBorder: Graphics | null = null;
    private readonly shear: number;
    private readonly valueText: Text;
    private readonly chevron: Text;
    private menu: DropdownMenu<T> | null = null;
    static popupHook: { open(menu: UIComponent, close: () => void): void; close(menu: UIComponent): void } | null = null;

    constructor(
        private items: DropdownItem<T>[],
        private readonly bindable: Bindable<T>,
        private readonly accent: number = Colors.pink,
        opts: DropdownOptions = {},
    ) {
        super();
        this.shear = opts.shear ?? 0;
        this.valueText = label('', { size: 14, weight: '600' });
        this.valueText.anchor.set(0, 0.5);
        this.chevron = icon('chevronDown', 11, 0xffffff);
        if (this.shear > 0) {
            this.shBg = new Graphics();
            this.shBg.tint = 0x000000;
            this.shBg.alpha = 0.5;
            this.shBorder = new Graphics();
            this.shBorder.alpha = 0;
            this.addChild(this.shBg, this.shBorder, this.valueText, this.chevron);
        } else {
            this.header = new Box({ color: 0x000000, alpha: 0.5, radius: 5 });
            this.addChild(this.header, this.valueText, this.chevron);
        }
        // Opening/closing have their own sounds.
        this.makeInteractive({ selectSample: null });
        this.disposer.add(bindable.bind(() => this.refresh(), true));
        this.resize(200, 36);
    }

    setItems(items: DropdownItem<T>[]): void {
        this.items = items;
        this.refresh();
    }

    private currentLabel(): string {
        return this.items.find(i => Object.is(i.value, this.bindable.value))?.label ?? String(this.bindable.value);
    }

    private refresh(): void {
        fitText(this.valueText, this._w - 40 - this._h * this.shear, this.currentLabel());
    }

    protected override updateHitArea(): void {
        if (this.shear > 0) this.hitArea = shearedHitArea(this._w, this._h, this._h * this.shear);
        else super.updateHitArea();
    }

    protected override onResize(w: number, h: number): void {
        // Text sits at mid-height, where the slanted edges are half the lean in.
        const lean = h * this.shear;
        if (this.shBg && this.shBorder) {
            drawSheared(this.shBg.clear(), 0, 0, w, h, 5, lean).fill(0xffffff);
            drawSheared(this.shBorder.clear(), 1, 1, w - 2, h - 2, 4, (h - 2) * this.shear).stroke({ width: 2, color: this.accent, alpha: 0.6 });
        }
        this.header?.resize(w, h);
        this.valueText.position.set(lean / 2 + 12, h / 2);
        this.chevron.position.set(w - lean / 2 - 16, h / 2);
        this.refresh();
    }

    protected override onHoverChange(hovered: boolean): void {
        if (this.shBg && this.shBorder) {
            tween(this.shBg, { alpha: hovered ? 0.7 : 0.5 }, { duration: 200 });
            tween(this.shBorder, { alpha: hovered ? 1 : 0 }, { duration: 200 });
            return;
        }
        if (!this.header) return;
        tween(this.header.g, { alpha: hovered ? 0.7 : 0.5 }, { duration: 200 });
        this.header.setBorder(hovered ? { width: 2, color: this.accent, alpha: 0.6 } : undefined);
    }

    protected override onClick(): void {
        if (this.menu) {
            this.closeMenu();
            return;
        }
        uiSounds()?.play('UI/dropdown-open');
        const menu = new DropdownMenu(this.items, this.bindable.value, v => {
            this.bindable.value = v;
            this.closeMenu();
        }, this.accent, this.shear);
        const k = this.shear;
        const layer = ui().popupLayer;
        const vp = ui().viewport();
        // Work in header-local space, then convert (keeps any UI scale).
        let top = this._h + MENU_GAP;
        const bottomLimit = this.toLocal(layer.toGlobal({ x: 0, y: vp.height - 8 })).y;
        // Short screens: shrink to the space below (the list scrolls)
        // before resorting to overlapping the header.
        const menuH = Math.min(300, this.items.length * ROW_H + MENU_PAD * 2, Math.max(120, bottomLimit - top));
        if (top + menuH > bottomLimit) top = Math.max(-menuH - MENU_GAP, bottomLimit - menuH);
        // Sheared: the menu continues the header's slanted edges, so its
        // top-left corner sits on the header's left edge line, x = (h − y)·k,
        // and it is as wide inside as the header.
        const lean = menuH * k;
        const x = (this._h - top) * k - lean;
        menu.resize(this._w - this._h * k + lean, menuH);
        const local = layer.toLocal(this.toGlobal({ x, y: top }));
        menu.position.set(local.x, local.y);
        this.menu = menu;
        if (Dropdown.popupHook) Dropdown.popupHook.open(menu, () => this.closeMenu());
        else ui().popupLayer.addChild(menu);
        tween(this.chevron, { rotation: Math.PI }, { duration: 200 });
    }

    closeMenu(): void {
        const m = this.menu;
        if (!m) return;
        this.menu = null;
        uiSounds()?.play('UI/dropdown-close');
        tween(this.chevron, { rotation: 0 }, { duration: 200 });
        if (Dropdown.popupHook) Dropdown.popupHook.close(m);
        m.fadeOut(150).finished.then(() => m.destroy());
    }

    override destroy(options?: Parameters<UIComponent['destroy']>[0]): void {
        this.closeMenu();
        super.destroy(options);
    }
}

class DropdownMenu<T> extends UIComponent {
    private readonly bg = new Graphics();
    private readonly scroll: ScrollContainer;
    private readonly rows: { item: DropdownItem<T>; row: Container; hl: Graphics; text: Text }[] = [];

    constructor(items: DropdownItem<T>[], selected: T, onPick: (v: T) => void, accent: number, private readonly shear = 0) {
        super();
        this.scroll = new ScrollContainer({ shear });
        this.bg.tint = 0x1a1a1a;
        this.bg.alpha = 0.97;
        this.addChild(this.bg, this.scroll);
        this.eventMode = 'static';
        for (const item of items) {
            const row = new Container();
            row.eventMode = 'static';
            row.cursor = 'pointer';
            const hl = new Graphics();
            hl.alpha = 0;
            const text = label(item.label, { size: 14, weight: Object.is(item.value, selected) ? '700' : '500', color: Object.is(item.value, selected) ? accent : 0xffffff });
            text.anchor.set(0, 0.5);
            row.addChild(hl, text);
            row.on('pointerover', () => tween(hl, { alpha: 0.12 }, { duration: 100 }));
            row.on('pointerout', () => tween(hl, { alpha: 0 }, { duration: 300 }));
            row.on('pointertap', () => onPick(item.value));
            this.scroll.content.addChild(row);
            this.rows.push({ item, row, hl, text });
        }
        // Sheared rows step along the slant as they scroll.
        if (shear > 0) this.scroll.scrolled.add(() => this.slantRows());
        this.alpha = 0;
        this.fadeIn(150);
    }

    protected override onResize(w: number, h: number): void {
        const k = this.shear;
        // Clicks beside the slanted edges fall through (and close the menu).
        this.hitArea = k > 0 ? shearedHitArea(w, h, h * k) : new Rectangle(0, 0, w, h);
        if (k > 0) drawSheared(this.bg.clear(), 0, 0, w, h, 6, h * k).fill(0xffffff);
        else this.bg.clear().roundRect(0, 0, w, h, 5).fill(0xffffff);
        // The scroll viewport is the same parallelogram, inset vertically:
        // shifting it right by pad·k keeps its slanted edges on the menu's.
        const sh = h - MENU_PAD * 2;
        const sw = w - MENU_PAD * 2 * k;
        this.scroll.position.set(MENU_PAD * k, MENU_PAD);
        this.scroll.resize(sw, sh);
        // Rows are as wide inside as the viewport, plus their own lean.
        const inner = sw - sh * k;
        const rowW = inner + ROW_H * k;
        const rowLean = ROW_H * k;
        let y = 0;
        for (const r of this.rows) {
            r.row.position.set(0, y);
            if (k > 0) {
                r.row.hitArea = shearedHitArea(rowW, ROW_H, rowLean);
                // Highlight inset 4px from both slanted edges.
                drawSheared(r.hl.clear(), 4, 1, rowW - 8, ROW_H - 2, 4, (ROW_H - 2) * k).fill(0xffffff);
            } else {
                r.row.hitArea = new Rectangle(0, 0, w, ROW_H);
                r.hl.clear().roundRect(4, 1, w - 8, ROW_H - 2, 4).fill(0xffffff);
            }
            r.text.position.set(14 + rowLean / 2, ROW_H / 2);
            fitText(r.text, inner - 28, r.item.label);
            y += ROW_H;
        }
        this.scroll.contentHeight = y;
        this.slantRows();
    }

    /** Put each row's left edge on the viewport's slanted left edge, x = (H − y)·k. */
    private slantRows(): void {
        const k = this.shear;
        if (k <= 0) return;
        const H = this.scroll.h;
        const off = this.scroll.content.y;
        for (const r of this.rows) r.row.x = (H - (r.row.y + off + ROW_H)) * k;
    }
}
