import { Graphics, type Text } from 'pixi.js';
import { modInfo, type ModAcronym, type ModCategory } from '../../gameplay/mods';
import { label } from '../../ui/text';
import { UIComponent } from '../../ui/UIComponent';

/** lazer mod-type colours, used for the small acronym pills. */
const CATEGORY_COLOR: Record<ModCategory, number> = {
    reduction: 0xb2ff66,
    increase: 0xff6666,
    conversion: 0x8c66ff,
    automation: 0x66ccff,
};

/**
 * Compact mod acronym pill (results panel only). `extended` is lazer's
 * ExtendedIconInformation: a custom rate reads "DT 1.30x".
 */
export class ModPill extends UIComponent {
    private readonly bg = new Graphics();
    private readonly text: Text;

    constructor(acronym: ModAcronym, extended = '') {
        super();
        const caption = extended ? `${acronym} ${extended}` : acronym;
        this.text = label(caption, { size: 12, weight: '800', color: 0x16161c });
        this.text.anchor.set(0.5);
        this.addChild(this.bg, this.text);
        this.tooltip = extended ? `${modInfo(acronym).name} (${extended})` : modInfo(acronym).name;
        this.eventMode = 'static';
        const w = extended ? Math.ceil(this.text.width + 16) : 36;
        this.bg.roundRect(0, 0, w, 20, 10).fill(CATEGORY_COLOR[modInfo(acronym).category]);
        this.resize(w, 20);
    }

    protected override onResize(w: number, h: number): void {
        this.text.position.set(w / 2, h / 2 + 0.5);
    }
}
