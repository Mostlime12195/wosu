import { Container } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import type { GameSettings, HudVisibility } from '../../settings/Settings';
import type { SkinChain } from '../../skin/SkinChain';
import type { Grade } from '../../storage/ScoreStore';
import type { GameplayButton } from '../input/GameplayInput';
import { BreakOverlay } from './BreakOverlay';
import { GameplayLeaderboard, LEADERBOARD_HEIGHT } from './GameplayLeaderboard';
import { HealthBar } from './HealthBar';
import { HitErrorMeter } from './HitErrorMeter';
import { KeyCounter, LegacyKeyCounter, type KeyOverlay } from './KeyCounter';
import type { LeaderboardSource } from './leaderboard';
import { LegacyBarHitErrorMeter } from './LegacyBarHitErrorMeter';
import { LegacySongProgress } from './LegacySongProgress';
import { ComboCounter, ScoreCounter } from './ScoreDisplay';
import { SongProgress } from './SongProgress';

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
}

/** lazer's HUDOverlay.FADE_DURATION / FADE_EASING. */
const FADE_DURATION = 300;
/** lazer's ToggleInGameInterface (Shift+Tab) cycle. */
const NEXT_MODE: Record<HudVisibility, HudVisibility> = { never: 'hideDuringGameplay', hideDuringGameplay: 'always', always: 'never' };

/**
 * Everything drawn over the playfield in screen space: score/accuracy
 * (top-right), health (top-left), combo (bottom-left), key overlay
 * (right), hit error meter and song progress (bottom), the gameplay
 * leaderboard (left), break info. With an imported skin, the layout is
 * lazer's legacy one (see HUDOptions.legacyLayout).
 * Score, accuracy, combo and health are lazer's legacy-skin components,
 * drawn from the skin chain in lazer's 1024×768 HUD units (so they size
 * like lazer with any osu! skin); the key overlay is the skin's when it
 * has inputoverlay images. Visibility follows lazer's HUD visibility mode
 * (fading as a whole), each element has its own toggle, and every
 * setting applies live.
 */
export class HUDOverlay extends Container {
    readonly errorMeter: HitErrorMeter | LegacyBarHitErrorMeter;
    readonly leaderboard: GameplayLeaderboard;
    /** The fading part (lazer's hide targets); the break overlay stays outside it. */
    private readonly content = new Container();
    private readonly score: ScoreCounter;
    private readonly combo: ComboCounter;
    private readonly health: HealthBar;
    /** wosu!'s progress bar (default layout) or lazer's legacy pie. */
    private readonly progress: SongProgress | null = null;
    private readonly pie: LegacySongProgress | null = null;
    private readonly legacy: boolean;
    private readonly keys: KeyOverlay;
    private readonly breakInfo: BreakOverlay;
    /** Ctrl held: show the HUD whatever the mode (lazer's HoldForHUD). */
    private holding = false;
    private playing = false;
    private shown: boolean | null = null;
    private unit = 1;
    /** lazer's HUD unit: 1024×768 fitted inside the screen, times the HUD scale. */
    private legacyUnit = 1;
    private w = 0;
    private h = 0;
    private readonly offs: (() => void)[] = [];

    constructor(chain: SkinChain, beatmap: PlayableBeatmap, private readonly settings: GameSettings, private readonly opts: HUDOptions = { canFail: true }) {
        super();
        this.eventMode = 'none';
        this.content.eventMode = 'none';
        const d = beatmap.difficulty;
        this.score = new ScoreCounter(chain);
        this.combo = new ComboCounter(chain);
        this.health = new HealthBar(chain);
        const legacy = (this.legacy = !!opts.legacyLayout);
        if (legacy) this.pie = new LegacySongProgress(opts.introStart ?? beatmap.startTime - 1500, beatmap.startTime, beatmap.endTime);
        else this.progress = new SongProgress(beatmap);
        this.keys = LegacyKeyCounter.create(chain, settings.keyOverlayStyle.value) ?? new KeyCounter(settings.keyOverlayStyle.value);
        this.errorMeter = legacy
            ? new LegacyBarHitErrorMeter(d.window300, d.window100, d.window50)
            : new HitErrorMeter(d.window300, d.window100, d.window50);
        this.leaderboard = new GameplayLeaderboard(opts.playerName ?? 'Guest');
        this.breakInfo = new BreakOverlay(beatmap.breaks);
        // lazer: health bars in front of everything else (for full-screen health bar skins).
        this.content.addChild(...[this.progress, this.pie].filter(c => c !== null), this.errorMeter, this.keys, this.leaderboard, this.score, this.combo, this.health);
        this.addChild(this.breakInfo, this.content);
        const s = settings;
        const apply = () => this.applySettings();
        for (const b of [
            s.hudScore, s.hudAccuracy, s.hudCombo, s.hudHealthBar, s.hudHealthWhenCantFail, s.hudBreakOverlay,
            s.hitErrorMeter, s.keyOverlay, s.keyOverlayStyle, s.progressBar, s.progressGraph, s.hudScale, s.gameplayLeaderboard,
        ] as { bind(fn: () => void): () => void }[]) this.offs.push(b.bind(apply));
        this.offs.push(s.hudVisibility.bind(() => this.updateVisibility()));
        this.applySettings();
        this.updateVisibility(true);
    }

    /** Per-element toggles, key overlay style, graph and scale. */
    applySettings(): void {
        const s = this.settings;
        this.score.setShown(s.hudScore.value, s.hudAccuracy.value);
        this.score.visible = s.hudScore.value || s.hudAccuracy.value;
        this.combo.visible = s.hudCombo.value;
        this.health.visible = s.hudHealthBar.value && (this.opts.canFail || s.hudHealthWhenCantFail.value);
        this.errorMeter.visible = s.hitErrorMeter.value;
        this.keys.visible = s.keyOverlay.value;
        this.keys.setStyle(s.keyOverlayStyle.value);
        if (this.progress) {
            this.progress.visible = s.progressBar.value;
            this.progress.showGraph = s.progressGraph.value;
        }
        if (this.pie) this.pie.visible = s.progressBar.value;
        this.leaderboard.shown = s.gameplayLeaderboard.value;
        this.breakInfo.enabled = s.hudBreakOverlay.value;
        // Bottom elements stack above the progress block only while it shows.
        if (this.w) this.layout(this.w, this.h);
    }

    /** lazer's HUDOverlay.updateVisibility: fade the whole HUD in or out. */
    private updateVisibility(instant = false): void {
        let show: boolean;
        if (this.holding) show = true;
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

    /** lazer's DrawableGameplayLeaderboard: collapsed while actively playing, unless holding for the HUD. */
    private updateLeaderboardExpanded(): void {
        this.leaderboard.expanded = !this.playing || this.holding;
    }

    /** The beatmap's local scores, best first, for the leaderboard. */
    setLeaderboardScores(scores: readonly LeaderboardSource[]): void {
        this.leaderboard.setScores(scores);
    }

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

    layout(fullWidth: number, h: number): void {
        this.w = fullWidth;
        this.h = h;
        this.breakInfo.position.set(fullWidth / 2, h / 2);
        this.breakInfo.layout(fullWidth);
        // osu! skins are drawn for screens up to 16:9 (full-screen frames in
        // scorebar-bg, scores meant to sit inside them): on wider screens the
        // legacy HUD keeps to a centred 16:9 area, as on a 16:9 monitor.
        const w = this.legacy ? Math.min(fullWidth, h * 16 / 9) : fullWidth;
        this.content.x = (fullWidth - w) / 2;
        const base = Math.max(0.6, Math.min(1.6, h / 720));
        const unit = (this.unit = base * this.settings.hudScale.value);
        const lu = (this.legacyUnit = Math.min(w / 1024, h / 768) * this.settings.hudScale.value);
        this.score.position.set(w, 0);
        this.score.scale.set(lu);
        this.health.position.set(0, 0);
        this.health.scale.set(lu);
        // lazer: bottom-left, 10 units margin, scale 1.28.
        this.combo.scale.set(1.28 * lu);
        this.combo.position.set(10 * lu, h - this.comboInset());
        if (this.progress) {
            this.progress.scale.set(unit);
            this.progress.position.set(0, h);
            this.progress.layout(w / unit);
        }
        if (this.pie) {
            // lazer's legacy layout: right edge 18 units left of the accuracy, centred on it.
            const acc = this.score.accuracyBox;
            this.pie.scale.set(lu);
            this.pie.position.set(w - (acc.width + 18) * lu, (acc.top + acc.height / 2) * lu);
        }
        if (this.errorMeter instanceof LegacyBarHitErrorMeter) {
            // lazer's legacy layout: bottom centre.
            this.errorMeter.scale.set(lu);
            this.errorMeter.position.set(w / 2, h);
        } else {
            this.errorMeter.position.set(w / 2, h - this.bottomInset() - 14 * unit);
            this.errorMeter.layout(220 * unit, unit);
        }
        this.keys.place(w, h, unit, lu);
        this.placeLeaderboard();
    }

    /**
     * Legacy layout: lazer's OsuLegacySkinTransformer puts the leaderboard's
     * bottom-left 10 units in, above the combo counter (1.56 × its height
     * + 20, at the combo's 1.28 scale) and the spectator list's 185 units.
     * Default layout: wosu!'s own spot, centred on the left edge.
     */
    private placeLeaderboard(): void {
        const lu = this.legacyUnit;
        const lb = this.leaderboard;
        lb.scale.set(lu);
        lb.setTextResolution(lu * (globalThis.devicePixelRatio || 1));
        if (this.legacy) {
            const above = (this.combo.textHeight * 1.56 + 20) * 1.28 + 185;
            lb.position.set(10 * lu, this.h - (above + LEADERBOARD_HEIGHT) * lu);
        } else lb.position.set(10 * lu, this.h / 2 - (LEADERBOARD_HEIGHT / 2) * lu);
    }

    /** Space the bottom HUD keeps clear for the song progress block. */
    private bottomInset(): number {
        return (this.progress?.visible ? this.progress.blockHeight + 6 : 10) * this.unit;
    }

    /** lazer's margin under the combo counter, raised above the song progress block while it shows. */
    private comboInset(): number {
        return this.progress?.visible ? this.bottomInset() : 10 * this.legacyUnit;
    }

    onHit(error: number): void {
        this.errorMeter.add(error);
    }

    /** A successful judgement (any hit result, ticks included): the health bar flashes. */
    onJudgement(): void {
        this.health.onJudgement();
    }

    update(dt: number, s: HUDState): void {
        if (!this.w) return;
        if (s.playing !== this.playing) {
            this.playing = s.playing;
            this.updateVisibility();
            this.updateLeaderboardExpanded();
        }
        this.score.set(s.score, s.accuracy);
        this.score.update(dt);
        this.combo.set(s.combo);
        this.combo.update(dt);
        this.health.update(s.hp, dt);
        if (this.progress?.visible) this.progress.update(s.time, s.rate);
        if (this.pie?.visible) this.pie.update(s.time);
        this.leaderboard.update(dt, s.score, s.accuracy, s.maxCombo);
        this.errorMeter.update(dt);
        if (this.keys.visible) this.keys.update(dt, s.down, s.counts);
        this.breakInfo.update(s.time, s.accuracy, s.grade);
        // Combo sits above the progress graph when that is shown.
        this.combo.y = this.h - this.comboInset();
    }

    isBreak(time: number): boolean {
        return this.breakInfo.breakAt(time) !== null;
    }

    override destroy(): void {
        for (const off of this.offs) off();
        super.destroy({ children: true });
    }
}
