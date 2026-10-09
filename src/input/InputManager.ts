import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import type { App } from '../app/App';
import { actionFor, DEFAULT_BINDINGS, type Action } from './bindings';
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
    bindings: Record<Action, string[]> = DEFAULT_BINDINGS;

    private entries: Entry[] = [];
    private order = 0;

    constructor(private readonly app: App, private readonly textInput: TextInputProxy) {
        const opts = { passive: true } as const;
        window.addEventListener('pointermove', e => this.onPointer(e), opts);
        window.addEventListener('pointerdown', e => {
            this.onPointer(e);
            this.pointer.down = true;
        }, opts);
        window.addEventListener('pointerup', e => {
            this.onPointer(e);
            this.pointer.down = false;
        }, opts);
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

    private onPointer(e: PointerEvent): void {
        this.pointerSeen = true;
        const p = this.app.toLogical(e.clientX, e.clientY);
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
        this.keysDown.add(e.code);
        if (this.textInput.focused && isTextEditingKey(e)) return;
        if (e.isComposing) return;
        const action = actionFor(e, this.bindings);
        // Snapshot: handlers may register/unregister while dispatching.
        for (const entry of this.entries.slice()) {
            if (entry.fn(e, action)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }
        // Keep focus inside the canvas; Tab would otherwise escape it.
        if (e.code === 'Tab') e.preventDefault();
    }

    private onKeyUp(e: KeyboardEvent): void {
        this.keysDown.delete(e.code);
        for (const entry of this.entries.slice()) entry.keyUp?.(e);
    }
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
