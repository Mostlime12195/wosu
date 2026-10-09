import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js';
import { Screen } from '../../app/Screen';
import type { Game, Selection } from '../../app/Game';
import type { MusicTrack } from '../../audio/MusicTrack';
import { calculateDifficulty } from '../../beatmap/difficulty';
import { buildPlayableBeatmap } from '../../beatmap/processing';
import type { BeatmapData, PlayableBeatmap, PlayableSlider } from '../../beatmap/types';
import { clamp01, damp } from '../../core/math';
import { tween } from '../../core/Tweener';
import { comboColor } from '../../gameplay/drawables/context';
import { PLAYFIELD_H, PLAYFIELD_W, Playfield } from '../../gameplay/drawables/Playfield';
import { BackgroundVideo } from '../../gameplay/BackgroundVideo';
import { GameplayClock } from '../../gameplay/GameplayClock';
import { GameplayRules, type CursorState, type SliderState, type SpinnerState } from '../../gameplay/GameplayRules';
import { HitsoundPlayer } from '../../gameplay/HitsoundPlayer';
import { HUDOverlay } from '../../gameplay/hud/HUDOverlay';
import { AutoPlayer } from '../../gameplay/input/AutoPlayer';
import { GameplayInput, type GameplayButton } from '../../gameplay/input/GameplayInput';
import { NO_MODS, inputMode, scoreMultiplier, sortedMods, type InputMode, type ModSet } from '../../gameplay/mods';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import { HealthProcessor } from '../../gameplay/scoring/HealthProcessor';
import { difficultyMultiplier, ScoreProcessor } from '../../gameplay/scoring/ScoreProcessor';
import type { Action } from '../../input/bindings';
import { beatmapKeyOf } from '../../storage/ScoreStore';
import { Colors } from '../../ui/theme';
import { ResultsScreen } from '../results/ResultsScreen';
import { ratingMods } from '../select/modStars';
import { GameplayMenu } from './GameplayMenu';
import { HoldForMenuButton } from './HoldForMenuButton';
import { ResumeOverlay } from './ResumeOverlay';
import { SkipButton } from './SkipButton';

/** Everything the player needs, prepared by the PlayerLoaderScreen. */
export interface PlayerOptions {
    selection: Selection;
    data: BeatmapData;
    mods: ModSet;
    /** Decoded song, already rate-adjusted for DT/HT/NC/DC. */
    track: MusicTrack;
    /** Retries so far for this beatmap (shown in the pause menu). */
    retryCount?: number;
}

/** How a Player ended, read by the loader when it resumes. */
export type PlayerOutcome = 'none' | 'quit' | 'retry' | 'completed';

type Phase = 'loading' | 'playing' | 'paused' | 'resuming' | 'failed' | 'completed';

/** Results appear this long after the last judgement (lazer). */
const RESULTS_DELAY = 1000;
const FAIL_DURATION = 2500;
const QUICK_RETRY_HOLD = 500;
/** Sample HP this often for the results graph. */
const HEALTH_SAMPLE_MS = 250;
/**
 * Judgement runs in steps of at most this many ms whatever the frame rate
 * (lazer's frame-stable gameplay), with the cursor interpolated between
 * frames, so a hitch never skips a slider tick or tail.
 */
const SUBSTEP_MS = 8;
const MAX_SUBSTEPS = 40;

/**
 * The gameplay screen (lazer's Player). Judgement lives in GameplayRules;
 * this screen feeds it input with exact timestamps, renders the playfield
 * and HUD from the audio clock every frame, plays hitsounds, and runs the
 * pause / fail / results flow. The loader beneath it handles retry/quit.
 */
export class PlayerScreen extends Screen {
    override readonly hideToolbar = true;
    override readonly showMenuCursor = false;
    /** Settings may be opened (Ctrl+O) while paused, and apply live. */
    override allowOverlays = false;
    outcome: PlayerOutcome = 'none';

    private beatmap!: PlayableBeatmap;
    private score!: ScoreProcessor;
    private health!: HealthProcessor;
    private rules!: GameplayRules;
    private clock!: GameplayClock;
    private input!: GameplayInput;
    private hitsounds!: HitsoundPlayer;
    private playfield!: Playfield;
    private hud!: HUDOverlay;
    private auto: AutoPlayer | null = null;
    private mode: InputMode = 'normal';
    private readonly root = new Container();
    private readonly fieldWrap = new Container();
    private readonly flashlight = new Container();
    private flashlightHole!: Sprite;
    private readonly flashlightFill = new Graphics();
    private readonly failFlash = new Graphics();
    private readonly retryFade = new Graphics();
    private menu!: GameplayMenu;
    private skip!: SkipButton;
    private resume!: ResumeOverlay;
    private holdButton!: HoldForMenuButton;

    private phase: Phase = 'loading';
    private sinceEnter = 0;
    private skipTarget = -Infinity;
    private autoPressIndex = 0;
    private autoButton: GameplayButton = 'K1';
    private readonly autoDown: Record<GameplayButton, boolean> = { K1: false, K2: false, M1: false, M2: false };
    private readonly autoCounts: Record<GameplayButton, number> = { K1: 0, K2: 0, M1: 0, M2: 0 };
    private autoReleaseAt = 0;
    /** First object whose hitsound loops may still be running. */
    private loopStart = 0;
    private rulesTime = -Infinity;
    private prevCursor: CursorState = { x: 256, y: 192, held: false };
    private lastJudgementTime = -Infinity;
    private failClock = 0;
    private failedAtTime = 0;
    private quickRetryHeld = 0;
    private quickRetryActive = false;
    private readonly healthGraph: [number, number][] = [];
    private nextHealthSample = -Infinity;
    private pausedCursor = { x: 0, y: 0 };
    private view = { scale: 1, x: 0, y: 0 };
    private readonly offs: (() => void)[] = [];
    private dimInBreak = 0;
    private released = false;
    private built = false;
    private entered = false;
    private video: BackgroundVideo | null = null;
    private videoReady = false;
    /** Gameplay time from which lazer counts the user as playing (first object's approach). */
    private playStart = 0;

    constructor(readonly options: PlayerOptions) {
        super();
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    override load(): void {
        this.build();
    }

    /**
     * Build, lay out and warm up the whole player while the loader is
     * still covering the screen (lazer loads its Player in the background
     * the same way), so the first revealed frame is already correct: HUD
     * sized, text measured, textures and shaders uploaded. The stack's
     * later load()/resize() calls are then no-ops.
     */
    prepare(game: Game, w: number, h: number): void {
        this.game = game;
        this.build();
        this.resize(w, h);
        this.warmUp();
    }

    private build(): void {
        if (this.built) return;
        this.built = true;
        const g = this.game;
        const o = this.options;
        const mods = o.mods;
        this.mode = inputMode(mods);
        const beatmap = (this.beatmap = buildPlayableBeatmap(o.data, mods));
        const d = o.data.difficulty;
        const objectCount = beatmap.hitObjects.length;
        const breakTime = beatmap.breaks.reduce((t, b) => t + Math.max(0, b.endTime - b.startTime), 0);
        this.score = new ScoreProcessor({
            difficultyMultiplier: difficultyMultiplier(
                { hp: d.hpDrainRate, cs: d.circleSize, od: d.overallDifficulty }, objectCount, beatmap.endTime - beatmap.startTime - breakTime),
            modMultiplier: scoreMultiplier(mods),
        });
        const noFail = mods.has('NF') || this.mode === 'autoplay' || this.mode === 'relax' || this.mode === 'autopilot';
        this.health = new HealthProcessor({
            hpDifficulty: beatmap.difficulty.hp,
            breaks: beatmap.breaks,
            drainStart: beatmap.startTime,
            drainEnd: beatmap.endTime,
            lives: mods.has('EZ') ? 2 : 0,
            noFail,
        });
        this.rules = new GameplayRules(beatmap, mods, this.score, this.health);
        if (this.mode === 'autoplay' || this.mode === 'autopilot') this.auto = new AutoPlayer(beatmap);

        const first = beatmap.hitObjects[0];
        const preempt = beatmap.difficulty.preempt;
        const leadIn = Math.max(o.data.general.audioLeadIn, 0);
        const start = Math.min(0, -leadIn, first.time - preempt - 1500);
        this.skipTarget = first.time - preempt - 1000;
        this.playStart = first.time - preempt;
        this.clock = new GameplayClock(o.track, start);

        this.input = new GameplayInput(g.app, g.settings, () => this.clock.now, { x: g.input.pointer.x, y: g.input.pointer.y });
        this.input.ignorePointer = (x, y) => this.holdButton.containsPoint(x, y) ||
            (this.skip.available && x >= this.skip.x && y >= this.skip.y && x <= this.skip.x + this.skip.w && y <= this.skip.y + this.skip.h);
        this.hitsounds = new HitsoundPlayer(g.samples, beatmap);
        this.hitsounds.useBeatmapSets = g.settings.beatmapHitsounds.value;

        this.playfield = new Playfield({
            renderer: g.app.renderer,
            skin: g.skin,
            beatmap,
            rules: this.rules,
            hidden: mods.has('HD'),
            hideNumbers: g.settings.hideNumbers.value,
            hideFollowPoints: g.settings.hideFollowPoints.value,
            snakingIn: g.settings.snakingIn.value,
            snakingOut: g.settings.snakingOut.value,
            kiaiFlashes: g.settings.kiaiFlash.value,
        });
        this.playfield.judgements.hideGreat = g.settings.hideGreat.value;
        this.playfield.judgements.hitLighting = g.settings.hitLighting.value;
        this.fieldWrap.addChild(this.playfield);

        if (mods.has('FL')) {
            this.flashlightHole = new Sprite(g.skin.tex('flashlight'));
            this.flashlightHole.anchor.set(0.5);
            this.flashlight.addChild(this.flashlightHole, this.flashlightFill);
        } else {
            this.flashlight.visible = false;
        }

        this.hud = new HUDOverlay(g.skin, beatmap, g.settings, { canFail: !noFail });
        this.menu = new GameplayMenu(g.skin.tex('triangle'));
        this.skip = new SkipButton();
        this.skip.onActivate = () => this.doSkip();
        this.resume = new ResumeOverlay();
        this.holdButton = new HoldForMenuButton();
        this.holdButton.onHeld = () => this.pause();
        this.failFlash.alpha = 0;
        this.retryFade.alpha = 0;
        this.root.addChild(this.fieldWrap, this.flashlight, this.hud, this.failFlash, this.skip, this.holdButton, this.resume, this.menu, this.retryFade);
        this.addChild(this.root);
        this.eventMode = 'passive';

        this.wireEvents();
        if (g.settings.backgroundVideo.value && o.data.events.video) void this.loadVideo(o.data.events.video);
    }

    private async loadVideo(info: { filename: string; offset: number }): Promise<void> {
        const video = (this.video = new BackgroundVideo(info.offset));
        try {
            const archive = await this.game.library.openArchive(this.options.selection.set.key);
            if (!(await video.load(archive, info.filename)) || this.released) return;
            video.cover(this._w, this._h);
            this.videoReady = true;
            // Prepared behind the loader: the video appears once gameplay is shown.
            if (this.entered) this.game.background.setCustom(video.sprite);
        } catch (e) {
            console.warn('background video failed', e);
        }
    }

    private wireEvents(): void {
        const rules = this.rules;
        const objs = this.beatmap.hitObjects;
        rules.objectJudged.add(info => {
            const h = objs[info.index];
            this.lastJudgementTime = Math.max(this.lastJudgementTime, info.time);
            this.playfield.judgements.add(info.result, info.x, info.y, info.time, comboColor(this.playfield.ctx, h));
            if (info.result === 'miss') return;
            if (h.kind === 'circle' || h.kind === 'spinner') this.hitsounds.hit(h);
        });
        rules.nestedJudged.add((index, ev, hit) => {
            if (!hit) return;
            const h = objs[index] as PlayableSlider;
            if (ev.kind === 'tick') this.hitsounds.tick(h, ev.time, ev.x);
            else if (ev.kind === 'head') this.hitsounds.sliderEdge(h, 0, h.x);
            else if (ev.kind === 'repeat') this.hitsounds.sliderEdge(h, ev.spanIndex + 1, ev.x);
            else this.hitsounds.sliderEdge(h, h.slides, ev.x);
        });
        rules.headHit.add((_i, _t, error) => this.hud.onHit(error));
        rules.spun.add((index, bonus) => {
            if (bonus) this.hitsounds.spinnerBonus(objs[index]);
        });
        this.score.comboBroken.add(previous => {
            if (previous >= 20) this.hitsounds.comboBreak();
        });
        this.health.failedSignal.add(() => this.startFail());
        this.input.pressed.add((time, x, y) => {
            if (this.phase !== 'playing' || this.mode === 'autoplay') return;
            const p = this.toPlayfield(x, y);
            if (this.mode === 'autopilot' && this.auto) {
                // Autopilot moves the cursor; the player only taps.
                const c = this.auto.cursorAt(time);
                this.rules.press(time, c.x, c.y);
            } else {
                this.rules.press(time, p.x, p.y);
            }
        });
        this.input.anyPress.add((x, y) => {
            if (this.phase === 'resuming' && this.resume.hits(x, y)) this.finishResume();
        });

        const blur = () => {
            if (this.phase === 'playing' && this.mode !== 'autoplay') this.pause();
            this.input.releaseAll();
            this.hud.holdingForHud = false;
        };
        const visibility = () => {
            if (document.visibilityState === 'hidden') blur();
        };
        const wheel = (e: WheelEvent) => {
            if (e.altKey || !this.game.settings.wheelVolumeInGameplay.value) return;
            if (this.phase !== 'playing' || this.game.volume.meterHovered) return;
            this.game.volume.adjust(e.deltaY < 0 ? 0.05 : -0.05);
        };
        window.addEventListener('blur', blur);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('wheel', wheel, { passive: true });
        this.offs.push(
            () => window.removeEventListener('blur', blur),
            () => document.removeEventListener('visibilitychange', visibility),
            () => window.removeEventListener('wheel', wheel),
        );
        const s = this.game.settings;
        this.offs.push(s.backgroundDim.bind(() => this.applyBackground(400)));
        this.offs.push(s.backgroundBlur.bind(() => this.applyBackground(400)));
        this.offs.push(s.kiaiFlash.bind(v => (this.playfield.kiaiFlashes = v)));
        this.offs.push(s.beatmapHitsounds.bind(v => (this.hitsounds.useBeatmapSets = v)));
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    protected override onResize(w: number, h: number): void {
        if (!this.playfield) return;
        // osu!'s 640×480 virtual screen scaled to fit; the 512×384 field
        // sits in its middle, nudged down 8px like stable.
        const scale = Math.min(w / 640, h / 480);
        const x = (w - PLAYFIELD_W * scale) / 2;
        const y = (h - PLAYFIELD_H * scale) / 2 + 8 * scale;
        this.view = { scale, x, y };
        this.fieldWrap.scale.set(scale);
        this.fieldWrap.position.set(x, y);
        this.playfield.setPixelsPerUnit(scale * this.game.app.uiScale * this.game.app.renderer.resolution);
        this.hud.layout(w, h);
        this.video?.cover(w, h);
        this.menu.resize(w, h);
        this.skip.position.set(w - this.skip.w - 24, h - this.skip.h - 130);
        this.holdButton.position.set(w - this.holdButton.w - 16, h - this.holdButton.h - 64);
        this.failFlash.clear().rect(0, 0, w, h).fill(0xff2a4a);
        this.retryFade.clear().rect(0, 0, w, h).fill(0x000000);
    }

    private toPlayfield(x: number, y: number): { x: number; y: number } {
        return { x: (x - this.view.x) / this.view.scale, y: (y - this.view.y) / this.view.scale };
    }

    private toScreen(x: number, y: number): { x: number; y: number } {
        return { x: x * this.view.scale + this.view.x, y: y * this.view.scale + this.view.y };
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    override onEntering(): void {
        // Gameplay keys must never be swallowed as text by a stray focused text box.
        this.game.textInput.blur();
        this.alpha = 0;
        this.fadeIn(400);
        this.entered = true;
        // lazer's Player has no background parallax (the loader already turned it off).
        this.game.background.suppressParallax(this);
        if (this.video && this.videoReady) this.game.background.setCustom(this.video.sprite);
        const cursor = this.game.cursor;
        cursor.external = true;
        this.game.updateCursorVisibility();
        this.applyBackground(800);
    }

    private applyBackground(duration: number): void {
        const s = this.game.settings;
        const bg = this.game.background;
        const breakLift = this.dimInBreak * 0.35;
        bg.setDim(Math.max(0, s.backgroundDim.value * (1 - breakLift)), duration);
        bg.setBlur(s.backgroundBlur.value, duration);
    }

    private begin(): void {
        this.phase = 'playing';
        this.input.enabled = this.mode !== 'autoplay';
        this.clock.start();
    }

    override onSuspending(): void {
        // Results are pushed on top: the music plays on, gameplay stops.
        this.releaseGameplay();
        this.fadeOut(300);
    }

    override onExiting(): number {
        this.releaseGameplay();
        if (this.outcome !== 'completed') this.clock?.pause();
        this.fadeOut(250);
        return 250;
    }

    /** Stop input, sounds and cursor control. Idempotent: suspend, exit and destroy all call it. */
    private releaseGameplay(): void {
        if (this.released) return;
        this.released = true;
        this.input?.dispose();
        this.hitsounds?.stopAll();
        for (const off of this.offs) off();
        this.offs.length = 0;
        this.game.background.releaseParallax(this);
        const cursor = this.game.cursor;
        cursor.external = false;
        this.game.updateCursorVisibility();
        if (this.video) {
            if (this.entered && this.videoReady) this.game.background.setCustom(null);
            this.video.dispose();
            this.video = null;
        }
    }

    // ------------------------------------------------------------------
    // Frame
    // ------------------------------------------------------------------

    override update(dt: number): void {
        if (!this.playfield || this.destroyed) return;
        this.sinceEnter += dt;
        if (this.phase === 'loading' && this.sinceEnter > 400) this.begin();
        // Before the clock starts everything still draws, frozen at the start time.
        const time = this.phase === 'loading' ? this.clock.frameTime : this.clock.tick(dt);
        const cursor = this.updateCursor(time, dt);

        if (this.phase === 'playing') {
            this.stepRules(time, cursor);
            this.updateLoops(time);
            this.sampleHealth(time);
            if (this.rules.finished && time >= this.lastJudgementTime + RESULTS_DELAY && time >= this.beatmap.endTime) this.complete();
        }
        this.renderState(time, dt);
        this.updateSkip(time, dt);
        this.holdButton.visible = this.phase === 'playing' || this.phase === 'resuming';
        if (this.holdButton.visible) this.holdButton.update(dt, this.input, this.game.input.lastPointerKind.value === 'touch');
        this.updateFlashlight(cursor, time);
        this.resume.update(dt, this._w, this._h, this.input.x, this.input.y);
        if (this.phase === 'failed') this.updateFail(dt);
        this.updateQuickRetry(dt);
    }

    /** Playfield, video, break dim and HUD for song time `time`. */
    private renderState(time: number, dt: number): void {
        this.playfield.update(this.phase === 'failed' ? this.failedAtTime : time);
        this.video?.sync(time, this.phase === 'playing' || this.phase === 'completed', this.clock.rate);
        this.updateBreakDim(time);
        this.hud.update(dt, {
            time,
            rate: this.clock.rate,
            score: this.score.score,
            accuracy: this.score.accuracy,
            combo: this.score.combo,
            hp: this.health.hp,
            grade: this.score.grade(this.options.mods.has('HD') || this.options.mods.has('FL')),
            down: this.mode === 'autoplay' ? this.autoDown : this.input.down,
            counts: this.mode === 'autoplay' ? this.autoCounts : this.input.counts,
            // lazer's localUserPlaying (breaks and the intro count as "not playing").
            playing: this.phase === 'playing' && time >= this.playStart && !this.hud.isBreak(time) && !this.rules.finished,
        });
    }

    /**
     * Draw the player once offscreen (see prepare): HUD and playfield at
     * the start time, plus one object of each kind and every judgement,
     * so text, glyph atlases, textures and shader pipelines exist before
     * the first visible frame.
     */
    private warmUp(): void {
        const r = this.game.app.renderer;
        this.renderState(this.clock.frameTime, 0);
        this.skip.update(0);
        const restoreHud = this.hud.revealForWarmUp();
        const rt = RenderTexture.create({
            width: Math.max(1, Math.ceil(this._w)),
            height: Math.max(1, Math.ceil(this._h)),
            resolution: r.resolution,
        });
        try {
            this.playfield.warmUp(() => r.render({ container: this.root, target: rt, clear: true }));
        } catch (e) {
            console.warn('player warm-up failed', e);
        } finally {
            restoreHud();
            rt.destroy(true);
        }
        // Back to the real start state.
        this.renderState(this.clock.frameTime, 0);
    }

    /** Cursor in playfield coordinates; also drives the on-screen cursor. */
    private updateCursor(time: number, _dt: number): { x: number; y: number; held: boolean } {
        const c = this.game.cursor;
        // lazer swaps to the menu cursor once the pause / fail menu is up; autoplay keeps the user's cursor visible.
        c.gameplayActive = this.phase !== 'paused' && !(this.phase === 'failed' && this.menu.shown);
        c.replayLoaded = this.mode === 'autoplay';
        c.playfieldScale = this.view.scale;
        c.circleSize = this.beatmap.difficulty.cs;
        const down = this.mode === 'autoplay' ? this.autoDown : this.input.down;
        c.setDownCount(+down.K1 + +down.K2 + +down.M1 + +down.M2);
        // Autoplay/autopilot steer the cursor while playing; menus give it back to the pointer.
        if (this.auto && (this.phase === 'playing' || this.phase === 'completed')) {
            const a = this.auto.cursorAt(time);
            const sp = this.toScreen(a.x, a.y);
            c.moveTo(sp.x, sp.y);
            const held = this.mode === 'autoplay' ? a.held : this.input.held;
            return { x: a.x, y: a.y, held };
        }
        c.moveTo(this.input.x, this.input.y, true);
        const p = this.toPlayfield(this.input.x, this.input.y);
        return { x: p.x, y: p.y, held: this.input.held };
    }

    private stepRules(time: number, cursor: CursorState): void {
        const from = this.rulesTime === -Infinity ? time : this.rulesTime;
        const span = time - from;
        const steps = span > 0 ? Math.min(MAX_SUBSTEPS, Math.ceil(span / SUBSTEP_MS)) : 1;
        const prev = this.prevCursor;
        for (let k = 1; k <= steps; k++) {
            const t = k === steps ? time : from + (span * k) / steps;
            let c = cursor;
            if (k < steps) {
                if (this.auto) {
                    const a = this.auto.cursorAt(t);
                    c = { x: a.x, y: a.y, held: this.mode === 'autoplay' ? a.held : cursor.held };
                } else {
                    const f = k / steps;
                    c = { x: prev.x + (cursor.x - prev.x) * f, y: prev.y + (cursor.y - prev.y) * f, held: cursor.held };
                }
            }
            this.feedAutoplay(t);
            this.rules.update(t, c);
        }
        this.rulesTime = Math.max(this.rulesTime, time);
        this.prevCursor = cursor;
    }

    private feedAutoplay(time: number): void {
        if (this.mode !== 'autoplay' || !this.auto) return;
        const presses = this.auto.presses;
        while (this.autoPressIndex < presses.length && presses[this.autoPressIndex].time <= time) {
            const p = presses[this.autoPressIndex++];
            this.rules.press(p.time, p.x, p.y);
            // Alternate keys like a streaming player for the key overlay.
            this.autoButton = this.autoButton === 'K1' ? 'K2' : 'K1';
            this.autoDown.K1 = this.autoDown.K2 = false;
            this.autoDown[this.autoButton] = true;
            this.autoCounts[this.autoButton]++;
            const h = this.beatmap.hitObjects[this.autoPressIndex - 1];
            this.autoReleaseAt = Math.max(h.endTime, h.time + 60);
        }
        if (time > this.autoReleaseAt) this.autoDown.K1 = this.autoDown.K2 = false;
    }

    /** Slider slide and spinner spin loops follow the tracking state. */
    private updateLoops(time: number): void {
        const objs = this.beatmap.hitObjects;
        while (this.loopStart < objs.length && objs[this.loopStart].endTime < time - 1000) this.loopStart++;
        for (let i = this.loopStart; i < objs.length; i++) {
            const h = objs[i];
            if (h.time - 1000 > time) break;
            const s = this.rules.states[i];
            if (s.kind === 'slider') {
                this.hitsounds.setSliding(h as PlayableSlider, (s as SliderState).tracking && time >= h.time && time < h.endTime);
            } else if (s.kind === 'spinner') {
                const sp = s as SpinnerState;
                const spinning = time >= h.time && time < h.endTime && sp.rpm > 30;
                this.hitsounds.setSpinning(h, spinning, sp.required > 0 ? sp.progress / sp.required : 1);
            }
        }
    }

    private sampleHealth(time: number): void {
        if (time < this.beatmap.startTime || time < this.nextHealthSample) return;
        this.healthGraph.push([time, this.health.hp]);
        this.nextHealthSample = time + HEALTH_SAMPLE_MS;
    }

    private updateBreakDim(time: number): void {
        const target = this.hud.isBreak(time) && this.phase === 'playing' ? 1 : 0;
        if (target !== this.dimInBreak) {
            this.dimInBreak = target;
            this.applyBackground(600);
        }
    }

    private updateSkip(time: number, dt: number): void {
        const can = this.phase === 'playing' && time < this.skipTarget - 500;
        this.skip.available = can;
        if (can) this.skip.remaining = clamp01((this.skipTarget - time) / Math.max(1, this.skipTarget - this.clock.startTime));
        this.skip.update(dt);
    }

    private doSkip(): void {
        if (!this.skip.available) return;
        this.game.uiSounds.click();
        this.clock.seek(this.skipTarget);
    }

    private updateFlashlight(cursor: { x: number; y: number }, time: number): void {
        if (!this.flashlight.visible) return;
        const combo = this.score.combo;
        const size = combo >= 200 ? 0.625 : combo >= 100 ? 0.8125 : 1;
        const inBreak = this.hud.isBreak(time);
        const radius = 120 * size * this.view.scale * (inBreak ? 2.5 : 1);
        const sp = this.toScreen(cursor.x, cursor.y);
        // The texture's clear centre is 70% of its radius.
        const texR = this.flashlightHole.texture.width / 2;
        const scale = radius / (texR * 0.7);
        const hole = this.flashlightHole;
        hole.scale.set(damp(hole.scale.x || scale, scale, 60, 16));
        hole.position.set(sp.x, sp.y);
        const half = texR * hole.scale.x;
        const w = this._w, h = this._h;
        const x0 = sp.x - half, x1 = sp.x + half, y0 = sp.y - half, y1 = sp.y + half;
        this.flashlightFill.clear()
            .rect(0, 0, w, Math.max(0, y0)).fill(0x000000)
            .rect(0, y1, w, Math.max(0, h - y1)).fill(0x000000)
            .rect(0, y0, Math.max(0, x0), y1 - y0).fill(0x000000)
            .rect(x1, y0, Math.max(0, w - x1), y1 - y0).fill(0x000000);
    }

    // ------------------------------------------------------------------
    // Pause / resume
    // ------------------------------------------------------------------

    pause(): void {
        if (this.phase !== 'playing' && this.phase !== 'resuming') return;
        this.phase = 'paused';
        this.clock.pause();
        this.hitsounds.stopAll();
        this.input.enabled = false;
        this.input.releaseAll();
        this.resume.hide();
        this.pausedCursor = { x: this.input.x, y: this.input.y };
        this.allowOverlays = true;
        this.menu.show({
            title: 'paused',
            description: "you're not going to do what i think you're going to do, are ya?",
            entries: [
                { caption: 'Continue', color: Colors.green, action: () => this.continuePlay() },
                { caption: 'Retry', color: Colors.yellowDark, action: () => this.retry() },
                { caption: 'Quit', color: 0xaa1b27, action: () => this.quit() },
            ],
            back: 'first',
            ...this.menuInfo(),
        });
    }

    /** lazer's play info under the menu buttons. */
    private menuInfo(): { retries: number; progress: number; accuracy: number } {
        const b = this.beatmap;
        const span = b.endTime - b.startTime;
        const time = this.phase === 'failed' ? this.failedAtTime : this.clock.frameTime;
        return {
            retries: this.options.retryCount ?? 0,
            progress: span > 0 ? clamp01((time - b.startTime) / span) * 100 : 0,
            accuracy: this.score.accuracy,
        };
    }

    private continuePlay(): void {
        if (this.phase !== 'paused') return;
        this.menu.hide();
        this.allowOverlays = false;
        this.game.overlays.hideAll();
        const time = this.clock.frameTime;
        const first = this.beatmap.hitObjects[0];
        const needsAim = this.mode !== 'autoplay' && this.mode !== 'autopilot' && time > first.time - this.beatmap.difficulty.preempt;
        if (!needsAim) {
            this.finishResume();
            return;
        }
        this.phase = 'resuming';
        this.resume.show(this.pausedCursor.x, this.pausedCursor.y, this.beatmap.difficulty.circleRadius * this.view.scale);
    }

    private finishResume(): void {
        this.resume.hide();
        this.phase = 'playing';
        this.rules.resetSpinnerTracking();
        this.input.enabled = this.mode !== 'autoplay';
        this.clock.resume();
    }

    // ------------------------------------------------------------------
    // Fail / complete / leave
    // ------------------------------------------------------------------

    private startFail(): void {
        if (this.phase === 'failed' || this.phase === 'completed') return;
        this.phase = 'failed';
        this.failedAtTime = this.clock.frameTime;
        this.failClock = 0;
        this.allowOverlays = false;
        this.game.overlays.hideAll();
        this.menu.hide();
        this.input.enabled = false;
        this.hitsounds.stopAll();
        this.clock.freeze();
        this.options.track.failSlowdown(FAIL_DURATION);
        this.menu.visible = false;
        this.failFlash.alpha = 0.35;
        tween(this.failFlash, { alpha: 0 }, { duration: 1000, ease: 'OutQuint' });
    }

    private updateFail(dt: number): void {
        this.failClock += dt;
        const t = clamp01(this.failClock / FAIL_DURATION);
        // lazer's FailAnimation: the field sinks, tilts and fades as the song winds down.
        const f = this.fieldWrap;
        f.rotation = 0.12 * t * t;
        f.alpha = 1 - t * 0.85;
        f.y = this.view.y + 120 * t * t * this.view.scale;
        this.hud.alpha = 1 - t;
        if (this.failClock >= FAIL_DURATION * 0.6 && !this.menu.shown) {
            this.menu.show({
                title: 'failed',
                description: "you're dead, try again?",
                entries: [
                    { caption: 'Retry', color: Colors.yellowDark, action: () => this.retry() },
                    { caption: 'Quit', color: 0xaa1b27, action: () => this.quit() },
                ],
                // lazer's fail overlay: Back presses its last button (Quit).
                back: 'last',
                ...this.menuInfo(),
            });
        }
    }

    private complete(): void {
        if (this.phase !== 'playing') return;
        this.phase = 'completed';
        this.outcome = 'completed';
        this.input.enabled = false;
        this.hitsounds.stopAll();
        const result = this.buildResult();
        if (this.mode !== 'autoplay') void this.saveScore(result);
        tween(this.root, { alpha: 0 }, { duration: 400 }).finished.then(() => {
            if (this.destroyed || !this.isCurrent) return;
            this.push(new ResultsScreen(result, this.options.selection));
        });
    }

    private buildResult(): ScoreResult {
        const o = this.options;
        const { set, diff } = o.selection;
        const s = this.score;
        const rate = this.clock.rate;
        const errors = this.rules.hitErrors.slice();
        const mean = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
        const variance = errors.length ? errors.reduce((a, b) => a + (b - mean) ** 2, 0) / errors.length : 0;
        const mapMaxCombo = this.beatmap.hitObjects.reduce((n, h) => n + (h.kind === 'slider' ? h.events.length : 1), 0);
        this.healthGraph.push([this.beatmap.endTime, this.health.hp]);
        return {
            setKey: set.key,
            beatmapId: diff.beatmapId,
            setId: set.onlineSetId ?? 0,
            title: set.title,
            artist: set.artist,
            version: diff.version,
            creator: set.creator,
            mods: sortedMods(o.mods),
            score: Math.round(s.score),
            accuracy: s.accuracy,
            maxCombo: s.maxCombo,
            mapMaxCombo,
            count300: s.count300,
            count100: s.count100,
            count50: s.count50,
            countMiss: s.countMiss,
            sliderTicksHit: s.sliderTicksHit,
            sliderTicksTotal: s.sliderTicksTotal,
            grade: s.grade(o.mods.has('HD') || o.mods.has('FL')),
            passed: true,
            perfect: s.countMiss === 0 && s.maxCombo >= mapMaxCombo,
            date: Date.now(),
            player: this.game.settings.playerName.value || 'Guest',
            hitErrors: errors,
            healthGraph: this.healthGraph,
            unstableRate: (Math.sqrt(variance) * 10) / rate,
            length: (this.beatmap.endTime - this.beatmap.startTime) / rate,
            stars: this.playedStars(),
        };
    }

    /** The difficulty's rating scaled to the mods played (see select/modStars). */
    private playedStars(): number | null {
        const base = this.options.selection.diff.stars;
        if (base === null || !ratingMods(this.options.mods)) return base;
        try {
            const nomod = calculateDifficulty(buildPlayableBeatmap(this.options.data, NO_MODS)).stars;
            const played = calculateDifficulty(this.beatmap, this.clock.rate).stars;
            return nomod > 0 ? Math.round(base * (played / nomod) * 100) / 100 : base;
        } catch {
            return base;
        }
    }

    private async saveScore(r: ScoreResult): Promise<void> {
        try {
            await this.game.scores.add({
                beatmapKey: beatmapKeyOf({ beatmapId: r.beatmapId, title: r.title, version: r.version, setId: r.setId }),
                beatmapId: r.beatmapId,
                setId: r.setId,
                title: r.title,
                artist: r.artist,
                version: r.version,
                creator: r.creator,
                mods: r.mods,
                score: r.score,
                accuracy: r.accuracy,
                maxCombo: r.maxCombo,
                count300: r.count300,
                count100: r.count100,
                count50: r.count50,
                countMiss: r.countMiss,
                grade: r.grade,
                passed: r.passed,
                date: r.date,
                player: r.player,
            });
        } catch (e) {
            console.warn('saving score failed', e);
            this.game.notifications.error('Your score could not be saved.');
        }
    }

    retry(): void {
        if (this.outcome !== 'none') return;
        this.outcome = 'retry';
        this.menu.hide();
        this.exit();
    }

    quit(): void {
        if (this.outcome !== 'none') return;
        this.outcome = 'quit';
        this.menu.hide();
        this.game.uiSounds.back();
        this.exit();
    }

    // ------------------------------------------------------------------
    // Keys
    // ------------------------------------------------------------------

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (this.menu.shown && this.menu.onKey(e, action)) return true;
        if (this.phase === 'resuming' || this.phase === 'playing') {
            if (this.input.keyDown(e)) return true;
        }
        if (action === 'quickRetry') {
            if (!e.repeat && this.phase !== 'completed') this.quickRetryActive = true;
            return true;
        }
        if (e.code === 'Tab' && e.shiftKey) {
            // lazer's ToggleInGameInterface: cycles the (persisted) HUD visibility mode.
            const mode = this.hud.cycleVisibilityMode();
            const names = { always: 'Always', hideDuringGameplay: 'Hide during gameplay', never: 'Never' } as const;
            this.game.notifications.info(`HUD visibility: ${names[mode]}`);
            return true;
        }
        if (e.key === 'Control') {
            // lazer's HoldForHUD.
            this.hud.holdingForHud = true;
            return false;
        }
        switch (action) {
            case 'back':
                if (this.phase === 'playing' || this.phase === 'resuming') this.pause();
                return true;
            case 'skip':
                this.doSkip();
                return true;
            default:
                return false;
        }
    }

    override onKeyUp(e: KeyboardEvent): void {
        this.input?.keyUp(e);
        if (e.key === 'Control' && this.hud) this.hud.holdingForHud = false;
        if (e.code === 'Backquote') this.quickRetryActive = false;
    }

    /** Hold ` to retry: the screen fades to black, release cancels (lazer). */
    private updateQuickRetry(dt: number): void {
        if (this.quickRetryActive) this.quickRetryHeld += dt;
        else this.quickRetryHeld = Math.max(0, this.quickRetryHeld - dt * 2);
        this.retryFade.alpha = clamp01(this.quickRetryHeld / QUICK_RETRY_HOLD);
        if (this.quickRetryHeld >= QUICK_RETRY_HOLD && this.outcome === 'none') {
            this.quickRetryActive = false;
            this.retry();
        }
    }

    override destroy(): void {
        this.releaseGameplay();
        super.destroy({ children: true });
    }
}
