import { Graphics, type FederatedPointerEvent, type Text } from 'pixi.js';
import type { BindableNumber } from '../core/Bindable';
import { clamp } from '../core/math';
import { tween } from '../core/Tweener';
import { label, fitText } from './text';
import { Colors } from './theme';
import { UIComponent } from './UIComponent';
import { ui, uiSounds } from './UIContext';

export interface SliderOptions {
    format?: (v: number) => string;
    accent?: number;
    /** Keyboard step when hovered (defaults to precision or 1% of range). */
    keyStep?: number;
}

/**
 * osu!lazer's OsuSliderBar with its settings label: caption + value on the
 * first line, thin bar with a pill nub below. Drag anywhere on the bar,
 * arrow keys while hovered, tooltip shows the value while dragging.
 */
export class Slider extends UIComponent {
    private readonly bar = new Graphics();
    private readonly nub = new Graphics();
    private readonly caption: Text;
    private readonly valueText: Text;
    private dragging = false;
    private lastTick = 0;
    private readonly fullCaption: string;
    private keyOff: (() => void) | null = null;
    static keyHook: ((fn: (e: KeyboardEvent) => boolean) => () => void) | null = null;

    constructor(caption: string, private readonly bindable: BindableNumber, private readonly opts: SliderOptions = {}) {
        super();
        this.fullCaption = caption;
        this.caption = label(caption, { size: 15, weight: '500' });
        this.valueText = label('', { size: 13, weight: '600', color: Colors.grayC });
        this.valueText.anchor.set(1, 0);
        this.addChild(this.caption, this.valueText, this.bar, this.nub);
        this.makeInteractive({ sounds: false });
        this.on('pointerdown', this.onDown, this);
        this.disposer.add(bindable.bind(() => this.draw()));
        this.resize(300, 52);
    }

    private format(v: number): string {
        return this.opts.format ? this.opts.format(v) : String(v);
    }

    protected override onResize(): void {
        this.draw();
    }

    private get barY(): number {
        return this._h - 12;
    }

    private draw(): void {
        const w = this._w;
        const t = clamp(this.bindable.normalized, 0, 1);
        const accent = this.opts.accent ?? Colors.pink;
        this.valueText.text = this.format(this.bindable.value);
        this.valueText.position.set(w, 3);
        fitText(this.caption, w - this.valueText.width - 12, this.fullCaption);
        const y = this.barY;
        const nubW = 26;
        const x = t * (w - nubW);
        const g = this.bar;
        g.clear();
        if (x > 2) g.roundRect(0, y - 2, x - 2, 4, 2).fill(accent);
        if (x + nubW + 2 < w) g.roundRect(x + nubW + 2, y - 2, w - x - nubW - 2, 4, 2).fill({ color: accent, alpha: 0.35 });
        // Drawn around its own origin and placed on the track centre, so the
        // hover scale grows symmetrically instead of pushing the nub down.
        this.nub.clear().roundRect(-nubW / 2, -6, nubW, 12, 6).fill(this.dragging || this.hovered ? 0xffffff : accent);
        this.nub.position.set(x + nubW / 2, y);
    }

    private setFromPointer(e: FederatedPointerEvent): void {
        const local = this.toLocal(e.global);
        const nubW = 26;
        const t = clamp((local.x - nubW / 2) / (this._w - nubW), 0, 1);
        const before = this.bindable.value;
        this.bindable.normalized = t;
        if (this.bindable.value !== before) this.tick();
        ui().tooltips.show(this.format(this.bindable.value), this);
    }

    private tick(): void {
        const now = performance.now();
        if (now - this.lastTick > 40) {
            this.lastTick = now;
            const b = this.bindable;
            const range = b.max - b.min;
            uiSounds()?.tick(Number.isFinite(range) && range > 0 ? (b.value - b.min) / range : 0.5);
        }
    }

    private onDown(e: FederatedPointerEvent): void {
        if (e.button > 0) return;
        this.dragging = true;
        this.setFromPointer(e);
        this.on('globalpointermove', this.setFromPointer, this);
        const up = () => {
            this.dragging = false;
            this.off('globalpointermove', this.setFromPointer, this);
            this.off('pointerup', up);
            this.off('pointerupoutside', up);
            ui().tooltips.hide(this);
            this.draw();
        };
        this.on('pointerup', up);
        this.on('pointerupoutside', up);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.nub, { scaleY: hovered ? 1.1 : 1 }, { duration: 200 });
        this.draw();
        if (hovered && Slider.keyHook) {
            this.keyOff = Slider.keyHook(e => this.onKey(e));
        } else {
            this.keyOff?.();
            this.keyOff = null;
        }
    }

    private onKey(e: KeyboardEvent): boolean {
        if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return false;
        // A hover can outlive its panel (closed without the pointer moving).
        if (!this.isOnScreen()) return false;
        const b = this.bindable;
        const range = Number.isFinite(b.max - b.min) ? b.max - b.min : 100;
        const step = this.opts.keyStep ?? (b.precision > 0 ? b.precision : range / 100);
        b.value += e.code === 'ArrowLeft' ? -step : step;
        this.tick();
        return true;
    }

    override destroy(options?: Parameters<UIComponent['destroy']>[0]): void {
        this.keyOff?.();
        super.destroy(options);
    }
}
