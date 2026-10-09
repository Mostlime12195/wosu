import type { Game } from '../../app/Game';
import type { LibrarySet } from '../../beatmap/Library';
import { Signal } from '../../core/Signal';
import { standardDifficulties } from '../../online/BeatmapApi';
import type { DownloadTask } from '../../online/Downloader';
import { coverUrl, type OnlineDifficulty, type OnlineSet } from '../../online/providers';
import type { PreviewState } from './PreviewButton';

export type DownloadPhase = 'none' | 'queued' | 'downloading' | 'importing' | 'local';

export interface DownloadStatus {
    phase: DownloadPhase;
    /** 0..1, NaN while the size is unknown. */
    progress: number;
}

/** A pending "download, then show this difficulty" request. */
export interface PendingOpen {
    sid: number;
    bid: number | null;
}

/**
 * Shared state and actions behind every listing card and the details
 * panel: audio previews, favourites, downloads (with an "importing"
 * phase between the finished download and the library import), lazily
 * fetched difficulty lists, and the "go to this beatmap" flow.
 */
export class ListingController {
    /** Something about `sid` (or everything, for null) changed: refresh visuals. */
    readonly changed = new Signal<[sid: number | null]>();
    private readonly diffs = new Map<number, OnlineDifficulty[]>();
    private readonly importing = new Set<number>();
    private readonly inflight = new Map<number, Promise<LibrarySet | null>>();
    private previewPending: number | null = null;
    /** Last preview started from the listing (stopped when it closes). */
    private previewSid: number | null = null;
    pendingOpen: PendingOpen | null = null;
    /** Whether the listing is still showing (navigation after a download needs it). */
    isActive: () => boolean = () => true;

    constructor(private readonly game: Game) {
        game.library.changed.add(() => {
            for (const sid of this.importing) if (game.library.has(sid)) this.importing.delete(sid);
            this.changed.emit(null);
        });
        game.favourites.changed.add(() => this.changed.emit(null));
        game.downloads.added.add(task => this.watch(task));
        for (const t of game.downloads.tasks) if (t.active) this.watch(t);
        const music = game.music;
        music.current.changed.add(() => this.changed.emit(null));
        music.playingState.changed.add(() => this.changed.emit(null));
        // A clip ending on its own changes neither of those when nothing
        // follows it (song select underneath): refresh the stop buttons.
        game.preview.ended.add(() => this.changed.emit(null));
    }

    // ------------------------------------------------------------------
    // Downloads
    // ------------------------------------------------------------------

    private watch(task: DownloadTask): void {
        const sid = task.sid;
        task.changed.add(() => {
            if (task.state === 'done' && !this.game.library.has(sid)) {
                this.importing.add(sid);
                // Imports started elsewhere may fail silently: don't spin forever.
                setTimeout(() => {
                    if (this.importing.delete(sid)) this.changed.emit(sid);
                }, 30000);
            }
            this.changed.emit(sid);
        });
        this.changed.emit(sid);
    }

    status(sid: number): DownloadStatus {
        if (this.game.library.has(sid)) return { phase: 'local', progress: 1 };
        const task = this.game.downloads.get(sid);
        if (task) return { phase: task.state === 'queued' ? 'queued' : 'downloading', progress: task.progress };
        if (this.importing.has(sid)) return { phase: 'importing', progress: NaN };
        return { phase: 'none', progress: 0 };
    }

    librarySet(sid: number): LibrarySet | undefined {
        return this.game.library.get(`osu-${sid}`);
    }

    /** Download + import (deduped). Resolves with the library set or null. */
    download(set: OnlineSet): Promise<LibrarySet | null> {
        const local = this.librarySet(set.sid);
        if (local) return Promise.resolve(local);
        const running = this.inflight.get(set.sid);
        if (running) return running;
        const p = this.game.downloadSet(set).then(async lib => {
            // Imports carry no star ratings: hand over the mirror's.
            if (lib) {
                const diffs = await this.loadDifficulties(set).catch(() => null);
                if (diffs?.length) await this.game.library.setStars(lib.key, new Map(diffs.map(d => [d.bid, d.stars])));
            }
            return lib;
        }).finally(() => {
            this.inflight.delete(set.sid);
            this.importing.delete(set.sid);
            this.changed.emit(set.sid);
        });
        this.inflight.set(set.sid, p);
        this.changed.emit(set.sid);
        return p;
    }

    /**
     * Show a set (optionally a difficulty) in song select, downloading it
     * first when needed. Only the latest request navigates, and only while
     * the listing is still open.
     */
    async open(set: OnlineSet, diff?: OnlineDifficulty): Promise<void> {
        let lib = this.librarySet(set.sid) ?? null;
        if (!lib) {
            const pending: PendingOpen = { sid: set.sid, bid: diff?.bid ?? null };
            this.pendingOpen = pending;
            this.changed.emit(set.sid);
            lib = await this.download(set);
            if (this.pendingOpen !== pending) return;
            this.pendingOpen = null;
            this.changed.emit(set.sid);
            if (!lib || !this.isActive()) return;
        }
        const d = diff
            ? lib.difficulties.find(x => diff.bid > 0 && x.beatmapId === diff.bid) ?? lib.difficulties.find(x => x.version === diff.version)
            : undefined;
        this.game.selectAndShow(lib, d);
    }

    // ------------------------------------------------------------------
    // Favourites
    // ------------------------------------------------------------------

    isFavourite(sid: number): boolean {
        return this.game.favourites.has(sid);
    }

    toggleFavourite(sid: number): void {
        const on = this.game.favourites.toggle(sid);
        if (on) this.game.uiSounds.toggleOn();
        else this.game.uiSounds.toggleOff();
    }

    // ------------------------------------------------------------------
    // Previews
    // ------------------------------------------------------------------

    previewState(sid: number): PreviewState {
        const cur = this.game.music.current.value;
        if (cur?.kind !== 'online' || cur.sid !== sid) return 'idle';
        if (this.game.preview.playing) return 'playing';
        return this.previewPending === sid ? 'loading' : 'idle';
    }

    /** Length of the playing preview clip in ms (NaN until known). */
    previewDuration(): number {
        return this.game.preview.duration;
    }

    /** Progress of the playing preview clip (NaN until its length is known). */
    previewProgress(): number {
        const d = this.game.preview.duration;
        return Number.isFinite(d) && d > 0 ? this.game.preview.currentTime / d : NaN;
    }

    togglePreview(set: OnlineSet): void {
        if (this.previewState(set.sid) !== 'idle') {
            this.previewPending = null;
            this.game.music.stopPreview();
            this.changed.emit(set.sid);
            return;
        }
        this.previewPending = set.sid;
        this.previewSid = set.sid;
        void this.game.music.playOnline(set).finally(() => {
            if (this.previewPending === set.sid) this.previewPending = null;
            this.changed.emit(set.sid);
        });
        this.changed.emit(set.sid);
    }

    /**
     * The listing closed: stop its preview and, if that left silence, let
     * menu music carry on (song select's track when it is showing).
     */
    releaseAudio(): void {
        const music = this.game.music;
        const sid = this.previewSid;
        this.previewSid = null;
        this.previewPending = null;
        // A clip still loading would otherwise keep its card spinning on reopen.
        if (sid !== null) this.changed.emit(sid);
        const cur = music.current.value;
        if (sid === null || cur?.kind !== 'online' || cur.sid !== sid) return;
        music.stopPreview();
        // Give whatever the close led to (song select) a moment to start its own track.
        setTimeout(() => {
            const now = music.current.value;
            const silent = !now || (now.kind === 'online' && now.sid === sid && !music.isPlaying);
            if (!silent || !this.game.settings.menuMusic.value || this.isActive()) return;
            const sel = this.game.selection.value;
            if (music.loopFromPreview && sel) void music.playSet(sel.set, { fromPreview: true });
            else void music.next();
        }, 350);
    }

    // ------------------------------------------------------------------
    // Difficulties (lazy)
    // ------------------------------------------------------------------

    /** osu!standard difficulties if already known (sorted by stars). */
    difficulties(set: OnlineSet): OnlineDifficulty[] | null {
        const hit = this.diffs.get(set.sid);
        if (hit) return hit;
        if (set.difficulties?.length) {
            const std = standardDifficulties(set.difficulties);
            this.diffs.set(set.sid, std);
            return std;
        }
        return null;
    }

    async loadDifficulties(set: OnlineSet, signal?: AbortSignal): Promise<OnlineDifficulty[]> {
        const known = this.difficulties(set);
        if (known) return known;
        const std = standardDifficulties(await this.game.api.difficulties(set.sid, signal));
        if (std.length) this.diffs.set(set.sid, std);
        return std;
    }

    cover(sid: number): string {
        return coverUrl(sid);
    }
}
