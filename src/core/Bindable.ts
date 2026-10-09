import { Signal } from './Signal';

/**
 * Observable value with a default, in the spirit of osu-framework's
 * Bindable<T>. Settings, overlay visibility and similar state are
 * Bindables so UI controls and game systems stay in sync without
 * knowing about each other.
 */
export class Bindable<T> {
    readonly changed = new Signal<[value: T, previous: T]>();
    readonly defaultValue: T;
    private current: T;
    private bound: Bindable<T>[] = [];
    private propagating = false;

    constructor(defaultValue: T) {
        this.defaultValue = defaultValue;
        this.current = defaultValue;
    }

    get value(): T {
        return this.current;
    }

    set value(v: T) {
        this.set(v);
    }

    get isDefault(): boolean {
        return Object.is(this.current, this.defaultValue);
    }

    set(v: T): void {
        v = this.coerce(v);
        if (Object.is(v, this.current)) return;
        const previous = this.current;
        this.current = v;
        this.changed.emit(v, previous);
        this.propagate(v);
    }

    setDefault(): void {
        this.set(this.defaultValue);
    }

    /**
     * Subscribe to changes. With `immediate`, the callback also runs once
     * right away with the current value, which keeps init code DRY.
     */
    bind(fn: (value: T, previous: T) => void, immediate = false): () => void {
        const off = this.changed.add(fn);
        if (immediate) fn(this.current, this.current);
        return off;
    }

    /** Two-way link: both bindables always hold the same value. */
    bindTo(other: Bindable<T>): () => void {
        this.set(other.value);
        this.bound.push(other);
        other.bound.push(this);
        return () => {
            this.bound = this.bound.filter(b => b !== other);
            other.bound = other.bound.filter(b => b !== this);
        };
    }

    /** Override to clamp/validate incoming values. */
    protected coerce(v: T): T {
        return v;
    }

    private propagate(v: T): void {
        if (this.propagating) return;
        this.propagating = true;
        try {
            for (const b of this.bound) b.set(v);
        } finally {
            this.propagating = false;
        }
    }
}

/** Numeric bindable with range and step, used by sliders. */
export class BindableNumber extends Bindable<number> {
    constructor(defaultValue: number, readonly min = -Infinity, readonly max = Infinity, readonly precision = 0) {
        super(defaultValue);
    }

    protected override coerce(v: number): number {
        if (!Number.isFinite(v)) return this.value ?? this.defaultValue;
        let n = Math.min(this.max, Math.max(this.min, v));
        if (this.precision > 0) n = Math.round(n / this.precision) * this.precision;
        // Remove float noise introduced by the rounding above.
        return Number(n.toFixed(6));
    }

    get normalized(): number {
        if (!Number.isFinite(this.min) || !Number.isFinite(this.max) || this.max === this.min) return 0;
        return (this.value - this.min) / (this.max - this.min);
    }

    set normalized(t: number) {
        this.set(this.min + (this.max - this.min) * t);
    }
}

/** Read-only view so consumers can observe but not mutate. */
export interface ReadonlyBindable<T> {
    readonly value: T;
    readonly changed: Signal<[value: T, previous: T]>;
    bind(fn: (value: T, previous: T) => void, immediate?: boolean): () => void;
}
