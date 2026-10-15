/**
 * Saved HUD layouts, one per skin (lazer keeps a skin's layout with the
 * skin): '' is wosu!'s default skin, otherwise the imported skin's id.
 * No entry means the skin uses its built-in layout. Layouts live in
 * localStorage (small, and read synchronously when a play starts).
 */
import { Signal } from '../../../core/Signal';
import { parseLayout, serialiseLayout, type HudLayout } from './HudLayout';

const STORAGE_KEY = 'wosu.hudLayouts.v1';

export class HudLayoutStore {
    /** A skin's layout was saved or reset (skin id). */
    readonly changed = new Signal<[skinId: string]>();
    private layouts: Record<string, HudLayout> | null = null;

    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {}

    private load(): Record<string, HudLayout> {
        if (this.layouts) return this.layouts;
        const out: Record<string, HudLayout> = {};
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            const v: unknown = raw ? JSON.parse(raw) : null;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [id, l] of Object.entries(v as Record<string, unknown>)) {
                    const layout = parseLayout(l);
                    if (layout) out[id] = layout;
                }
            }
        } catch {
            /* corrupt: every skin falls back to its built-in layout */
        }
        this.layouts = out;
        return out;
    }

    /** The skin's saved layout, or null for its built-in one. */
    get(skinId: string): HudLayout | null {
        return this.load()[skinId] ?? null;
    }

    has(skinId: string): boolean {
        return !!this.load()[skinId];
    }

    /** Save a layout (null: back to the built-in one). */
    set(skinId: string, layout: HudLayout | null): void {
        const all = this.load();
        if (layout) all[skinId] = parseLayout(serialiseLayout(layout)) ?? layout;
        else if (all[skinId]) delete all[skinId];
        else return;
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, l]) => [k, JSON.parse(serialiseLayout(l))]))));
        } catch {
            /* private mode / quota: kept for this session */
        }
        this.changed.emit(skinId);
    }
}

function safeStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

let instance: HudLayoutStore | null = null;

export function hudLayouts(): HudLayoutStore {
    instance ??= new HudLayoutStore();
    return instance;
}
