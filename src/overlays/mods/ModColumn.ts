import { Graphics, type Text } from 'pixi.js';
import type { ModCategory, ModInfo } from '../../gameplay/mods';
import { drawSheared, SHEAR } from '../../ui/ShearedButton';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';
import { modCategoryColor } from './ModIcon';
import { modColors, MOD_PANEL_HEIGHT, ModPanel } from './ModPanel';

/** Horizontal span of a column's interior (its box also includes the lean). */
export const MOD_COLUMN_SPAN = 300;
const HEADER = 40;
const PAD = 10;
const SPACING = 7;
const RADIUS = 10;

const TITLES: Record<ModCategory, string> = {
    reduction: 'Difficulty Reduction',
    increase: 'Difficulty Increase',
    automation: 'Automation',
};

/**
 * One mod-type column (lazer's ModColumn): an accent-coloured header
 * over a dark panel holding that category's mods. The whole column leans
 * with lazer's 0.2 shear, so each panel sits further left the lower it is.
 */
export class ModColumn extends UIComponent {
    readonly panels: ModPanel[];
    private readonly bg = new Graphics();
    private readonly header = new Graphics();
    private readonly title: Text;

    constructor(readonly category: ModCategory, mods: readonly ModInfo[]) {
        super();
        this.title = label(TITLES[category], { size: 16, weight: '700', color: 0xffffff });
        this.title.tint = modColors.background6;
        this.title.anchor.set(0, 0.5);
        this.addChild(this.bg, this.header, this.title);
        this.panels = mods.map(m => new ModPanel(m));
        for (const p of this.panels) this.addChild(p);
        // Static so clicks on the column body don't reach the backdrop (close).
        this.eventMode = 'static';
        this.setHeight(this.contentHeight);
    }

    /** Height needed to show every panel. */
    get contentHeight(): number {
        return HEADER + PAD + this.panels.length * (MOD_PANEL_HEIGHT + SPACING) - SPACING + PAD;
    }

    /** Columns share one height; the box width grows with the lean. */
    setHeight(h: number): void {
        this.resize(MOD_COLUMN_SPAN + h * SHEAR, h);
    }

    /** Lean offset of the left edge at height y. */
    private edgeX(y: number): number {
        return (this._h - y) * SHEAR;
    }

    protected override onResize(w: number, h: number): void {
        drawSheared(this.bg.clear(), 0, 0, w, h, RADIUS).fill(modColors.background5);
        // Header: the top band of the same parallelogram, rounded on top only.
        const color = modCategoryColor(this.category);
        const x0 = this.edgeX(0), x1 = this.edgeX(HEADER);
        this.header.clear().roundShape([
            { x: x0, y: 0, radius: RADIUS },
            { x: x0 + MOD_COLUMN_SPAN, y: 0, radius: RADIUS },
            { x: x1 + MOD_COLUMN_SPAN, y: HEADER, radius: 0 },
            { x: x1, y: HEADER, radius: 0 },
        ], RADIUS).fill(color);
        this.title.position.set(this.edgeX(HEADER / 2) + 16, HEADER / 2);
        const pw = MOD_COLUMN_SPAN - PAD * 2 + MOD_PANEL_HEIGHT * SHEAR;
        let y = HEADER + PAD;
        for (const p of this.panels) {
            p.resize(pw, MOD_PANEL_HEIGHT);
            p.position.set(Math.round(this.edgeX(y + MOD_PANEL_HEIGHT) + PAD), y);
            y += MOD_PANEL_HEIGHT + SPACING;
        }
    }
}
