import { Container, type Texture } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import type { GameSettings, HudVisibility } from '../../settings/Settings';
import type { SkinChain } from '../../skin/SkinChain';
import type { Grade } from '../../storage/ScoreStore';
import type { GameplayButton } from '../input/GameplayInput';
import { NO_MODS, sortedMods, type ModSet } from '../mods';
import { DEFAULT_MECHANICS, type GameplayMechanics } from '../scoring/mechanics';
import { BreakOverlay } from './BreakOverlay';
import { LEADERBOARD_HEIGHT } from './GameplayLeaderboard';
import { createHudElement, LeaderboardElement, type HudElement, type HudEnv } from './HudElements';
import type { BeatmapInfo } from './InfoCounters';
import {
    builtInComponents, captureElement, cloneLayout, layoutUnit, originPoint, resolvePlacement,
    type Area, type HudLayout, type LayoutKind,
} from './layout/HudLayout';
import { hudLayouts } from './layout/HudLayoutStore';
import type { LeaderboardSource } from './leaderboard';
import { LivePerformance, type LiveScoreStats } from './livePerformance';

export interface HUDState {
    time: number;
    rate: number;
    score: number;
    accuracy: number;
    combo: number;
    /** Highest combo so far (the leaderboard's combo). */
    maxCombo: number;
    hp: number;
    grade: Grade;
    down: Record<GameplayButton, boolean>;
    counts: Record<GameplayButton, number>;
    /**
     * lazer's "local user playing": false before the first object, in
     * breaks, while paused and after failing or completing. "Hide during
     * gameplay" shows the HUD whenever this is false.
     */
    playing: boolean;
    /** Judgements so far (judgement counter, live pp). */
    stats?: LiveScoreStats;
    /** Every hit's timing error so far, in song ms (unstable rate). */
    hitErrors?: readonly number[];
}

export interface HUDOptions {
    /** False under NF / autoplay / relax / autopilot (lazer: "when you can't fail"). */
    canFail: boolean;
    /**
     * lazer's legacy HUD layout (an imported osu! skin is selected): the
     * progress pie by the accuracy instead of the progress bar, stable's
     * hit error bar at the bottom edge, the leaderboard above the combo.
     * Off for wosu!'s default skin, which keeps wosu!'s own layout.
     */
    legacyLayout?: boolean;
    /** Name on the player's leaderboard entry. */
    playerName?: string;
    /** The gameplay clock's start time (the progress pie's intro starts there). */
    introStart?: number;
    /** The selected skin ('' = wosu!'s default): its saved layout is used, if it has one. */
    skinId?: string;
    /** Use this layout (null: the built-in one) instead of the skin's saved layout (the skin editor). */
    layout?: HudLayout | null;
    /** Mods played (live pp, beatmap info). */
    mods?: ModSet;
    /** Judgement rules played (live pp: stable means classic slider accuracy). */
    mechanics?: GameplayMechanics;
    /** What the beatmap info component shows (default: the beatmap's metadata); read when one is built. */
    beatmapInfo?: BeatmapInfo | (() => BeatmapInfo);
    /** The skin editor's preview: always shown, with hidden components drawn faintly. */
    editor?: boolean;
}

/** lazer's HUDOverlay.FADE_DURATION / FADE_EASING. */
const FADE_DURATION = 300;
/** lazer's ToggleInGameInterface (Shift+Tab) cycle. */
const NEXT_MODE: Record<HudVisibility, HudVisibility> = { never: 'hideDuringGameplay', hideDuringGameplay: 'always', always: 'never' };
/** How faintly the skin editor shows hidden components. */
const EDITOR_HIDDEN_ALPHA = 0.3;

/**
 * Everything drawn over the playfield in screen space: score/accuracy
 * (top-right), health (top-left), combo (bottom-left), key overlay
 * (right), hit error meter and song progress (bottom), the gameplay
 * leaderboard (left), break info. With an imported skin, the layout is
 * lazer's legacy one (see HUDOptions.legacyLayout).
 *
 * The components are lazer's skinnable ones (see HudElements), laid out
 * either by the built-in rules below or by the skin's saved layout from
 * the skin editor (see layout/HudLayout), which can also add components
 * (beatmap info, unstable rate, live pp, judgement counter).
 * Score, accuracy, combo and health are lazer's legacy-skin components,
 * drawn from the skin chain in lazer's 1024×768 HUD units (so they size
 * like lazer with any osu! skin); the key overlay is stable's in the
 * legacy layout (wosu!-drawn keys when the skin has none) and otherwise
 * the skin's when it has inputoverlay images. Visibility follows lazer's HUD visibility mode
 * (fading as a whole), each element has its own toggle, and every
 * setting applies live.
 */
export class HUDOverlay extends Container {
    /** The fading part (lazer's hide targets); the break overlay stays outside it. */
    private readonly content = new Container();
    private readonly legacy: boolean;
    private readonly kind: LayoutKind;
    private readonly breakInfo: BreakOverlay;
    private readonly env: HudEnv;
    private elements: HudElement[] = [];
    /** The saved layout in effect, or null for the built-in one. */
    private custom: HudLayout | null = null;
    /** Ctrl held: show the HUD whatever the mode (lazer's HoldForHUD). */
    private holding = false;
    private playing = false;
    private shown: boolean | null = null;
    private unit = 1;
    /** lazer's HUD unit: 1024×768 fitted inside the screen, times the HUD scale. */
    private legacyUnit = 1;
    private w = 0;
    private h = 0;
    /** The layout area's width (legacy: at most 16:9) and its left edge. */
    private areaW = 0;
    private scores: readonly LeaderboardSource[] = [];
    private avatar: { tex: Texture | null; onTracked: boolean } | null = null;
    private perf: LivePerformance | null = null;
    private readonly offs: (() => void)[] = [];

    constructor(chain: SkinChain, private readonly beatmap: PlayableBeatmap, private readonly settings: GameSettings, private readonly opts: HUDOptions = { canFail: true }) {
        super();
        this.eventMode = 'none';
        this.content.eventMode = 'none';
        const legacy = (this.legacy = !!opts.legacyLayout);
        this.kind = legacy ? 'legacy' : 'default';
        this.breakInfo = new BreakOverlay(beatmap.breaks);
        if (opts.editor) this.breakInfo.visible = false;
        this.addChild(this.breakInfo, this.content);
        const hud = this;
        this.env = {
            chain, beatmap, settings, opts, legacy,
            performance: () => (this.perf ??= new LivePerformance(beatmap, opts.mods ?? NO_MODS, opts.mechanics ?? DEFAULT_MECHANICS)),
            beatmapInfo: () => this.beatmapInfo(),
            get leaderboardScores() {
                return hud.scores;
            },
        };
        const s = settings;
        const apply = () => this.applySettings();
        for (const b of [
            s.hudScore, s.hudAccuracy, s.hudCombo, s.hudHealthBar, s.hudHealthWhenCantFail, s.hudBreakOverlay,
            s.hitErrorMeter, s.keyOverlay, s.keyOverlayStyle, s.progressBar, s.progressGraph, s.hudScale, s.gameplayLeaderboard,
        ] as { bind(fn: () => void): () => void }[]) this.offs.push(b.bind(apply));
        this.offs.push(s.hudVisibility.bind(() => this.updateVisibility()));
        const saved = opts.layout !== undefined ? opts.layout : opts.skinId !== undefined ? hudLayouts().get(opts.skinId) : null;
        this.setLayout(saved);
        this.updateVisibility(true);
    }

    private beatmapInfo(): BeatmapInfo {
        const given = this.opts.beatmapInfo;
        if (given) return typeof given === 'function' ? given() : given;
        const m = this.beatmap.data.metadata;
        return { artist: m.artist, title: m.title, version: m.version, creator: m.creator, stars: null, mods: sortedMods(this.opts.mods ?? NO_MODS) };
    }

    // ------------------------------------------------------------------
    // Layout model
    // ------------------------------------------------------------------

    /** Which built-in layout applies without a saved one. */
    get layoutKind(): LayoutKind {
        return this.kind;
    }

    /** The saved layout in effect (a copy), or null when the built-in layout is. */
    get layoutInUse(): HudLayout | null {
        return this.custom ? cloneLayout(this.custom) : null;
    }

    /**
     * Switch layouts (null: the built-in one). Components that stay (same
     * id and type) keep their state; the rest are built or destroyed.
     */
    setLayout(layout: HudLayout | null): void {
        const wasCustom = !!this.custom;
        this.custom = layout ? cloneLayout(layout) : null;
        const wanted = this.custom ? this.custom.elements : builtInComponents(this.kind).map(type => ({ id: type, type }));
        // Same components in the same order (the editor moving one): just place them again.
        if (wasCustom && this.custom && wanted.length === this.elements.length && wanted.every((w, i) => this.elements[i].id === w.id && this.elements[i].type === w.type)) {
            this.applySettings();
            return;
        }
        const old = new Map(this.elements.map(e => [e.id, e]));
        const next: HudElement[] = [];
        for (const w of wanted) {
            let e = old.get(w.id);
            if (e && e.type === w.type) old.delete(w.id);
            else {
                e = createHudElement(w.id, w.type, this.env);
                if (e instanceof LeaderboardElement && this.avatar) e.view.setAvatar(this.avatar.tex, this.avatar.onTracked);
            }
            next.push(e);
        }
        for (const e of old.values()) e.destroy();
        this.content.removeChildren();
        this.elements = next;
        for (const e of next) {
            // The built-in rules place the components themselves.
            if (!this.custom) {
                e.slot.position.set(0, 0);
                e.slot.scale.set(1);
                e.slot.rotation = 0;
            }
            this.content.addChild(e.slot);
        }
        this.updateLeaderboardExpanded();
        this.applySettings();
    }

    /** The components, in draw order. */
    get components(): readonly HudElement[] {
        return this.elements;
    }

    /** The layout area (HUD-local: left edge `x`, size `w`×`h`) and its layout unit. */
    get area(): { x: number; w: number; h: number; unit: number } {
        return { x: this.content.x, w: this.areaW, h: this.h, unit: layoutUnit(this.areaW, this.h, this.settings.hudScale.value) };
    }

    /**
     * The layout as drawn right now: the saved one, or the built-in one
     * captured into anchors and offsets (what the editor starts from).
     */
    captureLayout(): HudLayout {
        if (this.custom) return cloneLayout(this.custom);
        const area: Area = { w: this.areaW, h: this.h };
        const unit = layoutUnit(this.areaW, this.h, this.settings.hudScale.value);
        return {
            version: 1,
            kind: this.kind,
            elements: this.elements.map(e => captureElement(e.id, e.type, { x: e.view.x, y: e.view.y }, e.view.scale.x, e.box(), area, unit)),
        };
    }

    // ------------------------------------------------------------------
    // Settings and visibility
    // ------------------------------------------------------------------

    /** Per-element toggles, key overlay style, graph and scale. */
    applySettings(): void {
        const editor = !!this.opts.editor;
        for (const e of this.elements) {
            e.applySettings();
            const entry = this.custom?.elements.find(x => x.id === e.id);
            const shown = e.allowed() && (entry ? entry.visible : true);
            e.slot.visible = shown || editor;
            e.slot.alpha = shown ? 1 : EDITOR_HIDDEN_ALPHA;
        }
        this.breakInfo.enabled = !editor && this.settings.hudBreakOverlay.value;
        // Bottom elements stack above the progress block only while it shows.
        if (this.w) this.layout(this.w, this.h);
    }

    /** lazer's HUDOverlay.updateVisibility: fade the whole HUD in or out. */
    private updateVisibility(instant = false): void {
        let show: boolean;
        if (this.holding || this.opts.editor) show = true;
        else {
            switch (this.settings.hudVisibility.value) {
                case 'never': show = false; break;
                case 'hideDuringGameplay': show = !this.playing; break;
                default: show = true;
            }
        }
        if (show === this.shown) return;
        this.shown = show;
        const c = this.content;
        if (show) c.visible = true;
        if (instant) {
            c.alpha = show ? 1 : 0;
            c.visible = show;
            return;
        }
        tween(c, { alpha: show ? 1 : 0 }, { duration: FADE_DURATION, ease: 'OutQuint' }).finished.then(() => {
            if (!this.shown && !this.destroyed) c.visible = false;
        });
    }

    set holdingForHud(v: boolean) {
        if (v === this.holding) return;
        this.holding = v;
        this.updateVisibility();
        this.updateLeaderboardExpanded();
    }

    private get leaderboards(): LeaderboardElement[] {
        return this.elements.filter((e): e is LeaderboardElement => e instanceof LeaderboardElement);
    }

    /** lazer's DrawableGameplayLeaderboard: collapsed while actively playing, unless holding for the HUD. */
    private updateLeaderboardExpanded(): void {
        for (const lb of this.leaderboards) lb.view.expanded = !this.playing || this.holding || !!this.opts.editor;
    }

    /** The beatmap's local scores, best first, for the leaderboard. */
    setLeaderboardScores(scores: readonly LeaderboardSource[]): void {
        this.scores = scores;
        for (const lb of this.leaderboards) lb.view.setScores(scores);
    }

    /** Every gameplay leaderboard in the layout (most have one). */
    readonly leaderboard = {
        /** The local player's picture on their scores (`onTracked`: also on the live entry). */
        setAvatar: (tex: Texture | null, onTracked = true): void => {
            this.avatar = { tex, onTracked };
            for (const lb of this.leaderboards) lb.view.setAvatar(tex, onTracked);
        },
    };

    /** Tab in game (lazer's ToggleInGameLeaderboard); the setting persists. */
    toggleLeaderboard(): boolean {
        const b = this.settings.gameplayLeaderboard;
        b.value = !b.value;
        return b.value;
    }

    /** Shift+Tab: Never → Hide during gameplay → Always → Never (persisted, like lazer). */
    cycleVisibilityMode(): HudVisibility {
        const b = this.settings.hudVisibility;
        b.value = NEXT_MODE[b.value];
        return b.value;
    }

    /** Draw everything at least once even if hidden, so nothing uploads mid-play (see PlayerScreen.warmUp). */
    revealForWarmUp(): () => void {
        const c = this.content;
        const was = { visible: c.visible, alpha: c.alpha };
        c.visible = true;
        c.alpha = 1;
        return () => {
            c.visible = was.visible;
            c.alpha = was.alpha;
        };
    }

    // ------------------------------------------------------------------
    // Placement
    // ------------------------------------------------------------------

    layout(fullWidth: number, h: number): void {
        this.w = fullWidth;
        this.h = h;
        this.breakInfo.position.set(fullWidth / 2, h / 2);
        this.breakInfo.layout(fullWidth);
        // osu! skins are drawn for screens up to 16:9 (full-screen frames in
        // scorebar-bg, scores meant to sit inside them): on wider screens the
        // legacy HUD keeps to a centred 16:9 area, as on a 16:9 monitor.
        const w = (this.areaW = this.legacy ? Math.min(fullWidth, h * 16 / 9) : fullWidth);
        this.content.x = (fullWidth - w) / 2;
        const base = Math.max(0.6, Math.min(1.6, h / 720));
        this.unit = base * this.settings.hudScale.value;
        this.legacyUnit = Math.min(w / 1024, h / 768) * this.settings.hudScale.value;
        if (this.custom) this.placeCustom();
        else this.placeBuiltIn();
    }

    /** A saved layout: each component at its anchor + offset, scaled and rotated about its origin. */
    private placeCustom(): void {
        const layout = this.custom;
        if (!layout) return;
        const area: Area = { w: this.areaW, h: this.h };
        const unit = layoutUnit(this.areaW, this.h, this.settings.hudScale.value);
        for (const entry of layout.elements) {
            const e = this.elements.find(x => x.id === entry.id);
            if (!e) continue;
            const pl = resolvePlacement(entry, area, unit);
            e.prepare(pl.scale, area);
            const o = originPoint(e.box(), entry.origin);
            e.view.scale.set(1);
            e.view.position.set(-o.x, -o.y);
            e.slot.position.set(pl.x, pl.y);
            e.slot.scale.set(pl.scale);
            e.slot.rotation = pl.rotation;
        }
    }

    private find(type: HudElement['type']): HudElement | null {
        return this.elements.find(e => e.type === type) ?? null;
    }

    /** The built-in layouts (wosu!'s default, lazer's legacy). */
    private placeBuiltIn(): void {
        const w = this.areaW, h = this.h;
        const unit = this.unit, lu = this.legacyUnit;
        const score = this.find('score');
        const accuracy = this.find('accuracy');
        // lazer's legacy layout: score 10 units in from the right edge; accuracy 17 in, 9 below it
        // (moved up into the score's place while the score is hidden).
        const scoreBelow = score && this.settings.hudScore.value ? score.box().h : 0;
        if (score) {
            score.view.scale.set(lu);
            score.view.position.set(w - 10 * lu, 0);
        }
        if (accuracy) {
            accuracy.view.scale.set(lu);
            accuracy.view.position.set(w - 17 * lu, (scoreBelow + 9) * lu);
        }
        const health = this.find('health');
        if (health) {
            health.view.position.set(0, 0);
            health.view.scale.set(lu);
        }
        // lazer: bottom-left, 10 units margin, scale 1.28.
        const combo = this.find('combo');
        if (combo) {
            combo.view.scale.set(1.28 * lu);
            combo.view.position.set(10 * lu, h - this.comboInset());
        }
        const progress = this.find('songProgress');
        if (progress) {
            progress.view.scale.set(unit);
            progress.view.position.set(0, h);
            progress.prepare(unit, { w, h });
        }
        const pie = this.find('legacySongProgress');
        if (pie && accuracy) {
            // lazer's legacy layout: right edge 18 units left of the accuracy, centred on it.
            const acc = accuracy.box();
            const top = scoreBelow + 9;
            pie.view.scale.set(lu);
            pie.view.position.set(w - (acc.w + 18) * lu, (top + acc.h / 2) * lu);
        }
        const legacyMeter = this.find('legacyHitErrorMeter');
        if (legacyMeter) {
            // lazer's legacy layout: bottom centre.
            legacyMeter.view.scale.set(lu);
            legacyMeter.view.position.set(w / 2, h);
        }
        const meter = this.find('hitErrorMeter');
        if (meter) {
            meter.view.scale.set(unit);
            meter.view.position.set(w / 2, h - this.bottomInset() - 14 * unit);
        }
        const keys = this.find('keyCounter');
        if (keys) (keys.view as Container & { place(w: number, h: number, unit: number, lu: number): void }).place(w, h, unit, lu);
        this.placeLeaderboard();
        this.placeModDisplay();
    }

    /**
     * lazer's HUDOverlay TopRightElements (where its ModDisplay lives): 10
     * units in from the right edge, 10 below the lowest top-right component
     * shown (score, accuracy, progress pie), like stable's mod icons under
     * the score.
     */
    private placeModDisplay(): void {
        const mods = this.find('modDisplay');
        if (!mods) return;
        const lu = this.legacyUnit;
        let bottom = 0;
        for (const e of this.elements) {
            if (e === mods || !e.allowed()) continue;
            if (e.type !== 'score' && e.type !== 'accuracy' && e.type !== 'legacySongProgress') continue;
            const b = e.box();
            bottom = Math.max(bottom, e.view.y + (b.y + b.h) * e.view.scale.y);
        }
        mods.view.scale.set(lu);
        mods.view.position.set(this.areaW - 10 * lu, bottom + 10 * lu);
    }

    /**
     * Legacy layout: lazer's OsuLegacySkinTransformer puts the leaderboard's
     * bottom-left 10 units in, above the combo counter (1.56 × its height
     * + 20, at the combo's 1.28 scale) and the spectator list's 185 units.
     * Default layout: wosu!'s own spot, centred on the left edge.
     */
    private placeLeaderboard(): void {
        const lu = this.legacyUnit;
        const lb = this.find('leaderboard');
        if (!lb) return;
        lb.view.scale.set(lu);
        lb.prepare(lu, { w: this.areaW, h: this.h });
        if (this.legacy) {
            const combo = this.find('combo');
            const comboHeight = combo ? -combo.box().y : 0;
            const above = (comboHeight * 1.56 + 20) * 1.28 + 185;
            lb.view.position.set(10 * lu, this.h - (above + LEADERBOARD_HEIGHT) * lu);
        } else lb.view.position.set(10 * lu, this.h / 2 - (LEADERBOARD_HEIGHT / 2) * lu);
    }

    private get progressShown(): boolean {
        const p = this.find('songProgress');
        return !!p && p.allowed();
    }

    /** Space the bottom HUD keeps clear for the song progress block. */
    private bottomInset(): number {
        const p = this.find('songProgress');
        const block = p && this.progressShown ? p.box().h : 0;
        return (this.progressShown ? block + 6 : 10) * this.unit;
    }

    /** lazer's margin under the combo counter, raised above the song progress block while it shows. */
    private comboInset(): number {
        return this.progressShown ? this.bottomInset() : 10 * this.legacyUnit;
    }

    // ------------------------------------------------------------------
    // Gameplay
    // ------------------------------------------------------------------

    onHit(error: number): void {
        for (const e of this.elements) e.onHit(error);
    }

    /** A successful judgement (any hit result, ticks included): the health bar flashes. */
    onJudgement(): void {
        for (const e of this.elements) e.onJudgement();
    }

    update(dt: number, s: HUDState): void {
        if (!this.w) return;
        if (s.playing !== this.playing) {
            this.playing = s.playing;
            this.updateVisibility();
            this.updateLeaderboardExpanded();
        }
        for (const e of this.elements) e.update(dt, s);
        this.breakInfo.update(s.time, s.accuracy, s.grade);
        if (this.custom) {
            // Components sized to their text keep their origin's edge in place.
            for (const entry of this.custom.elements) {
                const e = this.elements.find(x => x.id === entry.id);
                if (!e?.dynamicBox) continue;
                const o = originPoint(e.box(), entry.origin);
                e.view.position.set(-o.x, -o.y);
            }
        } else {
            // Combo sits above the progress graph when that is shown.
            const combo = this.find('combo');
            if (combo) combo.view.y = this.h - this.comboInset();
        }
    }

    isBreak(time: number): boolean {
        return this.breakInfo.breakAt(time) !== null;
    }

    override destroy(): void {
        for (const off of this.offs) off();
        for (const e of this.elements) e.destroy();
        this.elements = [];
        super.destroy({ children: true });
    }
}
