import { Bindable } from '../core/Bindable';
import { whenIdle } from '../core/idle';
import type { Overlay } from './Overlay';

/**
 * Stands in for an overlay that is built the first time it's needed (its
 * code lives in the deferred chunk, see lazy.ts). `state` exists from the
 * start, so toolbar buttons and shortcuts bind to it as to a real
 * overlay's; opening it builds the overlay, which then shares the state.
 * Game also builds them in idle time after the menu shows, so opening one
 * is normally instant. Building and the first layout are separate idle
 * tasks (each is a long one on a slow CPU); opening lays out at once.
 */
export class LazyOverlay<T extends Overlay> {
    readonly state = new Bindable(false);
    private instance: T | null = null;
    private pending: Promise<T> | null = null;
    private laidOut = false;

    constructor(
        private readonly create: () => Promise<T>,
        private readonly layout: (overlay: T) => void,
        private readonly failed: (e: unknown) => void,
    ) {
        // Runs before the state reaches the overlay (Bindable emits, then propagates).
        this.state.bind(open => {
            if (!open) return;
            if (this.instance) this.ensureLayout(this.instance);
            else this.load().catch(() => { /* reported by `failed` */ });
        });
    }

    private ensureLayout(overlay: T): void {
        if (this.laidOut) return;
        this.laidOut = true;
        this.layout(overlay);
    }

    /** The overlay, once built. */
    get current(): T | null {
        return this.instance;
    }

    /** Build the overlay (once); a failed load can be retried. */
    load(): Promise<T> {
        this.pending ??= this.create().then(o => {
            this.instance = o;
            if (this.state.value) this.ensureLayout(o);
            else whenIdle(() => this.ensureLayout(o));
            // Opened while loading: binding shows it now.
            o.state.bindTo(this.state);
            return o;
        }, (e: unknown) => {
            this.pending = null;
            this.state.value = false;
            this.failed(e);
            throw e;
        });
        return this.pending;
    }

    /** Run `fn` with the overlay, building it first if needed. */
    use(fn: (overlay: T) => void): void {
        if (this.instance) fn(this.instance);
        else this.load().then(fn, () => { /* reported by `failed` */ });
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
}
