import { Container, Graphics, type Text } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { lerpColor, scaleColor } from '../../core/math';
import type { ModInfo } from '../../gameplay/mods';
import { drawSheared, SHEAR, shearedHitArea } from '../../ui/ShearedButton';
import { label, fitText } from '../../ui/text';
import { ColorProvider } from '../../ui/theme';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';
import { modCategoryColor } from './ModIcon';

export const MOD_PANEL_HEIGHT = 44;
const RADIUS = 7;
const SWITCH_IDLE = 54;
const SWITCH_EXPANDED = 66;

/** lazer's mod select uses the green overlay palette. */
export const modColors = new ColorProvider('green');

/**
 * lazer's ModPanel: a sheared row whose left "switch" strip lights up in
 * the mod-type colour when active, with the acronym on a tiny pill and the
 * name + description on an inner slab that turns the accent colour too.
 * All fills are drawn white once and tinted, so state changes only tween
 * tints (the strip width animation redraws one shape).
 */
export class ModPanel extends UIComponent {
    private readonly body = new Container();
    private readonly switchBg = new Graphics();
    private readonly mainBg = new Graphics();
    private readonly pill = new Graphics();
    private readonly acronym: Text;
    private readonly title: Text;
    private readonly desc: Text;
    private readonly accent: number;
    private active = false;
    private incompatible = false;
    private switchW = SWITCH_IDLE;
    /** Called when the panel is clicked (the overlay toggles the mod). */
    onToggle: (() => void) | null = null;

    constructor(readonly mod: ModInfo) {
        super();
        this.accent = modCategoryColor(mod.category);
        this.acronym = label(mod.acronym, { size: 12, weight: '800', color: 0xffffff });
        this.acronym.anchor.set(0.5);
        this.title = label(mod.name, { size: 16, weight: '700', color: 0xffffff });
        this.desc = label('', { size: 12, weight: '500', color: 0xffffff });
        this.body.addChild(this.switchBg, this.mainBg, this.pill, this.acronym, this.title, this.desc);
        this.addChild(this.body);
        this.tooltip = mod.description;
        // Sounds are the toggle sounds, played by the overlay.
        this.makeInteractive({ sounds: false });
        this.applyColors(0);
        this.resize(300, MOD_PANEL_HEIGHT);
    }

    /** Reflect selection + incompatibility with the current selection. */
    setState(active: boolean, incompatible: boolean, incompatibleWith: string): void {
        if (incompatible !== this.incompatible) {
            this.incompatible = incompatible;
            tween(this, { alpha: incompatible ? 0.55 : 1 }, { duration: 200 });
        }
        this.tooltip = incompatible ? `${this.mod.description}\nIncompatible with ${incompatibleWith}` : this.mod.description;
        if (active === this.active) return;
        this.active = active;
        this.applyColors(200);
        this.animateSwitch();
    }

    protected override updateHitArea(): void {
        this.hitArea = shearedHitArea(this._w, this._h);
    }

    protected override onResize(w: number, h: number): void {
        this.body.pivot.set(w / 2, h / 2);
        this.body.position.set(w / 2, h / 2);
        drawSheared(this.switchBg.clear(), 0, 0, w, h, RADIUS).fill(0xffffff);
        // Truncate for the expanded strip so the text fits in both states.
        fitText(this.desc, w - this.textX(SWITCH_EXPANDED) - h * SHEAR - 10, this.mod.description);
        this.drawMain();
    }

    private textX(switchW: number): number {
        return switchW + this._h * SHEAR * 0.5 + 12;
    }

    /** Inner slab, pill, acronym and text follow the (animated) switch width. */
    private drawMain(): void {
        const w = this._w, h = this._h;
        const shear = h * SHEAR;
        drawSheared(this.mainBg.clear(), this.switchW, 0, w - this.switchW, h, RADIUS).fill(0xffffff);
        const cx = (this.switchW + shear) / 2;
        const pw = 34, ph = 18;
        drawSheared(this.pill.clear(), cx - pw / 2, h / 2 - ph / 2, pw, ph, 5, ph * SHEAR).fill(0xffffff);
        this.acronym.position.set(cx, h / 2);
        // Text lines step left with the lean.
        const x = this.textX(this.switchW);
        this.title.position.set(x + 2, 5);
        this.desc.position.set(x - 2, 25);
    }

    private animateSwitch(): void {
        const proxy = { w: this.switchW };
        const target = this.active || this.hovered ? SWITCH_EXPANDED : SWITCH_IDLE;
        tween(proxy, { w: target }, {
            owner: this,
            duration: 300,
            ease: 'OutQuint',
            onUpdate: () => {
                // The proxy outlives the panel; never redraw destroyed graphics.
                if (this.destroyed) return;
                this.switchW = proxy.w;
                this.drawMain();
            },
        });
    }

    private applyColors(duration: number): void {
        const c = modColors;
        const hover = this.hovered ? 0.08 : 0;
        const strip = this.active ? this.accent : c.background3;
        const main = this.active ? scaleColor(this.accent, 0.77) : c.background2;
        const text = this.active ? c.background6 : 0xffffff;
        const set = (target: Graphics | Text, color: number) => {
            if (duration > 0) tweenTint(target, color, duration);
            else target.tint = color;
        };
        set(this.switchBg, lerpColor(strip, 0xffffff, hover));
        set(this.mainBg, lerpColor(main, 0xffffff, hover));
        set(this.pill, this.active ? scaleColor(this.accent, 0.3) : c.background6);
        set(this.acronym, this.active ? lerpColor(this.accent, 0xffffff, 0.3) : scaleColor(this.accent, 0.8));
        set(this.title, text);
        set(this.desc, this.active ? c.background5 : c.content2);
    }

    protected override onHoverChange(): void {
        this.applyColors(150);
        this.animateSwitch();
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.body, { scale: pressed ? 0.98 : 1 }, { duration: pressed ? 300 : 500, ease: pressed ? 'OutQuint' : 'OutElastic' });
    }

    protected override onClick(): void {
        this.onToggle?.();
    }

    /** Play the lazer toggle sound for the new state. */
    static playToggleSound(on: boolean): void {
        if (on) uiSounds()?.toggleOn();
        else uiSounds()?.toggleOff();
    }
}
