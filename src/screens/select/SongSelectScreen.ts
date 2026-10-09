import { Container, Texture, type FederatedPointerEvent } from 'pixi.js';
import type { Selection } from '../../app/Game';
import type { NowPlaying } from '../../app/MusicController';
import { Screen } from '../../app/Screen';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { clamp } from '../../core/math';
import type { MusicTrack } from '../../audio/MusicTrack';
import { delay, tween, tweener, type Tween } from '../../core/Tweener';
import { playbackRate, preservesPitch } from '../../gameplay/mods';
import type { Action } from '../../input/bindings';
import { ModSelectOverlay } from '../../overlays/mods/ModSelectOverlay';
import { SHEAR } from '../../ui/ShearedButton';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { uiSounds } from '../../ui/UIContext';
import { OsuLogo } from '../menu/OsuLogo';
import { BeatmapInfoWedge } from './BeatmapInfoWedge';
import { BeatmapOptionsOverlay } from './BeatmapOptions';
import { BeatmapCarousel } from './carousel/BeatmapCarousel';
import { EmptyLibraryState } from './EmptyLibrary';
import { filterSets, parseQuery, sortEntries } from './filter';
import { FILTER_HEIGHT, FilterControl } from './FilterControl';
import { FOOTER_HEIGHT, SongSelectFooter } from './Footer';
import { LocalLeaderboard } from './Leaderboard';

/** Music/background/leaderboard follow the selection after this pause (lazer debounces too). */
const SELECTION_DEBOUNCE = 150;
/** Below this logical width the wedge stacks above the carousel. */
const NARROW = 900;

/**
 * The selection object song select last published to `game.selection`;
 * any other value there was picked from outside (notification, listing).
 */
let published: Selection | null = null;

/**
 * osu!lazer's song select: info wedge + local leaderboard on the left,
 * the beatmap carousel under the filter control on the right, footer
 * with back / mods / random / options and the osu! logo as the play
 * button. The selection drives `game.selection`, the background and the
 * looping preview music, and is remembered in settings.
 */
export class SongSelectScreen extends Screen {
    override readonly hideMenuCursorOnNonMouseInput = true;
    private carousel!: BeatmapCarousel;
    private wedge!: BeatmapInfoWedge;
    private leaderboard!: LocalLeaderboard;
    private filter!: FilterControl;
    private footer!: SongSelectFooter;
    private logo!: OsuLogo;
    private empty!: EmptyLibraryState;
    private modSelect!: ModSelectOverlay;
    private options!: BeatmapOptionsOverlay;
    private readonly noMatches = new Container();
    private readonly leftArea = new Container();
    private readonly rightArea = new Container();
    private readonly footerSlot = new Container();
    private readonly logoSlot = new Container();

    private query = '';
    private current: Selection | null = null;
    private appliedSetKey: string | null = null;
    private pending: Tween | null = null;
    private filterDirty = false;
    private libraryEmpty = false;
    /** Track + rate the preview was last adjusted to (rate mods apply here too). */
    private rateTrack: MusicTrack | null = null;
    private rateKey = '';

    override load(): void {
        const g = this.game;
        this.wedge = new BeatmapInfoWedge(g);
        this.leaderboard = new LocalLeaderboard(g);
        this.leftArea.addChild(this.wedge, this.leaderboard);
        this.leftArea.eventMode = 'passive';

        this.carousel = new BeatmapCarousel(g);
        this.filter = new FilterControl(g);
        this.buildNoMatches();
        this.rightArea.addChild(this.carousel, this.noMatches, this.filter);
        this.rightArea.eventMode = 'passive';

        this.empty = new EmptyLibraryState(g.skin.tex('triangle'));
        this.empty.browse.onActivate = () => g.listing.show();
        this.empty.importFiles.onActivate = () => g.pickFiles();
        this.empty.visible = false;

        this.footer = new SongSelectFooter(g.skin.tex('fadeDown'));
        this.footerSlot.addChild(this.footer);
        this.footerSlot.eventMode = 'passive';

        this.logo = new OsuLogo(
            { triangle: g.skin.tex('triangle'), glow: g.skin.tex('glow'), white: Texture.WHITE },
            { beat: () => g.music.beat(), levels: () => g.audio.getLevels(), fft: out => g.audio.getFrequencyData(out) },
        );
        this.logo.onClickLogo = () => this.playSelected();
        // The corner logo keeps its beat but the spectrum is toned down.
        this.logo.visualiser.alpha = 0.5;
        this.logoSlot.addChild(this.logo);
        this.logoSlot.eventMode = 'passive';

        this.modSelect = new ModSelectOverlay(g);
        this.options = new BeatmapOptionsOverlay(g, [
            { icon: 'trash', first: 'Delete', second: 'this beatmap set', color: 0xc23a5a, action: () => void this.confirmDelete(), enabled: () => !!this.current },
            { icon: 'eraser', first: 'Clear', second: 'local scores', color: Colors.purpleDark, action: () => void this.confirmClearScores(), enabled: () => this.leaderboard.scores.length > 0 },
            { icon: 'fileImport', first: 'Import', second: '.osz files', color: 0xd98a00, action: () => g.pickFiles() },
            { icon: 'download', first: 'Browse', second: 'beatmap listing', color: Colors.greenDark, action: () => g.listing.show() },
        ]);

        this.addChild(this.leftArea, this.rightArea, this.empty, this.footerSlot, this.logoSlot, this.options, this.modSelect);
        this.eventMode = 'passive';
        this.wire();
    }

    private buildNoMatches(): void {
        const title = label('No matching beatmaps', { size: 22, weight: '700' });
        const body = label('Try a different search, or press Esc to clear it.', { size: 14, weight: '500', color: Colors.grayA });
        title.anchor.set(0.5, 0);
        body.anchor.set(0.5, 0);
        body.y = 36;
        this.noMatches.addChild(title, body);
        this.noMatches.visible = false;
    }

    private wire(): void {
        const g = this.game;
        const f = this.footer;
        f.back.onActivate = () => this.goBack();
        f.mods.onActivate = () => this.modSelect.toggle();
        f.random.onActivate = () => (this.shiftHeld ? this.carousel.rewind() : this.carousel.random());
        f.random.on('rightclick', (e: FederatedPointerEvent) => {
            e.stopPropagation();
            this.carousel.rewind();
        });
        f.options.onActivate = () => this.options.toggle();
        // Footer popups are mutually exclusive (lazer's Footer.showOverlay).
        this.options.state.bind(v => {
            f.options.selected = v;
            if (v) {
                // A focused search would take Esc/typing meant for the band.
                this.filter.search.blur();
                this.modSelect.hide();
            }
        });
        this.modSelect.state.bind(v => {
            f.mods.selected = v;
            if (v) {
                this.filter.search.blur();
                this.options.hide();
            }
        });

        this.filter.search.changed.add(v => {
            this.query = v;
            this.filterDirty = true;
        });
        this.filter.search.committed.add(() => this.playSelected());
        this.filter.search.onArrow = d => this.carousel.moveSet(d);

        this.carousel.selectionChanged.add((e, d) => this.onSelected(e.set, d));
        this.carousel.activated.add((e, d) => this.startPlay(e.set, d));

        const d = this.disposer;
        d.add(g.mods.bind(m => {
            f.mods.setMods(m);
            this.wedge.setMods(m);
        }, true));
        d.add(g.settings.songSort.bind(() => (this.filterDirty = true)));
        d.add(g.library.changed.add(() => (this.filterDirty = true)));
        d.add(g.selection.bind(sel => this.onExternalSelection(sel)));
        d.add(g.music.current.bind(n => this.onMusicChanged(n)));
        d.add(g.toolbarVisible.bind(() => this.relayout()));
    }

    private get shiftHeld(): boolean {
        return this.game.input.isKeyDown('ShiftLeft') || this.game.input.isKeyDown('ShiftRight');
    }

    // ------------------------------------------------------------------
    // Filtering
    // ------------------------------------------------------------------

    private refilter(): void {
        this.filterDirty = false;
        const sets = this.game.library.sets;
        const entries = sortEntries(filterSets(sets, parseQuery(this.query)), this.game.settings.songSort.value);
        if (this.current && !this.game.library.get(this.current.set.key)) {
            // The selected set was deleted while hidden by the search.
            this.current = null;
            this.pending?.cancel();
            this.pending = null;
            this.wedge.setBeatmap(null, null);
            this.leaderboard.setBeatmap(null, null);
        }
        const keep = this.current;
        this.carousel.setEntries(entries, keep?.set.key ?? null, keep?.diff.file ?? null);
        // A re-import replaces the set object under the same key: pick it up.
        const e = this.carousel.selectedEntry, d = this.carousel.selectedDiff;
        if (e && d && (e.set !== this.current?.set || d !== this.current?.diff)) this.onSelected(e.set, d);
        // Online star lookups update difficulties in place: redraw the wedge's rating.
        else if (this.current && !this.pending) this.wedge.setBeatmap(this.current.set, this.current.diff);
        let diffs = 0;
        for (const x of entries) diffs += x.diffs.length;
        this.filter.setCount(diffs, this.query.trim().length > 0);
        this.noMatches.visible = sets.length > 0 && entries.length === 0;
        this.setLibraryEmpty(sets.length === 0);
    }

    private setLibraryEmpty(empty: boolean): void {
        if (empty === this.libraryEmpty) return;
        this.libraryEmpty = empty;
        if (empty) {
            this.current = null;
            // A re-import of the same set must restart its music/background.
            this.appliedSetKey = null;
            this.pending?.cancel();
            this.pending = null;
            this.wedge.setBeatmap(null, null);
            this.leaderboard.setBeatmap(null, null);
            this.filter.search.blur();
        }
        // The empty state keeps the menu's online previews cycling.
        if (this.isCurrent) this.game.music.loopFromPreview = !empty;
        this.empty.visible = true;
        tween(this.empty, { alpha: empty ? 1 : 0 }, { duration: 300 }).finished.then(() => {
            if (!this.destroyed && !this.libraryEmpty) this.empty.visible = false;
        });
        for (const area of [this.leftArea, this.rightArea]) {
            area.visible = true;
            tween(area, { alpha: empty ? 0 : 1 }, { duration: 300 }).finished.then(() => {
                if (!this.destroyed) area.visible = !this.libraryEmpty;
            });
        }
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    /** Where to open: an outside pick, the song playing in the menu, the last selection, else random. */
    private restoreTarget(): Selection | null {
        const lib = this.game.library;
        const resolve = (key: string, file: string | null, refStars?: number | null): Selection | null => {
            const set = lib.get(key);
            if (!set || !set.difficulties.length) return null;
            const diff = (file ? set.difficulties.find(x => x.file === file) : undefined) ?? closestDifficulty(set, refStars ?? null);
            return { set, diff };
        };
        const sel = this.game.selection.value;
        const picked = sel ? resolve(sel.set.key, sel.diff.file) : null;
        if (picked && sel !== published) return picked;
        const [lastKey, lastFile] = this.game.settings.lastBeatmap.value.split('|');
        const ref = picked ?? (lastKey ? resolve(lastKey, lastFile ?? null) : null);
        const now = this.game.music.current.value;
        if (now?.kind === 'library' && lib.get(now.set.key)) {
            if (ref && ref.set.key === now.set.key) return ref;
            return resolve(now.set.key, null, ref?.diff.stars);
        }
        if (ref) return ref;
        const sets = lib.sets.filter(s => s.difficulties.length);
        if (!sets.length) return null;
        return resolve(sets[Math.floor(Math.random() * sets.length)].key, null);
    }

    private onSelected(set: LibrarySet, diff: DifficultySummary): void {
        const sameSet = this.current?.set.key === set.key;
        this.current = { set, diff };
        this.publish();
        // Difficulty changes are cheap; set changes load art + audio, so
        // wait until keyboard/scroll navigation settles.
        if (sameSet && !this.pending) this.applySelection();
        else this.scheduleApply();
    }

    /** Share the selection with the game and remember it for next time. */
    private publish(): void {
        const sel = this.current;
        if (!sel) return;
        published = sel;
        this.game.selection.value = sel;
        this.game.settings.lastBeatmap.value = `${sel.set.key}|${sel.diff.file}`;
    }

    private scheduleApply(): void {
        this.pending?.cancel();
        this.pending = delay(SELECTION_DEBOUNCE, () => {
            this.pending = null;
            this.applySelection();
        }, this);
    }

    private applySelection(): void {
        this.pending?.cancel();
        this.pending = null;
        const sel = this.current;
        this.wedge.setBeatmap(sel?.set ?? null, sel?.diff ?? null);
        this.leaderboard.setBeatmap(sel?.set ?? null, sel?.diff ?? null);
        if (!sel || this.appliedSetKey === sel.set.key) return;
        this.appliedSetKey = sel.set.key;
        void this.game.setBackgroundForSet(sel.set);
        if (this.isCurrent) void this.game.music.playSet(sel.set, { fromPreview: true });
    }

    /** Someone else picked a beatmap (notification, listing): follow it. */
    private onExternalSelection(sel: Selection | null): void {
        if (!sel || sel === this.current || this.libraryEmpty) return;
        if (sel.set.key === this.current?.set.key && sel.diff.file === this.current.diff.file) return;
        if (this.filterDirty) this.refilter();
        if (this.carousel.selectByKey(sel.set.key, sel.diff.file)) return;
        if (this.query) {
            // Filtered out: clear the search so it can be shown (lazer does the same).
            this.filter.search.setValue('');
            this.refilter();
            this.carousel.selectByKey(sel.set.key, sel.diff.file);
        }
    }

    /** Track changed from the now-playing controls: select that set. */
    private onMusicChanged(n: NowPlaying | null): void {
        if (!this.isCurrent) return;
        // The empty state's background follows the online previews, as in the menu.
        if (this.libraryEmpty && n?.kind === 'online') void this.game.setBackgroundForOnline(n.sid);
        if (n?.kind !== 'library' || n.set.key === this.current?.set.key) return;
        if (this.filterDirty) this.refilter();
        this.carousel.selectByKey(n.set.key);
    }

    private playSelected(): void {
        const e = this.carousel.selectedEntry, d = this.carousel.selectedDiff;
        if (e && d) this.startPlay(e.set, d);
    }

    private startPlay(set: LibrarySet, diff: DifficultySummary): void {
        if (!this.isCurrent) return;
        if (this.current?.set.key !== set.key || this.current.diff !== diff) this.onSelected(set, diff);
        // Don't start decoding the song now; the player loader loads it.
        this.pending?.cancel();
        this.pending = null;
        this.wedge.setBeatmap(set, diff);
        this.leaderboard.setBeatmap(set, diff);
        this.game.play(this.current!);
    }

    // ------------------------------------------------------------------
    // Options
    // ------------------------------------------------------------------

    private async confirmDelete(): Promise<void> {
        const sel = this.current;
        if (!sel) return;
        const ok = await this.game.dialog.confirm({
            title: 'Delete this beatmap set?',
            text: `${sel.set.artist} - ${sel.set.title} and all of its difficulties will be removed from your library.`,
            confirmText: 'Yes, delete it',
            cancelText: 'No, keep it',
            danger: true,
            icon: 'trash',
        });
        if (!ok) return;
        try {
            await this.game.library.delete(sel.set.key);
            this.game.notifications.success(`Deleted ${sel.set.artist} - ${sel.set.title}`);
        } catch (e) {
            console.warn('delete failed', e);
            this.game.notifications.error('Could not delete the beatmap set.');
        }
    }

    private async confirmClearScores(): Promise<void> {
        const scores = this.leaderboard.scores.slice();
        const sel = this.current;
        if (!scores.length || !sel) return;
        const ok = await this.game.dialog.confirm({
            title: 'Clear local scores?',
            text: `All ${scores.length} local score${scores.length === 1 ? '' : 's'} on ${sel.diff.version} will be deleted.`,
            confirmText: 'Yes, clear them',
            cancelText: 'No, keep them',
            danger: true,
            icon: 'eraser',
        });
        if (!ok) return;
        for (const s of scores) if (s.id !== undefined) await this.game.scores.delete(s.id);
        this.leaderboard.refresh();
    }

    // ------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------

    protected override onResize(w: number, h: number): void {
        if (!this.carousel) return;
        const top = this.game.toolbarOffset;
        const bottom = h - FOOTER_HEIGHT;
        if (w < NARROW) {
            // Phones in portrait: wedge on top, carousel below, no leaderboard.
            const wedgeH = clamp(Math.round(h * 0.2), 150, 200);
            this.wedge.position.set(0, top);
            this.wedge.resize(w - 20 - wedgeH * SHEAR, wedgeH);
            this.leaderboard.visible = false;
            this.filter.setFullWidth(true);
            this.layoutRight(0, top + wedgeH + 8, w, bottom);
        } else {
            const leftW = Math.round(w * 0.5);
            const wedgeH = clamp(Math.round(h * 0.3), 180, 245);
            // Both top wedges hang from the toolbar; the wedge's right edge
            // and the filter's left edge are parallel (same SHEAR), a
            // constant gutter apart.
            this.wedge.position.set(0, top);
            this.wedge.resize(leftW - 16 - wedgeH * SHEAR, wedgeH);
            this.filter.setFullWidth(false);
            const lbTop = top + wedgeH + 14;
            this.leaderboard.visible = bottom - 10 - lbTop > 80;
            this.leaderboard.position.set(20, lbTop);
            this.leaderboard.resize(leftW - 60, bottom - 10 - lbTop);
            this.layoutRight(leftW - 10, top, w, bottom);
        }
        this.empty.position.set(0, top);
        this.empty.resize(w, bottom - top);
        this.footer.position.set(0, bottom);
        this.footer.resize(w, FOOTER_HEIGHT);
        const d = clamp(Math.round(h * 0.23), 130, 200);
        this.logo.setDiameter(d);
        this.logoSlot.position.set(Math.round(w - d * 0.34), Math.round(h - d * 0.16));
        this.modSelect.resize(w, h);
        this.options.resize(w, h);
    }

    /** Filter control on top; the carousel runs on behind it and the footer. */
    private layoutRight(x: number, y: number, w: number, bottom: number): void {
        this.filter.position.set(x, y);
        this.filter.resize(w - x, FILTER_HEIGHT);
        this.carousel.position.set(x, y);
        this.carousel.setInsets(FILTER_HEIGHT, FOOTER_HEIGHT);
        this.carousel.resize(w - x, Math.max(FILTER_HEIGHT + FOOTER_HEIGHT + 100, bottom + FOOTER_HEIGHT - y));
        const cy = y + FILTER_HEIGHT;
        this.noMatches.position.set(x + (w - x) / 2, cy + Math.max(40, (bottom - cy) / 2 - 40));
    }

    // ------------------------------------------------------------------
    // Transitions (lazer: wedge from the left, carousel from the right,
    // footer from the bottom)
    // ------------------------------------------------------------------

    private animateIn(): void {
        // Resuming within the suspend fade (quick Esc from the loader) must
        // stop it, or it keeps fading the now-current screen to alpha 0.
        tweener.kill(this, ['alpha']);
        this.visible = true;
        this.alpha = 1;
        const w = this._w;
        const ease = { duration: 800, ease: 'OutQuint' as const };
        this.leftArea.x = -w * 0.35;
        this.rightArea.x = w * 0.35;
        tween(this.leftArea, { x: 0 }, ease);
        tween(this.rightArea, { x: 0 }, ease);
        this.footerSlot.y = FOOTER_HEIGHT;
        tween(this.footerSlot, { y: 0 }, { duration: 500, ease: 'OutQuint' });
        this.logoSlot.scale.set(0.4);
        this.logoSlot.alpha = 0;
        tween(this.logoSlot, { scale: 1, alpha: 1 }, { duration: 700, ease: 'OutQuint' });
        this.empty.scale.set(1);
    }

    private animateOut(duration: number): Tween {
        const w = this._w;
        const ease = { duration, ease: 'OutQuint' as const };
        tween(this.leftArea, { x: -w * 0.35 }, ease);
        tween(this.rightArea, { x: w * 0.35 }, ease);
        tween(this.footerSlot, { y: FOOTER_HEIGHT }, ease);
        tween(this.logoSlot, { scale: 0.4 }, ease);
        return tween(this, { alpha: 0 }, { duration, ease: 'OutQuad' });
    }

    private closePopups(): void {
        this.modSelect.hide();
        this.options.hide();
        this.filter.search.blur();
        this.filter.closeMenus();
    }

    override onEntering(): void {
        const bg = this.game.background;
        bg.setBlur(0.32, 800);
        bg.setDim(0.28, 800);
        this.current = this.restoreTarget();
        this.refilter();
        this.game.music.loopFromPreview = !this.libraryEmpty;
        if (this.current) {
            this.publish();
            this.applySelection();
        }
        // Show the empty state without a cross-fade on first entry.
        this.empty.alpha = this.libraryEmpty ? 1 : 0;
        this.empty.visible = this.libraryEmpty;
        this.leftArea.alpha = this.rightArea.alpha = this.libraryEmpty ? 0 : 1;
        this.leftArea.visible = this.rightArea.visible = !this.libraryEmpty;
        this.animateIn();
    }

    override onResuming(): void {
        this.eventMode = 'passive';
        // Gameplay hands the track back at rate 1; re-apply on the next frame.
        this.rateTrack = null;
        this.game.background.setBlur(0.32, 600);
        this.game.background.setDim(0.28, 600);
        if (this.filterDirty) this.refilter();
        const sel = this.game.selection.value;
        if (sel && sel !== this.current) this.onExternalSelection(sel);
        this.game.music.loopFromPreview = !this.libraryEmpty;
        this.appliedSetKey = null;
        this.resumeMusic();
        this.applySelection();
        this.leaderboard.refresh();
        this.animateIn();
    }

    /** After gameplay: keep a running track, else restart from the preview point (lazer). */
    private resumeMusic(): void {
        const set = this.current?.set;
        if (!set) return;
        const music = this.game.music;
        const now = music.current.value;
        const loaded = now?.kind === 'library' && now.set.key === set.key && !!music.currentTrack;
        this.appliedSetKey = set.key;
        if (loaded && !music.isPlaying) {
            void music.playSet(set);
            music.seek(set.previewTime > 0 ? set.previewTime : music.duration * 0.4);
        } else {
            void music.playSet(set, { fromPreview: true });
        }
        void this.game.setBackgroundForSet(set);
    }

    override onSuspending(): void {
        this.closePopups();
        this.eventMode = 'none';
        this.animateOut(300).finished.then(() => {
            if (!this.isCurrent && !this.destroyed) this.visible = false;
        });
    }

    override onExiting(): number {
        this.closePopups();
        this.pending?.cancel();
        this.pending = null;
        this.game.music.loopFromPreview = false;
        this.resetMusicRate();
        this.animateOut(350);
        return 350;
    }

    private goBack(): void {
        uiSounds()?.back();
        this.exit();
    }

    // ------------------------------------------------------------------
    // Frame / input
    // ------------------------------------------------------------------

    override update(): void {
        if (this.filterDirty) this.refilter();
        this.syncMusicRate();
        // lazer's random button turns into "rewind" while Shift is held.
        this.footer.random.caption = this.shiftHeld ? 'rewind' : 'random';
    }

    /**
     * lazer previews rate mods: DT/NC speed the song up, HT/DC slow it
     * down. Checked per frame because tracks change asynchronously (set
     * changes, gameplay handing the track back at rate 1).
     */
    private syncMusicRate(): void {
        const track = this.game.music.currentTrack;
        if (!track || !this.isCurrent) return;
        const mods = this.game.mods.value;
        const rate = playbackRate(mods), pitch = preservesPitch(mods);
        const key = `${rate}|${pitch}`;
        if (track === this.rateTrack && key === this.rateKey) return;
        this.rateTrack = track;
        this.rateKey = key;
        void track.setRate(rate, pitch).catch(() => {});
    }

    private resetMusicRate(): void {
        const track = this.rateTrack;
        this.rateTrack = null;
        this.rateKey = '';
        if (track && track === this.game.music.currentTrack) void track.setRate(1, true).catch(() => {});
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        switch (action) {
            case 'back':
                // lazer's search box always has focus, so Esc clears it first.
                if (this.filter.search.value) this.filter.search.setValue('');
                else this.goBack();
                return true;
            case 'select':
                this.playSelected();
                return true;
            case 'up':
                this.carousel.moveDiff(-1);
                return true;
            case 'down':
                this.carousel.moveDiff(1);
                return true;
            case 'left':
                this.carousel.moveSet(-1);
                return true;
            case 'right':
                this.carousel.moveSet(1);
                return true;
            case 'pageUp':
                this.carousel.scrollPage(-1);
                return true;
            case 'pageDown':
                this.carousel.scrollPage(1);
                return true;
            case 'home':
                this.carousel.first();
                return true;
            case 'end':
                this.carousel.last();
                return true;
            case 'random':
                this.carousel.random();
                return true;
            case 'randomRewind':
                this.carousel.rewind();
                return true;
            case 'toggleMods':
                this.modSelect.toggle();
                return true;
            case 'deleteItem':
                void this.confirmDelete();
                return true;
        }
        // Type-to-search: printable keys go to the search box.
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ' && !this.libraryEmpty) {
            const search = this.filter.search;
            search.focus();
            search.setValue(search.value + e.key);
            return true;
        }
        return false;
    }
}

/** Difficulty nearest a reference star rating (else the middle one). */
function closestDifficulty(set: LibrarySet, refStars: number | null): DifficultySummary {
    const diffs = set.difficulties;
    if (refStars === null) return diffs[Math.floor((diffs.length - 1) / 2)];
    let best = diffs[0], bestD = Infinity;
    for (const d of diffs) {
        const dist = Math.abs((d.stars ?? d.od) - refStars);
        if (dist < bestD) {
            bestD = dist;
            best = d;
        }
    }
    return best;
}
