import { Container, Graphics, Sprite, type BitmapText, type Text } from 'pixi.js';
import { Bindable } from '../core/Bindable';
import { formatTime } from '../core/math';
import { tween } from '../core/Tweener';
import type { Game } from '../app/Game';
import { icon, type IconName } from '../ui/icons';
import { drawRulesetIcon } from '../ui/RulesetIcon';
import { counterText, label, fitText } from '../ui/text';
import { Colors, Metrics } from '../ui/theme';
import { UIComponent } from '../ui/UIComponent';

/** One toolbar slot: icon (+ optional caption), hover wash, active bar. */
class ToolbarButton extends UIComponent {
    private readonly hoverBg = new Graphics();
    private readonly activeBar = new Graphics();
    protected readonly glyph: Text;
    protected readonly caption: Text | null;

    constructor(iconName: IconName, tooltip: string, captionText: string | null = null, active?: Bindable<boolean>) {
        super();
        this.hoverBg.alpha = 0;
        this.activeBar.alpha = 0;
        this.glyph = icon(iconName, 17, 0xffffff);
        this.caption = captionText !== null ? label(captionText, { size: 14, weight: '600' }) : null;
        this.addChild(this.hoverBg, this.activeBar, this.glyph);
        if (this.caption) {
            this.caption.anchor.set(0, 0.5);
            this.addChild(this.caption);
        }
        this.tooltip = tooltip;
        this.makeInteractive({ sounds: 'toolbar' });
        if (active) this.disposer.add(active.bind(v => tween(this.activeBar, { alpha: v ? 1 : 0 }, { duration: 200 }), true));
        this.resize(this.caption ? 48 + this.caption.width : Metrics.toolbarHeight + 4, Metrics.toolbarHeight);
    }

    protected override onResize(w: number, h: number): void {
        this.hoverBg.clear().rect(0, 0, w, h).fill(0xffffff);
        this.activeBar.clear().rect(4, h - 3, w - 8, 3).fill(Colors.pink);
        if (this.caption) {
            this.glyph.position.set(22, h / 2);
            this.caption.position.set(38, h / 2);
        } else {
            this.glyph.position.set(w / 2, h / 2);
        }
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this.hoverBg, { alpha: hovered ? 0.1 : 0 }, { duration: hovered ? 100 : 400 });
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.glyph, { scale: pressed ? 0.85 : 1 }, { duration: pressed ? 150 : 600, ease: pressed ? 'OutQuint' : 'OutElastic' });
    }
}

/** Notification bell with an unread-count badge. */
class NotificationButton extends ToolbarButton {
    private readonly badge = new Graphics();
    private readonly count: BitmapText;

    constructor(game: Game) {
        super('bell', 'notifications (Ctrl+N)', null, game.notificationOverlay.state);
        this.count = counterText('', { size: 10 });
        this.count.anchor.set(0.5);
        this.addChild(this.badge, this.count);
        this.onActivate = () => game.notificationOverlay.toggle();
        this.disposer.add(game.notifications.unread.bind(n => {
            this.count.text = n > 99 ? '99+' : String(n);
            const show = n > 0;
            this.badge.visible = this.count.visible = show;
            if (show) {
                this.badge.scale.set(1.4);
                tween(this.badge, { scale: 1 }, { duration: 500, ease: 'OutElastic' });
            }
            this.drawBadge();
        }, true));
    }

    private drawBadge(): void {
        // Runs from the base constructor's first resize, before fields exist.
        if (!this.count) return;
        const w = Math.max(16, this.count.width + 8);
        const x = this._w / 2 + 6, y = 9;
        this.badge.clear().roundRect(-w / 2, -8, w, 16, 8).fill(Colors.red);
        this.badge.position.set(x + w / 2 - 6, y);
        this.count.position.set(x + w / 2 - 6, y);
    }

    protected override onResize(w: number, h: number): void {
        super.onResize(w, h);
        this.drawBadge();
    }
}

/**
 * The ruleset selector (only osu!standard exists): lazer's ring-and-dot
 * glyph drawn as vector graphics, with the selection line underneath.
 */
class RulesetButton extends ToolbarButton {
    private readonly mark = new Graphics();

    constructor() {
        super('circle', 'osu!standard', null, new Bindable(true));
        this.glyph.visible = false;
        drawRulesetIcon(this.mark, 0, 0, 19);
        this.addChild(this.mark);
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        super.onResize(w, h);
        this.mark?.position.set(w / 2, h / 2);
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.mark, { scale: pressed ? 0.85 : 1 }, { duration: pressed ? 150 : 600, ease: pressed ? 'OutQuint' : 'OutElastic' });
    }
}

/** Digital clock with the running time underneath (lazer ToolbarClock). */
class ToolbarClock extends UIComponent {
    private readonly timeText: BitmapText;
    private readonly runningText: BitmapText;
    private accum = 1000;

    constructor(private readonly startedAt: number) {
        super();
        this.timeText = counterText('00:00:00', { size: 14 });
        this.runningText = counterText('', { size: 10, light: true, color: Colors.grayA });
        this.addChild(this.timeText, this.runningText);
        this.resize(80, Metrics.toolbarHeight);
        this.onFrame(dt => this.tick(dt));
    }

    protected override onResize(_w: number, _h: number): void {
        this.timeText.position.set(8, 5);
        this.runningText.position.set(8, 22);
    }

    private tick(dt: number): void {
        this.accum += dt;
        if (this.accum < 500) return;
        this.accum = 0;
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, '0');
        this.timeText.text = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        this.runningText.text = `running ${formatTime(Date.now() - this.startedAt)}`;
    }
}

/** Guest user chip. */
class UserButton extends ToolbarButton {
    private readonly avatar = new Container();

    constructor(game: Game) {
        super('user', 'your profile', game.settings.playerName.value);
        this.glyph.visible = false;
        const disc = new Graphics().circle(0, 0, 13).fill(Colors.gray4);
        const head = icon('user', 13, Colors.grayC);
        this.avatar.addChild(disc, head);
        this.addChildAt(this.avatar, 2);
        this.disposer.add(game.settings.playerName.bind(name => {
            if (this.caption) fitText(this.caption, 140, name || 'Guest');
            this.resize(48 + (this.caption?.width ?? 0) + 8, this._h);
        }));
        this.onActivate = () => game.settingsOverlay.show();
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        super.onResize(w, h);
        this.avatar?.position.set(22, h / 2);
    }
}

/**
 * osu!lazer's toolbar: settings/home and the ruleset on the left; beatmap
 * listing, now playing, notifications, user and clock on the right.
 * Slides out of view when the current screen hides it (gameplay).
 */
export class Toolbar extends UIComponent {
    private readonly bg = new Graphics();
    private readonly shadow: Sprite;
    private readonly left = new Container();
    private readonly right = new Container();
    private readonly leftButtons: UIComponent[] = [];
    private readonly rightButtons: UIComponent[] = [];
    /** Toggle buttons of the non-modal overlays (their "click outside" ignores these). */
    readonly musicButton: UIComponent;
    readonly notificationButton: UIComponent;

    constructor(game: Game) {
        super();
        this.shadow = new Sprite(game.skin.tex('fadeDown'));
        this.shadow.tint = 0x000000;
        this.shadow.alpha = 0.5;
        this.addChild(this.shadow, this.bg, this.left, this.right);
        this.eventMode = 'passive';

        const settings = new ToolbarButton('gear', 'settings (Ctrl+O)', null, game.settingsOverlay.state);
        settings.onActivate = () => game.settingsOverlay.toggle();
        const home = new ToolbarButton('home', 'home');
        home.onActivate = () => game.goHome();
        const mode = new RulesetButton();
        this.leftButtons.push(settings, home, mode);

        const listing = new ToolbarButton('download', 'beatmap listing (Ctrl+D)', null, game.listing.state);
        listing.onActivate = () => game.listing.toggle();
        const music = new ToolbarButton('music', 'now playing (F6)', null, game.nowPlaying.state);
        music.onActivate = () => game.nowPlaying.toggle();
        const notifications = new NotificationButton(game);
        const user = new UserButton(game);
        const clock = new ToolbarClock(game.startedAt);
        this.rightButtons.push(listing, music, notifications, user, clock);
        this.musicButton = music;
        this.notificationButton = notifications;

        for (const b of this.leftButtons) this.left.addChild(b);
        for (const b of this.rightButtons) this.right.addChild(b);

        game.toolbarVisible.bind(v => {
            tween(this, { y: v ? 0 : -Metrics.toolbarHeight - 10 }, { duration: 500, ease: 'OutQuint' });
            this.eventMode = v ? 'passive' : 'none';
        }, true);
        this.resize(1, Metrics.toolbarHeight);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.clear().rect(0, 0, w, h).fill(0x1a1a1f);
        this.shadow.position.set(0, h);
        this.shadow.width = w;
        this.shadow.height = 40;
        let x = 0;
        for (const b of this.leftButtons) {
            b.x = x;
            x += b.w;
        }
        let rx = w;
        for (let i = this.rightButtons.length - 1; i >= 0; i--) {
            const b = this.rightButtons[i];
            rx -= b.w;
            b.x = rx;
        }
    }

    update(_dt: number): void {
        // Buttons whose width depends on text (user chip) may change size.
        let total = 0;
        for (const b of this.rightButtons) total += b.w;
        if (total !== this.lastRightWidth) {
            this.lastRightWidth = total;
            this.relayout();
        }
    }

    private lastRightWidth = 0;
}
