import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import type { App } from '../app/App';
import { actionFor, bindingFromEvent, DEFAULT_BINDINGS, type Action, type Bindings } from './bindings';
import { PointerLockController, type PointerLockTarget } from './PointerLock';
import type { TextInputProxy } from './TextInputProxy';

export type KeyHandler = (e: KeyboardEvent, action: Action | null) => boolean;
export type PointerKind = 'mouse' | 'touch' | 'pen';

/**
 * Handler priorities. Higher runs first; equal priorities run most
 * recently registered first (the top-most overlay wins).
 */
export const KeyPriority = {
    global: 0,
    screen: 100,
    overlay: 300,
    dialog: 400,
    popup: 500,
    capture: 1000,
} as const;

interface Entry {
    fn: KeyHandler;
    priority: number;
    order: number;
    keyUp?: (e: KeyboardEvent) => void;
}

/**
 * Global input state and keyboard routing.
 *
 * Pointer *interaction* with UI is Pixi's event system; this class only
 * tracks the global pointer (for the cursor/gameplay) and routes keyboard
 * events through a priority stack so the top-most layer gets first refusal
 * (osu-framework's input queue, minus the per-drawable bookkeeping).
 */
export class InputManager {
    readonly pointer = { x: 0, y: 0, clientX: 0, clientY: 0, kind: 'mouse' as PointerKind, down: false, inside: true };
    readonly pointerMoved = new Signal<[]>();
    readonly lastPointerKind = new Bindable<PointerKind>('mouse');
    readonly keysDown = new Set<string>();
    /** False until the first pointer event (keeps the cursor hidden at 0,0). */
    pointerSeen = false;
    /** Effective global action bindings (Game keeps them in sync with the settings). */
    bindings: Bindings = DEFAULT_BINDINGS;
    /** Gameplay pointer lock (high precision mouse / confine); while locked, mouse positions are its virtual cursor. */
    readonly pointerLock: PointerLockController;

    private entries: Entry[] = [];
    private order = 0;

    constructor(private readonly app: App, private readonly textInput: TextInputProxy) {
        // Its listeners capture on window, so the virtual cursor is current before any listener below runs.
        this.pointerLock = new PointerLockController(app.canvas as unknown as PointerLockTarget, {
            doc: document,
            win: window,
            userActivation: (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation ?? null,
            now: () => performance.now(),
            toLogical: (x, y) => app.toLogical(x, y),
            view: () => ({ width: app.width, height: app.height, uiScale: app.uiScale }),
        });
        const opts = { passive: true } as const;
        window.addEventListener('pointermove', e => this.onPointer(e), opts);
        window.addEventListener('pointerdown', e => {
            this.onPointer(e);
            this.pointer.down = true;
            this.onMouseButton(e, true);
        });
        window.addEventListener('pointerup', e => {
            this.onPointer(e);
            this.pointer.down = false;
            this.onMouseButton(e, false);
        });
        // Chorded presses arrive as pointermove with `button` set.
        window.addEventListener('pointermove', e => {
            if (e.button > 0) this.onMouseButton(e, (e.buttons & buttonMask(e.button)) !== 0);
        }, opts);
        // The back/forward buttons would navigate the page when bound (Chrome acts on mouseup).
        window.addEventListener('mouseup', e => {
            if (this.handledMouse.delete(e.button)) e.preventDefault();
        });
        document.addEventListener('pointerleave', () => (this.pointer.inside = false));
        document.addEventListener('pointerenter', () => (this.pointer.inside = true));
        window.addEventListener('keydown', e => this.onKeyDown(e));
        window.addEventListener('keyup', e => this.onKeyUp(e));
        window.addEventListener('blur', () => this.keysDown.clear());
    }

    /** Register a key handler; returns an unregister function. */
    pushKeyHandler(fn: KeyHandler, priority: number = KeyPriority.screen, keyUp?: (e: KeyboardEvent) => void): () => void {
        const entry: Entry = { fn, priority, order: this.order++, keyUp };
        this.entries.push(entry);
        this.entries.sort((a, b) => b.priority - a.priority || b.order - a.order);
        return () => {
            const i = this.entries.indexOf(entry);
            if (i !== -1) this.entries.splice(i, 1);
        };
    }

    isKeyDown(code: string): boolean {
        return this.keysDown.has(code);
    }

    /** Whether the event is one of `action`'s bindings (handlers check their own actions with this). */
    matches(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>, action: Action): boolean {
        return this.bindings[action]?.includes(bindingFromEvent(e)) ?? false;
    }

    /** Whether a key-up ends a hold of `action` (its key without modifiers: those may be released first). */
    releases(e: Pick<KeyboardEvent, 'code'>, action: Action): boolean {
        return this.bindings[action]?.some(b => b === e.code || b.endsWith(`+${e.code}`)) ?? false;
    }

    private readonly mouseDown = new Set<number>();
    private readonly handledMouse = new Set<number>();

    /**
     * The middle and side mouse buttons can be bound like keys (lazer's
     * MouseMiddle / ExtraMouseButton bindings): they're routed through the
     * key handlers as keydown/keyup of a `Mouse…` code.
     */
    private onMouseButton(e: PointerEvent, down: boolean): void {
        if (e.pointerType !== 'mouse') return;
        const code = MOUSE_CODES[e.button];
        if (!code || this.mouseDown.has(e.button) === down) return;
        const init = { code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, bubbles: false, cancelable: true };
        if (down) {
            this.mouseDown.add(e.button);
            const ke = new KeyboardEvent('keydown', init);
            if (this.dispatchKey(ke)) {
                this.handledMouse.add(e.button);
                // No autoscroll on middle click.
                if (e.cancelable) e.preventDefault();
            }
        } else {
            this.mouseDown.delete(e.button);
            this.onKeyUp(new KeyboardEvent('keyup', init));
        }
    }

    private onPointer(e: PointerEvent): void {
        this.pointerSeen = true;
        const lock = this.pointerLock;
        // A locked pointer's client position is frozen; the virtual cursor stands in.
        const p = lock.locked && e.pointerType === 'mouse' ? lock.pointer : this.app.toLogical(e.clientX, e.clientY);
        this.pointer.x = p.x;
        this.pointer.y = p.y;
        this.pointer.clientX = e.clientX;
        this.pointer.clientY = e.clientY;
        const kind = (e.pointerType || 'mouse') as PointerKind;
        this.pointer.kind = kind;
        if (this.lastPointerKind.value !== kind) this.lastPointerKind.value = kind;
        this.pointerMoved.emit();
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (this.textInput.focused && isTextEditingKey(e)) {
            this.keysDown.add(e.code);
            return;
        }
        if (e.isComposing) return;
        if (this.dispatchKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // Keep focus inside the canvas; Tab would otherwise escape it.
        if (e.code === 'Tab') e.preventDefault();
    }

    /** Offer a key press to the handler stack; true when one took it. */
    private dispatchKey(e: KeyboardEvent): boolean {
        this.keysDown.add(e.code);
        const action = actionFor(e, this.bindings);
        // Snapshot: handlers may register/unregister while dispatching.
        for (const entry of this.entries.slice()) {
            if (entry.fn(e, action)) return true;
        }
        return false;
    }

    private onKeyUp(e: KeyboardEvent): void {
        this.keysDown.delete(e.code);
        for (const entry of this.entries.slice()) entry.keyUp?.(e);
    }
}

/** Pointer buttons that bind like keys. */
const MOUSE_CODES: Record<number, string> = { 1: 'MouseMiddle', 3: 'MouseBack', 4: 'MouseForward' };

function buttonMask(button: number): number {
    // PointerEvent.buttons bits: 1 left, 2 right, 4 middle, 8 back, 16 forward.
    return button === 1 ? 4 : button === 2 ? 2 : 1 << button;
}

/** Keys a focused text box consumes itself (typing, caret, deletion). */
function isTextEditingKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey) {
        return ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'].includes(e.code);
    }
    if (e.altKey) return false;
    if (e.key.length === 1) return true;
    return ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift', 'Space'].includes(e.key) ||
        e.code === 'ShiftLeft' || e.code === 'ShiftRight';
}
