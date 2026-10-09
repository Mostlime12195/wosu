import { Container, Graphics, type Text } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { Box } from '../../ui/Box';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';
import type { Notification, NotificationManager } from './Notifications';

const WIDTH = 320;
const GAP = 8;

function kindColor(n: Notification): number {
    if (n.state.value === 'failed') return Colors.red;
    switch (n.kind) {
        case 'success': return Colors.green;
        case 'warning': return Colors.yellow;
        case 'error': return Colors.red;
        case 'progress': return Colors.blue;
        default: return Colors.purple;
    }
}

/** One toast card: icon tile, text, optional progress bar. */
class Toast extends UIComponent {
    private readonly bg = new Box({ color: 0x1c1c22, alpha: 0.96, radius: 6 });
    private readonly tile = new Graphics();
    private readonly glyph: Text;
    private readonly body: Text;
    private readonly bar = new Graphics();
    private lifetime = 0;
    private expiresAt = Infinity;
    closing = false;
    targetY = 0;
    /** Owner callback: the height changed (text or state), so restack. */
    onHeightChange: (() => void) | null = null;

    constructor(readonly n: Notification, private readonly manager: NotificationManager, private readonly onClose: (t: Toast) => void) {
        super();
        this.glyph = icon(n.icon, 18, 0xffffff);
        this.body = label('', { size: 13, weight: '500', wrap: WIDTH - 70, lineHeight: 17 });
        this.addChild(this.bg, this.tile, this.glyph, this.body, this.bar);
        this.makeInteractive({ sounds: false });
        this.disposer.add(n.text.bind(() => this.layout(), true));
        this.disposer.add(n.progress.bind(() => this.drawBar()));
        this.disposer.add(n.state.bind(s => {
            this.layout();
            if (s !== 'active') this.expiresAt = this.lifetime + (s === 'failed' ? 6000 : 3500);
        }));
        this.disposer.add(n.dismissed.add(() => this.close()));
        if (n.state.value !== 'active') this.expiresAt = n.duration;
        this.onFrame(dt => this.tick(dt));
    }

    private layout(): void {
        // A task's title ("Downloading") only describes it while it runs.
        const titled = this.n.title && (this.n.kind !== 'progress' || this.n.state.value === 'active');
        const title = titled ? `${this.n.title}\n` : '';
        this.body.text = title + this.n.text.value;
        const h = Math.max(56, this.body.height + 22 + (this.n.kind === 'progress' ? 6 : 0));
        const changed = h !== this._h;
        this.resize(WIDTH, h);
        if (changed) this.onHeightChange?.();
    }

    protected override onResize(w: number, h: number): void {
        this.bg.resize(w, h);
        this.tile.clear().roundRect(0, 0, 48, h, 6).fill(kindColor(this.n));
        this.tile.rect(42, 0, 6, h).fill(kindColor(this.n));
        this.glyph.position.set(24, h / 2);
        this.body.position.set(60, (h - this.body.height) / 2 - (this.n.kind === 'progress' ? 3 : 0));
        this.drawBar();
    }

    private drawBar(): void {
        this.bar.clear();
        if (this.n.kind !== 'progress') return;
        const p = this.n.progress.value;
        const w = WIDTH - 60 - 12;
        const y = this._h - 10;
        this.bar.roundRect(60, y, w, 4, 2).fill({ color: 0xffffff, alpha: 0.15 });
        if (Number.isFinite(p)) {
            this.bar.roundRect(60, y, Math.max(4, w * Math.min(1, p)), 4, 2).fill(kindColor(this.n));
        } else {
            // Indeterminate: a sliding segment.
            const t = (this.lifetime % 1200) / 1200;
            const sx = 60 + t * (w + 60) - 60;
            const x0 = Math.max(60, sx), x1 = Math.min(60 + w, sx + 60);
            if (x1 > x0) this.bar.roundRect(x0, y, x1 - x0, 4, 2).fill(kindColor(this.n));
        }
    }

    private tick(dt: number): void {
        this.lifetime += dt;
        if (this.n.kind === 'progress' && !Number.isFinite(this.n.progress.value) && this.n.state.value === 'active') this.drawBar();
        if (!this.hovered && this.lifetime > this.expiresAt) this.close();
        this.y += (this.targetY - this.y) * Math.min(1, dt / 80);
    }

    protected override onClick(): void {
        this.n.onClick?.();
        this.manager.markRead(this.n);
        this.close();
    }

    close(): void {
        if (this.closing) return;
        this.closing = true;
        tween(this, { x: WIDTH + 40, alpha: 0 }, { duration: 300, ease: 'InQuad' }).finished.then(() => {
            this.onClose(this);
            this.destroy();
        });
    }
}

/** Stack of toasts at the top-right, under the toolbar. */
export class ToastTray extends Container {
    private readonly toasts: Toast[] = [];
    topOffset = 48;
    /** True while toasts must stay hidden (gameplay, like lazer); they still land in the panel. */
    suppressed: () => boolean = () => false;
    private viewportW = 0;

    constructor(private readonly manager: NotificationManager) {
        super();
        manager.posted.add(n => {
            // With the panel open, notifications go straight into it.
            if (n.silent || manager.panelOpen.value || this.suppressed()) return;
            this.add(n);
        });
        manager.panelOpen.bind(open => {
            if (open) for (const t of this.toasts) t.close();
        });
    }

    private add(n: Notification): void {
        if (n.kind === 'error') uiSounds()?.error();
        else uiSounds()?.notify();
        const t = new Toast(n, this.manager, x => this.removeToast(x));
        t.onHeightChange = () => this.restack(false);
        t.x = WIDTH + 40;
        t.alpha = 0;
        this.toasts.unshift(t);
        this.addChild(t);
        tween(t, { x: 0, alpha: 1 }, { duration: 500, ease: 'OutQuint' });
        while (this.toasts.filter(x => !x.closing).length > 4) {
            const victim = [...this.toasts].reverse().find(x => !x.closing && x.n.state.value !== 'active');
            if (!victim) break;
            victim.close();
        }
        this.restack(true);
    }

    private removeToast(t: Toast): void {
        const i = this.toasts.indexOf(t);
        if (i !== -1) this.toasts.splice(i, 1);
        this.restack(false);
    }

    private restack(snapNew: boolean): void {
        let y = 0;
        for (const t of this.toasts) {
            if (snapNew && t === this.toasts[0]) t.y = y;
            t.targetY = y;
            if (!t.closing) y += t.h + GAP;
        }
    }

    layout(width: number): void {
        this.viewportW = width;
        this.position.set(this.viewportW - WIDTH - 10, this.topOffset);
    }
}
