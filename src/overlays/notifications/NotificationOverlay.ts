import { Container, Graphics, Rectangle, Sprite, type BitmapText, type Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { tween } from '../../core/Tweener';
import { icon } from '../../ui/icons';
import { onPointerDownOutside } from '../../ui/outsideClick';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { counterText, label } from '../../ui/text';
import { ColorProvider, Colors } from '../../ui/theme';
import { UIComponent, tweenTint } from '../../ui/UIComponent';
import { NotificationItem } from './NotificationItem';
import type { Notification } from './Notifications';

const WIDTH = 320;
const PAD = 10;
const ITEM_GAP = 6;
const colors = new ColorProvider('purple');

/** Small text action at the right of a section header ("clear all"). */
class TextAction extends UIComponent {
    private readonly text: Text;

    constructor(caption: string) {
        super();
        this.text = label(caption, { size: 12, weight: '700' });
        this.text.tint = colors.light3;
        this.addChild(this.text);
        this.makeInteractive();
        this.resize(this.text.width + 8, 22);
        this.cursor = 'pointer';
    }

    protected override onResize(w: number, h: number): void {
        this.text.position.set(w - this.text.width, (h - this.text.height) / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        tweenTint(this.text, hovered ? 0xffffff : colors.light3, 150);
    }
}

/** lazer's NotificationSection header: TITLE, count, action. */
class SectionHeader extends Container {
    private readonly title: Text;
    private readonly count: BitmapText;
    readonly action: TextAction;

    constructor(title: string, actionText: string) {
        super();
        this.title = label(title.toUpperCase(), { size: 13, weight: '800', letterSpacing: 1 });
        this.count = counterText('0', { size: 13, color: Colors.yellow });
        this.action = new TextAction(actionText);
        this.addChild(this.title, this.count, this.action);
    }

    set n(v: number) {
        this.count.text = String(v);
    }

    layout(w: number): void {
        this.title.position.set(0, 4);
        this.count.position.set(this.title.width + 8, 5);
        this.action.position.set(w - this.action.w, 0);
    }
}

/**
 * osu!lazer's notification panel: a column on the right under the
 * toolbar with "running tasks" (progress bars, cancel) above the
 * finished notifications. Opening it marks everything read; it doesn't
 * dim the screen and closes on Esc or a click anywhere else.
 */
export class NotificationOverlay extends Overlay {
    override readonly exclusive = false;
    protected override readonly modal = false;
    private readonly panel = new Container();
    private readonly bg = new Graphics();
    private readonly edge: Sprite;
    private readonly scroll = new ScrollContainer();
    private readonly runningHeader = new SectionHeader('running tasks', 'cancel all');
    private readonly doneHeader = new SectionHeader('notifications', 'clear all');
    private readonly empty = new Container();
    private readonly items = new Map<Notification, NotificationItem>();
    private layoutQueued = true;
    private outsideOff: (() => void) | null = null;

    constructor(game: Game) {
        super(game);
        this.edge = new Sprite(game.skin.tex('fadeRight'));
        this.edge.tint = 0x000000;
        this.edge.alpha = 0.35;
        this.panel.addChild(this.edge, this.bg, this.scroll);
        this.panel.eventMode = 'static';
        this.addChild(this.panel);

        const bell = icon('bell', 30, colors.light4);
        const caption = label('no notifications', { size: 14, weight: '600', color: colors.light4 });
        bell.position.set(WIDTH / 2, 0);
        caption.anchor.set(0.5, 0);
        caption.position.set(WIDTH / 2, 28);
        this.empty.addChild(bell, caption);
        this.scroll.content.addChild(this.runningHeader, this.doneHeader, this.empty);
        this.runningHeader.action.onActivate = () => game.notifications.cancelAll();
        this.doneHeader.action.onActivate = () => game.notifications.clearCompleted();

        const m = game.notifications;
        for (const n of m.list) this.add(n);
        m.posted.add(n => this.add(n));
        m.removed.add(n => this.remove(n));

        this.state.bind(open => {
            m.panelOpen.value = open;
            this.outsideOff?.();
            this.outsideOff = null;
            if (!open) return;
            m.markAllRead();
            for (const item of this.items.values()) item.updateTime();
            this.outsideOff = onPointerDownOutside(
                game.app.canvas,
                () => [this.panel, game.toolbar.notificationButton],
                () => this.hide(),
            );
        });
    }

    private add(n: Notification): void {
        if (this.items.has(n)) return;
        const item = new NotificationItem(n, this.game.notifications, colors, WIDTH - PAD * 2);
        item.onLayoutChange = () => (this.layoutQueued = true);
        this.items.set(n, item);
        this.scroll.content.addChild(item);
        this.layoutQueued = true;
        if (this.isOpen) {
            item.alpha = 0;
            item.fadeIn(300);
        }
    }

    private remove(n: Notification): void {
        const item = this.items.get(n);
        if (!item) return;
        this.items.delete(n);
        item.destroy();
        this.layoutQueued = true;
    }

    private layoutList(): void {
        const list = this.game.notifications.list;
        const running = list.filter(n => this.items.get(n)?.running);
        const done = list.filter(n => this.items.has(n) && !this.items.get(n)!.running);
        let y = 12;
        const section = (header: SectionHeader, entries: Notification[]) => {
            header.visible = entries.length > 0;
            if (!entries.length) return;
            header.n = entries.length;
            header.layout(WIDTH - PAD * 2);
            header.position.set(PAD, y);
            y += 32;
            for (const n of entries) {
                const item = this.items.get(n)!;
                item.position.set(PAD, y);
                y += item.h + ITEM_GAP;
            }
            y += 14;
        };
        section(this.runningHeader, running);
        section(this.doneHeader, done);
        this.empty.visible = !running.length && !done.length;
        this.empty.position.set(0, 60);
        this.scroll.contentHeight = this.empty.visible ? 120 : y;
    }

    override update(dt: number): void {
        if (this.layoutQueued) {
            this.layoutQueued = false;
            this.layoutList();
        }
        for (const item of this.items.values()) if (item.y + item.h >= this.scroll.scrollY && item.y <= this.scroll.scrollY + this.scroll.h) item.tick(dt);
    }

    protected popIn(): void {
        this.relayout();
        this.layoutList();
        this.panel.pivot.x = -WIDTH - 20;
        tween(this.panel, { pivotX: 0 }, { duration: 600, ease: 'OutQuint' });
    }

    protected async popOut(): Promise<void> {
        await tween(this.panel, { pivotX: -WIDTH - 20 }, { duration: 400, ease: 'OutQuint' }).finished;
    }

    protected layout(w: number, h: number): void {
        const top = this.game.toolbarOffset;
        const ph = Math.max(0, h - top);
        this.panel.position.set(w - WIDTH, top);
        this.panel.hitArea = new Rectangle(0, 0, WIDTH, ph);
        this.bg.clear().rect(0, 0, WIDTH, ph).fill(colors.background4);
        // Soft shadow cast to the left.
        this.edge.scale.set(-24 / this.edge.texture.width, ph / this.edge.texture.height);
        this.edge.position.set(0, 0);
        this.scroll.resize(WIDTH, ph);
        this.layoutQueued = true;
    }
}
