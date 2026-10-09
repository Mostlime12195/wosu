import { Graphics, type Text } from 'pixi.js';
import { lerpColor } from '../../core/math';
import { tween } from '../../core/Tweener';
import { Box } from '../../ui/Box';
import { IconButton } from '../../ui/Button';
import { icon, Icons, type IconName } from '../../ui/icons';
import { label } from '../../ui/text';
import { Colors, type ColorProvider } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import type { Notification, NotificationManager } from './Notifications';

const TILE = 36;
const TEXT_X = 58;
const BAR_H = 4;

/** Accent colour by kind, following a progress task through its states. */
export function notificationColor(n: Notification): number {
    const s = n.state.value;
    if (s === 'failed') return Colors.red;
    if (s === 'cancelled') return Colors.gray6;
    switch (n.kind) {
        case 'success': return Colors.green;
        case 'warning': return Colors.yellowDark;
        case 'error': return Colors.red;
        case 'progress': return s === 'completed' ? Colors.green : Colors.blueDark;
        default: return Colors.purple;
    }
}

function notificationIcon(n: Notification): IconName {
    if (n.kind !== 'progress') return n.icon;
    switch (n.state.value) {
        case 'completed': return 'check';
        case 'failed': return 'error';
        case 'cancelled': return 'close';
        default: return n.icon;
    }
}

export function timeAgo(at: number, now = Date.now()): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

/**
 * One entry in the notification panel (lazer's Notification drawable):
 * coloured icon tile, title/body, relative time, a close button on hover
 * and, for running tasks, a progress bar with an always-visible cancel ×.
 * Finished entries with an action are clickable.
 */
export class NotificationItem extends UIComponent {
    private readonly bg: Box;
    private readonly tile = new Graphics();
    private readonly glyph: Text;
    private readonly titleText: Text | null;
    private readonly body: Text;
    private readonly time: Text;
    private readonly bar = new Graphics();
    private readonly closeButton: IconButton;
    private clock = 0;
    private timeClock = 0;
    /** Owner callback: height or section (running/finished) changed. */
    onLayoutChange: (() => void) | null = null;

    constructor(readonly n: Notification, private readonly manager: NotificationManager, private readonly colors: ColorProvider, width: number) {
        super();
        this.bg = new Box({ color: colors.background3, radius: 6 });
        this.glyph = icon(notificationIcon(n), 15, 0xffffff);
        const wrap = width - TEXT_X - 30;
        this.titleText = n.title ? label(n.title, { size: 13, weight: '700', wrap, lineHeight: 17 }) : null;
        this.body = label('', { size: 13, weight: '500', color: Colors.grayE, wrap, lineHeight: 17 });
        this.time = label('', { size: 11, weight: '600', color: colors.foreground1 });
        this.closeButton = new IconButton('close', { size: 24, iconSize: 11, circle: true });
        this.closeButton.alpha = 0;
        this.closeButton.onActivate = () => this.dismiss();
        // Don't let the close click also activate the item.
        this.closeButton.on('pointertap', e => e.stopPropagation());
        this.addChild(this.bg, this.tile, this.glyph, this.body, this.time, this.bar, this.closeButton);
        if (this.titleText) this.addChild(this.titleText);
        this.makeInteractive({ sounds: false });
        this.updateTime();

        this.disposer.add(n.text.bind(v => {
            this.body.text = v;
            this.measure(width);
        }, true));
        this.disposer.add(n.progress.bind(() => this.drawBar()));
        this.disposer.add(n.state.bind(() => {
            this.glyph.text = Icons[notificationIcon(n)];
            // A task's title ("Downloading") only describes it while it runs.
            if (this.titleText) this.titleText.visible = n.kind !== 'progress' || this.running;
            this.closeButton.tooltip = this.running ? 'cancel' : null;
            this.syncHover();
            this.measure(width);
        }, true));
    }

    get running(): boolean {
        return this.n.kind === 'progress' && this.n.state.value === 'active';
    }

    private get clickable(): boolean {
        return !this.running && !!this.n.onClick;
    }

    private measure(width: number): void {
        let h = 12;
        if (this.titleText?.visible) h += this.titleText.height;
        h += this.body.height + 2 + 15 + 10;
        if (this.running) h += BAR_H + 6;
        h = Math.max(TILE + 20, Math.ceil(h));
        if (h === this._h && width === this._w) {
            this.relayout();
            return;
        }
        this.resize(width, h);
        this.onLayoutChange?.();
    }

    protected override onResize(w: number, h: number): void {
        this.bg.resize(w, h);
        const color = notificationColor(this.n);
        this.tile.clear().roundRect(10, 10, TILE, TILE, 6).fill(color);
        this.glyph.position.set(10 + TILE / 2, 10 + TILE / 2);
        let y = 10;
        if (this.titleText?.visible) {
            this.titleText.position.set(TEXT_X, y);
            y += this.titleText.height;
        }
        this.body.position.set(TEXT_X, y);
        this.time.position.set(TEXT_X, y + this.body.height + 2);
        this.closeButton.position.set(w - 30, 6);
        this.drawBar();
    }

    private drawBar(): void {
        const g = this.bar.clear();
        if (!this.running) return;
        const x = TEXT_X, w = this._w - TEXT_X - 12, y = this._h - BAR_H - 8;
        g.roundRect(x, y, w, BAR_H, BAR_H / 2).fill({ color: 0xffffff, alpha: 0.12 });
        const p = this.n.progress.value;
        const color = notificationColor(this.n);
        if (Number.isFinite(p)) {
            g.roundRect(x, y, Math.max(BAR_H, w * Math.min(1, p)), BAR_H, BAR_H / 2).fill(color);
        } else {
            // Indeterminate: a sliding segment.
            const seg = 60;
            const t = (this.clock % 1200) / 1200;
            const sx = x - seg + t * (w + seg);
            const x0 = Math.max(x, sx), x1 = Math.min(x + w, sx + seg);
            if (x1 > x0) g.roundRect(x0, y, x1 - x0, BAR_H, BAR_H / 2).fill(color);
        }
    }

    tick(dt: number): void {
        this.clock += dt;
        if (this.running && !Number.isFinite(this.n.progress.value)) this.drawBar();
        this.timeClock += dt;
        if (this.timeClock > 15000) this.updateTime();
    }

    updateTime(): void {
        this.timeClock = 0;
        this.time.text = timeAgo(this.n.createdAt);
    }

    private dismiss(): void {
        if (this.running) this.n.cancel();
        else this.n.dismiss();
    }

    private syncHover(): void {
        const show = this.running || this.hovered;
        tween(this.closeButton, { alpha: show ? 1 : 0 }, { duration: 200 });
        this.closeButton.eventMode = show ? 'static' : 'none';
        this.cursor = this.clickable ? 'pointer' : 'default';
    }

    protected override onHoverChange(hovered: boolean): void {
        this.syncHover();
        const base = this.colors.background3;
        this.bg.color = hovered ? lerpColor(base, 0xffffff, this.clickable ? 0.1 : 0.04) : base;
    }

    protected override onClick(): void {
        if (!this.clickable) return;
        this.manager.markRead(this.n);
        this.n.onClick?.();
        // lazer: activating a notification closes it.
        this.n.dismiss();
    }
}
