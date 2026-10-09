import { Container, Graphics, Rectangle, type Text } from 'pixi.js';
import { Signal } from '../../core/Signal';
import { tween } from '../../core/Tweener';
import { label } from '../../ui/text';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { gesture, uiSounds } from '../../ui/UIContext';
import type { Choice } from './ListingPager';

export interface TabStripStyle {
    size: number;
    weight: '500' | '600' | '700';
    /** Horizontal space between items. */
    gap: number;
    rowHeight: number;
    idle: number;
    hover: number;
    active: number;
    /** Selection bar under the active item (lazer's header tab bar). */
    bar?: { color: number; height: number };
}

interface Item<T> {
    choice: Choice<T>;
    hit: Container;
    text: Text;
    x: number;
    y: number;
    w: number;
}

/**
 * A row of text tabs: lazer's OverlayTabControl (with the sliding bar)
 * and its filter rows (colour-only). Items wrap onto extra lines when
 * the strip is narrower than their total width.
 */
export class TabStrip<T> extends UIComponent {
    readonly changed = new Signal<[value: T]>();
    private readonly items: Item<T>[] = [];
    private readonly bar = new Graphics();
    private hovered_: Item<T> | null = null;
    private _value: T;
    private barReady = false;

    constructor(choices: Choice<T>[], value: T, private readonly style: TabStripStyle) {
        super();
        this._value = value;
        this.addChild(this.bar);
        this.setChoices(choices, value);
    }

    get value(): T {
        return this._value;
    }

    set value(v: T) {
        if (Object.is(v, this._value)) return;
        this._value = v;
        this.refresh(true);
    }

    setChoices(choices: Choice<T>[], value: T): void {
        for (const it of this.items) it.hit.destroy({ children: true });
        this.items.length = 0;
        this._value = value;
        for (const choice of choices) {
            const hit = new Container();
            const text = label(choice.label, { size: this.style.size, weight: this.style.weight });
            text.tint = this.style.idle;
            hit.addChild(text);
            hit.eventMode = 'static';
            hit.cursor = 'pointer';
            const item: Item<T> = { choice, hit, text, x: 0, y: 0, w: text.width };
            hit.on('pointerover', () => {
                this.hovered_ = item;
                uiSounds()?.hover();
                this.paint(item);
            });
            hit.on('pointerout', () => {
                if (this.hovered_ === item) this.hovered_ = null;
                this.paint(item);
            });
            hit.on('pointertap', () => this.pick(item));
            this.addChild(hit);
            this.items.push(item);
        }
        this.barReady = false;
        this.relayout();
    }

    /** Height needed to fit every item at `width` (wrapping). */
    measure(width: number): number {
        let x = 0, rows = 1;
        for (const it of this.items) {
            if (x > 0 && x + it.w > width) {
                rows++;
                x = 0;
            }
            x += it.w + this.style.gap;
        }
        return rows * this.style.rowHeight;
    }

    private pick(item: Item<T>): void {
        if (gesture.suppressClicks || Object.is(item.choice.value, this._value)) return;
        uiSounds()?.click();
        this._value = item.choice.value;
        this.refresh(true);
        this.changed.emit(this._value);
    }

    private paint(item: Item<T>): void {
        const s = this.style;
        const color = Object.is(item.choice.value, this._value) ? s.active : this.hovered_ === item ? s.hover : s.idle;
        tweenTint(item.text, color, 150);
    }

    protected override onResize(w: number): void {
        const s = this.style;
        let x = 0, y = 0;
        for (const it of this.items) {
            if (x > 0 && x + it.w > w) {
                x = 0;
                y += s.rowHeight;
            }
            it.x = x;
            it.y = y;
            it.hit.position.set(x, y);
            it.text.position.set(0, Math.round((s.rowHeight - it.text.height) / 2) - (s.bar ? 1 : 0));
            it.hit.hitArea = new Rectangle(-s.gap / 2, 0, it.w + s.gap, s.rowHeight);
            x += it.w + s.gap;
        }
        this.refresh(false);
    }

    private refresh(animate: boolean): void {
        for (const it of this.items) this.paint(it);
        const bar = this.style.bar;
        const sel = this.items.find(it => Object.is(it.choice.value, this._value));
        if (!bar) return;
        if (!sel) {
            tween(this.bar, { alpha: 0 }, { duration: 200 });
            return;
        }
        const y = sel.y + this.style.rowHeight - bar.height;
        if (!this.barReady || !animate) {
            this.barReady = true;
            this.bar.clear().rect(0, 0, 1, bar.height).fill(bar.color);
            this.bar.position.set(sel.x, y);
            this.bar.scale.x = sel.w;
            this.bar.alpha = 1;
            return;
        }
        this.bar.y = y;
        tween(this.bar, { x: sel.x, scaleX: sel.w, alpha: 1 }, { duration: 500, ease: 'OutQuint' });
    }
}
