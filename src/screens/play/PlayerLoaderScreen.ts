import { Container, Graphics, Rectangle, type Text, type Texture } from 'pixi.js';
import { Screen } from '../../app/Screen';
import type { Selection } from '../../app/Game';
import { MusicTrack } from '../../audio/MusicTrack';
import type { BeatmapData } from '../../beatmap/types';
import { Bindable } from '../../core/Bindable';
import { tween } from '../../core/Tweener';
import { playbackRate, preservesPitch, sortedMods, type ModSet } from '../../gameplay/mods';
import type { Action } from '../../input/bindings';
import { ModIconRow } from '../../overlays/mods/ModIcon';
import { Checkbox } from '../../ui/Checkbox';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { Slider } from '../../ui/Slider';
import { fitText, label } from '../../ui/text';
import { ColorProvider, Colors, starColor, starTextColor } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { modAdjustedStars } from '../select/modStars';
import { coverFill, formatStars, setBackground } from '../select/visuals';
import { parseStoryboard, type Storyboard } from '../../beatmap/storyboard';
import { BeatmapSkin } from '../../skin/BeatmapSkin';
import type { OszArchive } from '../../beatmap/archive';
import { PlayerScreen } from './PlayerScreen';

/** The loader shows at least this long so the metadata can be read (lazer: PlayerPushDelay). */
const MIN_DISPLAY = 1800;
/** lazer's BeatmapMetadataDisplay thumbnail. */
const THUMB_W = 300;
const THUMB_H = 60;
/** lazer's SettingsToolboxGroup.CONTAINER_WIDTH and the loader's side padding. */
const PANEL_W = 270;
const PANEL_PAD = 25;
const CONTENT_OUT = 300;
const colours = new ColorProvider('purple');

/**
 * lazer's PlayerLoader: the beatmap's metadata centred over its dimmed
 * background (title, artist, a thumbnail with the loading spinner,
 * difficulty, stars, source / mapper, mods) and the player settings
 * groups vertically centred on the right edge. Behind it the Player is
 * built and drawn offscreen once (PlayerScreen.prepare), so gameplay is
 * only revealed when it is fully ready. Retry and quit come back through
 * here: retry prepares a fresh Player on the same data.
 */
export class PlayerLoaderScreen extends Screen {
    override readonly hideToolbar = true;
    override readonly allowOverlays = false;

    private readonly content = new Container();
    private readonly meta = new Container();
    private readonly thumb = new Graphics();
    private readonly thumbShade = new Graphics();
    private spinner!: LoadingSpinner;
    private title!: Text;
    private artist!: Text;
    private version!: Text;
    private starText!: Text;
    private readonly starPill = new Graphics();
    private readonly lines = new Container();
    private readonly modRow = new ModIconRow(26, 4);
    private panel!: SettingsPanel;
    private thumbTexture: Texture | null = null;
    private stars: number | null = null;
    private metaH = 0;

    private data: BeatmapData | null = null;
    private track: MusicTrack | null = null;
    private mods!: ModSet;
    private shownFor = 0;
    private pushed = false;
    private storyboard: Storyboard | null = null;
    private beatmapSkin: BeatmapSkin | null = null;
    private cancelled = false;
    private retries = 0;
    /** Built and warmed up behind the loader; pushed once ready. */
    private player: PlayerScreen | null = null;

    constructor(readonly selection: Selection) {
        super();
    }

    override load(): void {
        const g = this.game;
        const { set, diff } = this.selection;
        this.mods = g.mods.value;
        if (g.settings.fullscreenOnPlay.value && !document.fullscreenElement) {
            // Still inside the click/keypress that started the play, so the browser allows it.
            try { void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch { /* unsupported */ }
        }

        this.title = label(set.titleUnicode || set.title, { size: 36, weight: '500', italic: true, shadow: true });
        this.artist = label(set.artistUnicode || set.artist, { size: 26, weight: '500', italic: true, shadow: true });
        this.version = label(diff.version, { size: 26, weight: '500', italic: true, shadow: true });
        this.stars = diff.stars;
        this.starText = label(`★ ${formatStars(diff.stars)}`, { size: 13, weight: '800' });
        this.starText.tint = starTextColor(diff.stars);
        for (const t of [this.title, this.artist, this.version, this.starText]) t.anchor.set(0.5, 0);
        this.spinner = new LoadingSpinner(16, 0xffffff, 4);
        this.buildLines(set.source, set.creator);
        this.modRow.setMods(sortedMods(this.mods));
        this.meta.addChild(this.title, this.artist, this.thumb, this.thumbShade, this.spinner, this.version, this.starPill, this.starText, this.lines, this.modRow);
        this.content.addChild(this.meta);
        this.panel = new SettingsPanel(this);
        this.addChild(this.content, this.panel);
        this.eventMode = 'passive';
        this.layoutMeta();

        setBackground(g, set).then(tex => {
            if (this.destroyed) return;
            this.thumbTexture = tex;
            this.drawThumb();
        });
        void this.prepare();
        // Beatmap skins change how the Player is built: rebuild one that was prepared but not started.
        this.disposer.add(g.settings.beatmapSkin.bind(() => {
            if (this.player && !this.pushed) {
                this.player.destroy();
                this.player = null;
            }
        }));
        void modAdjustedStars(g, set, diff, this.mods).then(stars => {
            if (this.destroyed || stars === this.stars) return;
            this.stars = stars;
            this.starText.text = `★ ${formatStars(stars)}`;
            this.starText.tint = starTextColor(stars);
            this.layoutMeta();
        });
    }

    /** lazer's MetadataLineLabel / MetadataLineInfo grid: grey right-aligned label, value on the right. */
    private buildLines(source: string, mapper: string): void {
        const rows: [string, string][] = [];
        if (source) rows.push(['Source', source]);
        rows.push(['Mapper', mapper]);
        const cells = rows.map(([k, v]) => {
            const key = label(k, { size: 16, weight: '500', color: Colors.grayA, shadow: true });
            const value = label(v, { size: 16, weight: '700', shadow: true });
            fitText(value, 260, v);
            key.anchor.set(1, 0);
            return { key, value };
        });
        // Auto-sized columns, the grid as a whole centred (lazer's GridContainer).
        const keyW = Math.max(...cells.map(c => c.key.width));
        const valueW = Math.max(...cells.map(c => c.value.width));
        const left = -(keyW + 10 + valueW) / 2;
        cells.forEach(({ key, value }, i) => {
            key.position.set(left + keyW, i * 22);
            value.position.set(left + keyW + 10, i * 22);
            this.lines.addChild(key, value);
        });
    }

    /** Load the difficulty and the song (borrowing menu music when it is the same song). */
    private async prepare(): Promise<void> {
        const g = this.game;
        const { set, diff } = this.selection;
        try {
            const data = await g.library.loadBeatmap(set.key, diff.file);
            if (this.cancelled) return;
            if (!data.hitObjects.length) throw new Error('This difficulty has no hit objects.');
            const archive = await g.library.openArchive(set.key);
            if (this.cancelled) return;
            const audioName = archive.findAudio(data.general.audioFilename || set.audioFile);
            if (!audioName) throw new Error("The beatmap's audio file is missing.");
            let track = g.music.lend(set.key);
            if (track && track.filename !== audioName) {
                g.music.reclaim(track, set.key);
                track = null;
            }
            if (!track) {
                g.music.pause();
                const bytes = await archive.readBytes(audioName);
                if (this.cancelled) return;
                const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                track = await MusicTrack.decode(g.audio, buf, audioName);
            }
            // Owned from here on: a cancel hands it back to the menu music.
            this.track = track;
            if (this.cancelled) return this.handBackTrack();
            // Fade the preview out while the rate (and time-stretch worklet) is prepared.
            await track.fadeTo(0, 250);
            if (this.cancelled) return this.handBackTrack();
            track.pause();
            await track.setRate(playbackRate(this.mods), preservesPitch(this.mods));
            if (this.cancelled) return this.handBackTrack();
            track.userOffsetMs = g.settings.audioOffset.value;
            this.disposer.add(g.settings.audioOffset.bind(v => {
                if (this.track) this.track.userOffsetMs = v;
            }));
            this.storyboard = await this.readStoryboard(archive, diff.file);
            if (this.cancelled) return this.handBackTrack();
            // The map's own skin elements and hitsounds (both toggled in the visual/audio settings).
            const customFiles = data.hitObjects.map(h => h.hitSample.filename).filter(Boolean);
            this.beatmapSkin = await BeatmapSkin.load(archive, g.audio.context, { textures: true, samples: true, customFiles });
            if (this.cancelled) return this.handBackTrack();
            this.data = data;
            g.library.markPlayed(set.key);
        } catch (e) {
            console.error('player load failed', e);
            if (this.cancelled) return;
            g.notifications.error(`Couldn't load ${set.title} [${diff.version}]: ${e instanceof Error ? e.message : String(e)}`);
            this.cancel();
        }
    }

    /** The set's .osb plus this difficulty's own events (either may be absent). */
    private async readStoryboard(archive: OszArchive, osuFile: string): Promise<Storyboard | null> {
        try {
            const osb = archive.files.find(f => /\.osb$/i.test(f));
            const [osbText, osuText] = await Promise.all([
                osb ? archive.readText(osb) : Promise.resolve(''),
                archive.readText(osuFile).catch(() => ''),
            ]);
            return parseStoryboard(osbText, osuText);
        } catch (e) {
            console.warn('storyboard parse failed', e);
            return null;
        }
    }

    private get ready(): boolean {
        return !!this.data && !!this.track;
    }

    // ------------------------------------------------------------------

    /** Stack the metadata top to bottom around x = 0 (lazer's vertical fill flow). */
    private layoutMeta(): void {
        const maxW = THUMB_W + 260;
        fitText(this.title, maxW, this.selection.set.titleUnicode || this.selection.set.title);
        fitText(this.artist, maxW, this.selection.set.artistUnicode || this.selection.set.artist);
        fitText(this.version, maxW, this.selection.diff.version);
        let y = 0;
        this.title.position.set(0, y);
        y += this.title.height;
        this.artist.position.set(0, y);
        y += this.artist.height + 10;
        this.drawThumb(y);
        this.spinner.position.set(-16, y + THUMB_H / 2 - 16);
        y += THUMB_H + 10;
        this.version.position.set(0, y);
        y += this.version.height + 5;
        const pillW = this.starText.width + 16;
        this.starPill.clear().roundRect(-pillW / 2, y, pillW, 20, 10).fill(starColor(this.stars));
        this.starText.position.set(0, y + 2);
        y += 20 + 40;
        this.lines.position.set(0, y);
        y += this.lines.height + 20;
        this.modRow.position.set(-this.modRow.rowWidth / 2, y);
        y += this.modRow.rowWidth > 0 ? 26 : 0;
        this.metaH = y;
    }

    private thumbY = 0;

    private drawThumb(y = this.thumbY): void {
        this.thumbY = y;
        const x = -THUMB_W / 2;
        this.thumb.clear();
        if (this.thumbTexture) this.thumb.roundRect(x, y, THUMB_W, THUMB_H, 10).fill(coverFill(this.thumbTexture, x, y, THUMB_W, THUMB_H));
        else this.thumb.roundRect(x, y, THUMB_W, THUMB_H, 10).fill(0x2a2a35);
        // lazer's LoadingLayer(dimBackground: true) over the thumbnail.
        this.thumbShade.clear().roundRect(x, y, THUMB_W, THUMB_H, 10).fill({ color: 0x000000, alpha: 0.5 });
    }

    protected override onResize(w: number, h: number): void {
        if (!this.panel) return;
        const showPanel = w >= 760;
        this.panel.visible = showPanel;
        const panelH = this.panel.preferredHeight;
        this.panel.resize(PANEL_W, panelH);
        // Middle of the right edge.
        this.panel.position.set(w - PANEL_W - PANEL_PAD, Math.max(PANEL_PAD, h / 2 - panelH / 2));
        // Centred on screen like lazer, unless the panel would overlap it.
        const reserved = showPanel ? PANEL_W + PANEL_PAD * 2 : 0;
        const metaW = THUMB_W + 260;
        const cx = w / 2 + metaW / 2 > w - reserved ? (w - reserved) / 2 : w / 2;
        const scale = Math.min(1, (h - 40) / Math.max(1, this.metaH), (w - reserved - 20) / metaW);
        this.content.position.set(cx, h / 2);
        this.meta.scale.set(scale);
        this.meta.position.set(0, (-this.metaH * scale) / 2);
    }

    override onEntering(): void {
        const g = this.game;
        const bg = g.background;
        void g.setBackgroundForSet(this.selection.set);
        bg.setDim(Math.min(0.6, g.settings.backgroundDim.value), 600);
        bg.setBlur(Math.max(0.25, g.settings.backgroundBlur.value), 600);
        // No parallax from here on: the background must not drift between loader and gameplay.
        bg.suppressParallax(this);
        this.contentIn();
    }

    /** lazer's contentIn: content scales 0.7 → 1 and fades in; the side panel slides in from the right. */
    private contentIn(): void {
        this.content.alpha = 0;
        this.content.scale.set(0.7);
        tween(this.content, { alpha: 1 }, { duration: 500, ease: 'OutQuint' });
        tween(this.content, { scale: 1 }, { duration: 650, ease: 'OutQuint' });
        const px = this.panel.x;
        this.panel.alpha = 0;
        this.panel.x = px + PANEL_W;
        tween(this.panel, { alpha: 1 }, { duration: 500, ease: 'Out', delay: 250 });
        tween(this.panel, { x: px }, { duration: 500, ease: 'OutQuint', delay: 250 });
    }

    /** lazer's ContentOut. */
    private contentOut(): void {
        tween(this.content, { scale: 0.7 }, { duration: CONTENT_OUT * 2, ease: 'OutQuint' });
        tween(this.content, { alpha: 0 }, { duration: CONTENT_OUT, ease: 'OutQuint' });
        tween(this.panel, { alpha: 0 }, { duration: CONTENT_OUT, ease: 'OutQuint' });
        tween(this.panel, { x: this.panel.x + PANEL_W }, { duration: CONTENT_OUT * 2, ease: 'OutQuint' });
    }

    override update(dt: number): void {
        if (!this.isCurrent || this.pushed || this.cancelled) return;
        this.shownFor += dt;
        if (this.ready && !this.player && this.shownFor > 300) this.preparePlayer();
        // Storyboard images decode while this screen covers everything.
        const loaded = !!this.player && this.player.assetsReady;
        const busy = this.panel.visible && this.panel.isPointerOver(this.game.input.pointer);
        if (loaded && this.shownFor >= MIN_DISPLAY && !busy && !this.panel.dragging) this.startPlayer();
        this.thumbShade.alpha = loaded ? Math.max(0, this.thumbShade.alpha - dt / 300) : Math.min(1, this.thumbShade.alpha + dt / 300);
        this.spinner.alpha = this.thumbShade.alpha;
        this.spinner.visible = this.spinner.alpha > 0.01;
    }

    /** Build, lay out and draw the Player offscreen while this screen still covers everything. */
    private preparePlayer(): void {
        if (!this.data || !this.track) return;
        const player = new PlayerScreen({
            selection: this.selection,
            data: this.data,
            mods: this.mods,
            track: this.track,
            retryCount: this.retries,
            storyboard: this.storyboard,
            beatmapSkin: this.beatmapSkin,
        });
        try {
            player.prepare(this.game, this._w, this._h);
            this.player = player;
        } catch (e) {
            console.error('player build failed', e);
            if (!player.destroyed) player.destroy();
            this.game.notifications.error(`Couldn't start ${this.selection.set.title}: ${e instanceof Error ? e.message : String(e)}`);
            this.cancel();
        }
    }

    private startPlayer(): void {
        if (!this.player) return;
        this.pushed = true;
        this.contentOut();
        this.push(this.player);
    }

    override onSuspending(): void {
        // The Player takes over the parallax block in its onEntering.
        this.game.background.releaseParallax(this);
        this.fadeOut(CONTENT_OUT);
    }

    override onResuming(previous: Screen): void {
        const outcome = previous.constructor.name === 'PlayerScreen' ? (previous as PlayerScreen).outcome : 'quit';
        this.player = null;
        if (outcome === 'retry' && !this.cancelled) {
            this.retries++;
            this.game.background.suppressParallax(this);
            this.fadeIn(0);
            this.content.alpha = 0;
            this.panel.alpha = 0;
            // lazer goes straight back into gameplay on retry (the new Player is still prepared first).
            this.pushed = false;
            this.shownFor = MIN_DISPLAY;
            return;
        }
        this.exit();
    }

    private cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.exit();
    }

    override onExiting(): number {
        this.cancelled = true;
        // A prepared Player that never got pushed is ours to dispose.
        if (this.player && !this.pushed) this.player.destroy();
        this.player = null;
        // Shared by every retry; gone with this screen.
        const skin = this.beatmapSkin;
        this.beatmapSkin = null;
        if (skin) setTimeout(() => skin.destroy(), 1000);
        this.game.background.releaseParallax(this);
        this.handBackTrack();
        this.contentOut();
        this.fadeOut(CONTENT_OUT);
        return CONTENT_OUT;
    }

    /** Return the song to the menu music (it keeps playing from where gameplay left it). */
    private handBackTrack(): void {
        const track = this.track;
        this.track = null;
        if (!track) {
            this.game.music.reclaim(null, null);
            return;
        }
        // A failed play (or a cancelled load) left the song faded out.
        if (track.volume < 1) {
            track.pause();
            track.volume = 1;
        }
        this.game.music.reclaim(track, this.selection.set.key);
    }

    override onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back') {
            this.game.uiSounds.back();
            this.cancel();
            return true;
        }
        return false;
    }
}

interface GroupDef {
    title: string;
    rows: UIComponent[];
}

const HEADER_H = 30;
const ROW_SPACING = 15;
const GROUP_SPACING = 20;

/**
 * lazer's player settings (PlayerSettingsGroup / SettingsToolboxGroup):
 * Visual, Audio and Input groups, each a translucent rounded panel with a
 * bold header. Hovering or dragging in here holds gameplay back.
 */
class SettingsPanel extends UIComponent {
    private readonly groups: { def: GroupDef; bg: Graphics; header: Text }[] = [];
    private readonly sliders: Slider[] = [];
    private readonly disableMouse = new Bindable(false);

    constructor(loader: PlayerLoaderScreen) {
        super();
        const s = loader.game.settings;
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const slider = (caption: string, b: typeof s.backgroundDim, format: (v: number) => string) => {
            const sl = new Slider(caption, b, { format });
            this.sliders.push(sl);
            return sl;
        };
        // "Disable mouse buttons" is the inverse of the mouseButtons setting.
        this.disableMouse.value = !s.mouseButtons.value;
        this.disposer.add(this.disableMouse.bind(v => (s.mouseButtons.value = !v)));
        this.disposer.add(s.mouseButtons.bind(v => (this.disableMouse.value = !v)));
        const defs: GroupDef[] = [
            {
                title: 'Visual settings',
                rows: [
                    slider('Background dim', s.backgroundDim, pct),
                    slider('Background blur', s.backgroundBlur, pct),
                    new Checkbox('Storyboard', s.storyboard),
                    new Checkbox('Beatmap skins', s.beatmapSkin),
                    new Checkbox('Background video', s.backgroundVideo),
                    new Checkbox('Kiai flashes on hit objects', s.kiaiFlash),
                ],
            },
            {
                title: 'Audio settings',
                rows: [
                    new Checkbox('Beatmap hitsounds', s.beatmapHitsounds),
                    slider('Audio offset', s.audioOffset, v => `${v > 0 ? '+' : ''}${Math.round(v)} ms`),
                ],
            },
            {
                title: 'Input settings',
                rows: [new Checkbox('Disable mouse buttons', this.disableMouse)],
            },
        ];
        for (const def of defs) {
            const bg = new Graphics();
            const header = label(def.title, { size: 17, weight: '700' });
            this.addChild(bg, header, ...def.rows);
            this.groups.push({ def, bg, header });
        }
        this.eventMode = 'static';
        this.hitArea = new Rectangle(0, 0, PANEL_W, 300);
    }

    get preferredHeight(): number {
        let h = 0;
        for (const { def } of this.groups) {
            h += HEADER_H + 5 + def.rows.reduce((a, r) => a + r.h, 0) + ROW_SPACING * (def.rows.length - 1) + 10;
        }
        return h + GROUP_SPACING * (this.groups.length - 1);
    }

    get dragging(): boolean {
        return this.sliders.some(sl => sl.pressed);
    }

    isPointerOver(p: { x: number; y: number }): boolean {
        const g = this.getGlobalPosition();
        const scale = this.worldTransform.a || 1;
        const lx = (p.x * (this.parent?.worldTransform.a ?? 1) - g.x) / scale;
        const ly = (p.y * (this.parent?.worldTransform.d ?? 1) - g.y) / scale;
        return lx >= 0 && ly >= 0 && lx <= this._w && ly <= this._h;
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        let y = 0;
        for (const { def, bg, header } of this.groups) {
            const top = y;
            header.position.set(10, y + (HEADER_H - header.height) / 2);
            y += HEADER_H + 5;
            def.rows.forEach((r, i) => {
                r.resize(w - 20, r.h);
                r.position.set(10, y);
                y += r.h + (i < def.rows.length - 1 ? ROW_SPACING : 0);
            });
            y += 10;
            bg.clear()
                .roundRect(0, top, w, y - top, 5).fill({ color: colours.background5, alpha: 0.75 })
                .roundRect(0, top, w, HEADER_H, 5).fill({ color: 0x000000, alpha: 0.15 });
            y += GROUP_SPACING;
        }
    }
}
