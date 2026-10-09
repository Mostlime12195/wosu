/**
 * Global key bindings (osu!lazer GlobalAction equivalents). Bindings are
 * strings like "Ctrl+KeyO": modifiers then a KeyboardEvent.code.
 */
export type Action =
    | 'back'
    | 'select'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'pageUp'
    | 'pageDown'
    | 'home'
    | 'end'
    | 'toggleSettings'
    | 'toggleNotifications'
    | 'toggleBeatmapListing'
    | 'toggleMods'
    | 'toggleNowPlaying'
    | 'random'
    | 'randomRewind'
    | 'volumeUp'
    | 'volumeDown'
    | 'toggleMute'
    | 'musicPlay'
    | 'musicNext'
    | 'musicPrev'
    | 'toggleFps'
    | 'screenshot'
    | 'fullscreen'
    | 'skip'
    | 'quickRetry'
    | 'deleteItem';

export const DEFAULT_BINDINGS: Record<Action, string[]> = {
    back: ['Escape'],
    select: ['Enter', 'NumpadEnter'],
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    pageUp: ['PageUp'],
    pageDown: ['PageDown'],
    home: ['Home'],
    end: ['End'],
    toggleSettings: ['Ctrl+KeyO'],
    toggleNotifications: ['Ctrl+KeyN'],
    toggleBeatmapListing: ['Ctrl+KeyD'],
    toggleMods: ['F1'],
    toggleNowPlaying: ['F6'],
    random: ['F2'],
    randomRewind: ['Shift+F2'],
    volumeUp: ['Alt+ArrowUp'],
    volumeDown: ['Alt+ArrowDown'],
    toggleMute: ['Ctrl+F4'],
    musicPlay: ['MediaPlayPause', 'F3'],
    musicNext: ['MediaTrackNext'],
    musicPrev: ['MediaTrackPrevious'],
    toggleFps: ['Ctrl+Shift+KeyF'],
    screenshot: ['F12', 'PrintScreen'],
    fullscreen: ['F11', 'Alt+Enter'],
    skip: ['Space'],
    quickRetry: ['Backquote'],
    deleteItem: ['Shift+Delete'],
};

export function bindingFromEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.code);
    return parts.join('+');
}

/** Exact modifier match, except plain keys also match with Shift held when unbound otherwise. */
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
    return bindingFromEvent(e) === binding;
}

export function actionFor(e: KeyboardEvent, bindings: Record<Action, string[]> = DEFAULT_BINDINGS): Action | null {
    const b = bindingFromEvent(e);
    for (const key in bindings) {
        const action = key as Action;
        if (bindings[action].includes(b)) return action;
    }
    return null;
}

/** Human-readable label for a KeyboardEvent.code (keybinding buttons). */
export function codeLabel(code: string): string {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    const map: Record<string, string> = {
        Space: 'Space', Escape: 'Esc', Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=',
        BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
        Comma: ',', Period: '.', Slash: '/', ShiftLeft: 'LShift', ShiftRight: 'RShift',
        ControlLeft: 'LCtrl', ControlRight: 'RCtrl', AltLeft: 'LAlt', AltRight: 'RAlt',
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: 'Tab', CapsLock: 'Caps',
        MetaLeft: 'LMeta', MetaRight: 'RMeta', Backspace: 'Backspace',
    };
    return map[code] ?? code;
}

export function bindingLabel(binding: string): string {
    return binding.split('+').map(p => (['Ctrl', 'Alt', 'Shift'].includes(p) ? p : codeLabel(p))).join('+');
}
