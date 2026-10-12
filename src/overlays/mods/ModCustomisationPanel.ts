import { Container, Graphics, type FederatedPointerEvent, type Text } from 'pixi.js';
import { Bindable, BindableNumber } from '../../core/Bindable';
import { tween, tweener } from '../../core/Tweener';
import {
    MODS,
    formatSetting,
    modInfo,
    modSetting,
    modSettingDefs,
    type ModAcronym,
    type ModSet,
    type ModSettingDef,
    type ModSettingValue,
} from '../../gameplay/mods';
import { Checkbox } from '../../ui/Checkbox';
import { icon } from '../../ui/icons';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { Slider } from '../../ui/Slider';
import { label } from '../../ui/text';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { modCategoryColor } from './ModIcon';
import { modColors } from './ModPanel';

/** lazer's ModCustomisationPanel constants. */
export const CUSTOMISATION_PANEL_WIDTH = 400;
const HEADER_HEIGHT = 42;
const CONTENT_PADDING = 20;
const BORDER = 2;
const RADIUS = 10;
/** ModCustomisationSection flow: 40 between sections, 8 between rows, title + 4. */
const SECTION_SPACING = 40;
const ROW_SPACING = 8;
const SECTION_LEFT = 7;
/** SettingsItem side margins inside a section. */
const ROW_MARGIN = 20;
/** FocusGrabbingContainer: collapse once the pointer stays this far out for this long. */
const COLLAPSE_GRACE_TIME = 180;
const COLLAPSE_GRACE_POSITION = 40;

export type CustomisationState = 'collapsed' | 'expanded' | 'expandedByMod';

type SettingControl = { def: ModSettingDef; bindable: Bindable<boolean> | BindableNumber; row: Slider | Checkbox };

/**
 * lazer's ModCustomisationPanel: a "Customise" header at the top right of
 * mod select that expands (on hover, or from a panel's gear) into a list
 * of the selected mods' settings, one section per mod with its sliders
 * and toggles. It is disabled (greyed, with a tooltip) when no selected mod
 * has settings, collapses again when the pointer leaves it for a moment
 * (unless it was opened from a mod), and on Back or a click elsewhere.
 * Changes go out through `onSettingChanged`; `sync` reflects the selection.
 */
export class ModCustomisationPanel extends UIComponent {
    private readonly header: CustomisationHeader;
    private readonly content = new Container();
    private readonly contentBg = new Graphics();
    private readonly contentMask = new Graphics();
    private readonly scroll = new ScrollContainer();
    private readonly sections = new Container();
    private controls = new Map<string, SettingControl>();
    private sectionsKey = '';
    private sectionsHeight = 0;
    private _state: CustomisationState = 'collapsed';
    private shownHeight = HEADER_HEIGHT;
    private maxHeight = 400;
    private collapseTimer = COLLAPSE_GRACE_TIME;
    private pointer: { x: number; y: number } | null = null;
    private customisable = false;
    /** A setting was changed by the user. */
    onSettingChanged: ((acronym: ModAcronym, key: string, value: ModSettingValue) => void) | null = null;
    /** The panel expanded or collapsed (the overlay dims its columns). */
    onStateChanged: ((state: CustomisationState) => void) | null = null;

    constructor() {
        super();
        this.header = new CustomisationHeader();
        this.header.onActivate = () => {
            if (!this.customisable) return;
            this.state = this._state === 'collapsed' ? 'expanded' : 'collapsed';
        };
        this.header.onHovered = () => {
            if (this.customisable && this._state === 'collapsed') this.state = 'expanded';
        };
        this.scroll.content.addChild(this.sections);
        this.content.addChild(this.contentBg, this.scroll, this.contentMask);
        this.content.mask = this.contentMask;
        this.content.alpha = 0;
        this.content.visible = false;
        // Clicks inside the content never reach the overlay's click-away blocker.
        this.content.eventMode = 'static';
        this.addChild(this.content, this.header);
        this.eventMode = 'static';
        this.on('globalpointermove', (e: FederatedPointerEvent) => (this.pointer = this.toLocal(e.global)));
        this.onFrame(dt => this.update(dt));
        this.setCustomisable(false);
        this.resize(CUSTOMISATION_PANEL_WIDTH, HEADER_HEIGHT);
    }

    get state(): CustomisationState {
        return this._state;
    }

    set state(v: CustomisationState) {
        if (v !== 'collapsed' && !this.customisable) v = 'collapsed';
        if (v === this._state) return;
        this._state = v;
        this.collapseTimer = COLLAPSE_GRACE_TIME;
        this.header.setExpanded(v !== 'collapsed');
        this.animate();
        this.onStateChanged?.(v);
    }

    get expanded(): boolean {
        return this._state !== 'collapsed';
    }

    /** Tallest the panel may grow (the space above the footer). */
    setMaxHeight(h: number): void {
        this.maxHeight = Math.max(HEADER_HEIGHT, h);
        this.layoutContent(false);
    }

    /**
     * Reflect the selection: rebuild the sections when the set of
     * customisable selected mods changes (collapsing, like lazer's
     * updateMods) and otherwise just update the controls' values.
     */
    sync(mods: ModSet): void {
        const list = MODS.map(m => m.acronym).filter(a => mods.has(a) && modSettingDefs(a).length > 0);
        const key = list.join(',');
        if (key !== this.sectionsKey) {
            this.sectionsKey = key;
            this.state = 'collapsed';
            this.rebuild(list, mods);
            this.setCustomisable(list.length > 0);
        }
        for (const [id, c] of this.controls) {
            const [a, k] = id.split('.') as [ModAcronym, string];
            const v = modSetting(mods, a, k);
            if (c.def.kind === 'toggle') (c.bindable as Bindable<boolean>).value = v === true;
            else (c.bindable as BindableNumber).value = Number(v);
        }
    }

    /** Open from a mod panel's gear (lazer's ExpandedByMod: no auto-collapse). */
    expandByMod(): void {
        if (this.customisable) this.state = 'expandedByMod';
    }

    /** True while one of the panel's sliders is being dragged. */
    get dragging(): boolean {
        for (const c of this.controls.values()) if (c.row instanceof Slider && c.row.pressed) return true;
        return this.scroll.isDragging;
    }

    private setCustomisable(v: boolean): void {
        this.customisable = v;
        this.header.setEnabledLook(v);
        // lazer fades the whole panel to Gray(0.6) when disabled.
        tweenTint(this.header, v ? 0xffffff : 0x999999, 300);
    }

    private rebuild(list: ModAcronym[], mods: ModSet): void {
        for (const c of this.sections.removeChildren()) c.destroy({ children: true });
        this.controls.clear();
        const rowW = CUSTOMISATION_PANEL_WIDTH - SECTION_LEFT - ROW_MARGIN * 2;
        let y = CONTENT_PADDING;
        list.forEach((a, i) => {
            if (i > 0) y += SECTION_SPACING;
            const section = new Container();
            section.y = y;
            // Title row: name on the left, the mod's tiny switch on the right.
            const title = label(modInfo(a).name, { size: 20, weight: '600' });
            title.anchor.set(0, 0.5);
            title.position.set(SECTION_LEFT + ROW_MARGIN, 14);
            const pill = tinySwitch(a);
            pill.position.set(CUSTOMISATION_PANEL_WIDTH - 27 - pill.width, 14 - pill.height / 2);
            section.addChild(title, pill);
            let sy = 28 + 4 + ROW_SPACING;
            for (const def of modSettingDefs(a)) {
                const control = this.createControl(a, def, mods);
                control.row.resize(rowW, control.row.h);
                control.row.position.set(SECTION_LEFT + ROW_MARGIN, sy);
                section.addChild(control.row);
                sy += control.row.h + ROW_SPACING;
            }
            y += sy - ROW_SPACING;
            this.sections.addChild(section);
        });
        this.sectionsHeight = list.length ? y + 5 + CONTENT_PADDING : 0;
        this.scroll.contentHeight = this.sectionsHeight;
        this.scroll.scrollTo(0, false);
        this.layoutContent(false);
    }

    private createControl(a: ModAcronym, def: ModSettingDef, mods: ModSet): SettingControl {
        const id = `${a}.${def.key}`;
        const accent = modColors.highlight1;
        let control: SettingControl;
        if (def.kind === 'toggle') {
            const b = new Bindable<boolean>(def.default);
            b.value = modSetting(mods, a, def.key) === true;
            const row = new Checkbox(def.label, b, accent);
            row.tooltip = def.description;
            b.bind(v => this.onSettingChanged?.(a, def.key, v));
            control = { def, bindable: b, row };
        } else {
            const b = new BindableNumber(def.default, def.min, def.max, def.precision);
            b.value = Number(modSetting(mods, a, def.key));
            const row = new Slider(def.label, b, { format: v => formatSetting(def, v), accent, keyStep: def.precision });
            b.bind(v => this.onSettingChanged?.(a, def.key, v));
            control = { def, bindable: b, row };
        }
        this.controls.set(id, control);
        return control;
    }

    /** Expanded height: header + content, capped by the space available. */
    private get targetHeight(): number {
        if (!this.expanded) return HEADER_HEIGHT;
        return Math.min(this.maxHeight, HEADER_HEIGHT + BORDER * 2 + this.sectionsHeight);
    }

    private animate(): void {
        tweener.kill(this.content);
        const proxy = { h: this.shownHeight };
        tween(proxy, { h: this.targetHeight }, {
            owner: this,
            duration: 400,
            ease: 'OutQuint',
            onUpdate: () => {
                if (this.destroyed) return;
                this.shownHeight = proxy.h;
                this.drawContent();
            },
        });
        if (this.expanded) {
            this.content.visible = true;
            tween(this.content, { alpha: 1 }, { duration: 120, ease: 'OutQuint' });
        } else {
            tween(this.content, { alpha: 0 }, { duration: 400, ease: 'OutSine' }).finished.then(() => {
                if (!this.destroyed && !this.expanded) this.content.visible = false;
            });
        }
    }

    private layoutContent(animated: boolean): void {
        if (animated) this.animate();
        else {
            this.shownHeight = this.targetHeight;
            this.drawContent();
        }
    }

    private drawContent(): void {
        const w = CUSTOMISATION_PANEL_WIDTH;
        const h = Math.max(HEADER_HEIGHT, this.shownHeight);
        // Shadow, then the bordered body (lazer: Dark4 with a Dark3 border, radius 10).
        this.contentBg.clear()
            .roundRect(0, 5, w, h, RADIUS + 5).fill({ color: 0x000000, alpha: 0.25 })
            .roundRect(0, 0, w, h, RADIUS).fill(modColors.dark3)
            .roundRect(BORDER, BORDER, w - BORDER * 2, h - BORDER * 2, RADIUS - BORDER).fill(modColors.dark4);
        this.contentMask.clear().roundRect(0, 0, w, h + 30, RADIUS).fill(0xffffff);
        const viewH = Math.max(0, Math.min(this.sectionsHeight, this.maxHeight - HEADER_HEIGHT - BORDER * 2));
        this.scroll.position.set(0, HEADER_HEIGHT + BORDER);
        this.scroll.resize(w, viewH);
        this.content.hitArea = { contains: (x: number, y: number) => x >= 0 && x <= w && y >= 0 && y <= h };
    }

    /** FocusGrabbingContainer.Update: hover-opened panels close once the pointer wanders off. */
    private update(dt: number): void {
        if (this._state !== 'expanded') return;
        const p = this.pointer;
        const h = this.shownHeight;
        const g = COLLAPSE_GRACE_POSITION;
        const inside = !!p && p.x >= -g && p.x <= CUSTOMISATION_PANEL_WIDTH + g && p.y >= -g && p.y <= h + g;
        if (!inside && !this.dragging) {
            if (this.collapseTimer <= 0) this.state = 'collapsed';
            this.collapseTimer -= dt;
        } else {
            this.collapseTimer = COLLAPSE_GRACE_TIME;
        }
    }

    /** The full panel rectangle in local space (for click-away tests). */
    containsLocal(x: number, y: number): boolean {
        return x >= 0 && x <= CUSTOMISATION_PANEL_WIDTH && y >= 0 && y <= Math.max(HEADER_HEIGHT, this.shownHeight);
    }
}

/** lazer's ModSwitchTiny at 0.5 scale: the acronym on a small pill in the mod colour. */
function tinySwitch(a: ModAcronym): Container {
    const c = new Container();
    const color = modCategoryColor(modInfo(a).category);
    const text = label(a, { size: 11, weight: '800', color: modColors.background6 });
    text.anchor.set(0.5);
    const w = 36, h = 18;
    c.addChild(new Graphics().roundRect(0, 0, w, h, h / 2).fill(color), text);
    text.position.set(w / 2, h / 2 + 0.5);
    return c;
}

/**
 * lazer's ModCustomisationHeader: "Customise" with a chevron that flips
 * when expanded; Dark3 collapsed, Light4 expanded, a hover wash, and a
 * flash when it becomes enabled.
 */
class CustomisationHeader extends UIComponent {
    private readonly bg = new Graphics();
    private readonly hoverWash = new Graphics();
    private readonly flash = new Graphics();
    private readonly title: Text;
    private readonly chevron: Text;
    private expanded = false;
    private enabledLook = false;
    onHovered: (() => void) | null = null;

    constructor() {
        super();
        this.title = label('Customise', { size: 20, weight: '600' });
        this.title.anchor.set(0, 0.5);
        this.chevron = icon('chevronDown', 16);
        this.chevron.anchor.set(0.5);
        this.hoverWash.alpha = 0;
        this.hoverWash.blendMode = 'add';
        this.flash.alpha = 0;
        this.flash.blendMode = 'add';
        this.addChild(this.bg, this.hoverWash, this.flash, this.title, this.chevron);
        this.makeInteractive({ sounds: false });
        this.bg.tint = modColors.dark3;
        this.resize(CUSTOMISATION_PANEL_WIDTH, HEADER_HEIGHT);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().roundRect(0, 0, w, h, RADIUS).fill(0xffffff);
        this.hoverWash.clear().roundRect(0, 0, w, h, RADIUS).fill(0x323232);
        this.flash.clear().roundRect(0, 0, w, h, RADIUS).fill({ color: 0xffffff, alpha: 0.4 });
        this.title.position.set(20, h / 2);
        this.chevron.position.set(w - 20 - 8, h / 2);
    }

    setExpanded(v: boolean): void {
        this.expanded = v;
        tween(this.chevron.scale, { y: v ? -1 : 1 }, { duration: 300, ease: 'OutQuint' });
        tweenTint(this.bg, v ? modColors.light4 : modColors.dark3, 500);
    }

    setEnabledLook(v: boolean): void {
        this.tooltip = v ? null : 'No mod selected which can be customised.';
        if (v && !this.enabledLook) {
            // lazer's backgroundFlash: in over 150 ms, out over 350 ms.
            tweener.kill(this.flash);
            this.flash.alpha = 0;
            tween(this.flash, { alpha: 1 }, { duration: 150, ease: 'OutQuad' }).finished.then(() => {
                if (!this.destroyed) tween(this.flash, { alpha: 0 }, { duration: 350, ease: 'OutQuad' });
            });
        }
        this.enabledLook = v;
        if (!v && this.expanded) this.setExpanded(false);
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.hoverWash, { alpha: hovered && this.enabledLook ? 0.4 : 0 }, { duration: 200, ease: 'OutQuint' });
        if (hovered) this.onHovered?.();
    }
}

