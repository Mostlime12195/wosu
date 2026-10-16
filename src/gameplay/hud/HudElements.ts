import { Container } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { NO_MODS } from '../mods';
import type { GameSettings } from '../../settings/Settings';
import type { SkinChain } from '../../skin/SkinChain';
import { GameplayLeaderboard, LEADERBOARD_HEIGHT, LEADERBOARD_WIDTH } from './GameplayLeaderboard';
import { HealthBar } from './HealthBar';
import { HitErrorMeter } from './HitErrorMeter';
import type { HUDOptions, HUDState } from './HUDOverlay';
import { BeatmapInfoDisplay, JudgementCounter, PerformancePointsCounter, UnstableRateCounter, type BeatmapInfo } from './InfoCounters';
import { KeyCounter, LegacyKeyCounter, type KeyOverlay } from './KeyCounter';
import type { Area, HudComponentType, Rect } from './layout/HudLayout';
import type { LeaderboardSource } from './leaderboard';
import { LegacyBarHitErrorMeter } from './LegacyBarHitErrorMeter';
import { LegacySongProgress } from './LegacySongProgress';
import { ModDisplay } from './ModDisplay';
import type { LivePerformance } from './livePerformance';
import { AccuracyCounter, ComboCounter, ScoreCounter } from './ScoreDisplay';
import { SongProgress } from './SongProgress';
import { UnstableRateTracker } from './unstableRate';

/** What every HUD component may draw from. */
export interface HudEnv {
    readonly chain: SkinChain;
    readonly beatmap: PlayableBeatmap;
    readonly settings: GameSettings;
    readonly opts: HUDOptions;
    /** lazer's legacy layout (an imported skin): the skin's key overlay always, stable-style pieces. */
    readonly legacy: boolean;
    /** The live pp calculation, created on first use. */
    performance(): LivePerformance;
    /** The beatmap info shown by the beatmap info component. */
    beatmapInfo(): BeatmapInfo;
    /** Local scores for leaderboards. */
    readonly leaderboardScores: readonly LeaderboardSource[];
}

/**
 * One HUD component in a layout (lazer's ISerialisableDrawable): the
 * component (`view`) inside a `slot` the layout moves, scales and rotates.
 * The built-in layouts place `view` directly and leave the slot alone.
 */
export abstract class HudElement<V extends Container = Container> {
    readonly slot = new Container();

    /** The box follows the content (counters sized to their text): re-place it as it changes. */
    readonly dynamicBox: boolean = false;

    constructor(readonly id: string, readonly type: HudComponentType, readonly view: V, protected readonly env: HudEnv) {
        this.slot.eventMode = 'none';
        this.slot.addChild(view);
    }

    /** The component's box in its own units, around its local origin. */
    abstract box(): Rect;

    /** The HUD settings' toggle for this component allows it. */
    allowed(): boolean {
        return true;
    }

    /** Settings changed (styles, graph): apply them. */
    applySettings(): void {}

    /** About to be drawn at `pixelScale` pixels per unit by a saved layout in `area`. */
    prepare(_pixelScale: number, _area: Area): void {}

    update(_dt: number, _s: HUDState): void {}

    onHit(_error: number): void {}

    onJudgement(): void {}

    destroy(): void {
        this.slot.destroy({ children: true });
    }
}

const dpr = () => globalThis.devicePixelRatio || 1;

class ScoreElement extends HudElement<ScoreCounter> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.hudScore.value; }
    override update(dt: number, s: HUDState): void {
        this.view.set(s.score);
        this.view.update(dt);
    }
}

class AccuracyElement extends HudElement<AccuracyCounter> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.hudAccuracy.value; }
    override update(dt: number, s: HUDState): void {
        this.view.set(s.accuracy);
        this.view.update(dt);
    }
}

class ComboElement extends HudElement<ComboCounter> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.hudCombo.value; }
    override update(dt: number, s: HUDState): void {
        this.view.set(s.combo);
        this.view.update(dt);
    }
}

class HealthElement extends HudElement<HealthBar> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean {
        const s = this.env.settings;
        return s.hudHealthBar.value && (this.env.opts.canFail || s.hudHealthWhenCantFail.value);
    }
    override update(dt: number, s: HUDState): void { this.view.update(s.hp, dt); }
    override onJudgement(): void { this.view.onJudgement(); }
}

class SongProgressElement extends HudElement<SongProgress> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.progressBar.value; }
    override applySettings(): void { this.view.showGraph = this.env.settings.progressGraph.value; }
    /** Always the full width of the area, whatever the scale (lazer's relative width). */
    override prepare(pixelScale: number, area: Area): void { this.view.layout(area.w / pixelScale); }
    override update(_dt: number, s: HUDState): void {
        if (this.slot.visible) this.view.update(s.time, s.rate);
    }
}

class LegacySongProgressElement extends HudElement<LegacySongProgress> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.progressBar.value; }
    override update(_dt: number, s: HUDState): void {
        if (this.slot.visible) this.view.update(s.time);
    }
}

class HitErrorElement extends HudElement<HitErrorMeter> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.hitErrorMeter.value; }
    override update(dt: number): void { this.view.update(dt); }
    override onHit(error: number): void { this.view.add(error); }
}

class LegacyHitErrorElement extends HudElement<LegacyBarHitErrorMeter> {
    override box(): Rect { return this.view.box; }
    override allowed(): boolean { return this.env.settings.hitErrorMeter.value; }
    override update(dt: number): void { this.view.update(dt); }
    override onHit(error: number): void { this.view.add(error); }
}

class KeyElement extends HudElement<KeyOverlay> {
    override box(): Rect { return this.view.box(); }
    override allowed(): boolean { return this.env.settings.keyOverlay.value; }
    override applySettings(): void { this.view.setStyle(this.env.settings.keyOverlayStyle.value); }
    override update(dt: number, s: HUDState): void {
        if (this.slot.visible) this.view.update(dt, s.down, s.counts);
    }
}

export class LeaderboardElement extends HudElement<GameplayLeaderboard> {
    override box(): Rect { return { x: 0, y: 0, w: LEADERBOARD_WIDTH, h: LEADERBOARD_HEIGHT }; }
    override allowed(): boolean { return this.env.settings.gameplayLeaderboard.value; }
    override applySettings(): void { this.view.shown = this.env.opts.editor || this.env.settings.gameplayLeaderboard.value; }
    override prepare(pixelScale: number): void { this.view.setTextResolution(pixelScale * dpr()); }
    override update(dt: number, s: HUDState): void { this.view.update(dt, s.score, s.accuracy, s.maxCombo); }
}

class BeatmapInfoElement extends HudElement<BeatmapInfoDisplay> {
    override box(): Rect { return this.view.box; }
    override prepare(pixelScale: number): void { this.view.setResolution(Math.min(4, pixelScale * dpr())); }
}

class UnstableRateElement extends HudElement<UnstableRateCounter> {
    override readonly dynamicBox = true;
    private readonly tracker = new UnstableRateTracker();
    override box(): Rect { return this.view.box; }
    override update(_dt: number, s: HUDState): void {
        this.view.set(this.tracker.update(s.hitErrors ?? [], s.rate));
    }
}

class PerformanceElement extends HudElement<PerformancePointsCounter> {
    override readonly dynamicBox = true;
    private key = '';
    override box(): Rect { return this.view.box; }
    override update(dt: number, s: HUDState): void {
        const st = s.stats;
        if (st) {
            const key = `${st.great}|${st.ok}|${st.meh}|${st.miss}|${st.maxCombo}|${st.accuracy}|${st.sliderEndsHit}|${st.sliderEndsJudged}|${st.tickMisses}`;
            if (key !== this.key) {
                this.key = key;
                this.view.set(this.env.performance().pp(st));
            }
        }
        this.view.update(dt);
    }
}

class JudgementElement extends HudElement<JudgementCounter> {
    override box(): Rect { return this.view.box; }
    override update(_dt: number, s: HUDState): void {
        const st = s.stats;
        if (st) this.view.set(st.great, st.ok, st.meh, st.miss);
    }
}

class ModDisplayElement extends HudElement<ModDisplay> {
    override box(): Rect { return this.view.box; }
}

/** Build a component of `type` for a HUD. */
export function createHudElement(id: string, type: HudComponentType, env: HudEnv): HudElement {
    const { chain, beatmap, settings, opts } = env;
    const d = beatmap.difficulty;
    switch (type) {
        case 'score': return new ScoreElement(id, type, new ScoreCounter(chain), env);
        case 'accuracy': return new AccuracyElement(id, type, new AccuracyCounter(chain), env);
        case 'combo': return new ComboElement(id, type, new ComboCounter(chain), env);
        case 'health': return new HealthElement(id, type, new HealthBar(chain), env);
        case 'songProgress': return new SongProgressElement(id, type, new SongProgress(beatmap), env);
        case 'legacySongProgress':
            return new LegacySongProgressElement(id, type, new LegacySongProgress(opts.introStart ?? beatmap.startTime - 1500, beatmap.startTime, beatmap.endTime), env);
        case 'hitErrorMeter': {
            const m = new HitErrorMeter(d.window300, d.window100, d.window50);
            // Drawn in its own units (220 across the 50 window); the layout scales it.
            m.layout(220, 1);
            return new HitErrorElement(id, type, m, env);
        }
        case 'legacyHitErrorMeter': return new LegacyHitErrorElement(id, type, new LegacyBarHitErrorMeter(d.window300, d.window100, d.window50), env);
        case 'keyCounter': {
            const style = settings.keyOverlayStyle.value;
            return new KeyElement(id, type, LegacyKeyCounter.create(chain, style, env.legacy) ?? new KeyCounter(style), env);
        }
        case 'leaderboard': {
            const lb = new GameplayLeaderboard(opts.playerName ?? 'Guest');
            lb.setScores(env.leaderboardScores);
            return new LeaderboardElement(id, type, lb, env);
        }
        case 'beatmapInfo': return new BeatmapInfoElement(id, type, new BeatmapInfoDisplay(env.beatmapInfo()), env);
        case 'unstableRate': return new UnstableRateElement(id, type, new UnstableRateCounter(), env);
        case 'performancePoints': {
            // Timed difficulty attributes are computed now (while the player loads), not on the first judgement.
            env.performance();
            return new PerformanceElement(id, type, new PerformancePointsCounter(), env);
        }
        case 'judgementCounter': return new JudgementElement(id, type, new JudgementCounter(), env);
        case 'modDisplay': return new ModDisplayElement(id, type, new ModDisplay(chain, opts.mods ?? NO_MODS, !!opts.editor), env);
    }
}
