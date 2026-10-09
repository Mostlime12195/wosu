import { Container, type FederatedPointerEvent } from 'pixi.js';
import type { Game } from '../../../app/Game';
import type { DifficultySummary } from '../../../beatmap/types';
import { Signal } from '../../../core/Signal';
import { damp } from '../../../core/math';
import { ScrollContainer } from '../../../ui/ScrollContainer';
import { UIComponent } from '../../../ui/UIComponent';
import type { FilterEntry } from '../filter';
import { DIFF_HEIGHT, DiffPanel } from './DiffPanel';
import { SET_HEIGHT, SetPanel } from './SetPanel';

const SPACING = 6;
const SET_STRIDE = SET_HEIGHT + SPACING;
const DIFF_STRIDE = DIFF_HEIGHT + SPACING;
/** Extra rows kept alive above/below the viewport (px). */
const OVERSCAN = 120;
/** Horizontal inset of panels from the carousel's left edge. */
const BASE_X = 30;
/** Damping half-life (ms) shared by every carousel animation (expansion, selection slide). */
const EXPAND_RATE = 55;
/** How far the selected set (and its difficulties with it) slides left. */
const SET_SLIDE = 24;

interface Expansion {
    key: string;
    index: number;
    extra: number;
    p: number;
    target: number;
}

/**
 * osu!lazer's beatmap carousel, virtualized.
 *
 * Row positions are analytic: set i sits at i × stride plus the animated
 * extra height of expanded sets above it (only the selected set expands,
 * plus one collapsing), so locating the visible window is a binary search
 * and only on-screen panels exist (pooled and re-pointed while scrolling).
 * Panels follow lazer's circular curve: they drift right with distance
 * from the vertical centre.
 */
export class BeatmapCarousel extends UIComponent {
    readonly selectionChanged = new Signal<[entry: FilterEntry, diff: DifficultySummary]>();
    readonly activated = new Signal<[entry: FilterEntry, diff: DifficultySummary]>();
    readonly scroll = new ScrollContainer();
    // Difficulties render beneath set headers so they slide out from under them.
    private readonly diffLayer = new Container();
    private readonly setLayer = new Container();

    private entries: FilterEntry[] = [];
    private readonly indexByKey = new Map<string, number>();
    private selIndex = -1;
    private selDiff = 0;
    private expansions: Expansion[] = [];
    private readonly setPool: SetPanel[] = [];
    private readonly diffPool: DiffPanel[] = [];
    private activeSets = new Map<string, SetPanel>();
    private activeDiffs = new Map<string, DiffPanel>();
    private nextSets = new Map<string, SetPanel>();
    private nextDiffs = new Map<string, DiffPanel>();
    private follow = false;
    private readonly history: { key: string; file: string }[] = [];
    private padTop = 0;
    private padBottom = 0;
    /** Space covered by translucent chrome (filter control, footer). */
    private insetTop = 0;
    private insetBottom = 0;

    constructor(private readonly game: Game) {
        super();
        this.addChild(this.scroll);
        this.scroll.content.addChild(this.diffLayer, this.setLayer);
        this.scroll.wheelStep = SET_STRIDE * 1.5;
        this.scroll.on('wheel', () => (this.follow = false));
        this.scroll.on('rightdown', this.onRightDown, this);
        this.eventMode = 'passive';
        this.onFrame(dt => this.update(dt));
    }

    get selectedEntry(): FilterEntry | null {
        return this.entries[this.selIndex] ?? null;
    }

    get selectedDiff(): DifficultySummary | null {
        return this.selectedEntry?.diffs[this.selDiff] ?? null;
    }

    get count(): number {
        return this.entries.length;
    }

    /**
     * Panels scroll on behind translucent chrome; the selection centres in
     * the uncovered part.
     */
    setInsets(top: number, bottom: number): void {
        if (top === this.insetTop && bottom === this.insetBottom) return;
        this.insetTop = top;
        this.insetBottom = bottom;
        if (this._h > 0) this.relayout();
    }

    private get visibleHeight(): number {
        return Math.max(1, this._h - this.insetTop - this.insetBottom);
    }

    /** Viewport y the selection settles at. */
    private get centerY(): number {
        return this.insetTop + this.visibleHeight / 2;
    }

    // ------------------------------------------------------------------
    // Data
    // ------------------------------------------------------------------

    /**
     * Replace the displayed entries, keeping the selection on `keepKey`
     * (and difficulty file) when it is still present.
     */
    setEntries(entries: FilterEntry[], keepKey: string | null, keepFile: string | null): void {
        const prevIndex = this.selIndex;
        this.entries = entries;
        this.indexByKey.clear();
        entries.forEach((e, i) => this.indexByKey.set(e.set.key, i));
        this.expansions = this.expansions
            .map(x => ({ ...x, index: this.indexByKey.get(x.key) ?? -1 }))
            .filter(x => x.index >= 0)
            .map(x => ({ ...x, extra: this.extraFor(x.index) }));
        if (!entries.length) {
            this.selIndex = -1;
            this.expansions = [];
            return;
        }
        let idx = keepKey ? this.indexByKey.get(keepKey) ?? -1 : -1;
        let diff = 0;
        let diffKept = false;
        if (idx >= 0 && keepFile) {
            const j = entries[idx].diffs.findIndex(d => d.file === keepFile);
            diff = Math.max(0, j);
            diffKept = j >= 0;
        }
        const lost = idx < 0;
        if (lost) idx = Math.min(Math.max(0, prevIndex), entries.length - 1);
        this.selIndex = -1; // force select() to treat it as a change
        // Stay quiet only when the exact same difficulty is still selected
        // (a numeric filter can hide the selected difficulty but keep its set).
        this.select(idx, diff, { instant: true, silent: !lost && diffKept });
    }

    /** Height an expanded set adds below its header (its difficulty rows). */
    private extraFor(index: number): number {
        return (this.entries[index]?.diffs.length ?? 0) * DIFF_STRIDE;
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    select(index: number, diffIndex: number, opts: { instant?: boolean; silent?: boolean } = {}): void {
        if (!this.entries.length) return;
        index = Math.max(0, Math.min(this.entries.length - 1, index));
        const entry = this.entries[index];
        diffIndex = Math.max(0, Math.min(entry.diffs.length - 1, diffIndex));
        const setChanged = index !== this.selIndex;
        const diffChanged = setChanged || diffIndex !== this.selDiff;
        if (setChanged) {
            for (const x of this.expansions) x.target = 0;
            let ex = this.expansions.find(x => x.key === entry.set.key);
            if (!ex) {
                ex = { key: entry.set.key, index, extra: this.extraFor(index), p: 0, target: 1 };
                this.expansions.push(ex);
            }
            ex.target = 1;
        }
        this.selIndex = index;
        this.selDiff = diffIndex;
        if (opts.instant) {
            for (const x of this.expansions) x.p = x.target;
            this.expansions = this.expansions.filter(x => x.p > 0);
            this.updateContentHeight();
            this.scroll.scrollTo(this.finalCenterTarget(), false);
        }
        this.follow = true;
        if (diffChanged && !opts.silent) this.selectionChanged.emit(entry, entry.diffs[diffIndex]);
    }

    selectByKey(key: string, file?: string | null, opts: { instant?: boolean; silent?: boolean } = {}): boolean {
        const idx = this.indexByKey.get(key);
        if (idx === undefined) return false;
        const diff = file ? Math.max(0, this.entries[idx].diffs.findIndex(d => d.file === file)) : this.preferredDiff(idx);
        this.select(idx, diff, opts);
        return true;
    }

    /** Difficulty closest in stars to the current one (keeps the player's level). */
    private preferredDiff(index: number): number {
        const cur = this.selectedDiff;
        const diffs = this.entries[index].diffs;
        if (!cur || cur.stars === null) return 0;
        let best = 0, bestD = Infinity;
        diffs.forEach((d, i) => {
            const dist = Math.abs((d.stars ?? d.od) - (cur.stars as number));
            if (dist < bestD) {
                bestD = dist;
                best = i;
            }
        });
        return best;
    }

    moveDiff(delta: number): void {
        if (this.selIndex < 0) return;
        const entry = this.entries[this.selIndex];
        const next = this.selDiff + delta;
        if (next >= 0 && next < entry.diffs.length) {
            this.select(this.selIndex, next);
        } else if (delta > 0 && this.selIndex < this.entries.length - 1) {
            this.select(this.selIndex + 1, 0);
        } else if (delta < 0 && this.selIndex > 0) {
            this.select(this.selIndex - 1, this.entries[this.selIndex - 1].diffs.length - 1);
        }
    }

    moveSet(delta: number): void {
        if (this.selIndex < 0) return;
        const n = this.entries.length;
        const idx = ((this.selIndex + delta) % n + n) % n;
        this.select(idx, this.preferredDiff(idx));
    }

    first(): void {
        if (this.entries.length) this.select(0, this.preferredDiff(0));
    }

    last(): void {
        if (this.entries.length) this.select(this.entries.length - 1, this.preferredDiff(this.entries.length - 1));
    }

    random(): void {
        const n = this.entries.length;
        if (n === 0) return;
        const cur = this.selectedEntry, d = this.selectedDiff;
        if (cur && d) {
            this.history.push({ key: cur.set.key, file: d.file });
            if (this.history.length > 50) this.history.shift();
        }
        let idx = Math.floor(Math.random() * n);
        if (n > 1 && idx === this.selIndex) idx = (idx + 1 + Math.floor(Math.random() * (n - 1))) % n;
        this.select(idx, this.preferredDiff(idx));
    }

    rewind(): void {
        const prev = this.history.pop();
        if (prev) this.selectByKey(prev.key, prev.file);
    }

    /** Scroll a viewport up/down without changing the selection. */
    scrollPage(dir: -1 | 1): void {
        this.follow = false;
        this.scroll.scrollTo(this.scroll.scrollY + dir * this.visibleHeight * 0.8);
    }

    /** lazer: holding the right button scrolls to the pointer's relative height. */
    private onRightDown(e: FederatedPointerEvent): void {
        this.follow = false;
        this.scrollToPointer(e);
        this.scroll.on('globalpointermove', this.scrollToPointer, this);
        // Only one of rightup/rightupoutside fires: drop both, or the other piles up per click.
        const stop = () => {
            this.scroll.off('globalpointermove', this.scrollToPointer, this);
            this.scroll.off('rightup', stop);
            this.scroll.off('rightupoutside', stop);
        };
        this.scroll.on('rightup', stop);
        this.scroll.on('rightupoutside', stop);
    }

    private scrollToPointer(e: FederatedPointerEvent): void {
        const y = this.toLocal(e.global).y;
        const t = Math.min(1, Math.max(0, (y - this.insetTop) / this.visibleHeight));
        this.scroll.scrollTo(t * this.scroll.maxScroll);
    }

    activateSelected(): void {
        const e = this.selectedEntry, d = this.selectedDiff;
        if (e && d) this.activated.emit(e, d);
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    /** Content y of set i's header, excluding the top padding. */
    private yOf(i: number): number {
        let y = i * SET_STRIDE;
        for (const x of this.expansions) if (x.index < i) y += x.extra * x.p;
        return y;
    }

    private totalHeight(): number {
        return this.entries.length ? this.yOf(this.entries.length) - SPACING : 0;
    }

    /** Scroll position centring the selected difficulty once animations settle. */
    private finalCenterTarget(): number {
        if (this.selIndex < 0) return 0;
        const header = this.selIndex * SET_STRIDE; // only the selection stays expanded
        const diffY = header + SET_HEIGHT + SPACING + this.selDiff * DIFF_STRIDE;
        return this.padTop + diffY + DIFF_HEIGHT / 2 - this.centerY;
    }

    private updateContentHeight(): void {
        this.scroll.contentHeight = this.padTop + this.totalHeight() + this.padBottom;
    }

    protected override onResize(w: number, h: number): void {
        this.scroll.resize(w, h);
        this.padTop = Math.max(0, this.centerY - SET_HEIGHT / 2);
        this.padBottom = Math.max(0, h - this.centerY - SET_HEIGHT / 2);
        this.updateContentHeight();
        if (this.selIndex >= 0) this.scroll.scrollTo(this.finalCenterTarget(), false);
    }

    private firstVisible(top: number): number {
        let lo = 0, hi = this.entries.length - 1, ans = this.entries.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.yOf(mid + 1) - SPACING >= top) {
                ans = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        return ans;
    }

    private curveX(screenCenterY: number): number {
        // lazer's offsetX: panels ride a circle of radius 3 half-heights.
        const half = this.visibleHeight / 2 || 1;
        const d = (screenCenterY - this.centerY) / half;
        return BASE_X + (3 - Math.sqrt(Math.max(0, 9 - d * d))) * half;
    }

    update(dt: number): void {
        // Expansion animation (lazer slides difficulties out of the header).
        let animating = false;
        for (const x of this.expansions) {
            if (Math.abs(x.p - x.target) > 0.001) {
                x.p = damp(x.p, x.target, EXPAND_RATE, dt);
                animating = true;
            } else {
                x.p = x.target;
            }
        }
        // Drop fully collapsed sets (in place: this runs every frame).
        let keep = 0;
        for (const x of this.expansions) if (x.target > 0 || x.p > 0) this.expansions[keep++] = x;
        this.expansions.length = keep;
        this.updateContentHeight();
        if (this.scroll.isDragging) this.follow = false;
        if (this.follow) {
            this.scroll.scrollTo(this.finalCenterTarget(), true);
            if (!animating && Math.abs(this.scroll.scrollY - this.finalCenterTarget()) < 1) this.follow = false;
        }
        this.layoutPanels(dt);
    }

    private layoutPanels(dt: number): void {
        const scrollY = this.scroll.scrollY;
        const top = scrollY - this.padTop - OVERSCAN;
        const bottom = scrollY - this.padTop + this._h + OVERSCAN;
        const setW = this._w - BASE_X + 80;
        const diffW = setW - 40;
        const nextSets = this.nextSets;
        const nextDiffs = this.nextDiffs;
        nextSets.clear();
        nextDiffs.clear();

        const n = this.entries.length;
        for (let i = this.firstVisible(top); i < n; i++) {
            const y = this.yOf(i);
            if (y > bottom) break;
            const entry = this.entries[i];
            const key = entry.set.key;
            const selected = i === this.selIndex;
            const exp = this.expansionAt(i);
            const panel = this.takeSet(key, entry, selected);
            nextSets.set(key, panel);
            panel.resize(setW, SET_HEIGHT);
            panel.selectProgress = damp(panel.selectProgress, selected ? 1 : 0, EXPAND_RATE, dt);
            panel.drawSelection();
            const contentY = this.padTop + y;
            const screenY = contentY - scrollY;
            panel.y = contentY;
            panel.x = this.curveX(screenY + SET_HEIGHT / 2) - SET_SLIDE * panel.selectProgress;

            if (exp && exp.p > 0.005) {
                for (let j = 0; j < entry.diffs.length; j++) {
                    const dy = y + (SET_HEIGHT + SPACING + j * DIFF_STRIDE) * exp.p;
                    if (dy + DIFF_HEIGHT < top || dy > bottom) continue;
                    const diff = entry.diffs[j];
                    const dkey = `${key}|${diff.file}`;
                    const dSelected = selected && j === this.selDiff;
                    const dp = this.takeDiff(dkey, entry, diff, dSelected);
                    nextDiffs.set(dkey, dp);
                    dp.resize(diffW, DIFF_HEIGHT);
                    dp.selectProgress = damp(dp.selectProgress, dSelected ? 1 : 0, EXPAND_RATE, dt);
                    dp.drawSelection();
                    const dContentY = this.padTop + dy;
                    dp.y = dContentY;
                    // Children ride the set's own slide (one value for the family,
                    // so they never lag behind the header); the selected one
                    // steps out a little further.
                    dp.x = this.curveX(dContentY - scrollY + DIFF_HEIGHT / 2) + 40 - SET_SLIDE * panel.selectProgress - 20 * dp.selectProgress;
                    dp.alpha = Math.min(1, exp.p * 1.2);
                }
            }
        }
        // Recycle panels that scrolled away.
        for (const [k, p] of this.activeSets) if (!nextSets.has(k)) this.recycleSet(p);
        for (const [k, p] of this.activeDiffs) if (!nextDiffs.has(k)) this.recycleDiff(p);
        this.nextSets = this.activeSets;
        this.nextDiffs = this.activeDiffs;
        this.activeSets = nextSets;
        this.activeDiffs = nextDiffs;
    }

    /** Closure-free lookup (called per visible row per frame). */
    private expansionAt(index: number): Expansion | null {
        for (const x of this.expansions) if (x.index === index) return x;
        return null;
    }

    private takeSet(key: string, entry: FilterEntry, selected: boolean): SetPanel {
        let p = this.activeSets.get(key);
        if (!p) {
            p = this.setPool.pop() ?? this.createSetPanel();
            p.visible = true;
            p.selectProgress = selected ? 1 : 0;
        }
        p.assign(entry);
        return p;
    }

    private takeDiff(key: string, entry: FilterEntry, diff: DifficultySummary, selected: boolean): DiffPanel {
        let p = this.activeDiffs.get(key);
        if (!p) {
            p = this.diffPool.pop() ?? this.createDiffPanel();
            p.visible = true;
            p.selectProgress = selected ? 1 : 0;
        }
        p.assign(entry, diff);
        return p;
    }

    private createSetPanel(): SetPanel {
        const p = new SetPanel(this.game);
        this.setLayer.addChild(p);
        p.onClickPanel = entry => {
            const idx = this.indexByKey.get(entry.set.key);
            if (idx === undefined || idx === this.selIndex) return;
            this.select(idx, this.preferredDiff(idx));
        };
        return p;
    }

    private createDiffPanel(): DiffPanel {
        const p = new DiffPanel(this.game);
        this.diffLayer.addChild(p);
        p.onClickPanel = (entry, diff) => {
            const idx = this.indexByKey.get(entry.set.key);
            if (idx === undefined) return;
            const j = entry.diffs.indexOf(diff);
            if (idx === this.selIndex && j === this.selDiff) this.activated.emit(entry, diff);
            else this.select(idx, Math.max(0, j));
        };
        return p;
    }

    private recycleSet(p: SetPanel): void {
        p.release();
        p.visible = false;
        this.setPool.push(p);
    }

    private recycleDiff(p: DiffPanel): void {
        p.release();
        p.visible = false;
        this.diffPool.push(p);
    }

}
