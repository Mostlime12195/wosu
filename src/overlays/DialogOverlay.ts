import { Container, Graphics } from 'pixi.js';
import type { Game } from '../app/Game';
import { Overlay } from '../app/Overlay';
import { lerpColor } from '../core/math';
import { tween } from '../core/Tweener';
import type { Action } from '../input/bindings';
import { Box } from '../ui/Box';
import { Button } from '../ui/Button';
import { icon, type IconName } from '../ui/icons';
import { label, textStyle } from '../ui/text';
import { Colors } from '../ui/theme';
import { Triangles } from '../ui/Triangles';

export interface ConfirmOptions {
    title: string;
    text: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    icon?: IconName;
}

const WIDTH = 440;

/**
 * osu!lazer's PopupDialog: a centred card with a triangle-filled header
 * (icon in a ring, title, body) over stacked full-width buttons. Enter
 * confirms, Esc / clicking outside cancels. Calls are queued.
 */
export class DialogOverlay extends Overlay {
    protected override readonly popInSample = 'UI/dialog-pop-in';
    protected override readonly popOutSample = 'UI/dialog-pop-out';
    override readonly exclusive = false;
    private readonly card = new Container();
    private queue: Promise<unknown> = Promise.resolve();
    private resolver: ((v: boolean) => void) | null = null;
    private viewW = 0;
    private viewH = 0;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.6;
        this.card.eventMode = 'static';
        this.addChild(this.card);
        this.state.bind(open => {
            if (!open) this.settle(false);
        });
    }

    confirm(opts: ConfirmOptions): Promise<boolean> {
        const run = this.queue.then(() => this.present(opts));
        this.queue = run.catch(() => false);
        return run;
    }

    private present(opts: ConfirmOptions): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            this.resolver = resolve;
            this.build(opts);
            this.show();
        });
    }

    private settle(v: boolean): void {
        const r = this.resolver;
        if (!r) return;
        this.resolver = null;
        r(v);
        if (this.state.value) this.hide();
    }

    private danger = false;

    private build(o: ConfirmOptions): void {
        this.danger = !!o.danger;
        for (const c of this.card.removeChildren()) c.destroy({ children: true });
        const accent = o.danger ? 0xc23a5a : Colors.purpleDark;
        const pad = 28;
        const titleText = label(o.title, { size: 22, weight: '700', align: 'center', wrap: WIDTH - pad * 2 });
        const body = label(o.text, { size: 14, weight: '500', color: Colors.grayE, align: 'center', wrap: WIDTH - pad * 2, lineHeight: 20 });
        titleText.anchor.set(0.5, 0);
        body.anchor.set(0.5, 0);
        const ringR = 34;
        const headerH = pad + ringR * 2 + 18 + titleText.height + 10 + body.height + pad;

        const header = new Box({ color: accent, radius: 10, corners: 'top' }, WIDTH, headerH);
        const tris = new Triangles(this.game.skin.tex('triangle'), {
            colorLight: lerpColor(accent, 0xffffff, 0.15),
            colorDark: lerpColor(accent, 0x000000, 0.2),
            maskRadius: 10,
            velocity: 0.5,
            density: 1.2,
        });
        tris.resize(WIDTH, headerH);
        const ring = new Graphics().circle(0, 0, ringR).stroke({ width: 4, color: 0xffffff });
        ring.position.set(WIDTH / 2, pad + ringR);
        const glyph = icon(o.icon ?? (o.danger ? 'warning' : 'question'), 26, 0xffffff);
        glyph.position.copyFrom(ring.position);
        titleText.position.set(WIDTH / 2, pad + ringR * 2 + 18);
        body.position.set(WIDTH / 2, titleText.y + titleText.height + 10);
        this.card.addChild(header, tris, ring, glyph, titleText, body);

        const footer = new Box({ color: 0x1e1c24, radius: 10, corners: 'bottom' });
        this.card.addChild(footer);
        let y = headerH + 16;
        const confirm = new Button(o.confirmText ?? 'OK', { color: o.danger ? Colors.red : Colors.pink, width: WIDTH - 32, height: 46, triangles: this.game.skin.tex('triangle'), fontSize: 16, selectSample: o.danger ? 'UI/dialog-dangerous-select' : 'UI/dialog-ok-select' });
        confirm.position.set(16, y);
        confirm.onActivate = () => this.settle(true);
        y += 54;
        const cancel = new Button(o.cancelText ?? 'Cancel', { color: Colors.gray4, width: WIDTH - 32, height: 46, fontSize: 16, selectSample: 'UI/dialog-cancel-select' });
        cancel.position.set(16, y);
        cancel.onActivate = () => this.settle(false);
        y += 46 + 16;
        footer.position.set(0, headerH);
        footer.resize(WIDTH, y - headerH);
        this.card.addChild(confirm, cancel);
        this.card.pivot.set(WIDTH / 2, y / 2);
        this.place();
        // Keep text crisp-wrapped even if styles were cached at other widths.
        body.style = textStyle({ size: 14, weight: '500', color: Colors.grayE, align: 'center', wrap: WIDTH - pad * 2, lineHeight: 20 });
    }

    private place(): void {
        this.card.position.set(this.viewW / 2, this.viewH / 2);
    }

    protected popIn(): void {
        this.card.scale.set(0.7);
        this.card.alpha = 0;
        tween(this.card, { scale: 1, alpha: 1 }, { duration: 600, ease: 'OutElastic' });
    }

    protected async popOut(): Promise<void> {
        await tween(this.card, { scale: 0.7, alpha: 0 }, { duration: 200, ease: 'InQuad' }).finished;
    }

    protected layout(w: number, h: number): void {
        this.viewW = w;
        this.viewH = h;
        this.place();
    }

    override onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'select') {
            this.game.uiSounds.play(this.danger ? 'UI/dialog-dangerous-select' : 'UI/dialog-ok-select');
            this.settle(true);
            return true;
        }
        if (action === 'back') {
            this.game.uiSounds.play('UI/dialog-cancel-select');
            this.settle(false);
            return true;
        }
        // Modal: swallow everything else so screens behind don't react.
        return true;
    }
}
