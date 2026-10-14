/**
 * Global key bindings (osu!lazer GlobalAction equivalents). Bindings are
 * strings like "Ctrl+KeyO": modifiers then a KeyboardEvent.code. The
 * extra mouse buttons bind as the codes `MouseMiddle`, `MouseBack` and
 * `MouseForward` (InputManager routes them like keys).
 *
 * One key may serve several actions in different contexts (lazer: F1 is
 * "previous track" globally but "mod select" in song select). Handlers ask
 * `matches(e, action)` for the actions they handle, so the context with
 * the highest priority decides.
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
    | 'toggleBeatmapOptions'
    | 'deselectAllMods'
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
    | 'quickExit'
    | 'pauseGameplay'
    | 'toggleInGameInterface'
    | 'toggleInGameLeaderboard'
    | 'increaseOffset'
    | 'decreaseOffset'
    | 'togglePauseReplay'
    | 'seekReplayBackward'
    | 'seekReplayForward'
    | 'deleteItem';

export type Bindings = Record<Action, string[]>;

/** lazer's defaults (GlobalActionContainer), where wosu! has the action. */
export const DEFAULT_BINDINGS: Bindings = {
    back: ['Escape', 'MouseBack'],
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
    toggleBeatmapOptions: ['F3'],
    deselectAllMods: ['Backspace'],
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
    skip: ['Space', 'MouseForward'],
    quickRetry: ['Backquote'],
    quickExit: ['Ctrl+Backquote'],
    pauseGameplay: ['MouseMiddle'],
    toggleInGameInterface: ['Shift+Tab'],
    toggleInGameLeaderboard: ['Tab'],
    increaseOffset: ['Alt+Equal'],
    decreaseOffset: ['Alt+Minus'],
    togglePauseReplay: ['Space', 'MouseMiddle'],
    seekReplayBackward: ['ArrowLeft'],
    seekReplayForward: ['ArrowRight'],
    deleteItem: ['Shift+Delete'],
};

export const ACTIONS = Object.keys(DEFAULT_BINDINGS) as Action[];

/** Where an action is live; bindings only conflict within one scope. */
export type BindingScope = 'global' | 'audio' | 'songSelect' | 'inGame' | 'replay';

export interface BindingSection {
    title: string;
    scope: BindingScope;
    actions: { action: Action; caption: string; keywords?: string }[];
}

/** lazer's key binding sections (GlobalActionKeyBindingsSection). */
export const BINDING_SECTIONS: readonly BindingSection[] = [
    {
        title: 'Global',
        scope: 'global',
        actions: [
            { action: 'back', caption: 'Back', keywords: 'escape exit' },
            { action: 'select', caption: 'Select', keywords: 'enter confirm' },
            { action: 'up', caption: 'Select previous' },
            { action: 'down', caption: 'Select next' },
            { action: 'left', caption: 'Select previous group' },
            { action: 'right', caption: 'Select next group' },
            { action: 'pageUp', caption: 'Page up' },
            { action: 'pageDown', caption: 'Page down' },
            { action: 'home', caption: 'First item' },
            { action: 'end', caption: 'Last item' },
            { action: 'toggleSettings', caption: 'Toggle settings' },
            { action: 'toggleNotifications', caption: 'Toggle notifications' },
            { action: 'toggleBeatmapListing', caption: 'Toggle beatmap listing', keywords: 'osu!direct download' },
            { action: 'toggleNowPlaying', caption: 'Toggle now playing overlay', keywords: 'music' },
            { action: 'toggleFps', caption: 'Toggle FPS counter' },
            { action: 'screenshot', caption: 'Take screenshot' },
            { action: 'fullscreen', caption: 'Toggle fullscreen' },
            { action: 'deleteItem', caption: 'Delete selected' },
        ],
    },
    {
        title: 'Audio',
        scope: 'audio',
        actions: [
            { action: 'volumeUp', caption: 'Increase volume' },
            { action: 'volumeDown', caption: 'Decrease volume' },
            { action: 'toggleMute', caption: 'Toggle mute' },
            { action: 'musicPlay', caption: 'Play / pause', keywords: 'music' },
            { action: 'musicNext', caption: 'Next track', keywords: 'music' },
            { action: 'musicPrev', caption: 'Previous track', keywords: 'music' },
        ],
    },
    {
        title: 'Song Select',
        scope: 'songSelect',
        actions: [
            { action: 'toggleMods', caption: 'Toggle mod select', keywords: 'mods' },
            { action: 'random', caption: 'Next random', keywords: 'random' },
            { action: 'randomRewind', caption: 'Previous random', keywords: 'random rewind' },
            { action: 'toggleBeatmapOptions', caption: 'Toggle beatmap options' },
            { action: 'deselectAllMods', caption: 'Deselect all mods', keywords: 'mods clear reset' },
        ],
    },
    {
        title: 'In Game',
        scope: 'inGame',
        actions: [
            { action: 'skip', caption: 'Skip cutscene', keywords: 'intro break' },
            { action: 'quickRetry', caption: 'Quick retry (hold)', keywords: 'restart' },
            { action: 'quickExit', caption: 'Quick exit (hold)', keywords: 'quit' },
            { action: 'pauseGameplay', caption: 'Pause gameplay' },
            { action: 'toggleInGameInterface', caption: 'Toggle in-game interface', keywords: 'hud' },
            { action: 'toggleInGameLeaderboard', caption: 'Toggle in-game leaderboard', keywords: 'scoreboard' },
            { action: 'increaseOffset', caption: 'Increase offset', keywords: 'beatmap offset timing' },
            { action: 'decreaseOffset', caption: 'Decrease offset', keywords: 'beatmap offset timing' },
        ],
    },
    {
        title: 'Replay',
        scope: 'replay',
        actions: [
            { action: 'togglePauseReplay', caption: 'Pause / resume replay' },
            { action: 'seekReplayBackward', caption: 'Seek replay backward' },
            { action: 'seekReplayForward', caption: 'Seek replay forward' },
        ],
    },
];

export function scopeOf(action: Action): BindingScope {
    for (const s of BINDING_SECTIONS) if (s.actions.some(a => a.action === action)) return s.scope;
    return 'global';
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;
const BINDING_RE = /^(?:(?:Ctrl|Alt|Shift)\+)*[A-Za-z][A-Za-z0-9]*$/;
/** Bindings kept per action (lazer shows a handful of slots). */
export const MAX_BINDINGS_PER_ACTION = 3;

export function isValidBinding(b: unknown): b is string {
    return typeof b === 'string' && BINDING_RE.test(b);
}

/** Codes that are modifiers themselves (never the "key" of a binding on their own). */
export function isModifierCode(code: string): boolean {
    return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code);
}

export function bindingFromEvent(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'>): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.code);
    return parts.join('+');
}

/** Exact modifier match. */
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
    return bindingFromEvent(e) === binding;
}

/** The first action bound to the event (record order), or null. */
export function actionFor(e: KeyboardEvent, bindings: Bindings = DEFAULT_BINDINGS): Action | null {
    const b = bindingFromEvent(e);
    for (const action of ACTIONS) if (bindings[action]?.includes(b)) return action;
    return null;
}

/** Every action bound to `binding`. */
export function actionsForBinding(binding: string, bindings: Bindings = DEFAULT_BINDINGS): Action[] {
    return ACTIONS.filter(a => bindings[a]?.includes(binding));
}

/**
 * Effective bindings: the defaults with the saved overrides on top.
 * Overrides are `{ action: bindings[] }` for changed actions only;
 * malformed entries (and unknown actions) are ignored.
 */
export function resolveBindings(overrides: Readonly<Record<string, unknown>> | null | undefined): Bindings {
    const out = {} as Bindings;
    for (const action of ACTIONS) {
        const o = overrides?.[action];
        out[action] = Array.isArray(o)
            ? [...new Set(o.filter(isValidBinding))].slice(0, MAX_BINDINGS_PER_ACTION)
            : [...DEFAULT_BINDINGS[action]];
    }
    return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The overrides to persist for `bindings` (actions that differ from their defaults). */
export function overridesFor(bindings: Bindings): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const action of ACTIONS) {
        if (!sameList(bindings[action], DEFAULT_BINDINGS[action])) out[action] = [...bindings[action]];
    }
    return out;
}

export interface BindResult {
    bindings: Bindings;
    /** Actions in the same scope that lost this binding to the new one. */
    displaced: Action[];
}

/**
 * Put `binding` in `slot` of `action` (a slot past the end appends; null
 * clears the slot). The same combination is taken away from other actions
 * in the same scope, so a key never silently does two things at once.
 */
export function bindAction(bindings: Bindings, action: Action, slot: number, binding: string | null): BindResult {
    const next = {} as Bindings;
    for (const a of ACTIONS) next[a] = [...bindings[a]];
    const list = next[action];
    const displaced: Action[] = [];
    if (binding === null) {
        if (slot < list.length) list.splice(slot, 1);
        return { bindings: next, displaced };
    }
    const existing = list.indexOf(binding);
    if (existing !== -1 && existing !== slot) list.splice(existing, 1);
    if (slot < list.length) list[slot] = binding;
    else if (list.length < MAX_BINDINGS_PER_ACTION) list.push(binding);
    else list[list.length - 1] = binding;
    next[action] = [...new Set(list)];
    const scope = scopeOf(action);
    for (const other of ACTIONS) {
        if (other === action || scopeOf(other) !== scope) continue;
        const i = next[other].indexOf(binding);
        if (i !== -1) {
            next[other].splice(i, 1);
            displaced.push(other);
        }
    }
    return { bindings: next, displaced };
}

export function captionOf(action: Action): string {
    for (const s of BINDING_SECTIONS) {
        const a = s.actions.find(x => x.action === action);
        if (a) return a.caption;
    }
    return action;
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
        MetaLeft: 'LMeta', MetaRight: 'RMeta', Backspace: 'Backspace', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn',
        PrintScreen: 'PrtSc', MediaPlayPause: 'Play/Pause', MediaTrackNext: 'Next track', MediaTrackPrevious: 'Prev track',
        MouseMiddle: 'Mouse 3', MouseBack: 'Mouse 4', MouseForward: 'Mouse 5',
    };
    return map[code] ?? code;
}

export function bindingLabel(binding: string): string {
    return binding.split('+').map(p => ((MODIFIERS as readonly string[]).includes(p) ? p : codeLabel(p))).join('+');
}

/** Labels for an action's bindings, e.g. "F1" or "Esc / Mouse 4" (for hints and tooltips). */
export function actionLabel(bindings: Bindings, action: Action): string {
    return bindings[action].map(bindingLabel).join(' / ') || 'unbound';
}
