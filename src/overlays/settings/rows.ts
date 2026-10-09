import { Graphics, type Text } from 'pixi.js';
import type { Bindable, BindableNumber } from '../../core/Bindable';
import { tween } from '../../core/Tweener';
import { Box } from '../../ui/Box';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { icon, type IconName } from '../../ui/icons';
import { KeyBindButton } from '../../ui/KeyBindButton';
import { Slider } from '../../ui/Slider';
import { label, textStyle } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

/** Horizontal padding inside the settings content column. */
export const ROW_PAD = 20;

/** Anything with a default it can be reset to (any Bindable). */
interface Restorable {
    readonly isDefault: boolean;
    setDefault(): void;
    readonly changed: { add(fn: () => void): () => void };
}

/** Controls whose height depends on their width (wrapped text). */
interface Measurable {
    preferredHeight(width: number): number;
}

function isMeasurable(c: unknown): c is Measurable {
    return typeof (c as Measurable).preferredHeight === 'function';
}

export interface RowOptions {
    /** Extra search terms. */
    keywords?: string;
    description?: string;
    /** Row only exists while this is true (e.g. "restart required"). */
    visibleWhen?: Bindable<boolean>;
}

/**
 * One settings row: the control, an optional description, and lazer's
 * restore-default pill on the left that appears while the bound value
 * differs from its default (click to restore).
 */
export class SettingsRow extends UIComponent {
    readonly keywords: string;
    private readonly restore = new Graphics();
    private readonly desc: Text | null;
    private readonly visibleWhen: Bindable<boolean> | null;
    /** Set by the overlay when the search query hides this row. */
    filtered = false;
    /** Owner callback: this row's height or visibility changed. */
    onLayoutChange: (() => void) | null = null;
    /** The panel hid: drop transient control state (open dropdown menu, slider key focus). */
    onPanelHide: (() => void) | null = null;

    constructor(readonly control: UIComponent, keywords: string, private readonly bindable: Restorable | null, opts: RowOptions = {}) {
        super();
        this.keywords = `${keywords} ${opts.keywords ?? ''} ${opts.description ?? ''}`.toLowerCase();
        this.desc = opts.description ? label(opts.description, { size: 12, weight: '500', color: Colors.grayA, wrap: 300, lineHeight: 16 }) : null;
        this.visibleWhen = opts.visibleWhen ?? null;
        this.restore.alpha = 0;
        this.restore.eventMode = 'none';
        this.restore.cursor = 'pointer';
        this.restore.on('pointertap', () => this.bindable?.setDefault());
        this.restore.on('pointerover', () => tween(this.restore, { scaleX: 1.6 }, { duration: 200 }));
        this.restore.on('pointerout', () => tween(this.restore, { scaleX: 1 }, { duration: 200 }));
        this.addChild(this.restore, control);
        if (this.desc) this.addChild(this.desc);
        if (bindable) this.disposer.add(bindable.changed.add(() => this.updateRestore()));
        if (this.visibleWhen) this.disposer.add(this.visibleWhen.bind(() => this.onLayoutChange?.()));
        this.updateRestore(true);
    }

    get available(): boolean {
        return this.visibleWhen ? this.visibleWhen.value : true;
    }

    get shown(): boolean {
        return this.available && !this.filtered;
    }

    matches(query: string): boolean {
        return !query || this.keywords.includes(query);
    }

    private updateRestore(instant = false): void {
        const show = !!this.bindable && !this.bindable.isDefault;
        this.restore.eventMode = show ? 'static' : 'none';
        if (instant) this.restore.alpha = show ? 1 : 0;
        else tween(this.restore, { alpha: show ? 1 : 0 }, { duration: 200 });
    }

    /** Lay out for `width`; returns the height used. */
    measure(width: number): number {
        const cw = width - ROW_PAD * 2;
        const ch = isMeasurable(this.control) ? this.control.preferredHeight(cw) : this.control.h;
        this.control.resize(cw, ch);
        let h = ch;
        if (this.desc) {
            this.desc.style = textStyle({ size: 12, weight: '500', color: Colors.grayA, wrap: cw, lineHeight: 16 });
            this.desc.position.set(ROW_PAD, ch + 2);
            h += this.desc.height + 4;
        }
        this.resize(width, h + 8);
        return h + 8;
    }

    protected override onResize(_w: number, h: number): void {
        this.control.position.set(ROW_PAD, 4);
        const barH = Math.min(this.control.h, h - 8) - 8;
        this.restore.clear().roundRect(-2, -barH / 2, 4, Math.max(8, barH), 2).fill(Colors.yellow);
        this.restore.position.set(8, 4 + this.control.h / 2);
    }
}

// ---------------------------------------------------------------------------
// Composite controls
// ---------------------------------------------------------------------------

/** Caption above a full-width control (dropdowns, text boxes). */
class Captioned extends UIComponent {
    private readonly caption: Text;

    constructor(text: string, private readonly inner: UIComponent, private readonly innerH: number) {
        super();
        this.caption = label(text, { size: 15, weight: '500' });
        this.addChild(this.caption, inner);
        this.resize(300, 24 + innerH);
    }

    protected override onResize(w: number): void {
        this.inner?.position.set(0, 24);
        this.inner?.resize(w, this.innerH);
    }
}

/** Wrapped paragraph (about text, explanations). */
export class TextBlock extends UIComponent implements Measurable {
    private readonly text: Text;

    constructor(content: string, private readonly color: number = Colors.grayC, private readonly size = 13) {
        super();
        this.text = label(content, { size, weight: '500', color, wrap: 300, lineHeight: size + 6 });
        this.addChild(this.text);
    }

    set content(v: string) {
        this.text.text = v;
    }

    preferredHeight(width: number): number {
        this.text.style = textStyle({ size: this.size, weight: '500', color: this.color, wrap: width, lineHeight: this.size + 6 });
        return Math.ceil(this.text.height) + 2;
    }
}

/** Coloured notice box with an icon, text and an optional action button. */
export class NoticeBox extends UIComponent implements Measurable {
    private readonly bg: Box;
    private readonly glyph: Text;
    private readonly text: Text;
    private readonly button: Button | null;

    constructor(content: string, color: number, iconName: IconName, action?: { text: string; onClick: () => void }) {
        super();
        this.bg = new Box({ color, alpha: 0.18, radius: 6, border: { width: 1, color, alpha: 0.6 } });
        this.glyph = icon(iconName, 16, color);
        this.text = label(content, { size: 13, weight: '600', wrap: 300, lineHeight: 18 });
        this.addChild(this.bg, this.glyph, this.text);
        this.button = action ? new Button(action.text, { color, height: 30, width: 120, fontSize: 13 }) : null;
        if (this.button && action) {
            this.button.onActivate = action.onClick;
            this.addChild(this.button);
        }
    }

    preferredHeight(width: number): number {
        this.text.style = textStyle({ size: 13, weight: '600', wrap: width - 48, lineHeight: 18 });
        return Math.ceil(this.text.height) + 20 + (this.button ? 38 : 0);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.resize(w, h);
        this.glyph.position.set(20, 20);
        this.text.position.set(38, 10);
        if (this.button) this.button.position.set(38, h - 38);
    }
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

export function checkboxRow(caption: string, b: Bindable<boolean>, opts: RowOptions = {}): SettingsRow {
    const c = new Checkbox(caption, b);
    c.resize(300, 34);
    return new SettingsRow(c, caption, b, opts);
}

export function sliderRow(caption: string, b: BindableNumber, format: (v: number) => string, opts: RowOptions = {}): SettingsRow {
    const slider = new Slider(caption, b, { format });
    const row = new SettingsRow(slider, caption, b, opts);
    // A hovered slider takes the arrow keys; without a pointer move after
    // the panel closes it would keep them (disabling clears the hover).
    row.onPanelHide = () => {
        if (!slider.hovered) return;
        slider.enabled = false;
        slider.enabled = true;
    };
    return row;
}

export function dropdownRow<T>(caption: string, items: DropdownItem<T>[], b: Bindable<T>, opts: RowOptions = {}): SettingsRow {
    const d = new Dropdown(items, b);
    const words = items.map(i => i.label).join(' ');
    const row = new SettingsRow(new Captioned(caption, d, 36), `${caption} ${words}`, b, opts);
    row.onPanelHide = () => d.closeMenu();
    return row;
}

export function keyBindRow(caption: string, b: Bindable<string>, opts: RowOptions = {}): SettingsRow {
    const btn = new KeyBindButton(caption, b);
    const row = new SettingsRow(btn, `${caption} key binding`, b, opts);
    // A capture left armed would swallow and bind the next key pressed anywhere.
    row.onPanelHide = () => btn.cancel();
    return row;
}

export function textBoxRow(caption: string, b: Bindable<string>, opts: RowOptions & { placeholder?: string; maxLength?: number } = {}): SettingsRow {
    const box = new TextBox({ placeholder: opts.placeholder, maxLength: opts.maxLength, fontSize: 15 });
    box.setValue(b.value, false);
    box.changed.add(v => (b.value = v));
    const off = b.bind(v => {
        if (!box.isFocused && box.value !== v) box.setValue(v, false);
    });
    const row = new SettingsRow(new Captioned(caption, box, 38), caption, b, opts);
    row.on('destroyed', off);
    return row;
}

export function buttonRow(text: string, onClick: () => void, opts: RowOptions & { color?: number; icon?: IconName } = {}): SettingsRow {
    const btn = new Button(text, { color: opts.color ?? Colors.pinkDark, height: 38, icon: opts.icon, fontSize: 14 });
    btn.onActivate = onClick;
    return new SettingsRow(btn, text, null, opts);
}

export function textRow(content: string, opts: RowOptions & { color?: number; size?: number } = {}): { row: SettingsRow; block: TextBlock } {
    const block = new TextBlock(content, opts.color, opts.size);
    return { row: new SettingsRow(block, content, null, opts), block };
}

export function noticeRow(content: string, color: number, iconName: IconName, opts: RowOptions & { action?: { text: string; onClick: () => void } } = {}): SettingsRow {
    return new SettingsRow(new NoticeBox(content, color, iconName, opts.action), content, null, opts);
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const mult = (v: number): string => `${v.toFixed(2)}x`;
export const ms = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v)}ms`;
