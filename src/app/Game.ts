import { Container, Graphics } from 'pixi.js';
import { Bindable } from '../core/Bindable';
import { App } from './App';
import { BackgroundManager } from './BackgroundManager';
import { Cursor, setOsCursorVisible, type CursorTextures } from './Cursor';
import { FpsCounter } from './FpsCounter';
import { MusicController } from './MusicController';
import { OverlayManager } from './Overlay';
import { ScreenStack, type Screen } from './Screen';
import { AudioEngine } from '../audio/AudioEngine';
import { MusicTrack } from '../audio/MusicTrack';
import { PreviewPlayer } from '../audio/PreviewPlayer';
import { SampleBank } from '../audio/SampleBank';
import { UISounds } from '../audio/UISounds';
import { BeatmapLibrary, type LibrarySet } from '../beatmap/Library';
import type { DifficultySummary } from '../beatmap/types';
import { NO_MODS, sanitizeMods, sortedMods, type ModSet } from '../gameplay/mods';
import { textureFromBlob, TextureCache, textureFromUrl } from '../graphics/textures';
import { InputManager, KeyPriority } from '../input/InputManager';
import type { Action } from '../input/bindings';
import { TextInputProxy } from '../input/TextInputProxy';
import { BeatmapApi } from '../online/BeatmapApi';
import { DownloadManager, type DownloadTask } from '../online/Downloader';
import { coverUrl, resolveProviders, type OnlineSet } from '../online/providers';
import { bundledSelection } from '../online/bundled';
import { BeatmapListingOverlay } from '../overlays/BeatmapListingOverlay';
import { DialogOverlay } from '../overlays/DialogOverlay';
import { NotificationManager } from '../overlays/notifications/Notifications';
import { NotificationOverlay } from '../overlays/notifications/NotificationOverlay';
import { ToastTray } from '../overlays/notifications/ToastTray';
import { NowPlayingOverlay } from '../overlays/NowPlayingOverlay';
import { SettingsOverlay } from '../overlays/settings/SettingsOverlay';
import { Toolbar } from '../overlays/Toolbar';
import { VolumeOverlay } from '../overlays/VolumeOverlay';
import { GameSettings } from '../settings/Settings';
import { Skin } from '../skin/Skin';
import { Favourites } from '../storage/Favourites';
import { KnownVideos } from '../storage/KnownVideos';
import { ScoreStore } from '../storage/ScoreStore';
import { Dropdown } from '../ui/Dropdown';
import { installBitmapFonts, loadFonts } from '../ui/fonts';
import { KeyBindButton } from '../ui/KeyBindButton';
import { Slider } from '../ui/Slider';
import { TooltipLayer } from '../ui/Tooltip';
import { installUIContext } from '../ui/UIContext';
import type { UIComponent } from '../ui/UIComponent';
import { IntroScreen } from '../screens/IntroScreen';
import { MainMenuScreen } from '../screens/MainMenuScreen';
import { SongSelectScreen } from '../screens/select/SongSelectScreen';
import { PlayerLoaderScreen } from '../screens/play/PlayerLoaderScreen';

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
    readonly settingsOverlay: SettingsOverlay;
    readonly listing: BeatmapListingOverlay;
    readonly notificationOverlay: NotificationOverlay;
    readonly nowPlaying: NowPlayingOverlay;
    readonly volume: VolumeOverlay;
    readonly dialog: DialogOverlay;

    private readonly popupBlockers = new Map<object, { blocker: Graphics; keyOff: () => void }>();
    readonly startedAt = Date.now();

    static async boot(host: HTMLElement): Promise<Game> {
        const settings = new GameSettings();
        settings.load();
        const app = new App();
        await app.init({
            host,
            preference: settings.renderer.value,
            resolutionScale: settings.resolutionScale.value,
            antialias: settings.antialias.value,
        });
        const loading = showBootSpinner(app);
        const skin = new Skin();
        const [, , cursorTextures] = await Promise.all([loadFonts(), skin.load(), Cursor.loadTextures()]);
        installBitmapFonts(app.renderer.resolution);
        loading.destroy();
        const game = new Game(app, settings, skin, cursorTextures);
        await game.start();
        return game;
    }

    private constructor(readonly app: App, readonly settings: GameSettings, readonly skin: Skin, cursorTextures: CursorTextures) {
        this.input = new InputManager(app, this.textInput);
        this.samples = new SampleBank(this.audio);
        this.uiSounds = new UISounds(this.audio);
        this.preview = new PreviewPlayer(this.audio);
        const providers = () => resolveProviders(settings.browseProvider.value, settings.downloadProvider.value);
        this.api = new BeatmapApi(providers);
        this.downloads = new DownloadManager(providers);
        this.music = new MusicController(this.audio, this.preview, this.library);
        this.background = new BackgroundManager(app.renderer, () => skin.defaultBackground);
        this.screens = new ScreenStack(this);
        this.tooltips = new TooltipLayer(() => this.input.pointer, () => ({ width: app.width, height: app.height }));
        this.cursor = new Cursor(cursorTextures, skin.get('cursor.png'), (x, y) => app.toLogical(x, y));
        this.fps = new FpsCounter();

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

        this.settingsOverlay = this.overlays.register(new SettingsOverlay(this));
        this.listing = this.overlays.register(new BeatmapListingOverlay(this));
        this.notificationOverlay = this.overlays.register(new NotificationOverlay(this));
        this.nowPlaying = this.overlays.register(new NowPlayingOverlay(this));
        this.dialog = this.overlays.register(new DialogOverlay(this));
        app.overlayLayer.addChild(this.listing, this.settingsOverlay, this.notificationOverlay, this.nowPlaying, this.dialog);
        this.volume = new VolumeOverlay(this);

        // The toolbar mirrors overlay state, so it is built after them.
        this.toolbar = new Toolbar(this);
        app.toolbarLayer.addChild(this.toolbar);
        this.toasts = new ToastTray(this.notifications);
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
        void this.samples.load().catch(e => console.warn('hitsounds failed to load', e));
        void this.uiSounds.load();
        await Promise.all([
            this.library.init().catch(e => console.error('library init failed', e)),
            this.scores.init().catch(e => console.error('score store init failed', e)),
            this.favourites.init().catch(e => console.error('favourites init failed', e)),
            this.knownVideos.init().catch(e => console.error('video registry init failed', e)),
        ]);
        this.background.setDefault();
        this.screens.push(new IntroScreen());
        this.handleLaunchParams();
        this.library.imported.add(set => this.queueStarLookup(set));
        for (const set of this.library.sets) this.queueStarLookup(set);
        void this.fetchBundledBeatmaps();
    }

    /**
     * First launch (or an empty library): download a few Featured Artist
     * sets, like osu!lazer, so menus have real songs to play. Sets already
     * in the library are skipped; one at a time, so the first is ready fast.
     */
    private async fetchBundledBeatmaps(): Promise<void> {
        const s = this.settings;
        if (s.bundledBeatmapsFetched.value && this.library.sets.length > 0) return;
        let any = false;
        for (const set of bundledSelection()) {
            const lib = await this.downloadSet(set, { video: false });
            if (!lib) continue;
            any = true;
            // Nothing playing yet (empty library until now): start this one.
            if (!this.music.current.value && s.menuMusic.value && this.screens.current?.showMenuCursor) {
                void this.music.playSet(lib, { fromPreview: true, fadeInMs: 1000 });
            }
        }
        if (any) s.bundledBeatmapsFetched.value = true;
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
        s.frameLimit.bind(v => this.app.setMaxFps(v), true);
        s.showFps.bind(v => (this.fps.visible = v), true);
        s.parallax.bind(v => (this.background.parallaxEnabled = v), true);
        s.menuCursorSize.bind(v => this.cursor.menu.setCursorSize(v), true);
        s.cursorSize.bind(v => (this.cursor.gameplay.userScale = v), true);
        s.autoCursorSize.bind(v => (this.cursor.gameplay.autoSize = v), true);
        s.cursorTrail.bind(v => this.cursor.gameplay.setTrailEnabled(v), true);
        s.cursorExpand.bind(v => (this.cursor.gameplay.expandEnabled = v), true);
        s.cursorRotation.bind(v => (this.cursor.menu.rotationEnabled = v), true);
        s.hardwareCursor.bind(() => this.updateCursorVisibility(), true);
        s.gameplayCursorDuringTouch.bind(() => this.updateCursorVisibility());
        s.menuMusic.bind(v => (this.music.enabled = v), true);
        s.renderer.bind(v => {
            this.settings.restartRequired.value = v !== 'auto' && v !== this.app.rendererKind ||
                (v === 'auto' && this.app.rendererKind !== 'webgl');
        });
        s.antialias.bind(() => (this.settings.restartRequired.value = true));
        this.mods.value = sanitizeMods(s.selectedMods.value);
        this.mods.bind(m => (s.selectedMods.value = sortedMods(m)));
        this.input.lastPointerKind.bind(() => this.updateCursorVisibility());
        this.input.pointerMoved.once(() => this.updateCursorVisibility());
        this.library.changed.add(() => this.onLibraryChanged());
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
        // Gameplay provides the cursor unless its pause/fail menu is up or a replay (autoplay) drives it.
        const menuProvided = c.external ? !c.gameplayActive || c.replayLoaded : (screen?.showMenuCursor ?? true);
        const hardware = s.hardwareCursor.value;
        c.menuStateVisible = validInput && menuProvided && !hardware;
        c.gameplayShown = c.replayLoaded ||
            (c.gameplayActive && this.input.pointerSeen && (!touch || s.gameplayCursorDuringTouch.value));
        c.hideMenuOnNonMouseInput = screen?.hideMenuCursorOnNonMouseInput ?? false;
        c.idleAllowed = !this.textInput.focused;
        // The OS cursor only ever stands in for the menu cursor.
        setOsCursorVisible(hardware && menuProvided && !touch);
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
        // Drag & drop .osz import, anywhere in the game.
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
            this.toolbarVisible.value = !!cur && !cur.hideToolbar;
            if (cur && !cur.allowOverlays) this.overlays.hideAll();
            this.updateCursorVisibility();
        });
    }

    private onGlobalKey(e: KeyboardEvent, action: Action | null): boolean {
        const allowOverlays = this.screens.current?.allowOverlays ?? true;
        switch (action) {
            case 'toggleSettings':
                if (allowOverlays) this.settingsOverlay.toggle();
                return true;
            case 'toggleNotifications':
                if (allowOverlays) this.notificationOverlay.toggle();
                return true;
            case 'toggleBeatmapListing':
                if (allowOverlays) this.listing.toggle();
                return true;
            case 'toggleNowPlaying':
                if (allowOverlays) this.nowPlaying.toggle();
                return true;
            case 'volumeUp':
                this.volume.adjust(0.05);
                return true;
            case 'volumeDown':
                this.volume.adjust(-0.05);
                return true;
            case 'toggleMute':
                this.volume.toggleMute();
                return true;
            case 'musicPlay':
                if (allowOverlays) this.music.togglePause();
                return allowOverlays;
            case 'musicNext':
                if (allowOverlays) void this.music.next();
                return allowOverlays;
            case 'musicPrev':
                if (allowOverlays) void this.music.prev();
                return allowOverlays;
            case 'toggleFps':
                this.settings.showFps.value = !this.settings.showFps.value;
                return true;
            case 'screenshot':
                void this.takeScreenshot();
                return true;
            case 'fullscreen':
                this.toggleFullscreen();
                return true;
            default:
                void e;
                return false;
        }
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
    }

    private update(dt: number): void {
        const p = this.input.pointer;
        this.background.update(dt, p);
        this.screens.update(dt);
        this.overlays.update(dt);
        this.toolbar.update(dt);
        this.tooltips.update(dt);
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
        const osz = files.filter(f => /\.(osz|zip)$/i.test(f.name));
        if (!osz.length) {
            this.notifications.error('Drop .osz beatmap files to import them.');
            return [];
        }
        const n = this.notifications.progress(`Importing ${osz.length} beatmap${osz.length > 1 ? 's' : ''}…`);
        n.progress.value = NaN;
        const result = await this.library.importMany(osz);
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
    pickFiles(): void {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = '.osz,.zip';
        el.multiple = true;
        el.onchange = () => {
            const files = Array.from(el.files ?? []);
            if (files.length) void this.importFiles(files);
        };
        el.click();
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

    openSongSelect(): void {
        const existing = this.screens.screens.find(s => s instanceof SongSelectScreen);
        if (existing) {
            this.screens.makeCurrent(existing);
            return;
        }
        // Return to the main menu first so the stack stays menu → select.
        const menu = this.screens.screens.find(s => s instanceof MainMenuScreen);
        if (menu) this.screens.makeCurrent(menu);
        this.screens.push(new SongSelectScreen());
    }

    /** Start playing a difficulty (via the player loader). */
    play(selection: Selection): void {
        this.selection.value = selection;
        this.screens.push(new PlayerLoaderScreen(selection));
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
