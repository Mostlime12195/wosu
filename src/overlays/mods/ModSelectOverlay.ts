import { Container, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { tween, tweener } from '../../core/Tweener';
import { MODS, modInfo, NO_MODS, scoreMultiplier, toggleMod, type ModCategory, type ModSet } from '../../gameplay/mods';
import type { Action } from '../../input/bindings';
import { BackButton } from '../../ui/Button';
import { drawSheared, SHEAR, ShearedButton } from '../../ui/ShearedButton';
import { label } from '../../ui/text';
import { Metrics } from '../../ui/theme';
import { tweenTint } from '../../ui/UIComponent';
import { ModColumn, MOD_COLUMN_SPAN } from './ModColumn';
import { modCategoryColor } from './ModIcon';
import { modColors, ModPanel } from './ModPanel';

const HEADER = 78;
const FOOTER = Metrics.footerHeight;
const COLUMN_GAP = 14;
/** Space between the last mod row and the footer. */
const COLUMN_FOOTER_GAP = 14;
const CATEGORIES: ModCategory[] = ['reduction', 'increase', 'automation'];
/** lazer's sequential hotkeys: one keyboard row per column. */
const HOTKEY_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

/**
 * lazer's ModSelectOverlay: slides up over song select with a header,
 * three leaning columns of mod panels (one per mod type) and a footer
 * with back / deselect-all. Toggling goes through `toggleMod`, so
 * incompatible mods drop out immediately and the panels follow
 * `game.mods`. Each column's mods also toggle from one keyboard row.
 */
export class ModSelectOverlay extends Overlay {
    protected override readonly popInSample = 'SongSelect/mod-column-pop-in';
    protected override readonly popOutSample = 'SongSelect/mod-select-overlay-pop-out';
    override readonly exclusive = false;
    private readonly headerLayer = new Container();
    private readonly headerBg = new Graphics();
    private readonly title: Text;
    private readonly description: Text;
    private readonly multiplier = new MultiplierDisplay();
    private readonly columnLayer = new Container();
    private readonly columns: ModColumn[];
    private readonly footerLayer = new Container();
    private readonly footerBg = new Graphics();
    private readonly back = new BackButton();
    private readonly deselect: ShearedButton;
    private readonly panels: ModPanel[] = [];
    private readonly hotkeys = new Map<string, ModPanel>();
    /** Resting y of each column (animations start from here). */
    private readonly columnY: number[] = [];

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.5;
        this.title = label('Mod Select', { size: 26, weight: '700' });
        this.description = label(
            'Mods provide different ways to enjoy gameplay. Some have an effect on the score you can achieve. Others are just for fun.',
            { size: 13, weight: '500', color: modColors.content2 },
        );
        this.headerLayer.addChild(this.headerBg, this.title, this.description, this.multiplier);
        this.headerLayer.eventMode = 'static';

        this.columns = CATEGORIES.map(c => new ModColumn(c, MODS.filter(m => m.category === c)));
        this.columns.forEach((col, ci) => {
            this.columnLayer.addChild(col);
            col.panels.forEach((p, pi) => {
                p.onToggle = () => this.togglePanel(p);
                const key = HOTKEY_ROWS[ci]?.[pi];
                if (key) this.hotkeys.set(`Key${key}`, p);
                this.panels.push(p);
            });
        });
        this.columnLayer.eventMode = 'passive';

        this.back.onActivate = () => {
            this.hide();
        };
        this.deselect = new ShearedButton('Deselect All', { color: modColors.background3, height: 38, width: 190, fontSize: 15 });
        this.deselect.onActivate = () => (this.game.mods.value = NO_MODS);
        this.footerLayer.addChild(this.footerBg, this.back, this.deselect);
        this.footerLayer.eventMode = 'passive';
        this.footerBg.eventMode = 'static';

        this.addChild(this.columnLayer, this.headerLayer, this.footerLayer);
        this.disposer.add(game.mods.bind(m => this.sync(m), true));
    }

    private togglePanel(p: ModPanel): void {
        const next = toggleMod(this.game.mods.value, p.mod.acronym);
        ModPanel.playToggleSound(next.has(p.mod.acronym));
        this.game.mods.value = next;
    }

    private sync(mods: ModSet): void {
        for (const p of this.panels) {
            const a = p.mod.acronym;
            const active = mods.has(a);
            const clashes = active ? [] : [...mods].filter(m => p.mod.incompatible.includes(m) || modInfo(m).incompatible.includes(a));
            p.setState(active, clashes.length > 0, clashes.map(m => modInfo(m).name).join(', '));
        }
        this.multiplier.setValue(scoreMultiplier(mods));
        this.deselect.enabled = mods.size > 0;
    }

    // ------------------------------------------------------------------

    protected layout(w: number, h: number): void {
        const top = this.game.toolbarOffset;
        const margin = w < 1000 ? 24 : 50;
        this.headerBg.clear().rect(0, top, w, HEADER).fill(modColors.background6)
            .rect(0, top + HEADER, w, 2).fill({ color: 0x000000, alpha: 0.3 });
        this.title.position.set(margin, top + 12);
        this.description.position.set(margin, top + 48);
        this.multiplier.position.set(w - margin - this.multiplier.w, top + (HEADER - this.multiplier.h) / 2);
        this.description.visible = this.description.x + this.description.width < this.multiplier.x - 20;

        // lazer anchors the column flow to the bottom: the panels end just
        // above the footer and the column bodies run on down behind it to
        // the screen's bottom edge, so the group grows upward. Side by
        // side, the columns share the tallest one's height; on narrow
        // (portrait) screens they stack instead. Either way the group
        // scales down when it doesn't fit.
        const availTop = top + HEADER + 24;
        const availBottom = h - FOOTER - COLUMN_FOOTER_GAP;
        const availH = availBottom - availTop;
        const behind = h - availBottom; // screen px hidden behind the footer
        const n = this.columns.length;
        const heights = this.columns.map(c => c.contentHeight);
        const colH = Math.max(...heights);
        const stackH = heights.reduce((a, b) => a + b, 0) + (n - 1) * COLUMN_GAP;
        // The lean (and so the width) depends on the extension, which is
        // fixed in screen px: settle the scale in two passes.
        const wideWidth = (s: number) => n * MOD_COLUMN_SPAN + (n - 1) * COLUMN_GAP + (colH + behind / s) * SHEAR;
        const stackWidth = (s: number) => MOD_COLUMN_SPAN + (heights[n - 1] + behind / s) * SHEAR;
        const fit = (width: (s: number) => number, contentH: number) => {
            let sc = Math.min(1, availH / contentH);
            for (let k = 0; k < 2; k++) sc = Math.max(0.3, Math.min(1, (w - 32) / width(sc), availH / contentH));
            return sc;
        };
        const wideScale = fit(wideWidth, colH);
        const stackScale = fit(stackWidth, stackH);
        this.columnY.length = 0;
        if (stackScale > wideScale * 1.15) {
            const ext = behind / stackScale;
            const stackW = stackWidth(stackScale);
            let y = 0;
            this.columns.forEach((c, i) => {
                c.setHeight(c.contentHeight + (i === n - 1 ? ext : 0));
                c.x = Math.round((stackW - c.w) / 2);
                this.columnY.push(y);
                y += c.h + COLUMN_GAP;
            });
            this.columnLayer.scale.set(stackScale);
            this.columnLayer.position.set(Math.round((w - stackW * stackScale) / 2), Math.round(availBottom - stackH * stackScale));
        } else {
            const ext = behind / wideScale;
            this.columns.forEach((c, i) => {
                c.setHeight(colH + ext);
                c.x = i * (MOD_COLUMN_SPAN + COLUMN_GAP);
                this.columnY.push(0);
            });
            this.columnLayer.scale.set(wideScale);
            this.columnLayer.position.set(Math.round((w - wideWidth(wideScale) * wideScale) / 2), Math.round(availBottom - colH * wideScale));
        }
        this.columns.forEach((c, i) => {
            if (!tweener.isTweening(c, 'y')) c.y = this.columnY[i];
        });

        this.footerBg.clear().rect(0, h - FOOTER, w, FOOTER).fill(modColors.background6)
            .rect(0, h - FOOTER - 2, w, 2).fill({ color: 0x000000, alpha: 0.3 });
        this.back.position.set(0, h - FOOTER);
        this.deselect.position.set(170, h - FOOTER + (FOOTER - this.deselect.h) / 2);
    }

    protected popIn(): void {
        this.relayout();
        this.headerLayer.y = -HEADER;
        this.headerLayer.alpha = 0;
        tween(this.headerLayer, { y: 0, alpha: 1 }, { duration: 400, ease: 'OutQuint' });
        this.footerLayer.y = FOOTER;
        tween(this.footerLayer, { y: 0 }, { duration: 400, ease: 'OutQuint' });
        this.columnLayer.alpha = 1;
        this.columns.forEach((c, i) => {
            c.y = this.columnY[i] + 120;
            c.alpha = 0;
            tween(c, { y: this.columnY[i], alpha: 1 }, { duration: 500, delay: i * 40, ease: 'OutQuint' });
        });
    }

    protected async popOut(): Promise<void> {
        tween(this.headerLayer, { y: -HEADER, alpha: 0 }, { duration: 300, ease: 'OutQuint' });
        tween(this.footerLayer, { y: FOOTER }, { duration: 300, ease: 'OutQuint' });
        this.columns.forEach((c, i) => tween(c, { y: this.columnY[i] + 120 }, { duration: 300, ease: 'OutQuint' }));
        await tween(this.columnLayer, { alpha: 0 }, { duration: 250, ease: 'OutQuint' }).finished;
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back' || action === 'toggleMods' || action === 'select') {
            this.hide();
            return true;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const panel = this.hotkeys.get(e.code);
        if (panel) {
            // Holding a hotkey must not flip the mod on every key repeat.
            if (!e.repeat) this.togglePanel(panel);
            return true;
        }
        // Swallow other typing so song select's type-to-search stays shut.
        return e.key.length === 1;
    }
}

/** lazer's score multiplier pill: caption + value tinted by direction. */
class MultiplierDisplay extends Container {
    readonly w = 230;
    readonly h = 42;
    private readonly bg = new Graphics();
    private readonly pill = new Graphics();
    private readonly caption: Text;
    private readonly value: Text;

    constructor() {
        super();
        this.caption = label('Score Multiplier', { size: 14, weight: '700', color: 0xffffff });
        this.caption.anchor.set(0, 0.5);
        this.value = label('1.00x', { size: 16, weight: '800', color: 0xffffff });
        this.value.anchor.set(0.5);
        drawSheared(this.bg, 0, 0, this.w, this.h, 8).fill(modColors.background4);
        const pw = 82;
        drawSheared(this.pill, this.w - pw - 6, 5, pw, this.h - 10, 6).fill(modColors.background6);
        this.caption.position.set(this.h * SHEAR + 12, this.h / 2);
        this.value.position.set(this.w - pw / 2 - 6 - 2, this.h / 2);
        this.addChild(this.bg, this.pill, this.caption, this.value);
        this.eventMode = 'none';
    }

    setValue(m: number): void {
        this.value.text = `${m.toFixed(2)}x`;
        const color = m > 1.0001 ? modCategoryColor('increase') : m < 0.9999 ? modCategoryColor('reduction') : 0xffffff;
        tweenTint(this.value, color, 200);
    }
}
