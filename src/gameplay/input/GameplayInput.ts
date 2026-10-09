import { Signal } from '../../core/Signal';
import type { App } from '../../app/App';
import type { GameSettings } from '../../settings/Settings';

/** The four osu! inputs: two keys, two mouse buttons (touches count as M1). */
export type GameplayButton = 'K1' | 'K2' | 'M1' | 'M2';

export const GAMEPLAY_BUTTONS: readonly GameplayButton[] = ['K1', 'K2', 'M1', 'M2'];

/**
 * Collects gameplay presses with the song time at the moment of the
 * event (not the next frame), plus held state for slider/spinner
 * tracking. Keyboard arrives through the screen's key routing (so menus
 * above gameplay get first refusal); pointers are read from window events
 * directly so touches and mouse buttons carry exact positions.
 *
 * Positions are logical (UI) pixels; the Player maps them to the playfield.
 */
export class GameplayInput {
    /** A button went down: song time, logical position, button. */
    readonly pressed = new Signal<[time: number, x: number, y: number, button: GameplayButton]>();
    readonly released = new Signal<[button: GameplayButton]>();
    /** Any press, even while judgement input is disabled (resume overlay). */
    readonly anyPress = new Signal<[x: number, y: number]>();
    /** Presses per button (key overlay). */
    readonly counts: Record<GameplayButton, number> = { K1: 0, K2: 0, M1: 0, M2: 0 };
    readonly down: Record<GameplayButton, boolean> = { K1: false, K2: false, M1: false, M2: false };
    /** Logical cursor position (last pointer / touch). */
    x = 0;
    y = 0;
    /** Accepts input (off while paused / failed / finished). */
    enabled = false;
    /** Pointer presses on on-screen controls (hold-for-menu, skip) aren't gameplay input. */
    ignorePointer: ((x: number, y: number) => boolean) | null = null;
    private readonly touches = new Map<number, GameplayButton>();
    private readonly listeners: [string, EventListener][] = [];

    constructor(
        private readonly app: App,
        private readonly settings: GameSettings,
        private readonly now: () => number,
        start: { x: number; y: number },
    ) {
        this.x = start.x;
        this.y = start.y;
        this.listen('pointermove', e => this.onMove(e as PointerEvent));
        this.listen('pointerdown', e => this.onDown(e as PointerEvent));
        this.listen('pointerup', e => this.onUp(e as PointerEvent));
        this.listen('pointercancel', e => this.onUp(e as PointerEvent));
    }

    get held(): boolean {
        return this.down.K1 || this.down.K2 || this.down.M1 || this.down.M2;
    }

    private listen(type: string, fn: EventListener): void {
        window.addEventListener(type, fn, { passive: true });
        this.listeners.push([type, fn]);
    }

    /** Keyboard down (from the screen's key routing). Returns true if it was a gameplay key. */
    keyDown(e: KeyboardEvent): boolean {
        const button = this.keyButton(e.code);
        if (!button) return false;
        if (!e.repeat && !this.down[button]) this.press(button);
        return true;
    }

    keyUp(e: KeyboardEvent): void {
        const button = this.keyButton(e.code);
        if (button) this.release(button);
    }

    private keyButton(code: string): GameplayButton | null {
        if (code === this.settings.keyLeft.value) return 'K1';
        if (code === this.settings.keyRight.value) return 'K2';
        return null;
    }

    private onMove(e: PointerEvent): void {
        // Only the primary pointer steers (a second finger shouldn't teleport mid-slider).
        if (e.pointerType === 'touch' && this.touches.size > 0 && !this.touches.has(e.pointerId)) return;
        const p = this.app.toLogical(e.clientX, e.clientY);
        this.x = p.x;
        this.y = p.y;
    }

    private onDown(e: PointerEvent): void {
        const p = this.app.toLogical(e.clientX, e.clientY);
        if (this.ignorePointer?.(p.x, p.y)) return;
        if (e.pointerType === 'touch' || e.pointerType === 'pen') {
            this.x = p.x;
            this.y = p.y;
            // Alternate the two virtual buttons so streams register as presses.
            const button: GameplayButton = this.down.M1 ? 'M2' : 'M1';
            this.touches.set(e.pointerId, button);
            if (!this.down[button]) this.press(button);
            return;
        }
        if (!this.settings.mouseButtons.value) return;
        const button: GameplayButton | null = e.button === 0 ? 'M1' : e.button === 2 ? 'M2' : null;
        if (!button) return;
        this.x = p.x;
        this.y = p.y;
        if (!this.down[button]) this.press(button);
    }

    private onUp(e: PointerEvent): void {
        const touch = this.touches.get(e.pointerId);
        if (touch) {
            this.touches.delete(e.pointerId);
            if (![...this.touches.values()].includes(touch)) this.release(touch);
            return;
        }
        if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
        if (e.button === 0) this.release('M1');
        else if (e.button === 2) this.release('M2');
    }

    private press(button: GameplayButton): void {
        this.down[button] = true;
        this.anyPress.emit(this.x, this.y);
        if (!this.enabled) return;
        this.counts[button]++;
        this.pressed.emit(this.now(), this.x, this.y, button);
    }

    private release(button: GameplayButton): void {
        if (!this.down[button]) return;
        this.down[button] = false;
        this.released.emit(button);
    }

    /** Forget held state (focus loss, pause) so nothing stays stuck down. */
    releaseAll(): void {
        for (const b of GAMEPLAY_BUTTONS) this.release(b);
        this.touches.clear();
    }

    dispose(): void {
        for (const [type, fn] of this.listeners) window.removeEventListener(type, fn);
        this.listeners.length = 0;
        this.pressed.clear();
        this.released.clear();
        this.anyPress.clear();
    }
}
