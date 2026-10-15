import { Container, Graphics, Sprite, type FederatedPointerEvent, type Text, type Texture } from 'pixi.js';
import { Screen } from '../../app/Screen';
import { Bindable, BindableNumber } from '../../core/Bindable';
import { parseOsu } from '../../beatmap/parser';
import { buildPlayableBeatmap, playableOptions } from '../../beatmap/processing';
import type { PlayableBeatmap } from '../../beatmap/types';
import { HUDOverlay } from '../../gameplay/hud/HUDOverlay';
import {
    ANCHORS, HUD_COMPONENTS, MAX_SCALE, MIN_SCALE, anchorFactor, anchorLabel, componentInfo, elementBounds, elementCorners, movedBy,
    newElement, normaliseDegrees, parseLayout, quadContains, scaledAbout, serialiseLayout, snapBox, withAnchor,
    withClosestAnchor, withOrigin, type Anchor, type Area, type HudElementLayout, type HudLayout, type Point, type Rect,
} from '../../gameplay/hud/layout/HudLayout';
import { hudLayouts } from '../../gameplay/hud/layout/HudLayoutStore';
import type { LeaderboardSource } from '../../gameplay/hud/leaderboard';
import { NO_MODS, playbackRate, sortedMods } from '../../gameplay/mods';
import { textureFromBlob } from '../../graphics/textures';
import { actionLabel, type Action } from '../../input/bindings';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Dropdown } from '../../ui/Dropdown';
import { icon, type IconName } from '../../ui/icons';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { Slider } from '../../ui/Slider';
import { fitText, label } from '../../ui/text';
import { Colors, ColorProvider } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { PreviewSimulation } from './previewSimulation';

const TOP = 56;
const LEFT_W = 260;
const RIGHT_W = 290;
const PAD = 14;
const HINT_H = 24;
const ROW_H = 30;
/** Screen pixels within which a dragged component snaps to the edges / centre. */
const SNAP_PX = 8;
const HANDLE = 9;
/** Property edits (sliders, nudges) become one undo step after this long without changes. */
const COMMIT_DELAY = 400;
const HISTORY_LIMIT = 100;

const colours = new ColorProvider('pink');
const ACCENT = Colors.pink;
const GUIDE = 0xff66aa;

/** Leaderboard rows for the preview (lazer's skin editor shows sample data too). */
const SAMPLE_SCORES: LeaderboardSource[] = [
    { player: 'Player A', score: 2_430_000, accuracy: 0.9871, maxCombo: 812, date: 0 },
    { player: 'Player B', score: 1_870_000, accuracy: 0.9652, maxCombo: 604, date: 0 },
    { player: 'Player C', score: 940_000, accuracy: 0.9410, maxCombo: 377, date: 0 },
];

/** A stand-in beatmap when nothing is selected: a minute of circles and sliders. */
function sampleBeatmap(): PlayableBeatmap {
    const objects: string[] = [];
    for (let i = 0; i < 150; i++) {
        const t = 2000 + i * 400;
        const x = Math.round(256 + 150 * Math.cos(i * 0.7));
        const y = Math.round(192 + 110 * Math.sin(i * 0.7));
        objects.push(i % 8 === 7 ? `${x},${y},${t},2,0,L|${Math.min(500, x + 90)}:${y},1,90` : `${x},${y},${t},1,0,0:0:0:0:`);
    }
    const text = [
        'osu file format v14', '[General]', 'AudioFilename: none.mp3', 'Mode: 0',
        '[Metadata]', 'Title:Sample beatmap', 'Artist:wosu!', 'Creator:wosu!', 'Version:Preview',
        '[Difficulty]', 'HPDrainRate:5', 'CircleSize:4', 'OverallDifficulty:8', 'ApproachRate:9', 'SliderMultiplier:1.4', 'SliderTickRate:1',
        '[TimingPoints]', '0,400,4,2,0,60,1,0', '[HitObjects]', ...objects, '',
    ].join('\n');
    return buildPlayableBeatmap(parseOsu(text), NO_MODS);
}

/** One row of the editor's lists: a caption plus icon buttons on the right. */
class ListRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly text: Text;
    private readonly buttons: IconButton[] = [];
    private readonly caption: string;

    constructor(caption: string, opts: { selected?: boolean; dim?: boolean; leading?: IconName; tooltip?: string; icons?: { name: IconName; tooltip: string; onClick: () => void; active?: boolean }[] } = {}) {
        super();
        this.caption = caption;
        this.text = label(caption, { size: 14, weight: opts.selected ? '700' : '500', color: opts.dim ? Colors.gray8 : 0xffffff });
        this.text.anchor.set(0, 0.5);
        this.addChild(this.bg, this.text);
        if (opts.leading) {
            const lead = icon(opts.leading, 11, colours.light1);
            lead.anchor.set(0.5);
            lead.position.set(14, ROW_H / 2);
            this.addChild(lead);
            this.text.x = 28;
        } else this.text.x = 10;
        for (const ic of opts.icons ?? []) {
            const b = new IconButton(ic.name, { size: 26, iconSize: 12 });
            b.tooltip = ic.tooltip;
            b.onActivate = ic.onClick;
            if (ic.active) b.active = true;
            this.buttons.push(b);
            this.addChild(b);
        }
        this.bg.alpha = opts.selected ? 1 : 0;
        this.tooltip = opts.tooltip ?? null;
        this.makeInteractive();
        this.selected = !!opts.selected;
        this.resize(200, ROW_H);
    }

    private selected = false;

    protected override onResize(w: number, h: number): void {
        this.bg.clear().roundRect(0, 0, w, h, 5).fill({ color: this.selected ? colours.dark2 : colours.background3 });
        this.text.y = h / 2;
        let x = w - 4;
        for (let i = this.buttons.length - 1; i >= 0; i--) {
            const b = this.buttons[i];
            x -= b.w;
            b.position.set(x, (h - b.h) / 2);
        }
        fitText(this.text, x - this.text.x - 4, this.caption);
    }

    protected override onHoverChange(hovered: boolean): void {
        if (!this.selected) this.bg.alpha = hovered ? 0.8 : 0;
    }
}

/** A titled section heading in the side panels. */
function heading(text: string): Text {
    return label(text.toUpperCase(), { size: 12, weight: '700', color: colours.light2, letterSpacing: 1 });
}

interface DragState {
    kind: 'move' | 'scale';
    id: string;
    start: HudElementLayout;
    pointer: Point;
    /** Scaling: the box corner (component units) that stays put, and where the dragged one started (area px). */
    fixed?: Point;
    fixedArea?: Point;
    handleArea?: Point;
    moved: boolean;
}

/**
 * lazer's skin editor (SkinEditor / SkinEditorOverlay, Ctrl+Shift+S) for
 * the gameplay HUD: the HUD over a looping gameplay preview, scaled into
 * the middle of the screen, with the components list and toolbox on the
 * left and the selected component's settings on the right.
 *
 * Click a component to select it, drag it to move (snapping to the
 * screen edges and centre lines, Shift to move freely), drag a corner to
 * scale it about the opposite corner. Anchors follow lazer: "Closest"
 * re-anchors to the nearest edge or corner as it moves. Layouts are kept
 * per skin (see HudLayoutStore); the HUD in gameplay uses the saved one.
 */
export class SkinEditorScreen extends Screen {
    override readonly hideToolbar = true;

    private readonly previewRoot = new Container();
    private readonly frame = new Graphics();
    private readonly frameMask = new Graphics();
    private readonly bgSprite = new Sprite();
    private readonly dim = new Graphics();
    private readonly playfieldOutline = new Graphics();
    private readonly overlay = new Graphics();
    private readonly hitLayer = new Graphics();
    private readonly topBar = new Container();
    private readonly topBg = new Graphics();
    private readonly title: Text;
    private readonly subtitle: Text;
    private readonly hint: Text;
    private readonly loadingText: Text;
    private readonly leftBg = new Graphics();
    private readonly rightBg = new Graphics();
    private readonly list = new ScrollContainer();
    private readonly props = new Container();
    private readonly undoButton = new IconButton('undo', { size: 34, iconSize: 14 });
    private readonly redoButton = new IconButton('redo', { size: 34, iconSize: 14 });
    private readonly resetButton = new Button('Reset to default', { color: colours.dark2, fontSize: 13 });
    private readonly revertButton = new Button('Revert', { color: colours.dark2, fontSize: 13 });
    private readonly saveButton = new Button('Save', { color: Colors.green, fontSize: 13, weight: '700' });
    private readonly closeButton = new Button('Close', { color: colours.dark3, fontSize: 13 });

    private hud: HUDOverlay | null = null;
    private sim: PreviewSimulation | null = null;
    private beatmap: PlayableBeatmap | null = null;
    private ownedBg: Texture | null = null;
    private rate = 1;
    private skinId = '';
    /** What is shown and edited; a capture of the built-in layout while `builtIn`. */
    private working: HudLayout | null = null;
    /** The skin's built-in layout is in effect (nothing saved / reset to default). */
    private builtIn = true;
    private savedKey = 'builtin';
    private history: { key: string; builtIn: boolean; layout: string }[] = [];
    private historyIndex = -1;
    private commitTimer: ReturnType<typeof setTimeout> | null = null;
    private selectedId: string | null = null;
    private hoverId: string | null = null;
    private drag: DragState | null = null;
    private guides: { x: number[]; y: number[] } = { x: [], y: [] };
    private shift = false;
    private view = { x: 0, y: 0, k: 1 };
    private previousDim = 0.2;
    private exiting = false;
    private readonly offs: (() => void)[] = [];

    // Selected component's settings.
    private syncing = false;
    private readonly anchorB = new Bindable<string>('closest');
    private readonly originB = new Bindable<string>('Centre');
    private readonly xB = new BindableNumber(0, -1500, 1500, 0.5);
    private readonly yB = new BindableNumber(0, -1500, 1500, 0.5);
    private readonly scaleB = new BindableNumber(1, MIN_SCALE, 5, 0.01);
    private readonly rotationB = new BindableNumber(0, -180, 180, 1);
    private readonly visibleB = new Bindable(true);

    constructor() {
        super();
        this.title = label('Skin layout editor', { size: 18, weight: '700' });
        this.subtitle = label('', { size: 13, weight: '500', color: Colors.grayA });
        this.hint = label('', { size: 12, weight: '500', color: Colors.gray9 });
        this.hint.anchor.set(0.5, 0);
        this.loadingText = label('Loading preview…', { size: 16, weight: '600', color: Colors.grayC });
        this.loadingText.anchor.set(0.5);
    }

    override load(): void {
        const g = this.game;
        this.previewRoot.addChild(this.frame, this.bgSprite, this.dim, this.playfieldOutline, this.frameMask);
        this.previewRoot.mask = this.frameMask;
        this.hitLayer.eventMode = 'static';
        this.hitLayer.on('pointerdown', this.onDown, this);
        this.hitLayer.on('globalpointermove', this.onMove, this);
        this.hitLayer.on('pointerup', this.onUp, this);
        this.hitLayer.on('pointerupoutside', this.onUp, this);
        this.overlay.eventMode = 'none';

        this.undoButton.tooltip = 'Undo (Ctrl+Z)';
        this.redoButton.tooltip = 'Redo (Ctrl+Y)';
        this.undoButton.onActivate = () => this.undo();
        this.redoButton.onActivate = () => this.redo();
        this.resetButton.tooltip = "Go back to the skin's built-in layout (save to keep it)";
        this.resetButton.onActivate = () => this.resetToDefault();
        this.revertButton.tooltip = 'Undo every change since the last save';
        this.revertButton.onActivate = () => this.revert();
        this.saveButton.tooltip = 'Save this layout for the skin (Ctrl+S)';
        this.saveButton.onActivate = () => this.save();
        this.closeButton.onActivate = () => this.requestExit();
        this.topBar.addChild(this.topBg, this.title, this.subtitle, this.undoButton, this.redoButton, this.resetButton, this.revertButton, this.saveButton, this.closeButton);
        this.addChild(this.previewRoot, this.hitLayer, this.overlay, this.leftBg, this.list, this.rightBg, this.props, this.topBar, this.hint, this.loadingText);
        this.eventMode = 'passive';

        for (const b of [this.anchorB, this.originB, this.xB, this.yB, this.scaleB, this.rotationB, this.visibleB] as Bindable<unknown>[]) {
            this.offs.push(b.changed.add(() => this.onPropertyChanged(b)));
        }
        // Settings that move the built-in layout: recapture it.
        const s = g.settings;
        for (const b of [s.hudScale, s.progressBar, s.progressGraph, s.hudScore, s.keyOverlayStyle, s.hudAccuracy] as { changed: { add(fn: () => void): () => void } }[]) {
            this.offs.push(b.changed.add(() => queueMicrotask(() => this.recaptureBuiltIn())));
        }
        this.offs.push(g.skins.current.changed.add(() => this.rebuild()));
        const shiftKeys = (e: KeyboardEvent) => (this.shift = e.shiftKey);
        window.addEventListener('keydown', shiftKeys);
        window.addEventListener('keyup', shiftKeys);
        this.offs.push(() => window.removeEventListener('keydown', shiftKeys), () => window.removeEventListener('keyup', shiftKeys));
        this.hint.text = `Drag to move (Shift: no snapping) · drag a corner to scale · arrows nudge · Del removes · Ctrl+Z / Ctrl+Y · Ctrl+S saves · ${actionLabel(g.input.bindings, 'toggleSkinEditor')} or Esc closes`;
        void this.loadPreview();
    }

    override onEntering(previous: Screen | null): void {
        super.onEntering(previous);
        this.previousDim = this.game.background.dimLevel;
        this.game.background.setDim(0.85, 300);
    }

    override onExiting(next: Screen | null): number | false {
        this.game.background.setDim(this.previousDim, 300);
        return super.onExiting(next);
    }

    // ------------------------------------------------------------------
    // Preview
    // ------------------------------------------------------------------

    private async loadPreview(): Promise<void> {
        const g = this.game;
        const sel = g.selection.value;
        const mods = g.mods.value;
        const mechanics = g.settings.gameplayMechanics.value;
        let beatmap: PlayableBeatmap | null = null;
        if (sel) {
            try {
                const data = await g.library.loadBeatmap(sel.set.key, sel.diff.file);
                beatmap = buildPlayableBeatmap(data, mods, playableOptions(mechanics));
                if (!beatmap.hitObjects.length) beatmap = null;
            } catch (e) {
                console.warn('[skin editor] beatmap failed to load', e);
            }
            try {
                const blob = await g.library.getBackground(sel.set.key, sel.diff.file);
                const tex = blob ? await textureFromBlob(blob) : null;
                if (tex && !this.destroyed) {
                    this.ownedBg = tex;
                    this.bgSprite.texture = tex;
                } else if (tex) tex.destroy(true);
            } catch {
                /* the default background */
            }
        }
        if (this.destroyed) return;
        if (!this.ownedBg) this.bgSprite.texture = g.skin.defaultBackground;
        this.rate = beatmap ? playbackRate(mods) : 1;
        this.beatmap = beatmap ?? sampleBeatmap();
        this.loadingText.visible = false;
        this.rebuild();
    }

    /** (Re)build the preview HUD for the selected skin and load its saved layout. */
    private rebuild(): void {
        const g = this.game;
        if (!this.beatmap || this.destroyed) return;
        const beatmap = this.beatmap;
        const sel = g.selection.value;
        const mods = sel ? g.mods.value : NO_MODS;
        this.skinId = g.skins.currentInfo.value?.id ?? '';
        const saved = hudLayouts().get(this.skinId);
        this.hud?.destroy();
        const hud = (this.hud = new HUDOverlay(g.skins.chain(), beatmap, g.settings, {
            canFail: true,
            legacyLayout: g.skins.current.value !== null,
            playerName: g.settings.playerName.value || 'Guest',
            introStart: beatmap.startTime - 1500,
            layout: saved,
            mods,
            mechanics: g.settings.gameplayMechanics.value,
            beatmapInfo: sel
                ? { artist: sel.set.artist, title: sel.set.title, version: sel.diff.version, creator: sel.set.creator, stars: sel.diff.stars, mods: sortedMods(mods) }
                : undefined,
            editor: true,
        }));
        hud.setLeaderboardScores(SAMPLE_SCORES);
        this.previewRoot.addChildAt(hud, this.previewRoot.getChildIndex(this.frameMask));
        this.sim = new PreviewSimulation(beatmap);
        hud.layout(this._w, this._h);
        this.builtIn = !saved;
        this.working = saved ?? hud.captureLayout();
        this.savedKey = this.stateKey();
        this.history = [];
        this.historyIndex = -1;
        this.selectedId = null;
        this.commit();
        this.refreshAll();
    }

    /** While the built-in layout is in effect, keep `working` matching what it draws. */
    private recaptureBuiltIn(): void {
        if (!this.hud || !this.builtIn || this.destroyed) return;
        this.hud.layout(this._w, this._h);
        this.working = this.hud.captureLayout();
        this.refreshProps();
    }

    // ------------------------------------------------------------------
    // State, history, saving
    // ------------------------------------------------------------------

    private stateKey(): string {
        return this.builtIn || !this.working ? 'builtin' : serialiseLayout(this.working);
    }

    private get dirty(): boolean {
        return this.stateKey() !== this.savedKey;
    }

    /** Push the working layout to the preview. */
    private applyWorking(): void {
        if (!this.hud || !this.working) return;
        this.hud.setLayout(this.builtIn ? null : this.working);
    }

    /** About to change the layout: from the built-in one, it becomes a saved-style layout first. */
    private customise(): void {
        this.builtIn = false;
    }

    private commit(): void {
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.commitTimer = null;
        if (!this.working) return;
        const key = this.stateKey();
        if (this.history[this.historyIndex]?.key === key) return;
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push({ key, builtIn: this.builtIn, layout: serialiseLayout(this.working) });
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.historyIndex = this.history.length - 1;
        this.refreshTop();
    }

    private scheduleCommit(): void {
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.commitTimer = setTimeout(() => {
            this.commitTimer = null;
            this.commit();
        }, COMMIT_DELAY);
    }

    private restore(entry: { builtIn: boolean; layout: string }): void {
        this.builtIn = entry.builtIn;
        if (entry.builtIn) {
            this.hud?.setLayout(null);
            this.recaptureBuiltIn();
        } else {
            this.working = parseLayout(entry.layout);
            this.applyWorking();
        }
        if (this.selectedId && !this.working?.elements.some(e => e.id === this.selectedId)) this.selectedId = null;
        this.refreshAll();
    }

    private undo(): void {
        if (this.commitTimer) this.commit();
        if (this.historyIndex <= 0) return;
        this.historyIndex--;
        this.restore(this.history[this.historyIndex]);
    }

    private redo(): void {
        if (this.historyIndex >= this.history.length - 1) return;
        this.historyIndex++;
        this.restore(this.history[this.historyIndex]);
    }

    private resetToDefault(): void {
        if (this.builtIn) return;
        this.builtIn = true;
        this.hud?.setLayout(null);
        this.recaptureBuiltIn();
        this.selectedId = null;
        this.commit();
        this.refreshAll();
    }

    private revert(): void {
        if (!this.dirty) return;
        const saved = hudLayouts().get(this.skinId);
        this.restore({ builtIn: !saved, layout: saved ? serialiseLayout(saved) : '' });
        this.commit();
    }

    private save(): void {
        if (this.commitTimer) this.commit();
        hudLayouts().set(this.skinId, this.builtIn ? null : this.working);
        this.savedKey = this.stateKey();
        const name = this.skinName;
        this.game.notifications.success(this.builtIn ? `${name} uses its built-in HUD layout again.` : `Saved the HUD layout for ${name}.`);
        this.refreshTop();
    }

    private get skinName(): string {
        return this.game.skins.currentInfo.value?.name ?? 'wosu! (default skin)';
    }

    private requestExit(): void {
        if (this.exiting) return;
        if (!this.dirty) {
            this.exiting = true;
            this.exit();
            return;
        }
        void this.game.dialog.confirm({
            title: 'Save layout changes?',
            text: `You have unsaved changes to the HUD layout of ${this.skinName}.`,
            confirmText: 'Save and close',
            cancelText: 'Discard changes',
            icon: 'brush',
        }).then(ok => {
            if (this.destroyed || this.exiting) return;
            if (ok) this.save();
            this.exiting = true;
            this.exit();
        });
    }

    // ------------------------------------------------------------------
    // Editing operations
    // ------------------------------------------------------------------

    private get geometry(): { area: Area; areaX: number; unit: number } | null {
        if (!this.hud) return null;
        const a = this.hud.area;
        return { area: { w: a.w, h: a.h }, areaX: a.x, unit: a.unit };
    }

    private entry(id: string | null): HudElementLayout | null {
        return (id && this.working?.elements.find(e => e.id === id)) || null;
    }

    private boxOf(id: string): Rect | null {
        const c = this.hud?.components.find(e => e.id === id);
        return c ? c.box() : null;
    }

    /** Replace one element of the working layout and show it. */
    private updateEntry(next: HudElementLayout): void {
        if (!this.working) return;
        this.customise();
        const i = this.working.elements.findIndex(e => e.id === next.id);
        if (i < 0) return;
        this.working.elements[i] = next;
        this.applyWorking();
        this.refreshProps();
        this.refreshTop();
    }

    private select(id: string | null): void {
        if (id === this.selectedId) return;
        this.selectedId = id;
        this.refreshList();
        this.rebuildProps();
    }

    private addComponent(type: HudElementLayout['type']): void {
        const g = this.geometry;
        if (!this.working || !g) return;
        this.customise();
        // On top, so it shows even over a full-screen scorebar frame ("Send to back" puts it behind).
        const el = newElement(type, this.working.elements);
        this.working.elements.push(el);
        this.applyWorking();
        this.selectedId = el.id;
        this.commit();
        this.refreshAll();
    }

    private removeComponent(id: string): void {
        if (!this.working) return;
        this.customise();
        this.working.elements = this.working.elements.filter(e => e.id !== id);
        if (this.selectedId === id) this.selectedId = null;
        this.applyWorking();
        this.commit();
        this.refreshAll();
    }

    private toggleVisible(id: string): void {
        const el = this.entry(id);
        if (!el) return;
        this.updateEntry({ ...el, visible: !el.visible });
        this.commit();
        this.refreshList();
    }

    private reorder(id: string, toFront: boolean): void {
        if (!this.working) return;
        const i = this.working.elements.findIndex(e => e.id === id);
        if (i < 0) return;
        this.customise();
        const [el] = this.working.elements.splice(i, 1);
        if (toFront) this.working.elements.push(el);
        else this.working.elements.unshift(el);
        this.applyWorking();
        this.commit();
        this.refreshList();
    }

    private nudge(dx: number, dy: number): void {
        const el = this.entry(this.selectedId);
        const g = this.geometry;
        if (!el || !g) return;
        this.updateEntry({ ...el, x: el.x + dx, y: el.y + dy });
        this.scheduleCommit();
    }

    private onPropertyChanged(b: Bindable<unknown>): void {
        if (this.syncing) return;
        const el = this.entry(this.selectedId);
        const g = this.geometry;
        const box = el ? this.boxOf(el.id) : null;
        if (!el || !g || !box) return;
        let next = el;
        if (b === this.anchorB) {
            const v = this.anchorB.value;
            next = v === 'closest' ? withClosestAnchor({ ...el, fixedAnchor: false }, box, g.area, g.unit) : { ...withAnchor(el, v as Anchor, g.area, g.unit), fixedAnchor: true };
        } else if (b === this.originB) {
            next = { ...withOrigin(el, this.originB.value as Anchor, box, g.area, g.unit), fixedAnchor: true };
        } else if (b === this.xB) next = { ...el, x: this.xB.value };
        else if (b === this.yB) next = { ...el, y: this.yB.value };
        else if (b === this.scaleB) next = { ...el, scale: this.scaleB.value };
        else if (b === this.rotationB) next = { ...el, rotation: normaliseDegrees(this.rotationB.value) };
        else if (b === this.visibleB) next = { ...el, visible: this.visibleB.value };
        this.updateEntry(next);
        if (b === this.visibleB) this.refreshList();
        if (b === this.anchorB || b === this.originB || b === this.visibleB) this.commit();
        else this.scheduleCommit();
    }

    // ------------------------------------------------------------------
    // Pointer
    // ------------------------------------------------------------------

    private screenToArea(p: Point): Point {
        const g = this.geometry;
        const areaX = g ? g.areaX : 0;
        return { x: (p.x - this.view.x) / this.view.k - areaX, y: (p.y - this.view.y) / this.view.k };
    }

    private areaToScreen(p: Point): Point {
        const g = this.geometry;
        const areaX = g ? g.areaX : 0;
        return { x: this.view.x + (p.x + areaX) * this.view.k, y: this.view.y + p.y * this.view.k };
    }

    private cornersOf(el: HudElementLayout): Point[] | null {
        const g = this.geometry;
        const box = this.boxOf(el.id);
        if (!g || !box) return null;
        return elementCorners(el, box, g.area, g.unit);
    }

    /** The topmost component under an area point. */
    private pick(p: Point): string | null {
        const els = this.working?.elements ?? [];
        for (let i = els.length - 1; i >= 0; i--) {
            const q = this.cornersOf(els[i]);
            if (q && quadContains(q, p)) return els[i].id;
        }
        return null;
    }

    /** A scale handle of the selected component under a screen point (corner index). */
    private pickHandle(screen: Point): number {
        const el = this.entry(this.selectedId);
        const q = el ? this.cornersOf(el) : null;
        if (!q) return -1;
        for (let i = 0; i < 4; i++) {
            const s = this.areaToScreen(q[i]);
            if (Math.abs(s.x - screen.x) <= HANDLE && Math.abs(s.y - screen.y) <= HANDLE) return i;
        }
        return -1;
    }

    private onDown(e: FederatedPointerEvent): void {
        if (e.button !== 0 || !this.working) return;
        const screen = this.toLocal(e.global);
        const p = this.screenToArea(screen);
        const handle = this.pickHandle(screen);
        const sel = this.entry(this.selectedId);
        if (handle >= 0 && sel) {
            const box = this.boxOf(sel.id)!;
            const corner = (i: number): Point => ({ x: i === 0 || i === 3 ? box.x : box.x + box.w, y: i < 2 ? box.y : box.y + box.h });
            const q = this.cornersOf(sel)!;
            this.drag = { kind: 'scale', id: sel.id, start: { ...sel }, pointer: p, fixed: corner((handle + 2) % 4), fixedArea: q[(handle + 2) % 4], handleArea: q[handle], moved: false };
            return;
        }
        const id = this.pick(p);
        this.select(id);
        const el = this.entry(id);
        if (el) this.drag = { kind: 'move', id: el.id, start: { ...el }, pointer: p, moved: false };
    }

    private onMove(e: FederatedPointerEvent): void {
        const screen = this.toLocal(e.global);
        const p = this.screenToArea(screen);
        const d = this.drag;
        const g = this.geometry;
        if (!d) {
            if (!this.working) return;
            const inside = screen.x >= this.view.x && screen.y >= this.view.y && screen.x <= this.view.x + this._w * this.view.k && screen.y <= this.view.y + this._h * this.view.k;
            const handle = inside ? this.pickHandle(screen) : -1;
            this.hoverId = inside ? this.pick(p) : null;
            this.hitLayer.cursor = handle === 0 || handle === 2 ? 'nwse-resize' : handle === 1 || handle === 3 ? 'nesw-resize' : this.hoverId ? 'move' : 'default';
            return;
        }
        const box = this.boxOf(d.id);
        if (!g || !box) return;
        const dx = p.x - d.pointer.x, dy = p.y - d.pointer.y;
        if (!d.moved && Math.hypot(dx, dy) * this.view.k < 3) return;
        d.moved = true;
        let next: HudElementLayout;
        this.guides = { x: [], y: [] };
        if (d.kind === 'move') {
            next = movedBy(d.start, dx, dy, g.unit);
            if (!this.shift) {
                const snap = snapBox(elementBounds(next, box, g.area, g.unit), g.area, SNAP_PX / this.view.k);
                next = movedBy(next, snap.dx, snap.dy, g.unit);
                this.guides = { x: snap.guidesX, y: snap.guidesY };
            }
        } else {
            const f = d.fixedArea!, h0 = d.handleArea!;
            const diag = { x: h0.x - f.x, y: h0.y - f.y };
            const len2 = diag.x * diag.x + diag.y * diag.y;
            const ratio = len2 > 0 ? ((p.x - f.x) * diag.x + (p.y - f.y) * diag.y) / len2 : 1;
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(d.start.scale * ratio * 100) / 100));
            next = scaledAbout(d.start, scale, d.fixed!, box, g.area, g.unit);
        }
        next = withClosestAnchor(next, box, g.area, g.unit);
        this.updateEntry(next);
    }

    private onUp(): void {
        const d = this.drag;
        this.drag = null;
        this.guides = { x: [], y: [] };
        if (d?.moved) this.commit();
    }

    // ------------------------------------------------------------------
    // Keys
    // ------------------------------------------------------------------

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        const ctrl = e.ctrlKey || e.metaKey;
        if (this.game.input.matches(e, 'toggleSkinEditor')) {
            this.requestExit();
            return true;
        }
        if (ctrl && e.code === 'KeyZ') {
            if (e.shiftKey) this.redo();
            else this.undo();
            return true;
        }
        if (ctrl && e.code === 'KeyY') {
            this.redo();
            return true;
        }
        if (ctrl && e.code === 'KeyS') {
            this.save();
            return true;
        }
        if ((e.code === 'Delete' || e.code === 'Backspace') && this.selectedId) {
            this.removeComponent(this.selectedId);
            return true;
        }
        const step = e.shiftKey ? 10 : 1;
        const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (arrows[e.code] && this.selectedId && !ctrl) {
            this.nudge(...arrows[e.code]);
            return true;
        }
        if (action === 'back') {
            if (this.selectedId) this.select(null);
            else this.requestExit();
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Panels
    // ------------------------------------------------------------------

    private refreshAll(): void {
        this.refreshTop();
        this.refreshList();
        this.rebuildProps();
    }

    private refreshTop(): void {
        const dirty = this.dirty;
        this.subtitle.text = `${this.skinName} · ${this.builtIn ? 'built-in layout' : 'custom layout'}${dirty ? ' · unsaved changes' : ''}`;
        this.undoButton.enabled = this.historyIndex > 0;
        this.redoButton.enabled = this.historyIndex < this.history.length - 1;
        this.undoButton.alpha = this.undoButton.enabled ? 1 : 0.4;
        this.redoButton.alpha = this.redoButton.enabled ? 1 : 0.4;
        this.saveButton.enabled = dirty;
        this.revertButton.enabled = dirty;
        this.resetButton.enabled = !this.builtIn;
    }

    private refreshList(): void {
        const c = this.list.content;
        for (const child of c.removeChildren()) child.destroy({ children: true });
        const w = LEFT_W - PAD * 2;
        let y = 0;
        const head = (text: string) => {
            const t = heading(text);
            t.position.set(4, y + 6);
            c.addChild(t);
            y += 28;
        };
        head('Components');
        const els = this.working?.elements ?? [];
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            const comp = this.hud?.components.find(x => x.id === el.id);
            const hiddenBySettings = !!comp && !comp.allowed();
            const name = componentInfo(el.type).name + (el.id !== el.type ? ` (${el.id.split('-').pop()})` : '');
            const row = new ListRow(name, {
                selected: el.id === this.selectedId,
                dim: !el.visible || hiddenBySettings,
                tooltip: hiddenBySettings ? 'Hidden by the HUD settings (Settings → Gameplay → HUD)' : undefined,
                icons: [
                    { name: el.visible ? 'eye' : 'eyeSlash', tooltip: el.visible ? 'Hide' : 'Show', onClick: () => this.toggleVisible(el.id) },
                    { name: 'trash', tooltip: 'Remove', onClick: () => this.removeComponent(el.id) },
                ],
            });
            row.onActivate = () => this.select(el.id);
            row.resize(w, ROW_H);
            row.position.set(0, y);
            c.addChild(row);
            y += ROW_H + 2;
        }
        if (!els.length) {
            const empty = label('No components. Add some below.', { size: 13, color: Colors.gray9 });
            empty.position.set(4, y + 4);
            c.addChild(empty);
            y += 28;
        }
        y += 10;
        head('Add component');
        for (const info of HUD_COMPONENTS) {
            const row = new ListRow(info.name, { leading: 'plus', tooltip: info.description });
            row.onActivate = () => this.addComponent(info.type);
            row.resize(w, ROW_H);
            row.position.set(0, y);
            c.addChild(row);
            y += ROW_H + 2;
        }
        this.list.contentHeight = y + 10;
    }

    /** Build the settings of the selected component (or the help text). */
    private rebuildProps(): void {
        for (const child of this.props.removeChildren()) child.destroy({ children: true });
        const w = RIGHT_W - PAD * 2;
        let y = 0;
        const el = this.entry(this.selectedId);
        if (!el) {
            const t = heading('Selected component');
            this.props.addChild(t);
            const help = label(
                'Click a component in the preview (or the list) to select it.\n\nDrag to move it; it snaps to the screen edges and centre (hold Shift to move freely). Drag a corner to resize it.\n\nLayouts are saved per skin. "Reset to default" goes back to the skin\'s built-in layout.',
                { size: 13, weight: '500', color: Colors.grayB, wrap: w, lineHeight: 18 },
            );
            help.y = 26;
            this.props.addChild(help);
            return;
        }
        const info = componentInfo(el.type);
        const head = heading('Selected component');
        this.props.addChild(head);
        y += 22;
        const name = label(info.name, { size: 17, weight: '700' });
        name.y = y;
        this.props.addChild(name);
        y += 26;
        const desc = label(info.description, { size: 12, weight: '500', color: Colors.grayA, wrap: w, lineHeight: 16 });
        desc.y = y;
        this.props.addChild(desc);
        y += desc.height + 8;
        const comp = this.hud?.components.find(x => x.id === el.id);
        if (comp && !comp.allowed()) {
            const note = label('Hidden by the HUD settings (Settings → Gameplay → HUD).', { size: 12, weight: '600', color: Colors.yellow, wrap: w });
            note.y = y;
            this.props.addChild(note);
            y += note.height + 8;
        }
        const add = (c: UIComponent, h: number, caption?: string) => {
            if (caption) {
                const t = label(caption, { size: 13, weight: '600', color: Colors.grayC });
                t.y = y;
                this.props.addChild(t);
                y += 20;
            }
            c.resize(w, h);
            c.y = y;
            this.props.addChild(c);
            y += h + 8;
        };
        add(new Dropdown<string>([{ value: 'closest', label: 'Closest' }, ...ANCHORS.map(a => ({ value: a, label: anchorLabel(a) }))], this.anchorB, ACCENT), 34, 'Anchor');
        add(new Dropdown<string>(ANCHORS.map(a => ({ value: a, label: anchorLabel(a) })), this.originB, ACCENT), 34, 'Origin');
        add(new Slider('X', this.xB, { format: v => v.toFixed(1), keyStep: 1 }), 48);
        add(new Slider('Y', this.yB, { format: v => v.toFixed(1), keyStep: 1 }), 48);
        add(new Slider('Scale', this.scaleB, { format: v => `${v.toFixed(2)}x`, keyStep: 0.01 }), 48);
        add(new Slider('Rotation', this.rotationB, { format: v => `${v.toFixed(0)}°`, keyStep: 1 }), 48);
        add(new Checkbox('Visible', this.visibleB), 32);
        const half = (w - 8) / 2;
        const front = new Button('Bring to front', { color: colours.dark2, fontSize: 12 });
        front.onActivate = () => this.reorder(el.id, true);
        front.resize(half, 32).position.set(0, y);
        const back = new Button('Send to back', { color: colours.dark2, fontSize: 12 });
        back.onActivate = () => this.reorder(el.id, false);
        back.resize(half, 32).position.set(half + 8, y);
        this.props.addChild(front, back);
        y += 40;
        const remove = new Button('Remove component', { color: 0xc23a5a, fontSize: 13, icon: 'trash' });
        remove.onActivate = () => this.removeComponent(el.id);
        remove.resize(w, 34).position.set(0, y);
        this.props.addChild(remove);
        this.refreshProps();
    }

    /** Copy the selected component's values into its settings controls. */
    private refreshProps(): void {
        const el = this.entry(this.selectedId);
        if (!el) return;
        this.syncing = true;
        try {
            this.anchorB.value = el.fixedAnchor ? el.anchor : 'closest';
            this.originB.value = el.origin;
            this.xB.value = el.x;
            this.yB.value = el.y;
            this.scaleB.value = Math.min(this.scaleB.max, el.scale);
            this.rotationB.value = el.rotation;
            this.visibleB.value = el.visible;
        } finally {
            this.syncing = false;
        }
    }

    // ------------------------------------------------------------------
    // Layout and drawing
    // ------------------------------------------------------------------

    protected override onResize(w: number, h: number): void {
        const aw = w - LEFT_W - RIGHT_W - PAD * 2;
        const ah = h - TOP - PAD * 2 - HINT_H;
        const k = Math.max(0.1, Math.min(aw / w, ah / h));
        const x = LEFT_W + PAD + (aw - w * k) / 2;
        const y = TOP + PAD + (ah - h * k) / 2;
        this.view = { x, y, k };
        this.previewRoot.position.set(x, y);
        this.previewRoot.scale.set(k);
        this.frame.clear().rect(0, 0, w, h).fill(0x000000);
        this.frameMask.clear().rect(0, 0, w, h).fill(0xffffff);
        const tex = this.bgSprite.texture;
        if (tex && tex.width > 1) {
            const s = Math.max(w / tex.width, h / tex.height);
            this.bgSprite.scale.set(s);
            this.bgSprite.position.set((w - tex.width * s) / 2, (h - tex.height * s) / 2);
        }
        this.dim.clear().rect(0, 0, w, h).fill({ color: 0x000000, alpha: this.game ? this.game.settings.backgroundDim.value : 0.7 });
        // osu!'s 512×384 playfield in its 640×480 frame (as in gameplay), faintly.
        const ps = Math.min(w / 640, h / 480);
        this.playfieldOutline.clear()
            .roundRect((w - 512 * ps) / 2, (h - 384 * ps) / 2 + 8 * ps, 512 * ps, 384 * ps, 6 * ps)
            .stroke({ width: 2 / k, color: 0xffffff, alpha: 0.12 });
        this.hitLayer.clear().rect(x, y, w * k, h * k).fill({ color: 0x000000, alpha: 0.001 });
        this.hitLayer.hitArea = null;
        this.loadingText.position.set(x + (w * k) / 2, y + (h * k) / 2);
        this.hint.position.set(x + (w * k) / 2, y + h * k + 6);
        // Top bar.
        this.topBg.clear().rect(0, 0, w, TOP).fill(colours.background5).rect(0, TOP - 1, w, 1).fill({ color: 0xffffff, alpha: 0.06 });
        this.title.position.set(PAD + 4, 8);
        this.subtitle.position.set(PAD + 4, 32);
        let bx = w - PAD;
        const place = (c: UIComponent, bw: number) => {
            c.resize(bw, 34);
            bx -= bw;
            c.position.set(bx, (TOP - 34) / 2);
            bx -= 8;
        };
        place(this.closeButton, 80);
        place(this.saveButton, 90);
        place(this.revertButton, 90);
        place(this.resetButton, 140);
        place(this.redoButton, 34);
        place(this.undoButton, 34);
        // Side panels.
        this.leftBg.clear().rect(0, TOP, LEFT_W, h - TOP).fill(colours.background4);
        this.rightBg.clear().rect(w - RIGHT_W, TOP, RIGHT_W, h - TOP).fill(colours.background4);
        this.list.position.set(PAD, TOP + PAD);
        this.list.resize(LEFT_W - PAD * 2, h - TOP - PAD * 2);
        this.props.position.set(w - RIGHT_W + PAD, TOP + PAD);
        if (this.hud) {
            this.hud.layout(w, h);
            if (this.builtIn) this.recaptureBuiltIn();
        }
    }

    override update(dt: number): void {
        const hud = this.hud;
        const sim = this.sim;
        if (!hud || !sim) return;
        const ev = sim.advance(dt);
        for (const e of ev.hits) hud.onHit(e);
        for (let i = 0; i < ev.judgements; i++) hud.onJudgement();
        hud.update(dt, sim.state(this.rate));
        this.drawOverlay();
    }

    /** Selection box and handles, hover outline, snap guides (screen space, constant size). */
    private drawOverlay(): void {
        const g = this.overlay.clear();
        const geo = this.geometry;
        if (!geo || !this.working) return;
        const poly = (q: Point[]) => q.flatMap(p => {
            const s = this.areaToScreen(p);
            return [s.x, s.y];
        });
        const hover = this.hoverId !== this.selectedId ? this.entry(this.hoverId) : null;
        if (hover && !this.drag) {
            const q = this.cornersOf(hover);
            if (q) g.poly(poly(q)).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
        }
        const sel = this.entry(this.selectedId);
        if (sel) {
            const q = this.cornersOf(sel);
            if (q) {
                g.poly(poly(q)).fill({ color: ACCENT, alpha: 0.08 }).poly(poly(q)).stroke({ width: 2, color: ACCENT });
                for (const p of q) {
                    const s = this.areaToScreen(p);
                    g.rect(s.x - HANDLE / 2, s.y - HANDLE / 2, HANDLE, HANDLE).fill(0xffffff).stroke({ width: 1.5, color: ACCENT });
                }
                // The anchor point, and a line to the origin.
                const f = anchorFactor(sel.anchor);
                const a = this.areaToScreen({ x: geo.area.w * f.x, y: geo.area.h * f.y });
                const o = this.areaToScreen({ x: sel.x * geo.unit + geo.area.w * f.x, y: sel.y * geo.unit + geo.area.h * f.y });
                g.moveTo(a.x, a.y).lineTo(o.x, o.y).stroke({ width: 1, color: Colors.yellow, alpha: 0.7 });
                g.circle(o.x, o.y, 3.5).fill(Colors.yellow);
                g.circle(a.x, a.y, 5).stroke({ width: 2, color: Colors.yellow });
            }
        }
        const top = this.areaToScreen({ x: 0, y: 0 });
        const bottom = this.areaToScreen({ x: geo.area.w, y: geo.area.h });
        for (const x of this.guides.x) {
            const s = this.areaToScreen({ x, y: 0 });
            g.moveTo(s.x, top.y).lineTo(s.x, bottom.y).stroke({ width: 1, color: GUIDE, alpha: 0.9 });
        }
        for (const y of this.guides.y) {
            const s = this.areaToScreen({ x: 0, y });
            g.moveTo(top.x, s.y).lineTo(bottom.x, s.y).stroke({ width: 1, color: GUIDE, alpha: 0.9 });
        }
        // The legacy layout's 16:9 area on wider screens.
        if (geo.areaX > 0) g.rect(top.x, top.y, bottom.x - top.x, bottom.y - top.y).stroke({ width: 1, color: 0xffffff, alpha: 0.15 });
    }

    override destroy(options?: Parameters<Container['destroy']>[0]): void {
        if (this.commitTimer) clearTimeout(this.commitTimer);
        for (const off of this.offs) off();
        this.hud?.destroy();
        this.hud = null;
        super.destroy(options);
        this.ownedBg?.destroy(true);
        this.ownedBg = null;
    }
}
