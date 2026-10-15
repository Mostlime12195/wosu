import { Container, Graphics, Rectangle, type BitmapText, type FederatedPointerEvent, type Text } from 'pixi.js';
import { Bindable, BindableNumber } from '../../core/Bindable';
import { clamp, damp, formatTime } from '../../core/math';
import {
    formatReplaySpeed, REPLAY_SPEED_DEFAULT, REPLAY_SPEED_MAX, REPLAY_SPEED_MIN, REPLAY_SPEED_STEP, seekFraction, seekTimeAt,
} from '../../gameplay/replay/playbackSpeed';
import type { GameSettings, HudVisibility } from '../../settings/Settings';
import { IconButton } from '../../ui/Button';
import { icon } from '../../ui/icons';
import { Checkbox } from '../../ui/Checkbox';
import { Slider } from '../../ui/Slider';
import { counterText, label } from '../../ui/text';
import { ColorProvider, Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { ui } from '../../ui/UIContext';

/** lazer's SettingsToolboxGroup.CONTAINER_WIDTH, as in the loader. */
const PANEL_W = 270;
const PAD = 10;
const MARGIN = 20;
const HEADER_H = 30;
const ROW_SPACING = 12;
const GROUP_SPACING = 14;
/** The panel slides in when the pointer reaches this close to the right edge... */
const REVEAL_EDGE = 24;
/** ...and stays while the pointer is over it (or this close to it). */
const KEEP_MARGIN = 40;
const TAB_W = 26;
const TAB_H = 64;
const colours = new ColorProvider('purple');

/** What the panel shows each frame. */
export interface ReplayPlaybackState {
    time: number;
    /** The seekable range (song time). */
    start: number;
    end: number;
    paused: boolean;
    pointer: { x: number; y: number };
}

/**
 * lazer's song progress seek bar, in the playback group: the played part
 * filled, a nub at the playhead; click or drag to seek (the preview
 * follows the drag, the seek happens on release).
 */
class ReplaySeekBar extends UIComponent {
    private readonly g = new Graphics();
    private progress = 0;
    private dragging = false;
    onSeek: ((fraction: number) => void) | null = null;
    /** The fraction being dragged to (null when not dragging). */
    preview: number | null = null;

    constructor() {
        super();
        this.addChild(this.g);
        this.makeInteractive({ sounds: false });
        this.cursor = 'pointer';
        this.on('pointerdown', this.onDown, this);
        this.resize(PANEL_W - PAD * 2, 18);
    }

    set value(v: number) {
        if (this.dragging) return;
        v = clamp(Number.isFinite(v) ? v : 0, 0, 1);
        if (Math.abs(v - this.progress) < 1e-4) return;
        this.progress = v;
        this.draw();
    }

    protected override onResize(): void {
        this.draw();
    }

    protected override onHoverChange(): void {
        this.draw();
    }

    private draw(): void {
        const w = this._w, h = this._h;
        const t = this.hovered || this.dragging ? 6 : 4;
        const y = h / 2;
        const x = this.progress * w;
        this.g.clear()
            .roundRect(0, y - t / 2, w, t, t / 2).fill({ color: 0xffffff, alpha: 0.2 })
            .roundRect(0, y - t / 2, Math.max(t, x), t, t / 2).fill(colours.highlight1)
            .circle(x, y, this.hovered || this.dragging ? 7 : 5).fill(0xffffff);
    }

    private fractionAt(e: FederatedPointerEvent): number {
        return clamp(this.toLocal(e.global).x / Math.max(1, this._w), 0, 1);
    }

    private onDown(e: FederatedPointerEvent): void {
        if (e.button > 0) return;
        this.dragging = true;
        const move = (ev: FederatedPointerEvent) => {
            this.preview = this.fractionAt(ev);
            this.progress = this.preview;
            this.draw();
        };
        move(e);
        this.on('globalpointermove', move);
        const up = () => {
            this.off('globalpointermove', move);
            this.off('pointerup', up);
            this.off('pointerupoutside', up);
            const f = this.preview;
            this.dragging = false;
            this.preview = null;
            this.draw();
            if (f !== null) this.onSeek?.(f);
        };
        this.on('pointerup', up);
        this.on('pointerupoutside', up);
    }

    get isDragging(): boolean {
        return this.dragging;
    }
}

/** The tab on the right edge that opens the panel while it is hidden. */
class SettingsTab extends UIComponent {
    private readonly bg = new Graphics();
    private readonly glyph = icon('sliders', 13, 0xffffff);

    constructor() {
        super();
        this.addChild(this.bg, this.glyph);
        this.makeInteractive({ sounds: 'button' });
        this.resize(TAB_W + 8, TAB_H);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().roundRect(0, 0, w, h, 6).fill({ color: colours.background5, alpha: this.hovered ? 0.95 : 0.8 });
        this.glyph.position.set(TAB_W / 2 + 1, h / 2);
    }

    protected override onHoverChange(): void {
        this.relayout();
    }
}

interface Group {
    title: string;
    rows: UIComponent[];
    bg: Graphics;
    header: Text;
}

/**
 * lazer's ReplayPlayer settings (PlayerSettingsOverlay with its Playback
 * group): a column of panels on the right edge with the seek bar, pause /
 * seek buttons and the playback speed, plus quick visibility toggles. It
 * slides in when the pointer reaches the right edge and stays while the
 * pointer is over it, or stays open when pinned (the tab, its close button
 * or the toggle key).
 */
export class ReplaySettingsOverlay extends UIComponent {
    /** The viewer's playback speed (lazer: 0.25x–2x, tempo only). */
    readonly speed = new BindableNumber(REPLAY_SPEED_DEFAULT, REPLAY_SPEED_MIN, REPLAY_SPEED_MAX, REPLAY_SPEED_STEP);
    /** Kept open regardless of the pointer. */
    readonly pinned = new Bindable(false);
    onTogglePause: (() => void) | null = null;
    onSeek: ((time: number) => void) | null = null;
    onSeekBy: ((delta: number) => void) | null = null;

    private readonly panel = new Container();
    private readonly groups: Group[] = [];
    private readonly seekBar = new ReplaySeekBar();
    private readonly timeText: BitmapText;
    private readonly lengthText: BitmapText;
    private readonly back = new IconButton('anglesLeft', { size: 36, circle: true });
    private readonly playPause = new IconButton('pause', { size: 44, circle: true, iconSize: 20 });
    private readonly forward = new IconButton('anglesRight', { size: 36, circle: true });
    private readonly closeButton = new IconButton('close', { size: 24, circle: true, iconSize: 12 });
    private readonly transport = new UIComponent();
    private readonly speedSlider: Slider;
    private readonly sliders: Slider[] = [];
    private readonly tab = new SettingsTab();
    private readonly hudShown = new Bindable(true);
    private reveal = 0;
    private panelH = 0;
    private range = { start: 0, end: 1 };
    private shownPaused: boolean | null = null;

    constructor(settings: GameSettings, seekStep: number, toggleHint: string) {
        super();
        this.timeText = counterText('0:00', { size: 12 });
        this.lengthText = counterText('0:00', { size: 12, color: Colors.grayA });
        this.lengthText.anchor.set(1, 0);
        this.seekBar.onSeek = f => this.onSeek?.(seekTimeAt(f, this.range.start, this.range.end));
        const secs = Math.round(seekStep / 1000);
        this.back.tooltip = `Seek back ${secs}s`;
        this.forward.tooltip = `Seek forward ${secs}s`;
        this.playPause.tooltip = 'Pause / resume';
        this.back.onActivate = () => this.onSeekBy?.(-seekStep);
        this.forward.onActivate = () => this.onSeekBy?.(seekStep);
        this.playPause.onActivate = () => this.onTogglePause?.();
        this.transport.addChild(this.back, this.playPause, this.forward, this.timeText, this.lengthText, this.seekBar);
        this.transport.resize(PANEL_W - PAD * 2, 92);
        this.layoutTransport();
        this.speedSlider = this.slider('Playback speed', this.speed, formatReplaySpeed);
        // "Show HUD" maps onto lazer's HUD visibility mode (off = Never).
        const hud = settings.hudVisibility;
        this.disposer.add(hud.bind(v => (this.hudShown.value = v !== 'never'), true));
        this.disposer.add(this.hudShown.bind(on => {
            if (on !== (hud.value !== 'never')) hud.value = (on ? 'always' : 'never') satisfies HudVisibility;
        }));
        this.addGroup('Playback', [this.transport, this.speedSlider]);
        this.addGroup('Visibility', [
            new Checkbox('Show HUD', this.hudShown),
            new Checkbox('Show leaderboard', settings.gameplayLeaderboard),
            new Checkbox('Cursor trail', settings.cursorTrail),
            this.slider('Background dim', settings.backgroundDim, v => `${Math.round(v * 100)}%`),
        ]);
        this.closeButton.tooltip = `Hide (${toggleHint})`;
        this.closeButton.onActivate = () => (this.pinned.value = false);
        this.panel.addChild(this.closeButton);
        this.layoutPanel();

        // The tab on the right edge opens (pins) the panel.
        this.tab.tooltip = `Replay settings (${toggleHint})`;
        this.tab.onActivate = () => (this.pinned.value = true);

        this.addChild(this.tab, this.panel);
        this.eventMode = 'passive';
        this.disposer.add(this.pinned.bind(() => (this.closeButton.visible = this.pinned.value), true));
    }

    private slider(caption: string, b: BindableNumber, format: (v: number) => string): Slider {
        const sl = new Slider(caption, b, { format, accent: colours.highlight1 });
        this.sliders.push(sl);
        return sl;
    }

    private addGroup(title: string, rows: UIComponent[]): void {
        const bg = new Graphics();
        const header = label(title, { size: 17, weight: '700' });
        this.panel.addChild(bg, header, ...rows);
        this.groups.push({ title, rows, bg, header });
    }

    private layoutTransport(): void {
        const w = this.transport.w;
        this.timeText.position.set(0, 0);
        this.lengthText.position.set(w, 0);
        this.seekBar.resize(w, 18);
        this.seekBar.position.set(0, 16);
        const cy = 40 + 22;
        this.playPause.position.set(w / 2 - 22, cy - 22);
        this.back.position.set(w / 2 - 22 - 16 - 36, cy - 18);
        this.forward.position.set(w / 2 + 22 + 16, cy - 18);
    }

    private layoutPanel(): void {
        let y = 0;
        const w = PANEL_W;
        for (const g of this.groups) {
            const top = y;
            g.header.position.set(PAD, y + (HEADER_H - g.header.height) / 2);
            y += HEADER_H + 5;
            g.rows.forEach((r, i) => {
                r.resize(w - PAD * 2, r.h);
                r.position.set(PAD, y);
                y += r.h + (i < g.rows.length - 1 ? ROW_SPACING : 0);
            });
            y += 10;
            g.bg.clear()
                .roundRect(0, top, w, y - top, 5).fill({ color: colours.background5, alpha: 0.85 })
                .roundRect(0, top, w, HEADER_H, 5).fill({ color: 0x000000, alpha: 0.15 });
            y += GROUP_SPACING;
        }
        this.panelH = y - GROUP_SPACING;
        this.closeButton.position.set(w - 24 - 4, (HEADER_H - 24) / 2);
        this.panel.hitArea = new Rectangle(0, 0, w, this.panelH);
        this.panel.eventMode = 'static';
    }

    /** Toggle the pinned state (the key binding). */
    toggle(): void {
        this.pinned.value = !this.pinned.value;
    }

    /** The panel is (at least partly) on screen. */
    get open(): boolean {
        return this.reveal > 0.01;
    }

    /** Something in the panel is being dragged (keep it shown). */
    private get busy(): boolean {
        return this.seekBar.isDragging || this.sliders.some(s => s.pressed);
    }

    protected override onResize(): void {
        this.place();
    }

    private place(): void {
        const w = this._w, h = this._h;
        const top = clamp(h / 2 - this.panelH / 2, 90, Math.max(90, h - this.panelH - 140));
        this.panel.position.set(w - (PANEL_W + MARGIN) * this.reveal, top);
        this.panel.alpha = this.reveal;
        this.panel.visible = this.reveal > 0.01;
        this.tab.position.set(w - (TAB_W + 2) * (1 - this.reveal), top + 8);
        this.tab.alpha = 1 - this.reveal;
        this.tab.visible = this.reveal < 0.99;
    }

    update(dt: number, s: ReplayPlaybackState): void {
        const p = s.pointer;
        const atEdge = p.x >= this._w - REVEAL_EDGE && p.x <= this._w + 1;
        const overPanel = this.reveal > 0.5 && p.x >= this.panel.x - KEEP_MARGIN &&
            p.y >= this.panel.y - KEEP_MARGIN && p.y <= this.panel.y + this.panelH + KEEP_MARGIN;
        const want = this.pinned.value || atEdge || overPanel || this.busy;
        const target = want ? 1 : 0;
        // Out quickly, back a little slower (lazer's 300 ms OutQuint-ish slide).
        this.reveal = damp(this.reveal, target, want ? 50 : 90, dt);
        if (Math.abs(this.reveal - target) < 0.002) this.reveal = target;
        this.place();
        if (!this.panel.visible) return;
        this.range = { start: s.start, end: s.end };
        const preview = this.seekBar.preview;
        const time = preview !== null ? seekTimeAt(preview, s.start, s.end) : s.time;
        this.seekBar.value = seekFraction(s.time, s.start, s.end);
        this.timeText.text = formatTime(Math.max(0, time));
        this.lengthText.text = formatTime(Math.max(0, s.end));
        if (s.paused !== this.shownPaused) {
            this.shownPaused = s.paused;
            this.playPause.setIcon(s.paused ? 'play' : 'pause');
            this.playPause.tooltip = s.paused ? 'Resume' : 'Pause';
        }
    }

    override destroy(): void {
        ui().tooltips.hide(this.tab);
        super.destroy({ children: true });
    }
}
