import { Graphics, type Text } from 'pixi.js';
import type { Bindable } from '../core/Bindable';
import { tween } from '../core/Tweener';
import { label, fitText } from './text';
import { Colors } from './theme';
import { UIComponent, tweenTint } from './UIComponent';
import { uiSounds } from './UIContext';

/**
 * osu!lazer's OsuCheckbox: label on the left, a pill "nub" on the right
 * that fills and stretches when enabled.
 */
export class Checkbox extends UIComponent {
    private readonly nub = new Graphics();
    private readonly nubFill = new Graphics();
    private readonly text: Text;
    private unbind: () => void;
    private fillProgress = 0;
    private readonly fullLabel: string;

    constructor(caption: string, private readonly bindable: Bindable<boolean>, private readonly accent = Colors.pink) {
        super();
        this.fullLabel = caption;
        this.text = label(caption, { size: 15, weight: '500' });
        this.text.anchor.set(0, 0.5);
        this.addChild(this.text, this.nubFill, this.nub);
        this.makeInteractive({ sounds: false });
        this.unbind = bindable.bind(v => this.animate(v, true), false);
        this.fillProgress = bindable.value ? 1 : 0;
        this.disposer.add(() => this.unbind());
        this.resize(300, 34);
    }

    protected override onResize(w: number, h: number): void {
        fitText(this.text, w - 60, this.fullLabel);
        this.text.position.set(0, h / 2);
        this.drawNub();
    }

    private drawNub(): void {
        const h = this._h;
        const nubH = 16;
        const baseW = 30;
        const fullW = 40;
        const w = baseW + (fullW - baseW) * this.fillProgress;
        const x = this._w - w;
        const y = (h - nubH) / 2;
        this.nub.clear().roundRect(x + 1, y + 1, w - 2, nubH - 2, nubH / 2).stroke({ width: 2, color: 0xffffff });
        this.nub.tint = this.hovered ? Colors.pinkLighter : this.accent;
        this.nubFill.clear().roundRect(x, y, w, nubH, nubH / 2).fill(0xffffff);
        this.nubFill.alpha = this.fillProgress;
        this.nubFill.tint = this.accent;
    }

    private animate(on: boolean, sound: boolean): void {
        if (sound && this.isOnScreen()) {
            if (on) uiSounds()?.toggleOn();
            else uiSounds()?.toggleOff();
        }
        const proxy = { p: this.fillProgress };
        tween(proxy, { p: on ? 1 : 0 }, {
            owner: this,
            duration: 400,
            ease: 'OutElastic',
            onUpdate: () => {
                this.fillProgress = Math.max(0, Math.min(1.15, proxy.p));
                this.drawNub();
            },
        });
    }

    protected override onHoverChange(hovered: boolean): void {
        tweenTint(this.nub, hovered ? Colors.pinkLighter : this.accent, 200);
    }

    protected override onClick(): void {
        this.bindable.value = !this.bindable.value;
    }
}
