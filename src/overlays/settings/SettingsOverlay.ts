import { Container, Graphics, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { icon, type IconName } from '../../ui/icons';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { ColorProvider, Colors, Metrics } from '../../ui/theme';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { audioSection } from './AudioSection';
import { gameplaySection } from './GameplaySection';
import { generalSection } from './GeneralSection';
import { graphicsSection } from './GraphicsSection';
import { inputSection } from './InputSection';
import { maintenanceSection } from './MaintenanceSection';
import { onlineSection } from './OnlineSection';
import type { SettingsRow } from './rows';
import { skinSection } from './SkinSection';
import type { SectionDef } from './types';

const SIDEBAR = Metrics.settingsSidebarWidth;
const CONTENT = Metrics.settingsWidth;
const HEADER = 136;
const colors = new ColorProvider('purple');

class SidebarButton extends UIComponent {
    private readonly wash = new Graphics();
    private readonly bar = new Graphics();
    private readonly glyph: Text;
    private _selected = false;

    constructor(iconName: IconName, title: string) {
        super();
        this.wash.alpha = 0;
        this.bar.alpha = 0;
        this.glyph = icon(iconName, 18, 0xffffff);
        this.addChild(this.wash, this.bar, this.glyph);
        this.tooltip = title;
        this.makeInteractive({ sounds: 'sidebar' });
        this.resize(SIDEBAR, 52);
    }

    set selected(v: boolean) {
        if (v === this._selected) return;
        this._selected = v;
        tween(this.bar, { alpha: v ? 1 : 0 }, { duration: 200 });
        tweenTint(this.glyph, v ? Colors.pink : 0xffffff, 200);
        tween(this.wash, { alpha: v ? 0.08 : this.hovered ? 0.05 : 0 }, { duration: 200 });
    }

    protected override onResize(w: number, h: number): void {
        this.wash.clear().rect(0, 0, w, h).fill(0xffffff);
        this.bar.clear().rect(0, 6, 3, h - 12).fill(Colors.pink);
        this.glyph.position.set(w / 2, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        if (!this._selected) tween(this.wash, { alpha: hovered ? 0.05 : 0 }, { duration: 150 });
    }
}

interface BuiltSection {
    def: SectionDef;
    header: Container;
    title: Text;
    subheaders: Text[];
    button: SidebarButton;
    top: number;
    shown: boolean;
}

/**
 * osu!lazer's settings panel: section sidebar on the far left, header +
 * search, then every section stacked in one scroll view. Typing anywhere
 * while it's open searches; rows that don't match collapse.
 */
export class SettingsOverlay extends Overlay {
    protected override readonly popInSample = 'UI/settings-pop-in';
    protected override readonly popOutSample = 'UI/overlay-pop-out';
    override readonly exclusive = false;
    private readonly panel = new Container();
    private readonly sidebarBg = new Graphics();
    private readonly contentBg = new Graphics();
    private readonly edge = new Graphics();
    private readonly title: Text;
    private readonly subtitle: Text;
    private readonly search: TextBox;
    private readonly scroll = new ScrollContainer();
    private readonly sidebar = new Container();
    private readonly empty: Text;
    private readonly sections: BuiltSection[] = [];
    private readonly rows: SettingsRow[] = [];
    private layoutQueued = false;
    private query = '';

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.3;
        this.title = label('settings', { size: 30, weight: '700' });
        this.subtitle = label('change the way wosu! behaves', { size: 14, weight: '500', color: colors.light3 });
        this.search = new TextBox({ placeholder: 'type to search', icon: 'search', color: colors.background6, alpha: 1, keepFocusOnCommit: true });
        this.empty = label('no matching settings', { size: 15, weight: '600', color: Colors.gray9 });
        this.empty.visible = false;
        this.scroll.padBottom = 120;

        this.panel.addChild(this.contentBg, this.sidebarBg, this.edge, this.sidebar, this.title, this.subtitle, this.search, this.scroll);
        this.scroll.content.addChild(this.empty);
        this.panel.eventMode = 'static';
        this.addChild(this.panel);

        const defs = [
            generalSection(game), graphicsSection(game), gameplaySection(game), audioSection(game),
            inputSection(game), skinSection(game), onlineSection(game), maintenanceSection(game),
        ];
        for (const def of defs) this.build(def);
        this.search.changed.add(v => {
            this.query = v.trim().toLowerCase();
            this.scroll.scrollTo(0, false);
            this.queueLayout();
        });
        this.scroll.scrolled.add(() => this.updateActiveSection());
        this.onFrame(() => {
            if (this.layoutQueued) {
                this.layoutQueued = false;
                this.layoutContent();
            }
        });
    }

    private build(def: SectionDef): void {
        const header = new Container();
        const title = label(def.title, { size: 24, weight: '700' });
        const underline = new Graphics().roundRect(0, 0, 36, 3, 1.5).fill(Colors.pink);
        underline.position.set(0, 36);
        header.addChild(title, underline);
        this.scroll.content.addChild(header);
        const subheaders: Text[] = [];
        for (const sub of def.subsections) {
            const t = label(sub.title.toUpperCase(), { size: 12, weight: '800', color: Colors.pinkLight, letterSpacing: 1 });
            subheaders.push(t);
            this.scroll.content.addChild(t);
            for (const row of sub.rows) {
                row.onLayoutChange = () => this.queueLayout();
                this.rows.push(row);
                this.scroll.content.addChild(row);
            }
        }
        const button = new SidebarButton(def.icon, def.title);
        button.onActivate = () => {
            const s = this.sections.find(x => x.def === def);
            if (s) this.scroll.scrollTo(s.top - 4);
        };
        this.sidebar.addChild(button);
        this.sections.push({ def, header, title, subheaders, button, top: 0, shown: true });
    }

    private queueLayout(): void {
        this.layoutQueued = true;
    }

    private layoutContent(): void {
        const q = this.query;
        let y = 8;
        let any = false;
        for (const s of this.sections) {
            const sectionMatch = !!q && s.def.title.toLowerCase().includes(q);
            let sectionShown = false;
            const subVisible: boolean[] = [];
            for (const sub of s.def.subsections) {
                const subMatch = sectionMatch || (!!q && sub.title.toLowerCase().includes(q));
                let anyRow = false;
                for (const row of sub.rows) {
                    row.filtered = !(subMatch || row.matches(q));
                    if (row.shown) anyRow = true;
                }
                subVisible.push(anyRow);
                if (anyRow) sectionShown = true;
            }
            s.shown = sectionShown;
            s.header.visible = sectionShown;
            if (!sectionShown) {
                s.subheaders.forEach(t => (t.visible = false));
                for (const sub of s.def.subsections) for (const row of sub.rows) row.visible = false;
                continue;
            }
            any = true;
            s.top = y;
            s.header.position.set(20, y + 12);
            y += 62;
            s.def.subsections.forEach((sub, i) => {
                const t = s.subheaders[i];
                t.visible = subVisible[i];
                if (!subVisible[i]) {
                    for (const row of sub.rows) row.visible = false;
                    return;
                }
                t.position.set(20, y + 6);
                y += 30;
                for (const row of sub.rows) {
                    row.visible = row.shown;
                    if (!row.shown) continue;
                    const h = row.measure(CONTENT);
                    row.position.set(0, y);
                    y += h;
                }
                y += 10;
            });
            y += 24;
        }
        this.empty.visible = !any;
        this.empty.position.set(20, 24);
        this.scroll.contentHeight = any ? y : 80;
        for (const s of this.sections) s.button.alpha = s.shown ? 1 : 0.35;
        this.updateActiveSection();
    }

    private updateActiveSection(): void {
        const y = this.scroll.scrollY + 40;
        let active: BuiltSection | null = null;
        for (const s of this.sections) if (s.shown && s.top <= y) active = s;
        active ??= this.sections.find(s => s.shown) ?? null;
        for (const s of this.sections) s.button.selected = s === active;
    }

    protected popIn(): void {
        this.relayout();
        this.panel.x = -(SIDEBAR + CONTENT);
        tween(this.panel, { x: 0 }, { duration: 500, ease: 'OutQuint' });
    }

    protected async popOut(): Promise<void> {
        this.search.blur();
        // Open dropdown menus live in the popup layer: don't leave them behind.
        for (const row of this.rows) row.onPanelHide?.();
        await tween(this.panel, { x: -(SIDEBAR + CONTENT) - 20 }, { duration: 400, ease: 'OutQuint' }).finished;
    }

    protected layout(_w: number, h: number): void {
        const top = this.game.toolbarOffset;
        const ph = h - top;
        this.panel.y = top;
        this.panel.hitArea = { contains: (x: number, y: number) => x >= 0 && x <= SIDEBAR + CONTENT && y >= 0 && y <= ph };
        this.sidebarBg.clear().rect(0, 0, SIDEBAR, ph).fill(colors.background6);
        this.contentBg.clear().rect(SIDEBAR, 0, CONTENT, ph).fill(colors.background5);
        this.edge.clear().rect(SIDEBAR + CONTENT, 0, 2, ph).fill({ color: 0x000000, alpha: 0.35 });
        this.title.position.set(SIDEBAR + 20, 16);
        this.subtitle.position.set(SIDEBAR + 20, 54);
        this.search.position.set(SIDEBAR + 20, 84);
        this.search.resize(CONTENT - 40, 38);
        this.scroll.position.set(SIDEBAR, HEADER);
        this.scroll.resize(CONTENT, Math.max(0, ph - HEADER));
        this.sections.forEach((s, i) => {
            s.button.position.set(0, 8 + i * 52);
        });
        this.layoutContent();
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (super.onKey(e, action)) return true;
        // Type-to-search, like lazer.
        if (!this.search.isFocused && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ') {
            this.search.focus();
            this.search.setValue(this.search.value + e.key);
            return true;
        }
        return false;
    }
}
