import type { Container } from 'pixi.js';

/**
 * Services that leaf UI components need without threading them through
 * every constructor: popup layer (dropdowns must escape scroll masks),
 * tooltips, sounds and the text-entry bridge. Installed once at boot.
 */
export type UISampleSet = 'default' | 'button' | 'toolbar' | 'tab' | 'submit' | 'sidebar' | 'menu';

export interface UISoundsLike {
    hover(set?: UISampleSet): void;
    click(set?: UISampleSet): void;
    denied(): void;
    typed(): void;
    tick(normalized: number): void;
    play(name: string, opts?: { volume?: number; rate?: number; throttle?: number }): boolean;
    select(): void;
    back(): void;
    toggleOn(): void;
    toggleOff(): void;
    notify(): void;
    error(): void;
}

export interface TooltipHost {
    show(text: string, owner: object): void;
    hide(owner: object): void;
}

export interface TextInputHost {
    /** Start routing keyboard/IME text into `sink`; returns a release fn. */
    focus(sink: TextSink): () => void;
    readonly focused: TextSink | null;
    blur(): void;
    /**
     * Mirror a programmatic value/caret change into the native input.
     * `caret` is the moving end of the selection, `anchor` the fixed end.
     */
    sync(value: string, caret: number, anchor?: number): void;
    /** Keep native focus on the text input through the current pointer press. */
    holdFocus(): void;
}

export interface TextSink {
    readonly value: string;
    /** Replace the whole value (from IME/proxy input): caret = moving end, anchor = fixed end of the selection. */
    applyInput(value: string, caret: number, anchor: number): void;
    /** Special keys not producing text (Enter, Escape, arrows...). Return true if handled. */
    onSpecialKey(e: KeyboardEvent): boolean;
    onFocusLost(): void;
    readonly multiline?: boolean;
}

export interface UIContextServices {
    popupLayer: Container;
    tooltips: TooltipHost;
    sounds: UISoundsLike | null;
    textInput: TextInputHost;
    /** Logical (CSS px) viewport size. */
    viewport(): { width: number; height: number };
    /** Current pointer position in logical px. */
    pointer(): { x: number; y: number };
}

let services: UIContextServices | null = null;

export function installUIContext(s: UIContextServices): void {
    services = s;
}

export function ui(): UIContextServices {
    if (!services) throw new Error('UI context not installed');
    return services;
}

export function uiSounds(): UISoundsLike | null {
    return services?.sounds ?? null;
}

/**
 * Set while a scroll container is being dragged past its tap threshold,
 * so children don't treat the end of a drag as a click.
 */
export const gesture = {
    suppressClicks: false,
};
