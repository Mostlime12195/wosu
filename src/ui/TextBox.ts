import { CanvasTextMetrics, Container, Graphics, type FederatedPointerEvent, type Text } from 'pixi.js';
import { Signal } from '../core/Signal';
import { clamp } from '../core/math';
import { tween } from '../core/Tweener';
import { Box } from './Box';
import { icon, type IconName } from './icons';
import { label, textStyle } from './text';
import { Colors } from './theme';
import { UIComponent } from './UIComponent';
import { ui, uiSounds, type TextSink } from './UIContext';

export interface TextBoxOptions {
    placeholder?: string;
    fontSize?: number;
    icon?: IconName;
    accent?: number;
    /** Background colour/alpha. */
    color?: number;
    alpha?: number;
    maxLength?: number;
    /** Keep focus after Enter (search boxes). */
    keepFocusOnCommit?: boolean;
}

/**
 * Single-line text field drawn entirely in Pixi. Real text entry (typing,
 * IME composition, paste, mobile keyboards) is delegated to the shared
 * TextInputProxy; this component renders the value, caret and selection.
 */
export class TextBox extends UIComponent implements TextSink {
    readonly changed = new Signal<[value: string]>();
    readonly committed = new Signal<[value: string]>();
    readonly focusChanged = new Signal<[focused: boolean]>();

    private readonly bg: Box;
    private readonly clip = new Container();
    private readonly clipMask = new Graphics();
    private readonly inner = new Container();
    private readonly selection = new Graphics();
    private readonly caret = new Graphics();
    private readonly display: Text;
    private readonly placeholderText: Text;
    private readonly iconText: Text | null = null;

    private _value = '';
    /** Moving end of the selection (where the caret is drawn). */
    private caretPos = 0;
    /** Fixed end of the selection; equal to caretPos when nothing is selected. */
    private anchor = 0;
    private dragging = false;
    private lastDownAt = 0;
    private lastDownX = 0;
    private clickCount = 0;
    /** Word/line being extended by a double/triple-click drag. */
    private dragUnit: [number, number] | null = null;
    private focusedState = false;
    private blinkClock = 0;
    private scrollX = 0;
    private release: (() => void) | null = null;
    private readonly fontSize: number;

    constructor(private readonly opts: TextBoxOptions = {}) {
        super();
        this.fontSize = opts.fontSize ?? 16;
        this.bg = new Box({ color: opts.color ?? 0x000000, alpha: opts.alpha ?? 0.5, radius: 5 });
        this.display = label('', { size: this.fontSize, weight: '500' });
        this.placeholderText = label(opts.placeholder ?? '', { size: this.fontSize, weight: '500', color: Colors.gray8 });
        this.inner.addChild(this.selection, this.display, this.caret);
        this.clip.addChild(this.inner, this.clipMask);
        this.clip.mask = this.clipMask;
        this.addChild(this.bg, this.placeholderText, this.clip);
        if (opts.icon) {
            this.iconText = icon(opts.icon, this.fontSize - 1, Colors.grayA);
            this.addChild(this.iconText);
        }
        this.caret.alpha = 0;
        this.makeInteractive({ sounds: false });
        this.on('pointerdown', this.onPointerDown, this);
        this.onFrame(dt => this.tick(dt));
        this.resize(300, 40);
    }

    get value(): string {
        return this._value;
    }

    set value(v: string) {
        this.setValue(v, true);
    }

    get isFocused(): boolean {
        return this.focusedState;
    }

    setValue(v: string, emit = true): void {
        if (this.opts.maxLength) v = v.slice(0, this.opts.maxLength);
        if (v === this._value) return;
        this._value = v;
        this.caretPos = this.anchor = v.length;
        this.render();
        if (this.focusedState) ui().textInput.sync(v, this.caretPos, this.anchor);
        if (emit) this.changed.emit(v);
    }

    focus(): void {
        if (this.focusedState) return;
        this.release = ui().textInput.focus(this);
        this.focusedState = true;
        this.blinkClock = 0;
        this.bg.setBorder({ width: 2, color: this.opts.accent ?? Colors.yellow, alpha: 1 });
        this.render();
        this.focusChanged.emit(true);
    }

    blur(): void {
        if (!this.focusedState) return;
        this.release?.();
    }

    // ---- TextSink ----------------------------------------------------

    applyInput(value: string, caret: number, anchor: number): void {
        if (this.opts.maxLength && value.length > this.opts.maxLength) value = value.slice(0, this.opts.maxLength);
        const changed = value !== this._value;
        this.inputSound(value, clamp(caret, 0, value.length), clamp(anchor, 0, value.length));
        this._value = value;
        this.caretPos = clamp(caret, 0, value.length);
        this.anchor = clamp(anchor, 0, value.length);
        this.blinkClock = 0;
        this.render();
        if (changed) this.changed.emit(value);
    }

    /** lazer's OsuTextBox feedback: typing, deleting, caret moves and selections each sound different. */
    private inputSound(value: string, caret: number, anchor: number): void {
        const s = uiSounds();
        if (!s) return;
        if (value !== this._value) {
            if (value.length >= this._value.length) s.typed();
            else s.play('Keyboard/key-delete', { throttle: 15 });
            return;
        }
        const hadSel = this.anchor !== this.caretPos;
        const hasSel = anchor !== caret;
        if (hasSel && Math.abs(anchor - caret) === value.length && value.length > 1) s.play('Keyboard/select-all');
        else if (hasSel) s.play('Keyboard/select-char', { throttle: 15 });
        else if (hadSel) s.play('Keyboard/deselect');
        else if (caret !== this.caretPos) s.play('Keyboard/key-movement', { throttle: 15 });
    }

    onSpecialKey(e: KeyboardEvent): boolean {
        if (e.key === 'Enter') {
            uiSounds()?.play('Keyboard/key-confirm');
            this.committed.emit(this._value);
            if (!this.opts.keepFocusOnCommit) this.blur();
            return true;
        }
        if (e.key === 'Escape') {
            if (this._value) {
                this.setValue('');
                return true;
            }
            this.blur();
            return false;
        }
        return false;
    }

    onFocusLost(): void {
        this.endDrag();
        this.focusedState = false;
        this.release = null;
        this.bg.setBorder(undefined);
        this.anchor = this.caretPos;
        this.render();
        this.focusChanged.emit(false);
    }

    // ------------------------------------------------------------------

    private get textLeft(): number {
        return 12;
    }

    private get textRight(): number {
        return this._w - (this.iconText ? 34 : 12);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.resize(w, h);
        const ty = Math.round((h - this.display.height) / 2);
        this.clip.position.set(this.textLeft, 0);
        this.clipMask.clear().rect(0, 0, Math.max(0, this.textRight - this.textLeft), h).fill(0xffffff);
        this.display.y = ty;
        this.placeholderText.position.set(this.textLeft, ty);
        if (this.iconText) this.iconText.position.set(w - 18, h / 2);
        this.render();
    }

    private measure(s: string): number {
        if (!s) return 0;
        return CanvasTextMetrics.measureText(s, textStyle({ size: this.fontSize, weight: '500' })).width;
    }

    private render(): void {
        this.display.text = this._value;
        this.placeholderText.visible = this._value.length === 0;
        const h = this._h;
        const caretX = this.measure(this._value.slice(0, this.caretPos));
        const visibleW = this.textRight - this.textLeft;
        // Scroll so the caret stays visible.
        if (caretX - this.scrollX > visibleW - 4) this.scrollX = caretX - visibleW + 4;
        if (caretX - this.scrollX < 0) this.scrollX = Math.max(0, caretX);
        this.scrollX = Math.max(0, Math.min(this.scrollX, Math.max(0, this.display.width - visibleW + 4)));
        this.inner.x = -this.scrollX;
        const ch = this.fontSize + 6;
        this.caret.clear().rect(caretX, (h - ch) / 2, 2, ch).fill(0xffffff);
        this.selection.clear();
        if (this.focusedState && this.anchor !== this.caretPos) {
            const a = Math.min(this.caretPos, this.anchor);
            const b = Math.max(this.caretPos, this.anchor);
            const x0 = this.measure(this._value.slice(0, a));
            const x1 = this.measure(this._value.slice(0, b));
            this.selection.rect(x0, (h - ch) / 2, x1 - x0, ch).fill({ color: this.opts.accent ?? Colors.yellow, alpha: 0.4 });
        }
    }

    private tick(dt: number): void {
        if (!this.focusedState) {
            if (this.caret.alpha !== 0) this.caret.alpha = 0;
            return;
        }
        this.blinkClock += dt;
        this.caret.alpha = this.anchor !== this.caretPos ? 0 : (Math.floor(this.blinkClock / 500) % 2 === 0 ? 1 : 0.15);
    }

    private indexAt(localX: number): number {
        const x = localX - this.textLeft + this.scrollX;
        const v = this._value;
        let lo = 0, hi = v.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const a = this.measure(v.slice(0, mid));
            const b = this.measure(v.slice(0, mid + 1));
            if (x < (a + b) / 2) hi = mid; else lo = mid + 1;
        }
        return lo;
    }

    private onPointerDown(e: FederatedPointerEvent): void {
        if (e.button > 0) return;
        const local = this.toLocal(e.global);
        const wasFocused = this.focusedState;
        this.focus();
        // The press must not hand native focus to the canvas (see TextInputProxy).
        ui().textInput.holdFocus();
        const idx = this.indexAt(local.x);
        const now = performance.now();
        this.clickCount = now - this.lastDownAt < 400 && Math.abs(local.x - this.lastDownX) < 6 ? this.clickCount + 1 : 1;
        this.lastDownAt = now;
        this.lastDownX = local.x;
        if (this.clickCount >= 3) {
            this.dragUnit = [0, this._value.length];
            this.select(0, this._value.length);
        } else if (this.clickCount === 2) {
            const [a, b] = this.wordAt(idx);
            this.dragUnit = [a, b];
            this.select(a, b);
        } else if (e.shiftKey && wasFocused) {
            this.dragUnit = null;
            this.select(this.anchor, idx);
        } else {
            this.dragUnit = null;
            this.select(idx, idx);
        }
        if (!this.dragging) {
            this.dragging = true;
            this.on('globalpointermove', this.onDragMove, this);
            this.on('pointerup', this.endDrag, this);
            this.on('pointerupoutside', this.endDrag, this);
        }
    }

    private onDragMove(e: FederatedPointerEvent): void {
        if (!this.dragging || !this.focusedState) return;
        const idx = this.indexAt(this.toLocal(e.global).x);
        const unit = this.dragUnit;
        if (!unit) {
            if (idx !== this.caretPos) this.select(this.anchor, idx);
            return;
        }
        // Word/line granularity, like native double-click-drag.
        if (idx < unit[0]) {
            const w = this.clickCount >= 3 ? 0 : this.wordAt(idx)[0];
            this.select(unit[1], w);
        } else if (idx > unit[1]) {
            const w = this.clickCount >= 3 ? this._value.length : this.wordAt(idx)[1];
            this.select(unit[0], w);
        } else {
            this.select(unit[0], unit[1]);
        }
    }

    private endDrag(): void {
        if (!this.dragging) return;
        this.dragging = false;
        this.off('globalpointermove', this.onDragMove, this);
        this.off('pointerup', this.endDrag, this);
        this.off('pointerupoutside', this.endDrag, this);
    }

    /** Select from `anchor` to `caret` (equal = plain caret). */
    select(anchor: number, caret: number): void {
        const len = this._value.length;
        this.anchor = clamp(anchor, 0, len);
        this.caretPos = clamp(caret, 0, len);
        if (this.focusedState) ui().textInput.sync(this._value, this.caretPos, this.anchor);
        this.blinkClock = 0;
        this.render();
    }

    selectAll(): void {
        this.select(0, this._value.length);
    }

    /** Bounds of the word (or run of spaces/punctuation) around index `i`. */
    private wordAt(i: number): [number, number] {
        const v = this._value;
        if (!v) return [0, 0];
        const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);
        // Prefer the character after the caret, else the one before it.
        const at = i < v.length ? i : v.length - 1;
        const kind = isWord(v[at]) ? 1 : v[at] === ' ' ? 2 : 3;
        const same = (c: string) => (kind === 1 ? isWord(c) : kind === 2 ? c === ' ' : !isWord(c) && c !== ' ');
        let a = at, b = at + 1;
        while (a > 0 && same(v[a - 1])) a--;
        while (b < v.length && same(v[b])) b++;
        return [a, b];
    }

    protected override onHoverChange(hovered: boolean): void {
        if (!this.focusedState) tween(this.bg.g, { alpha: hovered ? (this.opts.alpha ?? 0.5) + 0.15 : this.opts.alpha ?? 0.5 }, { duration: 200 });
    }

    override destroy(options?: Parameters<UIComponent['destroy']>[0]): void {
        this.blur();
        super.destroy(options);
    }
}
