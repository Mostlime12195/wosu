import { Container } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import type { GameSettings, HudVisibility } from '../../settings/Settings';
import type { SkinChain } from '../../skin/SkinChain';
import type { Grade } from '../../storage/ScoreStore';
import type { GameplayButton } from '../input/GameplayInput';
import { BreakOverlay } from './BreakOverlay';
import { HealthBar } from './HealthBar';
import { HitErrorMeter } from './HitErrorMeter';
import { KeyCounter, LegacyKeyCounter, type KeyOverlay } from './KeyCounter';
import { ComboCounter, ScoreCounter } from './ScoreDisplay';
import { SongProgress } from './SongProgress';

export interface HUDState {
    time: number;
    rate: number;
    score: number;
    accuracy: number;
    combo: number;
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
}

/** lazer's HUDOverlay.FADE_DURATION / FADE_EASING. */
const FADE_DURATION = 300;
/** lazer's ToggleInGameInterface (Shift+Tab) cycle. */
const NEXT_MODE: Record<HudVisibility, HudVisibility> = { never: 'hideDuringGameplay', hideDuringGameplay: 'always', always: 'never' };

/**
 * Everything drawn over the playfield in screen space: score/accuracy
 * (top-right), health (top-left), combo (bottom-left), key overlay
 * (right), hit error meter and song progress (bottom), break info.
 * Score, accuracy, combo and health are lazer's legacy-skin components,
 * drawn from the skin chain in lazer's 1024×768 HUD units (so they size
 * like lazer with any osu! skin); the key overlay is the skin's when it
 * has inputoverlay images. Visibility follows lazer's HUD visibility mode
 * (fading as a whole), each element has its own toggle, and every
 * setting applies live.
 */
export class HUDOverlay extends Container {
    readonly errorMeter: HitErrorMeter;
    /** The fading part (lazer's hide targets); the break overlay stays outside it. */
    private readonly content = new Container();
    private readonly score: ScoreCounter;
    private readonly combo: ComboCounter;
    private readonly health: HealthBar;
    private readonly progress: SongProgress;
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
        this.progress = new SongProgress(beatmap);
        this.keys = LegacyKeyCounter.create(chain, settings.keyOverlayStyle.value) ?? new KeyCounter(settings.keyOverlayStyle.value);
        this.errorMeter = new HitErrorMeter(d.window300, d.window100, d.window50);
        this.breakInfo = new BreakOverlay(beatmap.breaks);
        // lazer: health bars in front of everything else (for full-screen health bar skins).
        this.content.addChild(this.progress, this.errorMeter, this.keys, this.score, this.combo, this.health);
        this.addChild(this.breakInfo, this.content);
        const s = settings;
        const apply = () => this.applySettings();
        for (const b of [
            s.hudScore, s.hudAccuracy, s.hudCombo, s.hudHealthBar, s.hudHealthWhenCantFail, s.hudBreakOverlay,
            s.hitErrorMeter, s.keyOverlay, s.keyOverlayStyle, s.progressBar, s.progressGraph, s.hudScale,
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
        this.progress.visible = s.progressBar.value;
        this.progress.showGraph = s.progressGraph.value;
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

    layout(w: number, h: number): void {
        this.w = w;
        this.h = h;
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
        this.progress.scale.set(unit);
        this.progress.position.set(0, h);
        this.progress.layout(w / unit);
        this.errorMeter.position.set(w / 2, h - this.bottomInset() - 14 * unit);
        this.errorMeter.layout(220 * unit, unit);
        this.keys.place(w, h, unit, lu);
        this.breakInfo.position.set(w / 2, h / 2);
        this.breakInfo.layout(w);
    }

    /** Space the bottom HUD keeps clear for the song progress block. */
    private bottomInset(): number {
        return (this.progress.visible ? this.progress.blockHeight + 6 : 10) * this.unit;
    }

    /** lazer's margin under the combo counter, raised above the song progress block while it shows. */
    private comboInset(): number {
        return this.progress.visible ? this.bottomInset() : 10 * this.legacyUnit;
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
        }
        this.score.set(s.score, s.accuracy);
        this.score.update(dt);
        this.combo.set(s.combo);
        this.combo.update(dt);
        this.health.update(s.hp, dt);
        if (this.progress.visible) this.progress.update(s.time, s.rate);
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
