import { Graphics } from 'pixi.js';
import { Bindable } from '../core/Bindable';
import { tween } from '../core/Tweener';
import { UIComponent } from '../ui/UIComponent';
import { uiSounds } from '../ui/UIContext';
import type { Action } from '../input/bindings';
import { KeyPriority } from '../input/InputManager';
import type { Game } from './Game';

/**
 * Base for full-screen and side overlays (settings, beatmap listing,
 * notifications, mod select...). Visibility is a Bindable so toolbar
 * buttons can mirror it. While visible the overlay sits in the keyboard
 * stack above screens; `back` closes it.
 */
export abstract class Overlay extends UIComponent {
    readonly state = new Bindable(false);
    /** Dim + block the screen behind (click backdrop to close). */
    protected readonly modal: boolean = true;
    /** Opening this overlay closes other exclusive overlays. */
    readonly exclusive: boolean = true;
    protected readonly backdrop = new Graphics();
    private keyOff: (() => void) | null = null;
    protected backdropAlpha = 0.5;

    constructor(protected readonly game: Game) {
        super();
        this.visible = false;
        this.backdrop.alpha = 0;
        this.backdrop.eventMode = 'static';
        this.backdrop.on('pointertap', () => this.hide());
        this.addChild(this.backdrop);
        this.state.bind(v => (v ? this.onShow() : this.onHide()));
    }

    show(): void {
        this.state.value = true;
    }

    hide(): void {
        this.state.value = false;
    }

    toggle(): void {
        this.state.value = !this.state.value;
    }

    get isOpen(): boolean {
        return this.state.value;
    }

    private onShow(): void {
        this.game.overlays.notifyOpened(this);
        this.visible = true;
        this.eventMode = 'passive';
        this.keyOff?.();
        this.keyOff = this.game.input.pushKeyHandler((e, a) => this.onKey(e, a), KeyPriority.overlay);
        if (this.modal) tween(this.backdrop, { alpha: this.backdropAlpha }, { duration: 300 });
        uiSounds()?.select();
        this.popIn();
    }

    private onHide(): void {
        this.keyOff?.();
        this.keyOff = null;
        this.eventMode = 'none';
        tween(this.backdrop, { alpha: 0 }, { duration: 300 });
        this.popOut().then(() => {
            if (!this.state.value) this.visible = false;
        });
    }

    /** Show animation. */
    protected abstract popIn(): void;
    /** Hide animation; resolve when done so the overlay can be culled. */
    protected abstract popOut(): Promise<void>;

    /** Keys while open. Default: back closes. Return true when consumed. */
    onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back') {
            this.hide();
            uiSounds()?.back();
            return true;
        }
        return false;
    }

    protected override onResize(w: number, h: number): void {
        this.backdrop.clear();
        if (this.modal) this.backdrop.rect(0, 0, w, h).fill(0x000000);
        this.layout(w, h);
    }

    protected abstract layout(w: number, h: number): void;

    update(_dt: number): void {}
}

/** Tracks overlays and enforces exclusivity. */
export class OverlayManager {
    private readonly all: Overlay[] = [];

    register<T extends Overlay>(o: T): T {
        this.all.push(o);
        return o;
    }

    notifyOpened(o: Overlay): void {
        if (!o.exclusive) return;
        for (const other of this.all) if (other !== o && other.exclusive && other.isOpen) other.hide();
    }

    hideAll(): void {
        for (const o of this.all) if (o.isOpen) o.hide();
    }

    get anyOpen(): boolean {
        return this.all.some(o => o.isOpen);
    }

    resize(w: number, h: number): void {
        for (const o of this.all) o.resize(w, h);
    }

    update(dt: number): void {
        for (const o of this.all) if (o.visible) o.update(dt);
    }
}
