import { Container, Graphics, Rectangle, type Text } from 'pixi.js';
import { delay, tween, tweener, type Tween } from '../core/Tweener';
import { Dropdown } from './Dropdown';
import { icon, Icons } from './icons';
import { ScrollContainer } from './ScrollContainer';
import { fitText, label } from './text';
import { UIComponent } from './UIComponent';
import { ui, uiSounds } from './UIContext';

/** lazer's MenuItemType: text colour of an item. */
export type MenuItemType = 'standard' | 'highlighted' | 'destructive';

/** lazer's TernaryState (true / false / indeterminate). */
export type MenuItemState = boolean | 'indeterminate';

export interface MenuAction {
    text: string;
    type?: MenuItemType;
    /** Run on click; the menu closes first. */
    action?: () => void;
    /** Sub-menu (lazer: opens to the side on hover or click). */
    items?: MenuEntry[];
    /**
     * Stateful item (lazer's ToggleMenuItem / TernaryStateToggleMenuItem):
     * shows a check (or a dot when indeterminate); clicking flips it to
     * true (false when it was true) and keeps the menu open.
     */
    state?: MenuItemState;
    onToggle?: (next: boolean) => void;
    disabled?: boolean;
}

/** lazer's OsuMenuItemSpacer. */
export const MENU_SPACER = 'spacer' as const;
export type MenuEntry = MenuAction | typeof MENU_SPACER;

// osu!lazer's OsuContextMenu / DrawableOsuMenuItem metrics and colours.
const BG = 0x223034; // OsuColour.ContextMenuGray
const HOVER = 0x172023; // DrawableOsuMenuItem.BackgroundColourHover
const RED1 = 0xff6666; // OsuColour.Red1 (destructive)
const YELLOW = 0xffcc22; // highlighted
const TEXT_SIZE = 15;
const MARGIN_H = 10;
const MARGIN_V = 4;
const ROW_H = TEXT_SIZE + 2 * MARGIN_V + 6;
const SPACER_H = Math.round(ROW_H * 0.6);
const RADIUS = 5;
const MAX_HEIGHT = 340;
const MIN_WIDTH = 150;
const MAX_TEXT = 320;
const FADE = 280;
const CLOSE_DELAY = 50;
/** osu-framework opens sub-menus after hovering this long. */
const HOVER_OPEN_DELAY = 100;
const EDGE = 4;

function textColor(type: MenuItemType | undefined): number {
    return type === 'destructive' ? RED1 : type === 'highlighted' ? YELLOW : 0xffffff;
}

/** lazer's TernaryStateToggleMenuItem: anything but true becomes true. */
export function nextToggleState(s: MenuItemState | undefined): boolean {
    return s !== true;
}

class MenuRow extends UIComponent {
    private readonly hl = new Graphics();
    private readonly normal: Text;
    private readonly bold: Text;
    private readonly check: Text | null = null;
    private readonly chevron: Text | null = null;
    private hoverTimer: Tween | null = null;
    /** Natural content width (bold text + decorations). */
    readonly naturalWidth: number;

    constructor(readonly item: MenuAction, private readonly panel: MenuPanel, showCheck: boolean) {
        super();
        const color = textColor(item.type);
        this.normal = label(item.text, { size: TEXT_SIZE, weight: '500', color });
        this.bold = label(item.text, { size: TEXT_SIZE, weight: '700', color });
        for (const t of [this.normal, this.bold]) t.anchor.set(0, 0.5);
        this.bold.alpha = 0;
        this.hl.alpha = 0;
        this.addChild(this.hl, this.normal, this.bold);
        if (showCheck) {
            this.check = icon('check', 10, 0xffffff);
            this.addChild(this.check);
        }
        if (item.items) {
            this.chevron = icon('chevronRight', 8, 0xffffff);
            this.addChild(this.chevron);
        }
        this.naturalWidth = this.textLeft + Math.min(MAX_TEXT, this.bold.width) + MARGIN_H + (this.chevron ? 28 : 0);
        this.makeInteractive({ sounds: 'default', selectSample: item.items ? null : undefined });
        this.enabled = !item.disabled;
        this.alpha = item.disabled ? 0.2 : 1;
        this.syncState();
    }

    private get textLeft(): number {
        return MARGIN_H + (this.check ? MARGIN_H + 10 : 0);
    }

    syncState(): void {
        const c = this.check;
        if (!c) return;
        const s = this.item.state;
        // lazer: check for true, a dot for indeterminate, nothing for false.
        c.text = s === 'indeterminate' ? Icons.circle : Icons.check;
        c.scale.set(s === 'indeterminate' ? 0.6 : 1);
        c.visible = s === true || s === 'indeterminate';
    }

    protected override onResize(w: number, h: number): void {
        this.hl.clear().rect(0, 0, w, h).fill(HOVER);
        const tl = this.textLeft;
        const maxText = w - tl - MARGIN_H - (this.chevron ? 28 : 0);
        fitText(this.normal, maxText, this.item.text);
        fitText(this.bold, maxText, this.item.text);
        this.normal.position.set(tl, h / 2);
        this.bold.position.set(tl, h / 2);
        this.check?.position.set(MARGIN_H + 5, h / 2);
        this.chevron?.position.set(w - MARGIN_H - 4, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        // lazer: the hovered item turns bold over a darker background.
        tween(this.hl, { alpha: hovered ? 1 : 0 }, { duration: 80 });
        tween(this.bold, { alpha: hovered ? 1 : 0 }, { duration: 80 });
        tween(this.normal, { alpha: hovered ? 0 : 1 }, { duration: 80 });
        this.hoverTimer?.cancel();
        this.hoverTimer = null;
        if (hovered) this.hoverTimer = delay(HOVER_OPEN_DELAY, () => this.panel.hoverSettled(this), this);
    }

    protected override onClick(): void {
        this.panel.activateRow(this);
    }

    /** Persistent highlight while this row's sub-menu is open. */
    set open(v: boolean) {
        if (!this.hovered) tween(this.hl, { alpha: v ? 1 : 0 }, { duration: 80 });
    }
}

class SpacerRow extends Container {
    private readonly line = new Graphics();
    constructor() {
        super();
        this.addChild(this.line);
    }
    layout(w: number): void {
        this.line.clear().rect(w * 0.05, SPACER_H / 2 - 1, w * 0.9, 2).fill(HOVER);
    }
}

/** One vertical menu (the root or a sub-menu). */
class MenuPanel extends UIComponent {
    private readonly bg = new Graphics();
    private readonly shadow = new Graphics();
    private readonly scroll = new ScrollContainer();
    private readonly rows: (MenuRow | SpacerRow)[] = [];
    private readonly fullH: number;
    private readonly panelW: number;
    private shownH = 0;
    child: MenuPanel | null = null;
    private childRow: MenuRow | null = null;

    constructor(private readonly root: ContextMenu, entries: MenuEntry[], readonly depth: number) {
        super();
        this.addChild(this.shadow, this.bg, this.scroll);
        this.eventMode = 'static';
        // lazer's OsuMenu shows the checkbox column when any item is stateful.
        const showCheck = entries.some(e => e !== MENU_SPACER && e.state !== undefined);
        let y = MARGIN_V;
        let w = MIN_WIDTH;
        for (const e of entries) {
            if (e === MENU_SPACER) {
                const s = new SpacerRow();
                s.y = y;
                y += SPACER_H;
                this.rows.push(s);
                this.scroll.content.addChild(s);
                continue;
            }
            const r = new MenuRow(e, this, showCheck);
            r.y = y;
            y += ROW_H;
            w = Math.max(w, r.naturalWidth);
            this.rows.push(r);
            this.scroll.content.addChild(r);
        }
        y += MARGIN_V;
        this.panelW = Math.ceil(w);
        this.fullH = Math.min(MAX_HEIGHT, y);
        this.scroll.contentHeight = y;
        for (const r of this.rows) {
            if (r instanceof MenuRow) r.resize(this.panelW, ROW_H);
            else r.layout(this.panelW);
        }
        this._w = this.panelW;
        this._h = this.fullH;
        this.hitArea = new Rectangle(0, 0, this.panelW, 0);
        this.setShownHeight(0);
    }

    get fullHeight(): number {
        return this.fullH;
    }

    /** lazer's OsuMenu.AnimateOpen: fade in while the height grows. */
    animateOpen(): void {
        this.alpha = 0;
        tween(this, { alpha: 1 }, { duration: FADE, ease: 'OutQuint' });
        const proxy = { h: 0 };
        tween(proxy, { h: this.fullH }, {
            duration: 300,
            ease: 'OutQuint',
            owner: this,
            onUpdate: () => this.setShownHeight(proxy.h),
        });
    }

    private setShownHeight(h: number): void {
        this.shownH = h;
        const w = this.panelW;
        this.bg.clear().roundRect(0, 0, w, Math.max(1, h), RADIUS).fill(BG);
        this.shadow.clear();
        // lazer's EdgeEffect: a faint 4px black shadow.
        for (let i = 1; i <= 2; i++) this.shadow.roundRect(-i * 2, -i * 2 + 1, w + i * 4, h + i * 4, RADIUS + i * 2).fill({ color: 0x000000, alpha: 0.06 });
        this.scroll.resize(w, Math.max(0, h));
        (this.hitArea as Rectangle).height = h;
    }

    hoverSettled(row: MenuRow): void {
        if (this.destroyed || !row.hovered) return;
        if (row.item.items) {
            if (this.childRow !== row) this.openChild(row);
        } else {
            this.closeChild();
        }
    }

    activateRow(row: MenuRow): void {
        const item = row.item;
        if (item.items) {
            if (this.childRow !== row) this.openChild(row);
            return;
        }
        if (item.state !== undefined) {
            const next = nextToggleState(item.state);
            item.state = next;
            row.syncState();
            item.onToggle?.(next);
            return;
        }
        this.root.close();
        item.action?.();
    }

    private openChild(row: MenuRow): void {
        this.closeChild();
        const items = row.item.items;
        if (!items?.length) return;
        const child = new MenuPanel(this.root, items, this.depth + 1);
        this.child = child;
        this.childRow = row;
        row.open = true;
        this.root.placeSubmenu(this, child, row.y - this.scroll.scrollY);
        child.animateOpen();
    }

    closeChild(): void {
        const c = this.child;
        if (!c) return;
        c.closeChild();
        if (this.childRow && !this.childRow.destroyed) this.childRow.open = false;
        this.child = null;
        this.childRow = null;
        c.eventMode = 'none';
        tween(c, { alpha: 0 }, { duration: 150 }).finished.then(() => c.destroy());
    }

    get panelWidth(): number {
        return this.panelW;
    }

    get shownHeight(): number {
        return this.shownH;
    }
}

/**
 * osu!lazer's OsuContextMenu: a dark rounded menu at the pointer with
 * coloured items (yellow = highlighted, red = destructive), spacers,
 * check/ternary toggles and side sub-menus. One is open at a time; it
 * lives in the popup layer and closes on outside presses or Esc.
 */
export class ContextMenu extends UIComponent {
    private static current: ContextMenu | null = null;
    private readonly rootPanel: MenuPanel;
    private closed = false;
    /** Called once after the menu closed (any reason). */
    onClosed: (() => void) | null = null;

    /** Open a menu at a global (canvas) position, replacing any open one. */
    static open(entries: MenuEntry[], globalX: number, globalY: number): ContextMenu | null {
        ContextMenu.closeCurrent();
        if (!entries.length) return null;
        const menu = new ContextMenu(entries);
        ContextMenu.current = menu;
        const layer = ui().popupLayer;
        const p = layer.toLocal({ x: globalX, y: globalY });
        const vp = ui().viewport();
        const lt = layer.toLocal({ x: 0, y: 0 });
        const rb = layer.toLocal({ x: vp.width, y: vp.height });
        const w = menu.rootPanel.panelWidth, h = menu.rootPanel.fullHeight;
        // Keep the whole menu on screen (osu-framework clamps it into its container).
        const x = Math.max(lt.x + EDGE, Math.min(p.x, rb.x - w - EDGE));
        const y = Math.max(lt.y + EDGE, Math.min(p.y, rb.y - h - EDGE));
        menu.position.set(x, y);
        if (Dropdown.popupHook) Dropdown.popupHook.open(menu, () => menu.close());
        else layer.addChild(menu);
        uiSounds()?.play('UI/menu-open');
        menu.rootPanel.animateOpen();
        return menu;
    }

    /** Close whatever context menu is open. */
    static closeCurrent(): void {
        ContextMenu.current?.close();
    }

    static get isOpen(): boolean {
        return ContextMenu.current !== null;
    }

    private constructor(entries: MenuEntry[]) {
        super();
        this.eventMode = 'passive';
        this.rootPanel = new MenuPanel(this, entries, 0);
        this.addChild(this.rootPanel);
    }

    /** Sub-menus open beside their item (flipping left at the screen edge). */
    placeSubmenu(parent: MenuPanel, child: MenuPanel, rowY: number): void {
        this.addChild(child);
        // Pixi's global space is the logical viewport.
        const vp = ui().viewport();
        const lt = this.toLocal({ x: 0, y: 0 });
        const rb = this.toLocal({ x: vp.width, y: vp.height });
        let x = parent.x + parent.panelWidth;
        if (x + child.panelWidth > rb.x - EDGE) x = parent.x - child.panelWidth;
        x = Math.max(lt.x + EDGE, x);
        const y = Math.max(lt.y + EDGE, Math.min(parent.y + rowY, rb.y - child.fullHeight - EDGE));
        child.position.set(x, y);
        uiSounds()?.play('UI/menu-open', { volume: 0.5, throttle: 50 });
    }

    /** lazer's AnimateClose: short delay, then fade out. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (ContextMenu.current === this) ContextMenu.current = null;
        this.eventMode = 'none';
        if (Dropdown.popupHook) Dropdown.popupHook.close(this);
        uiSounds()?.play('UI/menu-close');
        tweener.kill(this);
        tween(this, { alpha: 0 }, { duration: FADE, delay: CLOSE_DELAY, ease: 'OutQuint' }).finished.then(() => this.destroy());
        this.onClosed?.();
    }

    get isClosed(): boolean {
        return this.closed;
    }
}
