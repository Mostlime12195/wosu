import { Container, Graphics, type Text } from 'pixi.js';
import { extendedModInfo, modInfo, type ModAcronym, type ModCategory, type ModSettingsMap } from '../../gameplay/mods';
import { label } from '../../ui/text';

/** lazer's OsuColour.ForModType. */
export function modCategoryColor(category: ModCategory): number {
    switch (category) {
        case 'reduction': return 0xb2ff66;
        case 'increase': return 0xff6666;
        case 'conversion': return 0x8c66ff;
        case 'automation': return 0x66ccff;
    }
}

export function modColor(acronym: ModAcronym): number {
    return modCategoryColor(modInfo(acronym).category);
}

/**
 * Compact mod badge: a rounded pill in the mod-type colour with the
 * acronym in a dark shade, like lazer's ModIcon. `size` is the pill height
 * (width follows at 1.6× size). `extended` is lazer's
 * ExtendedIconInformation (a custom rate's "1.30x"), shown on a dark tab
 * to the right of the pill.
 */
export class ModIcon extends Container {
    private readonly bg = new Graphics();
    private readonly text: Text;
    private readonly extendedText: Text | null = null;
    private readonly width_: number;

    constructor(readonly acronym: ModAcronym, readonly size = 24, extended = '') {
        super();
        const color = modColor(acronym);
        const w = Math.round(size * 1.6);
        const r = size * 0.35;
        let total = w;
        if (extended) {
            const ext = label(extended, { size: Math.round(size * 0.5), weight: '700', color });
            ext.anchor.set(0, 0.5);
            const extW = Math.ceil(ext.width + size * 0.45 + r);
            total = w + extW - r;
            this.bg.roundRect(w - r * 2, 0, extW + r, size, r).fill(0x1f1f24);
            ext.position.set(w + size * 0.15, size / 2);
            this.extendedText = ext;
        }
        this.bg.roundRect(0, 0, w, size, r).fill(color);
        // Darker inner band gives the lazer "plate" look.
        this.bg.roundRect(2, 2, w - 4, size - 4, Math.max(1, r - 2)).fill({ color: 0x000000, alpha: 0.12 });
        this.text = label(acronym, { size: Math.round(size * 0.55), weight: '800', color: 0x1f1f1f });
        this.text.anchor.set(0.5);
        this.text.position.set(w / 2, size / 2);
        this.addChild(this.bg, this.text);
        if (this.extendedText) this.addChild(this.extendedText);
        this.width_ = Math.round(total);
        this.eventMode = 'none';
    }

    get iconWidth(): number {
        return this.width_;
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

    /** `settings` (customised mod settings) adds a custom rate beside its acronym. */
    setMods(mods: Iterable<ModAcronym>, settings?: ModSettingsMap): void {
        for (const i of this.icons) i.destroy({ children: true });
        this.icons = [];
        let x = 0;
        for (const m of mods) {
            const icon = new ModIcon(m, this.iconHeight, extendedModInfo(m, settings));
            icon.x = x;
            x += icon.iconWidth + this.gap;
            this.icons.push(icon);
            this.addChild(icon);
        }
        this.rowWidth = Math.max(0, x - this.gap);
    }
}
