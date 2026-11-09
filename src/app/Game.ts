import { Container, Graphics, Texture } from 'pixi.js';
import { loadPack, packFetch } from '../core/assetPacks';
import { track } from '../core/analytics';
import { sendPlayPing } from '../online/gameEvents';
import { Bindable } from '../core/Bindable';
import { afterNextFrame, whenIdle } from '../core/idle';
import { App } from './App';
import { BackgroundManager } from './BackgroundManager';
import { Cursor, setOsCursorVisible, type CursorTextures } from './Cursor';
import { FpsCounter } from './FpsCounter';
import type * as Deferred from './lazy';
import { LazyOverlay } from './LazyOverlay';
import { MusicController } from './MusicController';
import { OverlayManager, type Overlay } from './Overlay';
import { ScreenStack, type Screen } from './Screen';
import { AudioEngine } from '../audio/AudioEngine';
import { resolveAssetUrl } from '../audio/base';
import { MusicTrack } from '../audio/MusicTrack';
import { PreviewPlayer } from '../audio/PreviewPlayer';
import { SampleBank } from '../audio/SampleBank';
import { LATER_UI_SAMPLES, UISounds } from '../audio/UISounds';
import { BeatmapLibrary, type LibrarySet } from '../beatmap/Library';
import type { DifficultySummary } from '../beatmap/types';
import { NO_MODS, modSettingsOf, sanitizeMods, sortedMods, type ModSet } from '../gameplay/mods';
import { decodeReplay, type ReplayInfo } from '../gameplay/replay/Replay';
import { DEFAULT_MECHANICS } from '../gameplay/scoring/mechanics';
import { textureFromBlob, TextureCache, textureFromUrl } from '../graphics/textures';
import { InputManager, KeyPriority } from '../input/InputManager';
import { resolveBindings, type Action } from '../input/bindings';
import { openFileDialog } from '../input/PointerLock';
import { pointerLockWanted } from '../input/pointerLockPolicy';
import { TextInputProxy } from '../input/TextInputProxy';
import { AccountManager } from '../online/Account';
import { BeatmapApi } from '../online/BeatmapApi';
import { DownloadManager, type DownloadTask } from '../online/Downloader';
import { coverUrl, resolveProviders, type OnlineSet } from '../online/providers';
import { ALWAYS_BUNDLED, bundledSelection } from '../online/bundled';
import type { BeatmapListingOverlay } from '../overlays/BeatmapListingOverlay';
import { DialogOverlay } from '../overlays/DialogOverlay';
import { NotificationManager, type Notification } from '../overlays/notifications/Notifications';
import { NotificationOverlay } from '../overlays/notifications/NotificationOverlay';
import { ToastTray } from '../overlays/notifications/ToastTray';
import { NowPlayingOverlay } from '../overlays/NowPlayingOverlay';
import type { SettingsOverlay } from '../overlays/settings/SettingsOverlay';
import { Toolbar } from '../overlays/Toolbar';
import { VolumeOverlay } from '../overlays/VolumeOverlay';
import type { ProfileOverlay } from '../overlays/profile/ProfileOverlay';
import type { UserProfileOverlay } from '../overlays/profile/UserProfileOverlay';
import { LocalProfile } from './Profile';
import { GameSettings } from '../settings/Settings';
import { Skin } from '../skin/Skin';
import { menuSkin } from '../skin/MenuSkin';
import { DEFAULT_SKIN_URL, SkinManager } from '../skin/SkinManager';
import { Favourites } from '../storage/Favourites';
import { KnownVideos } from '../storage/KnownVideos';
import { ScoreStore, type ScoreRecord } from '../storage/ScoreStore';
import { Dropdown } from '../ui/Dropdown';
import { installBitmapFonts, loadFonts, loadMenuFonts, warmBitmapFonts } from '../ui/fonts';
import { KeyBindButton } from '../ui/KeyBindButton';
import { Slider } from '../ui/Slider';
import { TooltipLayer } from '../ui/Tooltip';
import { installUIContext } from '../ui/UIContext';
import type { UIComponent } from '../ui/UIComponent';
import { IntroScreen } from '../screens/IntroScreen';
import { MainMenuScreen } from '../screens/MainMenuScreen';

export interface Selection {
    set: LibrarySet;
    diff: DifficultySummary;
}

/**
 * The game root (osu!'s OsuGame): owns every service and global overlay,
 * routes global shortcuts and exposes the high-level flows screens use
 * (import, download, play). Screens get it injected by the ScreenStack.
 */
export class Game {
    readonly textInput = new TextInputProxy();
    readonly input: InputManager;
    readonly audio = new AudioEngine();
    readonly samples: SampleBank;
    readonly uiSounds: UISounds;
    readonly preview: PreviewPlayer;
    readonly library = new BeatmapLibrary();
    readonly scores = new ScoreStore();
    readonly favourites = new Favourites();
    readonly knownVideos = new KnownVideos();
    readonly api: BeatmapApi;
    readonly downloads: DownloadManager;
    readonly music: MusicController;
    readonly notifications = new NotificationManager();
    readonly background: BackgroundManager;
    readonly screens: ScreenStack;
    readonly overlays = new OverlayManager();
    readonly covers = new TextureCache(150);
    readonly cursor: Cursor;
    readonly tooltips: TooltipLayer;
    readonly fps: FpsCounter;

    /** Selected mods (persisted through settings). */
    readonly mods = new Bindable<ModSet>(NO_MODS);
    /** Beatmap selected in song select (drives music + background). */
    readonly selection = new Bindable<Selection | null>(null);
    readonly toolbarVisible = new Bindable(true);

    readonly toolbar: Toolbar;
    readonly toasts: ToastTray;
    /** Built on first use or in idle time after the menu shows (see LazyOverlay). */
    readonly settingsOverlay: LazyOverlay<SettingsOverlay>;
    readonly listing: LazyOverlay<BeatmapListingOverlay>;
    readonly notificationOverlay: NotificationOverlay;
    readonly nowPlaying: NowPlayingOverlay;
    readonly volume: VolumeOverlay;
    readonly dialog: DialogOverlay;
    /** The local player's name, picture and banner. */
    readonly profile: LocalProfile;
    /** The player's wosu! account (global leaderboards). */
    readonly account = new AccountManager();
    readonly profileOverlay: LazyOverlay<ProfileOverlay>;
    /** The full profile page (any player's; rankings live there too). */
    readonly userProfile: LazyOverlay<UserProfileOverlay>;

    private readonly popupBlockers = new Map<object, { blocker: Graphics; keyOff: () => void }>();
    readonly startedAt = Date.now();

    /**
     * Startup, kept to what the intro draws: the upright UI font, the icon
     * font and the menu cursor (index.html preloads the fonts, so they
     * download alongside the scripts). The audio output, menu background,
     * default skin, UI sounds, italic font and the deferred code chunk
     * follow once the intro is on screen (startDeferred, afterMenu).
     */
    static async boot(host: HTMLElement): Promise<Game> {
        const settings = new GameSettings();
        settings.load();
        const assets = Promise.all([loadFonts(), Cursor.loadTextures()]);
        assets.catch(() => { /* awaited below */ });
        const app = new App();
        await app.init({
            host,
            preference: settings.renderer.value,
            resolutionScale: settings.resolutionScale.value,
            antialias: settings.antialias.value,
            lowLatency: settings.lowLatency.value,
        });
        const loading = showBootSpinner(app);
        const skin = new Skin();
        const skins = new SkinManager();
        const [, cursorTextures] = await assets;
        skin.load();
        installBitmapFonts(app.renderer.resolution);
        loading.destroy();
        const game = new Game(app, settings, skin, skins, cursorTextures);
        await game.start();
        return game;
    }

    /**
     * `skin` holds the UI's own textures (shapes, glows, fades); `skins`
     * the osu!-format gameplay skins (default, selected, beatmap).
     */
    private constructor(
        readonly app: App,
        readonly settings: GameSettings,
        readonly skin: Skin,
        readonly skins: SkinManager,
        cursorTextures: CursorTextures,
    ) {
        this.input = new InputManager(app, this.textInput);
        settings.keyBindings.bind(v => (this.input.bindings = resolveBindings(v)), true);
        // One pack download each instead of a request per sound (see tools/assetPacks.ts).
        this.samples = new SampleBank(this.audio, { fetcher: packFetch('default-hitsounds', resolveAssetUrl(DEFAULT_SKIN_URL)) });
        const uiBase = resolveAssetUrl('assets/samples/');
        const [menuPack, laterPack] = [packFetch('ui-samples', uiBase), packFetch('result-samples', uiBase)];
        this.uiSounds = new UISounds(this.audio, url => (LATER_UI_SAMPLES.test(url.slice(uiBase.length)) ? laterPack : menuPack)(url));
        this.preview = new PreviewPlayer(this.audio);
        const providers = () => resolveProviders(settings.browseProvider.value, settings.downloadProvider.value);
        this.api = new BeatmapApi(providers);
        this.downloads = new DownloadManager(providers);
        this.music = new MusicController(this.audio, this.preview, this.library);
        // With skins in menus, a skin's menu-background stands in for wosu!'s own (like osu!stable).
        this.background = new BackgroundManager(app.renderer, () => menuSkin.value?.texture('menu-background')?.texture ?? skin.defaultBackground);
        // 'default:none' until wosu!'s background has loaded (it follows the intro), so it then fades in.
        this.background.defaultKey = () => (menuSkin.value?.texture('menu-background')
            ? `default:${skins.currentInfo.value?.id ?? 'skin'}`
            : skin.defaultBackground === Texture.EMPTY ? 'default:none' : 'default');
        this.screens = new ScreenStack(this);
        this.tooltips = new TooltipLayer(() => this.input.pointer, () => ({ width: app.width, height: app.height }));
        // The gameplay cursor and trail come from the osu! skins (selected → default).
        this.cursor = new Cursor(cursorTextures, skins, (x, y) => app.toLogical(x, y));
        const lock = this.input.pointerLock;
        this.cursor.virtualPointer = () => (lock.virtual ? lock.pointer : null);
        lock.moved.add((x, y) => this.cursor.addSample(x, y));
        this.fps = new FpsCounter(app.loop.stats);

        installUIContext({
            popupLayer: app.popupLayer,
            tooltips: this.tooltips,
            sounds: this.uiSounds,
            textInput: this.textInput,
            viewport: () => ({ width: app.width, height: app.height }),
            pointer: () => this.input.pointer,
        });
        Dropdown.popupHook = {
            open: (menu, close) => this.openPopup(menu, close),
            close: menu => this.closePopup(menu),
        };
        Slider.keyHook = fn => this.input.pushKeyHandler(e => fn(e), KeyPriority.popup);
        KeyBindButton.capture = fn => this.input.pushKeyHandler(e => fn(e), KeyPriority.capture);

        app.backgroundLayer.addChild(this.background.root);
        app.tooltipLayer.addChild(this.tooltips);
        app.cursorLayer.addChild(this.cursor);
        app.debugLayer.addChild(this.fps);

        // Placeholders keep the deferred overlays' stacking order.
        const listingSlot = new Container();
        const settingsSlot = new Container();
        const profileSlot = new Container();
        const userProfileSlot = new Container();
        this.listing = this.lazyOverlay(listingSlot, (m, g) => new m.BeatmapListingOverlay(g));
        this.settingsOverlay = this.lazyOverlay(settingsSlot, (m, g) => new m.SettingsOverlay(g));
        this.notificationOverlay = this.overlays.register(new NotificationOverlay(this));
        this.nowPlaying = this.overlays.register(new NowPlayingOverlay(this));
        this.profile = new LocalProfile(settings);
        this.profileOverlay = this.lazyOverlay(profileSlot, (m, g) => new m.ProfileOverlay(g));
        this.userProfile = this.lazyOverlay(userProfileSlot, (m, g) => new m.UserProfileOverlay(g));
        this.dialog = this.overlays.register(new DialogOverlay(this));
        app.overlayLayer.addChild(listingSlot, userProfileSlot, settingsSlot, this.notificationOverlay, this.nowPlaying, profileSlot, this.dialog);
        this.volume = new VolumeOverlay(this);

        // The toolbar mirrors overlay state, so it is built after them.
        this.toolbar = new Toolbar(this);
        app.toolbarLayer.addChild(this.toolbar);
        this.toasts = new ToastTray(this.notifications);
        // Gameplay screens draw their own cursor; lazer shows no notification toasts over them.
        this.toasts.suppressed = () => this.screens.current?.showMenuCursor === false;
        app.toastLayer.addChild(this.toasts, this.volume);

        this.bindSettings();
        this.bindGlobalInput();
        app.resized.add((w, h) => this.resize(w, h));
        app.frame.add(dt => this.update(dt));
        this.resize(app.width, app.height);
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------

    private async start(): Promise<void> {
        if (this.app.fellBackFrom === 'webgpu') {
            this.notifications.warning('WebGPU is not available in this browser, so WebGL is being used instead.');
        }
        MusicTrack.diagnostics.add(msg => this.notifications.warning(msg));
        this.downloads.added.add(task => this.trackDownload(task));
        // The intro's click plays a UI sound: that pack downloads first (decoded in startDeferred).
        const uiSamples = loadPack('ui-samples');
        await Promise.all([
            this.library.init().catch(e => console.error('library init failed', e)),
            this.scores.init().catch(e => console.error('score store init failed', e)),
            this.favourites.init().catch(e => console.error('favourites init failed', e)),
            this.knownVideos.init().catch(e => console.error('video registry init failed', e)),
            this.profile.init().catch(e => console.error('profile init failed', e)),
        ]);
        // The account session restores in the background; a signed-in player's scores carry the account name.
        this.account.user.bind(u => {
            if (u) this.profile.rename(u.name);
        });
        void this.account.init().then(() => {
            // The game opened (counts this player for the day; guests by their anonymous id).
            if (this.account.available.value) sendPlayPing({ phase: 'open' });
        });
        // Imported skins and the selected one load in the background (applies from the next play).
        void this.skins.attach(this).catch(e => console.error('skin store init failed', e));
        this.background.setDefault();
        this.screens.push(new IntroScreen());
        // Boot timing marks (the intro is interactive from here; see also afterMenu).
        performance.mark('wosu:intro');
        this.handleLaunchParams();
        this.library.imported.add(set => this.queueStarLookup(set));
        for (const set of this.library.sets) this.queueStarLookup(set);
        // First-launch songs are big downloads: after the sounds the intro needs.
        void uiSamples.then(() => this.fetchBundledBeatmaps());
        afterNextFrame(() => this.startDeferred(uiSamples));
        const off = this.screens.changed.add(() => {
            if (!(this.screens.current instanceof MainMenuScreen)) return;
            off();
            this.afterMenu();
        });
    }

    /**
     * Once the intro is on screen: open the audio output (a long task,
     * kept off the first frame; the intro's click would open it anyway)
     * and decode the menus' UI sounds. Downloads go in order of need: those
     * sounds and the italic face (the menu waits for it), then the menu
     * background, then the default skin (cursor trail, gameplay).
     */
    private startDeferred(uiSamples: Promise<unknown>): void {
        this.audio.start();
        void this.uiSounds.load(undefined, name => !LATER_UI_SAMPLES.test(name));
        void loadMenuFonts();
        this.essentials = uiSamples
            .then(() => this.skin.loadBackground())
            .then(() => {
                if (this.background.showingDefault) this.background.setDefault();
                return this.skins.loadDefault();
            })
            .catch(e => console.error('default skin failed to load', e));
    }

    /** startDeferred's downloads; gameplay's own wait for them (they share the bandwidth). */
    private essentials: Promise<unknown> = Promise.resolve();

    /**
     * The main menu is up: in idle time, finish the counter font atlas,
     * load the deferred code chunk and build its overlays (so they open
     * instantly), then the hitsounds and the rest of gameplay's assets.
     */
    private afterMenu(): void {
        performance.mark('wosu:menu');
        const warm = (): void => {
            if (!warmBitmapFonts()) whenIdle(warm);
        };
        whenIdle(
            warm,
            () => this.deferredModules(),
            () => this.listing.load(),
            () => this.settingsOverlay.load(),
            () => this.profileOverlay.load(),
            () => void this.essentials.then(() => this.gameplayAssets()),
        );
    }

    // ------------------------------------------------------------------
    // Deferred code (lazy.ts)
    // ------------------------------------------------------------------

    private deferred: typeof Deferred | null = null;
    private deferredLoad: Promise<typeof Deferred> | null = null;

    /** The deferred chunk (overlays, song select, gameplay, skin editor); loads once. */
    deferredModules(): Promise<typeof Deferred> {
        this.deferredLoad ??= import('./lazy').then(m => (this.deferred = m), (e: unknown) => {
            this.deferredLoad = null;
            throw e;
        });
        return this.deferredLoad;
    }

    private gameplayReady = false;

    /** What gameplay needs beyond the menus: default skin, Venera, hitsounds (not waited for). */
    private gameplayAssets(): Promise<unknown> {
        void this.samples.load().catch(e => console.warn('hitsounds failed to load', e));
        void this.uiSounds.load();
        return Promise.all([this.skins.loadDefault(), this.skin.loadDeferred()]).then(() => (this.gameplayReady = true));
    }

    /**
     * Run `fn` with the deferred modules: at once when they're in (the
     * usual case, as the menu loads them), else after loading them (with
     * gameplay's assets when `gameplay`), unless the screen changed meanwhile.
     */
    private withDeferred(fn: (m: typeof Deferred) => void, gameplay = false): void {
        if (this.deferred && (!gameplay || this.gameplayReady)) {
            fn(this.deferred);
            return;
        }
        const from = this.screens.current;
        // Normally a moment; on a slow connection, say why nothing happened yet.
        let note: Notification | null = null;
        const slow = setTimeout(() => {
            note = this.notifications.progress('Loading the game…');
            note.progress.value = NaN;
        }, 400);
        Promise.all([this.deferredModules(), gameplay ? this.gameplayAssets() : null]).then(([m]) => {
            if (this.screens.current === from) fn(m);
        }, e => this.deferredFailed(e)).finally(() => {
            clearTimeout(slow);
            note?.dismiss();
        });
    }

    private deferredFailed(e: unknown): void {
        console.error('deferred load failed', e);
        this.notifications.error('Part of wosu! failed to load. Check your connection and try again.');
    }

    private lazyOverlay<T extends Overlay>(slot: Container, make: (m: typeof Deferred, game: Game) => T): LazyOverlay<T> {
        return this.overlays.track(new LazyOverlay<T>(async () => {
            const overlay = make(await this.deferredModules(), this);
            this.overlays.register(overlay);
            slot.addChild(overlay);
            return overlay;
        }, overlay => overlay.resize(this.app.width, this.app.height), e => this.deferredFailed(e)));
    }

    /**
     * First launch (or an empty library): download a few Featured Artist
     * sets, like osu!lazer, so menus have real songs to play. Sets already
     * in the library are skipped; one at a time, so the first is ready fast.
     */
    private async fetchBundledBeatmaps(): Promise<void> {
        const s = this.settings;
        // Already fetched: still pick up always-included maps added since (once each).
        const sets = s.bundledBeatmapsFetched.value && this.library.sets.length > 0
            ? ALWAYS_BUNDLED.filter(b => !s.bundledSeen.value.includes(b.sid) && !this.library.get(`osu-${b.sid}`))
            : bundledSelection();
        let any = false;
        for (const set of sets) {
            const lib = await this.downloadSet(set, { video: false });
            if (!lib) continue;
            any = true;
            // Nothing playing yet (empty library until now): start this one.
            if (!this.music.current.value && s.menuMusic.value && this.screens.current?.showMenuCursor) {
                void this.music.playSet(lib, { fromPreview: true, fadeInMs: 1000 });
            }
        }
        if (any) s.bundledBeatmapsFetched.value = true;
        // Remember what was offered, so deleting a map doesn't make it come back.
        s.bundledSeen.value = [...new Set([...s.bundledSeen.value, ...ALWAYS_BUNDLED.map(b => b.sid)])];
    }

    // ------------------------------------------------------------------
    // Star ratings
    // ------------------------------------------------------------------

    private readonly starQueue = new Set<string>();
    /** Imports of finished downloads, by online set id. */
    private readonly imports = new Map<number, Promise<LibrarySet | null>>();
    private starWorker: Promise<void> | null = null;

    /**
     * Imports carry a local star estimate; submitted sets get the mirror's
     * official ratings instead (one request at a time, in the background).
     */
    private queueStarLookup(set: LibrarySet): void {
        if (!set.onlineSetId || set.difficulties.every(d => d.starSource === 'online')) return;
        this.starQueue.add(set.key);
        this.starWorker ??= this.runStarLookups().finally(() => (this.starWorker = null));
    }

    private async runStarLookups(): Promise<void> {
        // A Set iterator also visits keys queued while it runs.
        for (const key of this.starQueue) {
            this.starQueue.delete(key);
            const set = this.library.get(key);
            if (!set?.onlineSetId) continue;
            try {
                const diffs = await this.api.difficulties(set.onlineSetId);
                if (diffs.length) await this.library.setStars(key, new Map(diffs.map(d => [d.bid, d.stars])));
            } catch {
                /* offline or unknown to the mirror: stars stay unknown */
            }
        }
    }

    /** Old site links (search.html?q=…) arrive as query params. */
    private handleLaunchParams(): void {
        try {
            const url = new URL(window.location.href);
            const q = url.searchParams.get('q') ?? url.searchParams.get('search');
            const sid = url.searchParams.get('sid');
            if (q || sid) this.pendingListingQuery = q ?? sid;
        } catch {
            /* ignore */
        }
    }

    pendingListingQuery: string | null = null;

    // ------------------------------------------------------------------
    // Settings → systems
    // ------------------------------------------------------------------

    private bindSettings(): void {
        const s = this.settings;
        const volumes = () => this.audio.setVolumes({
            master: s.masterVolume.value,
            music: s.musicVolume.value,
            effects: s.effectsVolume.value,
        });
        s.masterVolume.bind(volumes);
        s.musicVolume.bind(volumes);
        s.effectsVolume.bind(volumes, true);
        s.uiSounds.bind(v => (this.uiSounds.enabled = v), true);
        s.uiScale.bind(v => this.app.setUiScale(v), true);
        s.resolutionScale.bind(v => this.app.setResolutionScale(v));
        s.frameLimit.bind(v => this.app.setFrameLimit(v), true);
        s.uncappedInMenus.bind(v => this.app.loop.setUncappedInMenus(v), true);
        s.showFps.bind(v => (this.fps.visible = v), true);
        s.parallax.bind(v => (this.background.parallaxEnabled = v), true);
        s.menuCursorSize.bind(v => {
            this.cursor.menu.setCursorSize(v);
            this.cursor.menuSkinned.userScale = v;
        }, true);
        s.cursorSize.bind(v => (this.cursor.gameplay.userScale = v), true);
        s.autoCursorSize.bind(v => (this.cursor.gameplay.autoSize = v), true);
        s.cursorTrail.bind(v => this.cursor.gameplay.setTrailEnabled(v), true);
        s.cursorRipples.bind(v => (this.cursor.gameplay.ripplesEnabled = v), true);
        s.cursorExpand.bind(v => (this.cursor.gameplay.expandEnabled = this.cursor.menuSkinned.expandEnabled = v), true);
        s.cursorRotation.bind(v => (this.cursor.menu.rotationEnabled = v), true);
        s.hardwareCursor.bind(() => this.updateCursorVisibility(), true);
        s.gameplayCursorDuringTouch.bind(() => this.updateCursorVisibility());
        s.menuMusic.bind(v => {
            this.music.enabled = v;
            // Turned on in the main menu with nothing playing: start now, not on the next visit.
            if (v && !this.music.isPlaying && this.screens.current instanceof MainMenuScreen) void this.music.playRandom();
        }, true);
        // Renderer, antialiasing and low latency apply to a new renderer: say so only while they differ.
        for (const b of [s.renderer, s.antialias, s.lowLatency] as const) {
            b.bind(() => (this.settings.restartRequired.value = this.needsRestart()));
        }
        this.mods.value = sanitizeMods(s.selectedMods.value, s.modSettings.value);
        this.mods.bind(m => {
            s.selectedMods.value = sortedMods(m);
            s.modSettings.value = modSettingsOf(m);
        });
        this.input.lastPointerKind.bind(() => this.updateCursorVisibility());
        this.input.pointerMoved.once(() => this.updateCursorVisibility());
        this.library.changed.add(() => this.onLibraryChanged());
        // osu!stable-style skinned menus: the selected skin while "Use skin in menus" is on.
        const syncMenuSkin = () => (menuSkin.value = s.skinInMenus.value ? this.skins.current.value : null);
        s.skinInMenus.bind(syncMenuSkin);
        this.skins.current.bind(syncMenuSkin, true);
        this.uiSounds.skinSamples = name => menuSkin.value?.sample(name);
        menuSkin.bind(() => {
            if (this.background.showingDefault) this.background.setDefault();
        });
    }

    /** Settings that only apply to a new renderer differ from what this one was created with. */
    private needsRestart(): boolean {
        const s = this.settings, a = this.app;
        return s.renderer.value !== a.bootPreference || s.lowLatency.value !== a.bootLowLatency || s.antialias.value !== a.bootAntialias;
    }

    /**
     * Decide which cursor the current state provides (lazer's
     * GlobalCursorDisplay) and whether the OS cursor shows. Runs every
     * frame, so no event (focus, fullscreen, Pixi's hover cursor) can
     * leave a stale state behind.
     */
    updateCursorVisibility(): void {
        const c = this.cursor;
        const s = this.settings;
        const screen = this.screens.current;
        const touch = this.input.lastPointerKind.value === 'touch';
        // lazer hides cursors until a mouse source exists, and for touch.
        const validInput = this.input.pointerSeen && !touch;
        // Gameplay provides the cursor unless its pause/fail menu or an overlay (settings while paused) is up,
        // or a replay (autoplay) drives it.
        const overlayOver = c.external && this.overlays.anyOpen;
        const menuProvided = c.external ? !c.gameplayActive || c.replayLoaded || overlayOver : (screen?.showMenuCursor ?? true);
        // "Use system cursor in menus": the OS cursor stands in for the menu cursor, except while the
        // pointer is locked (the browser hides it then, so the game keeps drawing its own).
        const hardware = s.hardwareCursor.value && !this.input.pointerLock.virtual;
        c.menuStateVisible = validInput && menuProvided && !hardware;
        // Autoplay / a replay drive the gameplay cursor, but never over the pause or fail menu.
        c.gameplayShown = c.gameplayActive && !overlayOver &&
            (c.replayLoaded || (this.input.pointerSeen && (!touch || s.gameplayCursorDuringTouch.value)));
        c.hideMenuOnNonMouseInput = screen?.hideMenuCursorOnNonMouseInput ?? false;
        c.idleAllowed = !this.textInput.focused;
        // The OS cursor only ever stands in for the menu cursor.
        setOsCursorVisible(hardware && menuProvided && !touch);
    }

    /**
     * lazer's relative mouse mode and cursor confinement, through pointer
     * lock: high precision mouse (and confine "Always") everywhere, menus
     * included; confine "During gameplay" while the player aims. Runs every
     * frame, so settings, screens and phases apply at once.
     */
    private syncPointerLock(): void {
        const s = this.settings;
        const lock = this.input.pointerLock;
        const screen = this.screens.current;
        const gameplay = screen?.showMenuCursor === false;
        const aiming = screen?.localUserPlaying ?? false;
        lock.relative = s.highPrecisionMouse.value;
        lock.raw = s.highPrecisionMouse.value && s.rawInput.value;
        lock.sensitivity = s.cursorSensitivity.value;
        // Menus (pause menu included) only take the pointer on a click: typing in a search box or Ctrl+O
        // shouldn't, and the Esc after it should close what opened. While aiming, Z/X take it too.
        lock.keyGestures = aiming && !this.overlays.anyOpen;
        lock.wanted = pointerLockWanted({
            highPrecision: s.highPrecisionMouse.value,
            confine: s.confineMouse.value,
            systemCursorInMenus: s.hardwareCursor.value,
            gameplay,
            aiming,
        });
    }

    private onLibraryChanged(): void {
        const sel = this.selection.value;
        if (sel && !this.library.get(sel.set.key)) this.selection.value = null;
    }

    // ------------------------------------------------------------------
    // Global input
    // ------------------------------------------------------------------

    private bindGlobalInput(): void {
        this.input.pushKeyHandler((e, action) => this.onGlobalKey(e, action), KeyPriority.global);
        window.addEventListener('wheel', e => {
            if (!e.altKey) return;
            e.preventDefault();
            this.volume.adjust(e.deltaY < 0 ? 0.05 : -0.05);
        }, { passive: false });
        // Drag & drop .osz / .osk import, anywhere in the game.
        window.addEventListener('dragover', e => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        window.addEventListener('drop', e => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length) void this.importFiles(files);
        });
        this.screens.changed.add(() => {
            const cur = this.screens.current;
            // Frame rates above the display's apply during gameplay (see FrameLoop).
            this.app.loop.setGameplay(cur?.showMenuCursor === false);
            this.toolbarVisible.value = !!cur && !cur.hideToolbar;
            if (cur && !cur.allowOverlays) this.overlays.hideAll();
            this.updateCursorVisibility();
        });
    }

    private onGlobalKey(e: KeyboardEvent, _action: Action | null): boolean {
        const allowOverlays = this.screens.current?.allowOverlays ?? true;
        // Every action checks its own bindings: a key may also be bound in another context (F3).
        const is = (a: Action) => this.input.matches(e, a);
        if (is('toggleSettings')) {
            if (allowOverlays) this.settingsOverlay.toggle();
            return true;
        }
        if (is('toggleNotifications')) {
            if (allowOverlays) this.notificationOverlay.toggle();
            return true;
        }
        if (is('toggleBeatmapListing')) {
            if (allowOverlays) this.listing.toggle();
            return true;
        }
        if (is('toggleSkinEditor')) {
            // The editor closes itself (it has the key first); gameplay doesn't open it.
            if (allowOverlays) this.openSkinEditor();
            return true;
        }
        if (is('toggleNowPlaying')) {
            if (allowOverlays) this.nowPlaying.toggle();
            return true;
        }
        if (is('volumeUp')) {
            this.volume.adjust(0.05);
            return true;
        }
        if (is('volumeDown')) {
            this.volume.adjust(-0.05);
            return true;
        }
        if (is('toggleMute')) {
            this.volume.toggleMute();
            return true;
        }
        if (is('musicPlay')) {
            if (allowOverlays) this.music.togglePause();
            return allowOverlays;
        }
        if (is('musicNext')) {
            if (allowOverlays) void this.music.next();
            return allowOverlays;
        }
        if (is('musicPrev')) {
            if (allowOverlays) void this.music.prev();
            return allowOverlays;
        }
        if (is('toggleFps')) {
            this.settings.showFps.value = !this.settings.showFps.value;
            return true;
        }
        if (is('screenshot')) {
            void this.takeScreenshot();
            return true;
        }
        if (is('fullscreen')) {
            this.toggleFullscreen();
            return true;
        }
        return false;
    }

    private openPopup(menu: UIComponent, close: () => void): void {
        const blocker = new Graphics().rect(0, 0, this.app.width, this.app.height).fill({ color: 0x000000, alpha: 0.001 });
        blocker.eventMode = 'static';
        blocker.on('pointerdown', () => close());
        this.app.popupLayer.addChild(blocker, menu);
        const keyOff = this.input.pushKeyHandler((_e, a) => {
            if (a === 'back') {
                close();
                return true;
            }
            return false;
        }, KeyPriority.popup);
        this.popupBlockers.set(menu, { blocker, keyOff });
    }

    private closePopup(menu: UIComponent): void {
        const entry = this.popupBlockers.get(menu);
        if (!entry) return;
        this.popupBlockers.delete(menu);
        entry.keyOff();
        entry.blocker.destroy();
    }

    // ------------------------------------------------------------------
    // Frame / layout
    // ------------------------------------------------------------------

    private resize(w: number, h: number): void {
        this.background.resize(w, h);
        this.screens.resize(w, h);
        this.overlays.resize(w, h);
        this.toolbar.resize(w, this.toolbar.h);
        this.toasts.layout(w);
        this.volume.resize(w, h);
        this.fps.position.set(w - 8, h - 8);
        // The skinned menu cursor takes its gameplay size (a playfield unit is h / 480).
        this.cursor.menuPlayfieldScale = h / 480;
    }

    private update(dt: number): void {
        const p = this.input.pointer;
        this.background.update(dt, p);
        this.screens.update(dt);
        this.overlays.update(dt);
        this.toolbar.update(dt);
        this.tooltips.update(dt);
        this.syncPointerLock();
        this.updateCursorVisibility();
        this.cursor.update(dt, p.x, p.y);
        this.fps.update(dt);
    }

    // ------------------------------------------------------------------
    // High-level flows
    // ------------------------------------------------------------------

    get currentScreen(): Screen | null {
        return this.screens.current;
    }

    /** Height the toolbar occupies right now (overlays start below it). */
    get toolbarOffset(): number {
        return this.toolbarVisible.value ? this.toolbar.h : 0;
    }

    async importFiles(files: File[]): Promise<LibrarySet[]> {
        // .osk (or a zip holding a skin.ini and no .osu) goes to the skins.
        const { skins, beatmaps: osz } = await this.skins.partition(files);
        if (skins.length) void this.skins.importFiles(skins);
        if (!osz.length) {
            if (!skins.length) this.notifications.error('Drop .osz beatmaps or .osk skins to import them.');
            return [];
        }
        const n = this.notifications.progress(`Importing ${osz.length} beatmap${osz.length > 1 ? 's' : ''}…`);
        n.progress.value = NaN;
        const result = await this.library.importMany(osz);
        track('import', { files: osz.length, ok: result.ok.length });
        if (result.ok.length) {
            const first = result.ok[0];
            n.complete(
                result.ok.length === 1 ? `Imported ${first.artist} - ${first.title}` : `Imported ${result.ok.length} beatmaps`,
                () => this.selectAndShow(first),
            );
        } else {
            n.fail('Import failed.');
        }
        for (const f of result.failed) this.notifications.error(`${f.name}: ${f.error}`);
        return result.ok;
    }

    /** Pick a file with the browser's file dialog (programmatic, never shown in-page). */
    pickFiles(accept = '.osz,.osk,.zip'): void {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = accept;
        el.multiple = true;
        el.onchange = () => {
            const files = Array.from(el.files ?? []);
            if (files.length) void this.importFiles(files);
        };
        openFileDialog(el);
    }

    /**
     * Download an online set into the library (deduped). Resolves with the
     * imported set, or null on failure/cancel.
     */
    async downloadSet(set: Pick<OnlineSet, 'sid' | 'title' | 'artist'>, opts: { video?: boolean } = {}): Promise<LibrarySet | null> {
        const existing = this.library.get(`osu-${set.sid}`);
        if (existing) return existing;
        const pending = this.imports.get(set.sid);
        if (pending) return pending;
        const task = this.downloads.download(set.sid, { title: set.title, artist: set.artist }, { withVideo: opts.video ?? this.settings.backgroundVideo.value });
        track('download', { set: set.sid });
        const p = task.result
            .then(blob => this.library.importOsz(blob, { onlineSetId: set.sid }))
            .catch(e => {
                if (task.state !== 'cancelled') console.warn('download/import failed', e);
                return null;
            })
            .finally(() => this.imports.delete(set.sid));
        this.imports.set(set.sid, p);
        return p;
    }

    private trackDownload(task: DownloadTask): void {
        const n = this.notifications.progress(`${task.artist} - ${task.title}`, 'Downloading');
        n.onCancel = () => task.cancel();
        const sync = () => {
            n.progress.value = task.progress;
            if (task.state === 'failed') n.fail(`Download failed: ${task.title}${task.error ? ` (${task.error})` : ''}`);
            if (task.state === 'cancelled') n.fail(`Cancelled: ${task.title}`);
        };
        task.changed.add(sync);
        task.result.then(async () => {
            n.text.value = `Importing ${task.title}…`;
            n.progress.value = NaN;
            // Import runs in downloadSet; however long a big set takes.
            const set = (await this.imports.get(task.sid)) ?? this.library.get(`osu-${task.sid}`) ?? null;
            if (set) n.complete(`Downloaded ${set.artist} - ${set.title}`, () => this.selectAndShow(set));
            else n.fail(`Import failed: ${task.title}`);
        }).catch(() => sync());
    }

    /** Select a set and go to song select (from notifications/listing). */
    selectAndShow(set: LibrarySet, diff?: DifficultySummary): void {
        const d = diff ?? set.difficulties[0];
        if (d) this.selection.value = { set, diff: d };
        this.overlays.hideAll();
        this.openSongSelect();
    }

    /** Return to the main menu (toolbar home button). */
    goHome(): void {
        this.overlays.hideAll();
        const menu = this.screens.screens.find(s => s instanceof MainMenuScreen);
        if (menu) this.screens.makeCurrent(menu);
    }

    /**
     * lazer's skin editor for the HUD layout (Ctrl+Shift+S), over the
     * menus. Not from gameplay or while a play loads.
     */
    openSkinEditor(): boolean {
        const cur = this.screens.current;
        // These screens live in the deferred chunk: none can be up before it loaded.
        const d = this.deferred;
        if (d && cur instanceof d.SkinEditorScreen) return true;
        if (!cur || cur instanceof IntroScreen || (d && cur instanceof d.PlayerLoaderScreen) || !cur.showMenuCursor) {
            this.notifications.info('The skin editor opens from the menus and song select, not during gameplay.');
            return false;
        }
        this.overlays.hideAll();
        this.withDeferred(m => this.screens.push(new m.SkinEditorScreen()), true);
        return true;
    }

    openSongSelect(): void {
        const d = this.deferred;
        const existing = d && this.screens.screens.find(s => s instanceof d.SongSelectScreen);
        if (existing) {
            this.screens.makeCurrent(existing);
            return;
        }
        // Return to the main menu first so the stack stays menu → select.
        const menu = this.screens.screens.find(s => s instanceof MainMenuScreen);
        if (menu) this.screens.makeCurrent(menu);
        this.withDeferred(m => this.screens.push(new m.SongSelectScreen()));
    }

    /** Start playing a difficulty (via the player loader). */
    play(selection: Selection): void {
        this.selection.value = selection;
        track('play', { mods: sortedMods(this.mods.value).join('') || 'NM', online: selection.diff.beatmapId > 0, stars: Math.round((selection.diff.stars ?? 0) * 10) / 10 });
        this.withDeferred(m => this.screens.push(new m.PlayerLoaderScreen(selection)), true);
    }

    /** Watch a replay of a difficulty (lazer's ReplayPlayer, loaded with the score's mods). */
    watchReplay(selection: Selection, replay: ReplayInfo): void {
        this.selection.value = selection;
        this.withDeferred(m => this.screens.push(new m.PlayerLoaderScreen(selection, replay)), true);
    }

    /** Watch a saved score's replay; false when it has none or it can't be read. */
    async watchScore(selection: Selection, score: ScoreRecord): Promise<boolean> {
        const data = score.hasReplay && score.id !== undefined ? await this.scores.replay(score.id) : null;
        let events = null;
        try {
            events = data ? decodeReplay(data) : null;
        } catch (e) {
            console.warn('[replay] decode failed', e);
        }
        if (!events) {
            this.notifications.error(data ? "This score's replay could not be read." : 'This score has no replay.');
            return false;
        }
        this.watchReplay(selection, {
            events,
            mods: score.mods,
            modSettings: score.modSettings,
            mechanics: score.mechanics ?? DEFAULT_MECHANICS,
            player: score.player,
            date: score.date,
        });
        return true;
    }

    /** Background texture for a library set (falls back to default). */
    async setBackgroundForSet(set: LibrarySet | null): Promise<void> {
        if (!set) {
            this.background.setDefault();
            return;
        }
        await this.background.setFrom(`set:${set.key}`, async () => {
            const blob = await this.library.getBackground(set.key);
            if (blob) return textureFromBlob(blob);
            if (set.onlineSetId) return textureFromUrl(coverUrl(set.onlineSetId, 'jpg'));
            return null;
        });
    }

    async setBackgroundForOnline(sid: number): Promise<void> {
        await this.background.setFrom(`online:${sid}`, () => textureFromUrl(coverUrl(sid, 'jpg')));
    }

    toggleFullscreen(): void {
        // A locked pointer stays locked across the switch (Chrome; fullscreen also uses up the click's
        // activation, so a lock let go of here couldn't come back without another click).
        try {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        } catch {
            this.notifications.error('Fullscreen is not available.');
        }
    }

    async takeScreenshot(): Promise<void> {
        try {
            const canvas = this.app.renderer.extract.canvas({ target: this.app.pixi.stage }) as HTMLCanvasElement;
            this.uiSounds.playSkin(['shutter']);
            const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
            if (!blob) throw new Error('empty');
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            a.href = url;
            a.download = `wosu-${stamp}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            this.notifications.success('Screenshot saved.');
        } catch (e) {
            console.warn('screenshot failed', e);
            this.notifications.error('Screenshot failed.');
        }
    }

    /** Reload the page (renderer changes need a fresh context). */
    restart(): void {
        this.settings.saveNow();
        window.location.reload();
    }
}

/** A minimal spinner drawn before fonts/skin are ready. */
function showBootSpinner(app: App): Container {
    const c = new Container();
    const g = new Graphics();
    c.addChild(g);
    app.toastLayer.addChild(c);
    let t = 0;
    const tick = (dt: number) => {
        t += dt;
        g.clear();
        const start = t / 300;
        g.arc(0, 0, 18, start, start + Math.PI * 1.3).stroke({ width: 4, color: 0xff66aa, cap: 'round' });
        c.position.set(app.width / 2, app.height / 2);
    };
    const off = app.frame.add(tick);
    const destroy = c.destroy.bind(c);
    c.destroy = (opts?: Parameters<Container['destroy']>[0]) => {
        off();
        destroy(opts);
    };
    return c;
}
