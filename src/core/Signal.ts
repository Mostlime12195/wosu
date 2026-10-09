/**
 * Minimal typed event emitter.
 *
 *   const changed = new Signal<[value: number]>();
 *   const off = changed.add(v => ...);
 *   changed.emit(3);
 *   off();
 *
 * Listeners added or removed while emitting take effect on the next emit,
 * so a handler may safely unsubscribe itself.
 */
export type Listener<A extends unknown[]> = (...args: A) => void;

export class Signal<A extends unknown[] = []> {
    private listeners: Listener<A>[] = [];
    private emitting = 0;
    private dirty = false;

    /** Subscribe; returns an unsubscribe function. */
    add(fn: Listener<A>): () => void {
        this.copyIfEmitting();
        this.listeners.push(fn);
        return () => this.remove(fn);
    }

    /** Subscribe for exactly one emission. */
    once(fn: Listener<A>): () => void {
        const off = this.add((...args) => {
            off();
            fn(...args);
        });
        return off;
    }

    remove(fn: Listener<A>): void {
        const i = this.listeners.indexOf(fn);
        if (i === -1) return;
        this.copyIfEmitting();
        this.listeners.splice(i, 1);
    }

    emit(...args: A): void {
        const list = this.listeners;
        this.emitting++;
        try {
            for (let i = 0; i < list.length; i++) list[i](...args);
        } finally {
            this.emitting--;
            if (this.emitting === 0) this.dirty = false;
        }
    }

    clear(): void {
        this.copyIfEmitting();
        this.listeners.length = 0;
    }

    get count(): number {
        return this.listeners.length;
    }

    /** Copy-on-write while an emit is iterating the current array. */
    private copyIfEmitting(): void {
        if (this.emitting > 0 && !this.dirty) {
            this.listeners = this.listeners.slice();
            this.dirty = true;
        }
    }
}

/**
 * Collects unsubscribe callbacks so a component can drop every external
 * subscription in one call when it is destroyed.
 */
export class Disposer {
    private fns: (() => void)[] = [];

    add(fn: () => void): void {
        this.fns.push(fn);
    }

    /** Listen on a DOM-style target and register the removal. */
    listen<K extends keyof WindowEventMap>(
        target: Window, type: K, fn: (e: WindowEventMap[K]) => void, options?: AddEventListenerOptions | boolean,
    ): void;
    listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions | boolean): void;
    listen(target: EventTarget, type: string, fn: (e: never) => void, options?: AddEventListenerOptions | boolean): void {
        const handler = fn as unknown as EventListener;
        target.addEventListener(type, handler, options);
        this.fns.push(() => target.removeEventListener(type, handler, options));
    }

    dispose(): void {
        const fns = this.fns;
        this.fns = [];
        for (let i = fns.length - 1; i >= 0; i--) {
            try {
                fns[i]();
            } catch (e) {
                console.error('dispose callback failed', e);
            }
        }
    }
}
