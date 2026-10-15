import { Container, Graphics, RenderTexture, type Text } from 'pixi.js';
import { Screen } from '../../app/Screen';
import type { Game, Selection } from '../../app/Game';
import type { MusicTrack } from '../../audio/MusicTrack';
import { calculateDifficulty } from '../../beatmap/difficulty';
import { buildPlayableBeatmap, playableOptions } from '../../beatmap/processing';
import type { Storyboard } from '../../beatmap/storyboard';
import type { LegacySkin } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import type { BeatmapData, PlayableBeatmap, PlayableSlider } from '../../beatmap/types';
import { clamp01 } from '../../core/math';
import { tween, tweener } from '../../core/Tweener';
import { comboColor } from '../../gameplay/drawables/context';
import { PLAYFIELD_H, PLAYFIELD_W, Playfield } from '../../gameplay/drawables/Playfield';
import { SmokeLayer } from '../../gameplay/drawables/Smoke';
import { BackgroundVideo } from '../../gameplay/BackgroundVideo';
import { StoryboardView } from '../../gameplay/StoryboardView';
import { GameplayClock } from '../../gameplay/GameplayClock';
import { GameplayRules, type CursorState, type SliderState, type SpinnerState } from '../../gameplay/GameplayRules';
import { RulesDriver } from '../../gameplay/RulesDriver';
import { buttonMask, encodeReplay, SMOKE_BIT, type ReplayInfo } from '../../gameplay/replay/Replay';
import { ReplayPlayback } from '../../gameplay/replay/ReplayPlayback';
import { ReplayRecorder } from '../../gameplay/replay/ReplayRecorder';
import { clampReplaySpeed, replayTrackRate } from '../../gameplay/replay/playbackSpeed';
import { HitsoundPlayer } from '../../gameplay/HitsoundPlayer';
import { HUDOverlay } from '../../gameplay/hud/HUDOverlay';
import { StablePlayOverlay } from '../../gameplay/hud/StablePlayOverlay';
import { countdownSchedule } from '../../gameplay/legacyPlayEvents';
import type { LoopHandle } from '../../audio/SampleBank';
import { ComboBursts, comboBurstSounds } from '../../gameplay/hud/ComboBursts';
import { NightcoreBeats, nightcorePlaysHats } from '../../gameplay/NightcoreBeats';
import { AutoPlayer } from '../../gameplay/input/AutoPlayer';
import { GameplayInput, type GameplayButton } from '../../gameplay/input/GameplayInput';
import { NO_MODS, audioPitch, extraLives, flashlightSettings, hiddenSettings, inputMode, modSettingsOf, playbackRate, preservesPitch, restartOnFail, scoreMultiplier, sortedMods, type InputMode, type ModSet } from '../../gameplay/mods';
import { Flashlight } from '../../gameplay/Flashlight';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import { HealthProcessor } from '../../gameplay/scoring/HealthProcessor';
import { difficultyMultiplier, ScoreProcessor } from '../../gameplay/scoring/ScoreProcessor';
import { actionLabel, type Action } from '../../input/bindings';
import { formatBeatmapOffset, type PlayTiming } from '../../gameplay/offsetCalibration';
import { beatmapOffsets, offsetKeyFor } from '../../storage/BeatmapOffsets';
import { label } from '../../ui/text';
import { beatmapKeyOf } from '../../storage/ScoreStore';
import { Colors } from '../../ui/theme';
import { ResultsScreen, skinApplause } from '../results/ResultsScreen';
import { ratingMods } from '../select/modStars';
import { GameplayMenu } from './GameplayMenu';
import { LegacyGameplayMenu } from './LegacyGameplayMenu';
import { HoldForMenuButton } from './HoldForMenuButton';
import { ReplayIndicator } from './ReplayIndicator';
import { ReplaySettingsOverlay } from './ReplaySettingsOverlay';
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
    /** Parsed storyboard (.osb + this difficulty's events), if the map has one. */
    storyboard?: Storyboard | null;
    /** The map's own skin elements and hitsounds (owned by the loader). */
    beatmapSkin?: LegacySkin | null;
    /** Watch this replay (lazer's ReplayPlayer) instead of playing; `mods` are the score's. */
    replay?: ReplayInfo | null;
    /** Replays: start watching from this song time (a backward seek). */
    startAt?: number;
    /** Replays: the viewer's controls, carried across a backward seek's rebuild. */
    replayView?: ReplayViewState | null;
}

/** The replay viewer's own state (lazer keeps it on the ReplayPlayer). */
export interface ReplayViewState {
    speed: number;
    settingsPinned: boolean;
    paused: boolean;
}

/** How a Player ended, read by the loader when it resumes. */
/**
 * How a Player ended, read by the loader when it resumes. `retry` goes
 * back through the loader's screen (lazer's Restart()); `quickRetry` (the
 * hold-to-retry hotkey, "restart on fail") restarts at once.
 */
export type PlayerOutcome = 'none' | 'quit' | 'retry' | 'quickRetry' | 'completed';

type Phase = 'loading' | 'playing' | 'paused' | 'resuming' | 'failed' | 'completed';

/** Results appear this long after the last judgement (lazer). */
const RESULTS_DELAY = 1000;
/** lazer's replay keyboard seek amount. */
const REPLAY_SEEK_MS = 5000;
/** Replay events this far behind the clock are a seek's catch-up (no hitsounds). */
const CATCH_UP_MS = 1000;
const FAIL_DURATION = 2500;
/** The pause-loop's fade in and out (ms). */
const PAUSE_LOOP_FADE = 200;
/** Sample HP this often for the results graph. */
const HEALTH_SAMPLE_MS = 250;

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
    /** osu!stable's combo bursts (skins with comboburst art), between the background and the playfield. */
    private bursts!: ComboBursts;
    /** The Nightcore mod's beat (with the selected skin's nightcore samples). */
    private nightcore: NightcoreBeats | null = null;
    /** Cursor smoke, under the hit objects (lazer's SmokeContainer). */
    private smoke!: SmokeLayer;
    private auto: AutoPlayer | null = null;
    private mode: InputMode = 'normal';
    /** Feeds the rules (sub-stepped frames, presses, resumes); see RulesDriver. */
    private driver!: RulesDriver;
    /** Records a real play's input (not Autoplay, not a replay). */
    private recorder: ReplayRecorder | null = null;
    /** The replay being watched. */
    private replay: ReplayPlayback | null = null;
    private replayIndicator: ReplayIndicator | null = null;
    /** lazer's replay settings (playback speed, seek, visibility). */
    private replaySettings: ReplaySettingsOverlay | null = null;
    /** The playback speed the track runs at (see applyReplaySpeed). */
    private speedApplied = 1;
    private speedApplying = false;
    /** Undoes the avatar binding (kept until destroy: the leaderboard draws the texture). */
    private avatarOff: (() => void) | null = null;
    private readonly root = new Container();
    private readonly fieldWrap = new Container();
    /** Everything the fail animation shrinks, tilts and greys (lazer's FailAnimationContainer.Content). */
    private readonly failContent = new Container();
    private readonly failBacking = new Graphics();
    /** Holds the Flashlight mod's overlay (above the playfield, below the HUD). */
    private readonly flashlightLayer = new Container();
    private flashlight: Flashlight | null = null;
    /** Song time the flashlight last advanced to. */
    private flashlightTime = NaN;
    /** SD / PF "Restart on fail" tripped: retry at the end of this frame. */
    private restartPending = false;
    private readonly failFlash = new Graphics();
    private readonly retryFade = new Graphics();
    /** wosu!'s pause / fail menu, or stable's when the skin draws one. */
    private menu!: GameplayMenu | LegacyGameplayMenu;
    private skip!: SkipButton;
    /** stable's countdown, section pass / fail and break warning arrows. */
    private stablePlay!: StablePlayOverlay;
    /** The skin's pause-loop while the pause menu is up, and its volume. */
    private pauseLoop: LoopHandle | null = null;
    private pauseLoopVolume = 0;
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
    private lastJudgementTime = -Infinity;
    private failClock = 0;
    private failedAtTime = 0;
    private quickRetryHeld = 0;
    private catchingUp = false;
    private lastFedTime = -Infinity;
    /** The hold-to-confirm hotkey being held (quick retry / quick exit). */
    private holdAction: 'quickRetry' | 'quickExit' | null = null;
    private fadingFor: 'quickRetry' | 'quickExit' | null = null;
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
    /** The skins in effect for this play (beatmap → selected → default). */
    skinChain!: SkinChain;
    private storyboard: StoryboardView | null = null;
    private storyboardLoad: Promise<void> | null = null;
    private storyboardLoaded = false;
    /** What the background layer shows instead of the plain image: backing, video, storyboard. */
    private readonly bgCustom = new Container();
    private readonly bgBacking = new Graphics();
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
        // The skins in effect: the map's own (its images under "Beatmap skins", its .osu
        // colours under "Beatmap colours"), then the selected skin, then wosu!'s default.
        const set = g.settings;
        const raw = o.data;
        const chain = (this.skinChain = g.skins.chain({
            skin: o.beatmapSkin ?? null,
            textures: set.beatmapSkin.value,
            samples: false, // the map's hitsounds follow osu!'s sample-index rules (HitsoundPlayer)
            config: { comboColours: raw.comboColors, sliderTrackOverride: raw.sliderTrackOverride ?? undefined, sliderBorder: raw.sliderBorder ?? undefined },
            useConfig: set.beatmapColours.value,
        }));
        const data = {
            ...raw,
            comboColors: chain.config('comboColours').slice(),
            sliderTrackOverride: chain.config('sliderTrackOverride') ?? null,
            sliderBorder: chain.config('sliderBorder') ?? null,
        };
        // A replay judges with the mechanics its score was set with.
        const mechanics = o.replay?.mechanics ?? g.settings.gameplayMechanics.value;
        const beatmap = (this.beatmap = buildPlayableBeatmap(data, mods, playableOptions(mechanics)));
        const d = o.data.difficulty;
        const objectCount = beatmap.hitObjects.length;
        const breakTime = beatmap.breaks.reduce((t, b) => t + Math.max(0, b.endTime - b.startTime), 0);
        this.score = new ScoreProcessor({
            difficultyMultiplier: difficultyMultiplier(
                { hp: d.hpDrainRate, cs: d.circleSize, od: d.overallDifficulty }, objectCount, beatmap.endTime - beatmap.startTime - breakTime),
            modMultiplier: scoreMultiplier(mods),
            mechanics,
        });
        const noFail = mods.has('NF') || this.mode === 'autoplay' || this.mode === 'relax' || this.mode === 'autopilot';
        this.health = new HealthProcessor({
            hpDifficulty: beatmap.difficulty.hp,
            breaks: beatmap.breaks,
            drainStart: beatmap.startTime,
            drainEnd: beatmap.endTime,
            lives: extraLives(mods),
            noFail,
            mechanics,
            objects: beatmap.hitObjects,
            od: beatmap.difficulty.od,
        });
        this.rules = new GameplayRules(beatmap, mods, this.score, this.health, mechanics);
        if (this.mode === 'autoplay' || this.mode === 'autopilot') this.auto = new AutoPlayer(beatmap);
        this.driver = new RulesDriver(this.rules, this.mode, this.auto);
        if (this.mode === 'autoplay') this.driver.beforeStep = t => this.feedAutoplay(t);
        else if (o.replay) this.replay = new ReplayPlayback(o.replay.events);
        else this.recorder = new ReplayRecorder();

        const first = beatmap.hitObjects[0];
        const preempt = beatmap.difficulty.preempt;
        const leadIn = Math.max(o.data.general.audioLeadIn, 0);
        // The map's countdown (stable): the intro makes room for it, and skipping lands just before it.
        const countdown = countdownSchedule(first.time, beatmap.controlPoints.at(first.time).beatLength, o.data.general.countdown, o.data.general.countdownOffset);
        const start = Math.min(0, -leadIn, first.time - preempt - 1500, countdown ? countdown.start - 500 : 0);
        this.skipTarget = Math.min(first.time - preempt - 1000, countdown ? countdown.start - 100 : Infinity);
        this.playStart = first.time - preempt;
        this.clock = new GameplayClock(o.track, start);

        this.input = new GameplayInput(g.app, g.settings, () => this.clock.now, { x: g.input.pointer.x, y: g.input.pointer.y });
        this.input.relative = g.input.pointerLock;
        this.input.ignorePointer = (x, y) => {
            const onHold = this.holdButton.containsPoint(x, y);
            const onSkip = this.skip.available && x >= this.skip.x && y >= this.skip.y && x <= this.skip.x + this.skip.w && y <= this.skip.y + this.skip.h;
            // Pixi can't see a locked pointer (its client position is frozen): press these for it.
            if (g.input.pointerLock.locked) {
                if (onHold) this.holdButton.beginHold();
                else if (onSkip) this.doSkip();
            }
            return onHold || onSkip;
        };
        this.hitsounds = new HitsoundPlayer(g.samples, beatmap, o.beatmapSkin ?? null, g.skins.current.value);
        this.hitsounds.useBeatmapSamples = g.settings.beatmapHitsounds.value;
        this.hitsounds.spinnerFrequencyModulate = chain.config('spinnerFrequencyModulate');
        // Nightcore's beat comes from the selected skin only, never a beatmap's (osu! wiki, Skinning/Sounds);
        // wosu!'s default skin has no nightcore samples, so it stays silent there.
        const userSkin = g.skins.current.value;
        if (mods.has('NC') && userSkin) {
            this.nightcore = new NightcoreBeats(raw.timingPoints, nightcorePlaysHats(raw.difficulty.sliderTickRate), name => {
                const buf = userSkin.sample(name);
                if (buf) g.samples.playBuffer(buf, 1);
            });
        }

        this.playfield = new Playfield({
            renderer: g.app.renderer,
            skin: chain,
            beatmap,
            rules: this.rules,
            // HD's "Only fade approach circles" keeps the objects' normal fading.
            hidden: mods.has('HD') && !hiddenSettings(mods).onlyFadeApproachCircles,
            hideApproachCircles: mods.has('HD'),
            hideNumbers: g.settings.hideNumbers.value,
            hideFollowPoints: g.settings.hideFollowPoints.value,
            snakingIn: g.settings.snakingIn.value,
            snakingOut: g.settings.snakingOut.value,
            kiaiFlashes: g.settings.kiaiFlash.value,
        });
        this.playfield.judgements.hideGreat = g.settings.hideGreat.value;
        this.playfield.judgements.hitLighting = g.settings.hitLighting.value;
        this.smoke = new SmokeLayer(chain);
        this.fieldWrap.addChild(this.smoke, this.playfield);

        if (mods.has('FL')) {
            this.flashlight = new Flashlight(flashlightSettings(mods));
            this.flashlightLayer.addChild(this.flashlight);
        }

        this.hud = new HUDOverlay(chain, beatmap, g.settings, {
            canFail: !noFail,
            // lazer's legacy HUD layout comes with an imported skin; wosu!'s default keeps its own.
            legacyLayout: g.skins.current.value !== null,
            // lazer names Autoplay's score "Autoplay"; a replay shows its player.
            playerName: this.mode === 'autoplay' ? 'Autoplay' : o.replay ? o.replay.player || 'Guest' : g.profile.name.value,
            introStart: start,
            // The selected skin's saved layout (skin editor), and what its extra components show.
            skinId: g.skins.currentInfo.value?.id ?? '',
            mods,
            mechanics,
            beatmapInfo: () => ({
                artist: o.selection.set.artist, title: o.selection.set.title, version: o.selection.diff.version,
                creator: o.selection.set.creator, stars: this.playedStars(), mods: sortedMods(mods),
            }),
        });
        this.stablePlay = new StablePlayOverlay(chain, countdown, beatmap.breaks);
        this.stablePlay.playSample = names => this.playSkinSample(names);
        // The gameplay leaderboard lists this difficulty's local scores (lazer's solo leaderboard provider).
        const { set: lbSet, diff: lbDiff } = o.selection;
        void g.scores.forBeatmap(beatmapKeyOf({ beatmapId: lbDiff.beatmapId, title: lbSet.title, version: lbDiff.version, setId: lbSet.onlineSetId ?? 0 }))
            .then(list => { if (!this.destroyed) this.hud.setLeaderboardScores(list); })
            .catch(e => console.warn('[leaderboard] scores unavailable', e));
        // Local scores are all this device's player: their picture in the avatar tiles (not on Autoplay's entry).
        this.avatarOff = g.profile.avatar.bind(t => this.hud.leaderboard.setAvatar(t, this.mode !== 'autoplay'), true);
        this.menu = LegacyGameplayMenu.available(chain)
            ? new LegacyGameplayMenu(chain, names => this.playSkinSample(names))
            : new GameplayMenu(g.skin.tex('triangle'));
        const skipFrames = chain.frames('play-skip');
        this.skip = new SkipButton(skipFrames.length ? { frames: skipFrames, frameDuration: chain.frameDuration(skipFrames.length) } : null);
        this.skip.onActivate = () => this.doSkip();
        this.resume = new ResumeOverlay();
        this.holdButton = new HoldForMenuButton();
        this.offs.push(this.game.settings.holdToConfirmMs.bind(v => (this.holdButton.holdMs = v), true));
        this.holdButton.onHeld = () => this.pause();
        this.failFlash.alpha = 0;
        this.retryFade.alpha = 0;
        this.failBacking.visible = false;
        this.failContent.addChild(this.failBacking, this.fieldWrap, this.flashlightLayer, this.stablePlay, this.hud, this.stablePlay.arrowLayer);
        // A beatmap's comboburst sounds play with "Beatmap hitsounds" on (like its other samples).
        const burstSounds = comboBurstSounds([set.beatmapHitsounds.value ? o.beatmapSkin : null, g.skins.current.value]);
        this.bursts = new ComboBursts(chain, burstSounds, buf => g.samples.playBuffer(buf, 1));
        this.failContent.addChildAt(this.bursts, this.failContent.getChildIndex(this.fieldWrap));
        this.offs.push(set.comboBursts.bind(v => (this.bursts.enabled = v), true));
        if (o.replay) {
            const { set, diff } = o.selection;
            this.replayIndicator = new ReplayIndicator(`Watching ${o.replay.player || 'Guest'} play ${set.artist} - ${set.title} [${diff.version}]`);
            this.failContent.addChild(this.replayIndicator);
            const rs = (this.replaySettings = new ReplaySettingsOverlay(g.settings, REPLAY_SEEK_MS, actionLabel(g.input.bindings, 'toggleReplaySettings')));
            const view = o.replayView;
            rs.speed.value = view?.speed ?? 1;
            rs.pinned.value = view?.settingsPinned ?? false;
            rs.onTogglePause = () => this.toggleReplayPause();
            rs.onSeek = t => this.seekReplayTo(t);
            rs.onSeekBy = d => this.seekReplay(d);
            // A rebuild (backward seek) gets the track still running at the previous Player's speed.
            this.speedApplied = o.track.playbackRate / playbackRate(mods);
            this.offs.push(rs.speed.bind(() => void this.applyReplaySpeed(), true));
        }
        this.failFlash.blendMode = 'add';
        this.root.addChild(this.failContent, this.failFlash, this.skip, this.holdButton, this.resume, this.menu, this.retryFade);
        if (this.replaySettings) this.root.addChildAt(this.replaySettings, this.root.getChildIndex(this.resume));
        this.addChild(this.root);
        this.eventMode = 'passive';

        this.wireEvents();
        // Video and storyboard sit in the background layer (dimmed with it):
        // black backing (when the storyboard replaces the image), video, storyboard.
        this.bgBacking.visible = false;
        this.bgCustom.addChild(this.bgBacking);
        if (o.storyboard?.sprites.length || o.storyboard?.samples.length) {
            const sb = (this.storyboard = new StoryboardView(o.storyboard, o.data.general.widescreenStoryboard));
            this.bgCustom.addChild(sb.back);
            this.failContent.addChildAt(sb.front, this.failContent.getChildIndex(this.fieldWrap) + 1);
        }
        const s = g.settings;
        this.offs.push(s.storyboard.bind(on => {
            if (on && this.storyboard && !this.storyboardLoad) this.storyboardLoad = this.loadStoryboard();
            this.updateBackgroundLayers();
        }, true));
        this.offs.push(s.backgroundVideo.bind(on => {
            if (on && o.data.events.video && !this.video) void this.loadVideo(o.data.events.video);
            this.updateBackgroundLayers();
        }, true));
    }

    /** Ready to show: storyboard images (when shown) are decoded. The loader waits on this. */
    get assetsReady(): boolean {
        return !this.game.settings.storyboard.value || !this.storyboard || this.storyboardLoaded;
    }

    private async loadStoryboard(): Promise<void> {
        const sb = this.storyboard;
        if (!sb) return;
        try {
            const archive = await this.game.library.openArchive(this.options.selection.set.key);
            if (this.released) return;
            await sb.load(archive, this.game.audio);
        } catch (e) {
            console.warn('storyboard failed to load', e);
        }
        if (this.released) return;
        this.storyboardLoaded = true;
        this.updateBackgroundLayers();
    }

    private async loadVideo(info: { filename: string; offset: number }): Promise<void> {
        const video = (this.video = new BackgroundVideo(info.offset));
        try {
            const archive = await this.game.library.openArchive(this.options.selection.set.key);
            if (!(await video.load(archive, info.filename)) || this.released) return;
            video.cover(this._w, this._h);
            this.videoReady = true;
            this.bgCustom.addChildAt(video.sprite, 1);
            this.updateBackgroundLayers();
        } catch (e) {
            console.warn('background video failed', e);
        }
    }

    /** Which background pieces show, from the settings and what has loaded. */
    private updateBackgroundLayers(): void {
        if (this.released) return;
        const s = this.game.settings;
        const showVideo = !!this.video && this.videoReady && s.backgroundVideo.value;
        if (this.video) this.video.sprite.renderable = showVideo;
        const sb = this.storyboard;
        const showSb = !!sb && this.storyboardLoaded && s.storyboard.value;
        if (sb) sb.back.visible = sb.front.visible = showSb;
        // osu! hides the plain background when the storyboard draws that image
        // itself, and shows black (not our default art) when the map has none.
        const bgFile = this.options.data.events.backgroundFile;
        this.bgBacking.visible = showSb && !showVideo && (!bgFile || !!sb?.usesImage(bgFile));
        const any = showVideo || showSb;
        // Prepared behind the loader: these appear once gameplay is shown.
        if (this.entered) this.game.background.setCustom(any ? this.bgCustom : null);
    }

    private wireEvents(): void {
        const rules = this.rules;
        const objs = this.beatmap.hitObjects;
        rules.objectJudged.add(info => {
            const h = objs[info.index];
            this.lastJudgementTime = Math.max(this.lastJudgementTime, info.time);
            this.playfield.judgements.add(info.result, info.x, info.y, info.time, comboColor(this.playfield.ctx, h), info.variant);
            if (info.result === 'miss' || this.catchingUp) return;
            if (h.kind === 'circle' || h.kind === 'spinner') this.hitsounds.hit(h);
        });
        rules.nestedJudged.add((index, ev, hit) => {
            // lazer's slider end isn't an objectJudged (its judgement was the head's); its tail is the last.
            this.lastJudgementTime = Math.max(this.lastJudgementTime, ev.time);
            if (!hit || this.catchingUp) return;
            const h = objs[index] as PlayableSlider;
            if (ev.kind === 'tick') this.hitsounds.tick(h, ev.time, ev.x);
            else if (ev.kind === 'head') this.hitsounds.sliderEdge(h, 0, h.x);
            else if (ev.kind === 'repeat') this.hitsounds.sliderEdge(h, ev.spanIndex + 1, ev.x);
            else this.hitsounds.sliderEdge(h, h.slides, ev.x);
        });
        rules.headHit.add((_i, _t, error) => this.hud.onHit(error));
        // lazer's HealthDisplay flashes on every successful judgement (ticks and spins too).
        rules.objectJudged.add(info => { if (info.result !== 'miss') this.hud.onJudgement(); });
        rules.nestedJudged.add((_i, _e, hit) => { if (hit) this.hud.onJudgement(); });
        rules.spun.add(() => this.hud.onJudgement());
        rules.spun.add((index, bonus) => {
            if (bonus) this.hitsounds.spinnerBonus(objs[index]);
        });
        this.score.comboBroken.add(previous => {
            if (previous >= 20) this.hitsounds.comboBreak();
        });
        this.score.comboIncreased.add(combo => this.bursts.onCombo(combo));
        this.health.failedSignal.add(() => this.startFail());
        this.input.pressed.add((time, x, y, button) => {
            // Only a real play takes presses: Autoplay and replays ignore the user's
            // (the driver also drops Relax's, but they're recorded for the key overlay).
            if (this.phase !== 'playing' || !this.recorder) return;
            const p = this.toPlayfield(x, y);
            const e = this.recorder.press(time, p.x, p.y, button);
            this.driver.press(e.time, e.x, e.y);
        });
        this.input.anyPress.add((x, y) => {
            if (this.phase === 'resuming' && this.resume.hits(x, y)) this.finishResume();
        });

        const blur = () => {
            if (this.phase === 'playing' && this.mode !== 'autoplay' && !this.replay) this.pause();
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
        // Esc (or the browser) took the pointer lock back: pause like Esc does.
        this.offs.push(this.game.input.pointerLock.lost.add(() => {
            if (this.phase === 'playing' || this.phase === 'resuming') this.pause();
        }));
        // Locked, Pixi would hit-test at the frozen lock point; gameplay presses the controls itself.
        this.offs.push(this.game.input.pointerLock.lockChanged.add(locked => (this.root.interactiveChildren = !locked)));
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
        this.offs.push(s.beatmapHitsounds.bind(v => (this.hitsounds.useBeatmapSamples = v)));
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
        this.bursts.layout(w, h);
        this.video?.cover(w, h);
        this.storyboard?.layout(w, h);
        this.bgBacking.clear().rect(0, 0, w, h).fill(0x000000);
        this.menu.resize(w, h);
        this.skip.layout(w, h);
        this.stablePlay.layout(w, h);
        this.holdButton.position.set(w - this.holdButton.w - 16, h - this.holdButton.h - 64);
        this.failFlash.clear().rect(0, 0, w, h).fill(0xff0000);
        this.failBacking.clear().rect(0, 0, w, h).fill(0x000000);
        this.retryFade.clear().rect(0, 0, w, h).fill(0x000000);
        this.flashlight?.resize(w, h);
        this.replayIndicator?.layout(w, h);
        this.replaySettings?.resize(w, h);
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
        this.updateBackgroundLayers();
        const cursor = this.game.cursor;
        // The gameplay cursor follows this play's skins (beatmap skin included).
        cursor.useSkin(this.skinChain);
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
        this.input.enabled = this.mode !== 'autoplay' && !this.replay;
        this.clock.start();
        const at = this.options.startAt;
        if (this.replay && at !== undefined && at > this.clock.frameTime) this.clock.seek(at);
        if (this.replay && this.options.replayView?.paused) this.toggleReplayPause();
    }

    override onSuspending(): void {
        // Results are pushed on top: the music plays on, gameplay stops.
        this.releaseGameplay();
        this.fadeOut(300);
    }

    override onExiting(): number {
        // The loader offers "Calibrate using last play" from this (also after results → song select → play again).
        const timing = this.playTiming;
        if (timing && this.phase !== 'loading') beatmapOffsets().recordPlay(offsetKeyFor(this.options.selection.set, this.options.selection.diff), timing);
        this.releaseGameplay();
        if (this.outcome !== 'completed') this.clock?.pause();
        this.fadeOut(250);
        return 250;
    }

    /** Stop input, sounds and cursor control. Idempotent: suspend, exit and destroy all call it. */
    private releaseGameplay(): void {
        if (this.released) return;
        this.released = true;
        this.game.input.pointerLock.wanted = false;
        this.root.interactiveChildren = true;
        this.input?.dispose();
        this.hitsounds?.stopAll();
        this.stopPauseLoop();
        for (const off of this.offs) off();
        this.offs.length = 0;
        this.game.background.releaseParallax(this);
        const cursor = this.game.cursor;
        cursor.external = false;
        cursor.useSkin(null);
        this.game.updateCursorVisibility();
        if (this.entered) this.game.background.setCustom(null);
        if (this.video) {
            this.video.dispose();
            this.video = null;
        }
        this.storyboard?.destroy();
        this.storyboard = null;
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
        this.updatePointerLock();
        const cursor = this.updateCursor(time, dt);

        if (this.phase === 'playing') {
            this.feedRules(time, cursor);
            this.updateLoops(time);
            this.bursts.update(dt);
            this.nightcore?.update(time);
            this.sampleHealth(time);
            if (this.rules.finished && time >= this.lastJudgementTime + RESULTS_DELAY && time >= this.beatmap.endTime) this.complete();
        }
        this.updateSmoke(time, cursor);
        this.renderState(time, dt);
        this.updateSkip(time, dt);
        this.holdButton.visible = this.phase === 'playing' || this.phase === 'resuming';
        if (this.holdButton.visible) this.holdButton.update(dt, this.input, this.game.input.lastPointerKind.value === 'touch');
        this.updateFlashlight(cursor, time);
        this.updateReplaySettings(dt, time);
        this.resume.update(dt, this._w, this._h, this.input.x, this.input.y);
        if (this.restartPending) {
            // Outside the judgement loop that raised the fail.
            this.restartPending = false;
            this.retry(true);
            return;
        }
        if (this.phase === 'failed') this.updateFail(dt);
        this.updatePauseLoop(dt);
        this.updateQuickRetry(dt);
    }

    /** Playfield, video, break dim and HUD for song time `time`. */
    private renderState(time: number, dt: number): void {
        this.playfield.update(this.phase === 'failed' ? this.failedAtTime : time);
        this.video?.sync(time, this.phase === 'playing' || this.phase === 'completed', this.clock.rate);
        this.storyboard?.update(this.phase === 'failed' ? this.failedAtTime : time, this.phase === 'playing', this.game.audio);
        this.updateBreakDim(time);
        this.hud.update(dt, {
            time,
            // The mods' rate: a replay's playback speed doesn't change the song's length.
            rate: playbackRate(this.options.mods),
            score: this.score.score,
            accuracy: this.score.accuracy,
            combo: this.score.combo,
            maxCombo: this.score.maxCombo,
            hp: this.health.hp,
            grade: this.score.grade(this.options.mods.has('HD') || this.options.mods.has('FL')),
            down: this.keysDown,
            counts: this.mode === 'autoplay' ? this.autoCounts : this.replay ? this.replay.counts : this.input.counts,
            // lazer's localUserPlaying (breaks and the intro count as "not playing").
            playing: this.phase === 'playing' && time >= this.playStart && !this.hud.isBreak(time) && !this.rules.finished,
            stats: {
                great: this.score.count300, ok: this.score.count100, meh: this.score.count50, miss: this.score.countMiss,
                maxCombo: this.score.maxCombo, accuracy: this.score.accuracy,
                sliderEndsJudged: this.score.sliderEndsTotal, sliderEndsHit: this.score.sliderEndsHit,
                tickMisses: this.score.sliderTicksTotal - this.score.sliderTicksHit,
            },
            hitErrors: this.rules.hitErrors,
        });
        this.stablePlay.update(this.phase === 'failed' ? this.failedAtTime : time, this.health.hp);
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

    /**
     * lazer's high precision mouse / confine during gameplay: the pointer is
     * locked while the player aims (not paused, failed or finished, nor while
     * autoplay or autopilot moves the cursor). The menus get the real pointer back.
     */
    private updatePointerLock(): void {
        const lock = this.game.input.pointerLock;
        const s = this.game.settings;
        const raw = s.highPrecisionMouse.value;
        const aiming = this.phase === 'loading' || this.phase === 'playing' || this.phase === 'resuming';
        lock.raw = raw;
        lock.sensitivity = s.cursorSensitivity.value;
        lock.wanted = !this.released && aiming && this.mode !== 'autoplay' && this.mode !== 'autopilot' && !this.replay &&
            (raw || s.confineMouse.value === 'duringGameplay');
        this.root.interactiveChildren = !lock.locked;
    }

    /** Cursor in playfield coordinates; also drives the on-screen cursor. */
    private updateCursor(time: number, _dt: number): { x: number; y: number; held: boolean } {
        const c = this.game.cursor;
        // lazer swaps to the menu cursor once the pause / fail menu is up; autoplay keeps the user's cursor visible.
        c.gameplayActive = this.phase !== 'paused' && !(this.phase === 'failed' && this.menu.shown);
        c.replayLoaded = this.mode === 'autoplay' || !!this.replay;
        c.playfieldScale = this.view.scale;
        c.circleSize = this.beatmap.difficulty.cs;
        const down = this.keysDown;
        c.setDownCount(+down.K1 + +down.K2 + +down.M1 + +down.M2);
        // A replay moves the gameplay cursor along its frames (the menus keep the user's).
        if (this.replay) {
            const r = this.replay.cursorAt(time);
            const sp = this.toScreen(r.x, r.y);
            c.moveTo(sp.x, sp.y);
            return { x: r.x, y: r.y, held: buttonMask(down) !== 0 };
        }
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

    /** Held gameplay buttons as shown (key overlay, cursor): Autoplay's, the replay's or the user's. */
    private get keysDown(): Readonly<Record<GameplayButton, boolean>> {
        return this.mode === 'autoplay' ? this.autoDown : this.replay ? this.replay.down : this.input.down;
    }

    /**
     * Judge up to `time`. A real play judges exactly the frames it records
     * (lazer's ReplayRecorder rate), a replay feeds back the recorded events
     * as the clock passes them, and Autoplay steps every frame.
     */
    private feedRules(time: number, cursor: CursorState): void {
        if (this.replay) {
            // A seek catches up many events in one frame: judge them without a burst of hitsounds.
            this.catchingUp = time - this.lastFedTime > CATCH_UP_MS;
            this.replay.advance(time, e => this.driver.apply(e));
            this.catchingUp = false;
            this.lastFedTime = time;
        } else if (this.recorder) {
            const f = this.recorder.frame(time, cursor.x, cursor.y, buttonMask(this.input.down) | (this.input.smoke ? SMOKE_BIT : 0));
            if (f) this.driver.apply(f);
        } else {
            this.driver.step(time, cursor);
        }
    }

    /**
     * The smoke key draws along the cursor on the gameplay clock: the
     * player's own key, or the replay's recorded one. Autoplay has none.
     * A press also ripples the cursor, like every osu! action in lazer.
     */
    private updateSmoke(time: number, cursor: { x: number; y: number }): void {
        const on = this.replay ? this.replay.smoke : this.mode !== 'autoplay' && this.input.smoke;
        if (this.smoke.input(time, on, cursor.x, cursor.y)) this.game.cursor.gameplay.ripple();
        this.smoke.draw(time);
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
        this.stablePlay.seeked();
    }

    // ------------------------------------------------------------------
    // Beatmap offset (lazer's IncreaseOffset / DecreaseOffset in gameplay)
    // ------------------------------------------------------------------

    /**
     * Nudge this difficulty's offset by `step` ms. Like lazer, only while
     * it can't affect a judgement already under way: before the first
     * object, in breaks, or paused.
     */
    private adjustBeatmapOffset(step: number): void {
        if (this.options.replay) return;
        const time = this.clock.frameTime;
        const first = this.beatmap.hitObjects[0];
        const quiet = this.phase === 'paused' || this.phase === 'loading' ||
            (this.phase === 'playing' && (time < first.time - this.beatmap.difficulty.preempt || this.hud.isBreak(time)));
        const store = beatmapOffsets();
        const key = offsetKeyFor(this.options.selection.set, this.options.selection.diff);
        if (quiet) store.set(key, store.get(key) + step);
        this.showOffsetToast(quiet ? null : 'Offset can only be adjusted before the first object, in breaks or while paused');
    }

    private offsetToast: Text | null = null;

    private showOffsetToast(warning: string | null): void {
        if (!this.offsetToast) {
            this.offsetToast = label('', { size: 16, weight: '700', shadow: true });
            this.offsetToast.anchor.set(0.5, 0);
            this.root.addChild(this.offsetToast);
        }
        const t = this.offsetToast;
        const v = beatmapOffsets().get(offsetKeyFor(this.options.selection.set, this.options.selection.diff));
        t.text = warning ?? `Beatmap offset: ${formatBeatmapOffset(v)}`;
        t.tint = warning ? Colors.yellow : 0xffffff;
        t.position.set(this._w / 2, 64);
        tweener.kill(t, ['alpha']);
        t.alpha = 1;
        tween(t, { alpha: 0 }, { duration: 600, delay: 1400 });
    }

    // ------------------------------------------------------------------
    // Replay controls (lazer's ReplayPlayer)
    // ------------------------------------------------------------------

    private replayPaused = false;
    /** A backward seek rebuilds the Player from the loader at this time (judgement can't run backwards). */
    replayRestartAt: number | null = null;

    private toggleReplayPause(): void {
        if (this.phase !== 'playing') return;
        this.replayPaused = !this.replayPaused;
        if (this.replayPaused) {
            this.clock.pause();
            this.hitsounds.stopAll();
        } else {
            this.clock.resume();
        }
    }

    private seekReplay(delta: number): void {
        if (this.phase !== 'playing' || !this.replay) return;
        this.seekReplayTo(this.clock.frameTime + delta);
    }

    /** Seek the replay to song time `time` (the keys and the replay settings' seek bar). */
    private seekReplayTo(time: number): void {
        if (this.phase !== 'playing' || !this.replay) return;
        const now = this.clock.frameTime;
        const target = Math.max(this.clock.startTime, Math.min(this.beatmap.endTime, time));
        if (target >= now) {
            // Forward: the replay's events catch up (silently) on the next frame.
            if (target > now) this.clock.seek(target);
            return;
        }
        if (now - target < 50) return;
        this.replayRestartAt = target;
        this.retry(true);
    }

    /** The viewer's controls for the loader to hand to the rebuilt Player (null: not a replay). */
    get replayView(): ReplayViewState | null {
        const rs = this.replaySettings;
        return rs ? { speed: rs.speed.value, settingsPinned: rs.pinned.value, paused: this.replayPaused } : null;
    }

    /**
     * Run the track at the replay settings' speed (lazer's UserPlaybackRate:
     * tempo on top of the mods' rate, pitch kept). Only the clock's rate
     * changes; the replay's events are still applied at their own times, so
     * judgement doesn't depend on it. Slider drags coalesce into one change
     * at a time, with the clock held while the track restarts.
     */
    private async applyReplaySpeed(): Promise<void> {
        const rs = this.replaySettings;
        if (!rs || this.speedApplying) return;
        this.speedApplying = true;
        try {
            while (!this.released && Math.abs(clampReplaySpeed(rs.speed.value) - this.speedApplied) > 1e-6) {
                const speed = clampReplaySpeed(rs.speed.value);
                const mods = this.options.mods;
                const hold = this.phase === 'playing' && !this.clock.paused;
                if (hold) this.clock.pause();
                await this.options.track.setRate(replayTrackRate(playbackRate(mods), speed), preservesPitch(mods), audioPitch(mods));
                this.speedApplied = speed;
                if (hold && !this.released && this.phase === 'playing' && !this.replayPaused) this.clock.resume();
            }
        } catch (e) {
            console.warn('[replay] playback speed change failed', e);
        } finally {
            this.speedApplying = false;
        }
    }

    private updateReplaySettings(dt: number, time: number): void {
        const rs = this.replaySettings;
        if (!rs) return;
        // Not over the pause / fail menus or the end of the replay.
        rs.visible = this.phase === 'playing' || this.phase === 'loading';
        if (!rs.visible) return;
        rs.update(dt, {
            time,
            start: this.clock.startTime,
            end: this.beatmap.endTime,
            paused: this.replayPaused,
            pointer: this.game.input.pointer,
        });
    }

    /**
     * The Flashlight mod (see gameplay/Flashlight): it runs on song time like
     * lazer's (frozen while paused, faster under DT). lazer's IsBreakTime also
     * covers the intro until 2 s before the first object (its shrink delayed by
     * BREAK_FADE_DURATION, as when leaving a break) and everything after the
     * last judgement.
     */
    private updateFlashlight(cursor: { x: number; y: number }, time: number): void {
        const fl = this.flashlight;
        if (!fl) return;
        const dt = Number.isNaN(this.flashlightTime) ? 0 : time - this.flashlightTime;
        this.flashlightTime = time;
        const first = this.beatmap.hitObjects[0];
        const inBreak = this.hud.isBreak(time) || time < first.time - 2000 + 325 || this.rules.finished;
        fl.update(dt, {
            cursorX: cursor.x,
            cursorY: cursor.y,
            combo: this.score.combo,
            inBreak,
            sliderTracking: this.sliderTracked(time),
        }, this.view.scale, (x, y) => this.toScreen(x, y));
    }

    /** A started slider is being held right now (OsuFlashlight.OnSliderTrackingChange). */
    private sliderTracked(time: number): boolean {
        const objs = this.beatmap.hitObjects;
        for (let i = this.loopStart; i < objs.length; i++) {
            const h = objs[i];
            if (h.time > time) break;
            if (h.kind !== 'slider' || time >= h.endTime) continue;
            if ((this.rules.states[i] as SliderState).tracking) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Pause / resume
    // ------------------------------------------------------------------

    pause(): void {
        if (this.phase !== 'playing' && this.phase !== 'resuming') return;
        this.phase = 'paused';
        // The pause menu needs the real pointer at once.
        this.updatePointerLock();
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
                { caption: 'Continue', color: Colors.green, action: () => this.continuePlay(), element: 'continue' },
                { caption: 'Retry', color: Colors.yellowDark, action: () => this.retry(), element: 'retry' },
                { caption: 'Quit', color: 0xaa1b27, action: () => this.quit(), element: 'back' },
            ],
            back: 'first',
            ...this.menuInfo(),
        });
    }

    /**
     * The skin's pause-loop while the pause menu is up (stable's pause
     * music; lazer fades it in and out with the menu). Only a skin's:
     * wosu!'s default skin has none.
     */
    private updatePauseLoop(dt: number): void {
        const want = this.phase === 'paused' && this.menu.shown && !this.released;
        if (want && !this.pauseLoop) {
            const buf = this.skinSample('pause-loop');
            if (!buf) return;
            this.pauseLoop = this.game.samples.startLoopBuffer(buf, 0);
            this.pauseLoopVolume = 0;
        }
        const loop = this.pauseLoop;
        if (!loop) return;
        this.pauseLoopVolume = clamp01(this.pauseLoopVolume + (want ? dt : -dt) / PAUSE_LOOP_FADE);
        loop.setVolume(this.pauseLoopVolume);
        if (!want && this.pauseLoopVolume <= 0) this.stopPauseLoop();
    }

    private stopPauseLoop(): void {
        this.pauseLoop?.stop();
        this.pauseLoop = null;
    }

    /** A skin sound: the map's own (with beatmap hitsounds on), else the skins in the chain. */
    private skinSample(name: string): AudioBuffer | null | undefined {
        const fromMap = this.game.settings.beatmapHitsounds.value ? this.options.beatmapSkin?.sample(name) : undefined;
        return fromMap !== undefined ? fromMap : this.skinChain.sample(name);
    }

    /** Play the first of `names` a skin has (a deliberately blank one stays silent); false when none has any. */
    private playSkinSample(names: readonly string[]): boolean {
        if (this.released) return false;
        for (const n of names) {
            const buf = this.skinSample(n);
            if (buf === undefined) continue;
            if (buf) this.game.samples.playBuffer(buf, 1);
            return true;
        }
        return false;
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
        const needsAim = this.mode !== 'autoplay' && this.mode !== 'autopilot' && !this.replay && time > first.time - this.beatmap.difficulty.preempt;
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
        this.replayPaused = false;
        // A replay's own pauses are among its events; pausing while watching changes nothing.
        if (this.recorder) this.driver.apply(this.recorder.resume(this.clock.frameTime));
        else if (!this.replay) this.driver.resume();
        this.input.enabled = this.mode !== 'autoplay' && !this.replay;
        this.clock.resume();
    }

    // ------------------------------------------------------------------
    // Fail / complete / leave
    // ------------------------------------------------------------------

    private startFail(): void {
        if (this.phase === 'failed' || this.phase === 'completed') return;
        if (restartOnFail(this.options.mods)) {
            // lazer's Player.onFail: a fail override with RestartOnFail (SD / PF
            // "Restart on fail") restarts at once (quick restart), with no fail animation.
            this.phase = 'failed';
            this.failedAtTime = this.clock.frameTime;
            this.input.enabled = false;
            this.hitsounds.stopAll();
            this.clock.freeze();
            this.restartPending = true;
            return;
        }
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
        this.storyboard?.setFailed(true);
        // A skin (or the map, with beatmap hitsounds on) may bring its own failsound.
        const fromMap = this.game.settings.beatmapHitsounds.value ? this.options.beatmapSkin?.sample('failsound') : undefined;
        const own = fromMap !== undefined ? fromMap : this.skinChain.sample('failsound');
        if (own) this.game.samples.playBuffer(own, 1);
        else if (own === undefined) this.game.uiSounds.play('Gameplay/failsound');
        this.menu.visible = false;
        // lazer: an additive red flash fading from full over 1s.
        this.failFlash.alpha = 0.6;
        tween(this.failFlash, { alpha: 0 }, { duration: 1000, ease: 'None' });
        // The gameplay becomes a black card that shrinks, tilts and greys
        // out over a background darkened to 30% (lazer's FailAnimationContainer).
        const w = this._w, h = this._h;
        this.failBacking.visible = true;
        this.failContent.pivot.set(w / 2, h / 2);
        this.failContent.position.set(w / 2, h / 2);
        tween(this.failContent, { scale: 0.85, rotation: Math.PI / 180 }, { duration: FAIL_DURATION, ease: 'OutQuart' });
        const s = this.game.settings;
        this.game.background.setDim(1 - (1 - s.backgroundDim.value) * 0.3, 60);
    }

    /** Back during the fail animation jumps to its end: the retry/quit menu at once (lazer). */
    private skipFailAnimation(): void {
        this.options.track.pause();
        tweener.kill(this.failContent);
        this.failContent.scale.set(0.85);
        this.failContent.rotation = Math.PI / 180;
        this.failClock = FAIL_DURATION;
        this.updateFail(0);
    }

    private updateFail(dt: number): void {
        this.failClock += dt;
        const t = clamp01(this.failClock / FAIL_DURATION);
        // lazer's FailAnimation: objects drop away, everything fades to grey.
        this.playfield.failDrop(t);
        const grey = Math.round(255 - (255 - 128) * t);
        this.failContent.tint = (grey << 16) | (grey << 8) | grey;
        this.hud.alpha = 1 - t;
        if (this.failClock >= FAIL_DURATION && !this.menu.shown) {
            this.menu.show({
                title: 'failed',
                description: "you're dead, try again?",
                entries: [
                    { caption: 'Retry', color: Colors.yellowDark, action: () => this.retry(), element: 'retry' },
                    { caption: 'Quit', color: 0xaa1b27, action: () => this.quit(), element: 'back' },
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
        const watched = this.options.replay;
        let replay: ReplayInfo | null = watched ?? null;
        if (watched) {
            // lazer: results of a replay show that score, and nothing new is saved.
            result.player = watched.player;
            result.date = watched.date;
        } else if (this.recorder) {
            replay = { events: this.recorder.events, mods: result.mods, modSettings: result.modSettings, mechanics: this.rules.mechanics, player: result.player, date: result.date };
            void this.saveScore(result, replay);
        }
        tween(this.root, { alpha: 0 }, { duration: 400 }).finished.then(() => {
            if (this.destroyed || !this.isCurrent) return;
            this.push(new ResultsScreen(result, this.options.selection, {
                replay,
                allowRetry: !watched,
                // The skin's applause (a beatmap's with "Beatmap hitsounds" on), like osu!stable's.
                applause: skinApplause([
                    this.game.settings.beatmapHitsounds.value ? this.options.beatmapSkin : null, this.game.skins.current.value,
                ], result.grade),
                // Back through the loader beneath (lazer's Player.Restart from results).
                onRetry: quick => this.restartFromResults(quick),
            }));
        });
    }

    private buildResult(): ScoreResult {
        const o = this.options;
        const { set, diff } = o.selection;
        const s = this.score;
        // The mods' rate (a replay watched at another playback speed scores the same).
        const rate = playbackRate(o.mods);
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
            modSettings: modSettingsOf(o.mods),
            score: Math.round(s.score),
            accuracy: s.accuracy,
            maxCombo: s.maxCombo,
            mapMaxCombo,
            count300: s.count300,
            count100: s.count100,
            count50: s.count50,
            countMiss: s.countMiss,
            countGeki: s.countGeki,
            countKatu: s.countKatu,
            sliderTicksHit: s.sliderTicksHit,
            sliderTicksTotal: s.sliderTicksTotal,
            // lazer's "slider end" statistic (tails count toward its accuracy).
            ...(s.mechanics === 'lazer' ? { sliderEndsHit: s.sliderEndsHit, sliderEndsTotal: s.sliderEndsTotal } : {}),
            grade: s.grade(o.mods.has('HD') || o.mods.has('FL')),
            passed: true,
            perfect: s.countMiss === 0 && s.maxCombo >= mapMaxCombo,
            date: Date.now(),
            player: this.game.profile.name.value,
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
        const relevant = ratingMods(this.options.mods);
        if (base === null || !relevant) return base;
        try {
            // Built as song select's modAdjustedStars does (legacy tails), so the figures match.
            const nomod = calculateDifficulty(buildPlayableBeatmap(this.options.data, NO_MODS)).stars;
            const played = calculateDifficulty(buildPlayableBeatmap(this.options.data, relevant), playbackRate(relevant)).stars;
            return nomod > 0 ? Math.round(base * (played / nomod) * 100) / 100 : base;
        } catch {
            return base;
        }
    }

    private async saveScore(r: ScoreResult, replay: ReplayInfo): Promise<void> {
        let data: Uint8Array | undefined;
        try {
            data = encodeReplay(replay.events);
        } catch (e) {
            console.warn('encoding the replay failed', e);
        }
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
                modSettings: r.modSettings,
                score: r.score,
                accuracy: r.accuracy,
                maxCombo: r.maxCombo,
                count300: r.count300,
                count100: r.count100,
                count50: r.count50,
                countMiss: r.countMiss,
                countGeki: r.countGeki,
                countKatu: r.countKatu,
                grade: r.grade,
                passed: r.passed,
                date: r.date,
                player: r.player,
                mechanics: replay.mechanics,
            }, data);
        } catch (e) {
            console.warn('saving score failed', e);
            this.game.notifications.error('Your score could not be saved.');
        }
    }

    /** `quick`: straight back into gameplay; otherwise through the loader's screen (lazer's Restart(quickRestart)). */
    retry(quick = false): void {
        if (this.outcome !== 'none') return;
        this.outcome = quick ? 'quickRetry' : 'retry';
        this.menu.hide();
        this.exit();
    }

    /** Results' Retry: the results screen goes with this Player, and the loader restarts. */
    private restartFromResults(quick: boolean): void {
        if (this.outcome !== 'completed' || this.destroyed) return;
        this.outcome = quick ? 'quickRetry' : 'retry';
        this.exit();
    }

    /** The play's timing for the loader's offset calibration (null: not the player's own timed play). */
    get playTiming(): PlayTiming | null {
        if (!this.rules || this.options.replay || this.mode === 'autoplay' || this.mode === 'relax') return null;
        return { hitErrors: this.rules.hitErrors, rate: this.clock?.rate ?? 1, offset: beatmapOffsets().get(offsetKeyFor(this.options.selection.set, this.options.selection.diff)) };
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
        // The Esc that just broke the pointer lock already paused; it must not also press "Continue".
        if (e.code === 'Escape' && this.game.input.pointerLock.lostWithin(500)) return true;
        if (this.menu.shown && this.menu.onKey(e, action)) return true;
        if (this.phase === 'resuming' || this.phase === 'playing') {
            if (this.input.keyDown(e)) return true;
        }
        const is = (a: Action) => this.game.input.matches(e, a);
        if (is('quickRetry') || is('quickExit')) {
            if (!e.repeat && this.phase !== 'completed') this.holdAction = is('quickRetry') ? 'quickRetry' : 'quickExit';
            return true;
        }
        if (is('toggleInGameInterface')) {
            // lazer's ToggleInGameInterface: cycles the (persisted) HUD visibility mode.
            const mode = this.hud.cycleVisibilityMode();
            const names = { always: 'Always', hideDuringGameplay: 'Hide during gameplay', never: 'Never' } as const;
            this.game.notifications.info(`HUD visibility: ${names[mode]}`);
            return true;
        }
        if (is('toggleInGameLeaderboard')) {
            // lazer's ToggleInGameLeaderboard (persisted, like the setting).
            if (!e.repeat) {
                const on = this.hud.toggleLeaderboard();
                this.game.notifications.info(`Gameplay leaderboard: ${on ? 'enabled' : 'disabled'}`);
            }
            return true;
        }
        if (is('increaseOffset') || is('decreaseOffset')) {
            this.adjustBeatmapOffset(is('increaseOffset') ? 1 : -1);
            return true;
        }
        if (this.replay && this.onReplayKey(e, is)) return true;
        if (e.key === 'Control') {
            // lazer's HoldForHUD.
            this.hud.holdingForHud = true;
            return false;
        }
        if (is('back')) {
            if (this.phase === 'playing' || this.phase === 'resuming') this.pause();
            else if (this.phase === 'failed' && !this.menu.shown) this.skipFailAnimation();
            return true;
        }
        if (is('pauseGameplay')) {
            if (this.phase === 'playing') this.pause();
            return true;
        }
        if (is('skip')) {
            this.doSkip();
            return true;
        }
        return false;
    }

    /** lazer's ReplayPlayer keys: pause the replay (Space doubles as skip while the intro can be skipped) and seek. */
    private onReplayKey(e: KeyboardEvent, is: (a: Action) => boolean): boolean {
        if (is('toggleReplaySettings')) {
            if (!e.repeat) this.replaySettings?.toggle();
            return true;
        }
        if (is('togglePauseReplay') && !(is('skip') && this.skip.available)) {
            if (!e.repeat) this.toggleReplayPause();
            return true;
        }
        if (is('seekReplayForward') || is('seekReplayBackward')) {
            this.seekReplay(is('seekReplayForward') ? REPLAY_SEEK_MS : -REPLAY_SEEK_MS);
            return true;
        }
        return false;
    }

    override onKeyUp(e: KeyboardEvent): void {
        this.input?.keyUp(e);
        if (e.key === 'Control' && this.hud) this.hud.holdingForHud = false;
        if (this.holdAction && this.game.input.releases(e, this.holdAction)) this.holdAction = null;
    }

    /**
     * Hold ` to retry or Ctrl+` to exit (lazer's HotkeyRetryOverlay /
     * HotkeyExitOverlay): the screen fades to black, release cancels.
     */
    private updateQuickRetry(dt: number): void {
        const action = this.holdAction;
        if (action) {
            if (action !== this.fadingFor) this.quickRetryHeld = 0;
            this.fadingFor = action;
            this.quickRetryHeld += dt;
        } else {
            this.quickRetryHeld = Math.max(0, this.quickRetryHeld - dt * 2);
        }
        const hold = this.game.settings.holdToConfirmMs.value;
        this.retryFade.alpha = hold > 0 ? clamp01(this.quickRetryHeld / hold) : 0;
        // Only while the key is down: with a 0 ms hold time, "held ≥ 0" is always true.
        if (action && this.quickRetryHeld >= hold && this.outcome === 'none') {
            this.holdAction = null;
            if (action === 'quickRetry') this.retry(true);
            else this.quit();
        }
    }

    override destroy(): void {
        this.releaseGameplay();
        this.avatarOff?.();
        this.avatarOff = null;
        super.destroy({ children: true });
    }
}
