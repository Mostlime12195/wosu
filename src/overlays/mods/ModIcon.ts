import { Container, Graphics, type Text } from 'pixi.js';
import { modInfo, type ModAcronym, type ModCategory } from '../../gameplay/mods';
import { label } from '../../ui/text';

/** lazer's OsuColour.ForModType. */
export function modCategoryColor(category: ModCategory): number {
    switch (category) {
        case 'reduction': return 0xb2ff66;
        case 'increase': return 0xff6666;
        case 'automation': return 0x66ccff;
    }
}

export function modColor(acronym: ModAcronym): number {
    return modCategoryColor(modInfo(acronym).category);
}

/**
 * Compact mod badge: a rounded pill in the mod-type colour with the
 * acronym in a dark shade, like lazer's ModIcon. `size` is the pill height
 * (width follows at 1.6× size).
 */
export class ModIcon extends Container {
    private readonly bg = new Graphics();
    private readonly text: Text;

    constructor(readonly acronym: ModAcronym, readonly size = 24) {
        super();
        const color = modColor(acronym);
        const w = Math.round(size * 1.6);
        const r = size * 0.35;
        this.bg.roundRect(0, 0, w, size, r).fill(color);
        // Darker inner band gives the lazer "plate" look.
        this.bg.roundRect(2, 2, w - 4, size - 4, Math.max(1, r - 2)).fill({ color: 0x000000, alpha: 0.12 });
        this.text = label(acronym, { size: Math.round(size * 0.55), weight: '800', color: 0x1f1f1f });
        this.text.anchor.set(0.5);
        this.text.position.set(w / 2, size / 2);
        this.addChild(this.bg, this.text);
        this.eventMode = 'none';
    }

    get iconWidth(): number {
        return Math.round(this.size * 1.6);
    }
}

/** Horizontal row of mod icons (leaderboards, loader, results). */
export class ModIconRow extends Container {
    private icons: ModIcon[] = [];
    rowWidth = 0;

    constructor(private readonly iconHeight = 20, private readonly gap = 3) {
        super();
        this.eventMode = 'none';
    }

    setMods(mods: Iterable<ModAcronym>): void {
        for (const i of this.icons) i.destroy({ children: true });
        this.icons = [];
        let x = 0;
        for (const m of mods) {
            const icon = new ModIcon(m, this.iconHeight);
            icon.x = x;
            x += icon.iconWidth + this.gap;
            this.icons.push(icon);
            this.addChild(icon);
        }
        this.rowWidth = Math.max(0, x - this.gap);
    }
}
