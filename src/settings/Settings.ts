import { Bindable, BindableNumber } from '../core/Bindable';
import type { RendererPreference } from '../app/App';
import { isModAcronym, sanitizeMods, sortedMods, type ModAcronym } from '../gameplay/mods';
import type { ProviderId } from '../online/providers';

export type SongSort = 'title' | 'artist' | 'creator' | 'difficulty' | 'length' | 'bpm' | 'dateAdded' | 'lastPlayed';
/** lazer's HUDVisibilityMode. */
export type HudVisibility = 'always' | 'hideDuringGameplay' | 'never';
/** lazer: one counter per action (keyboard + mouse combined); stable: K1 K2 M1 M2. */
export type KeyOverlayStyle = 'lazer' | 'stable';

/** String settings restricted to a fixed set of values. */
const ENUM_VALUES: Record<string, readonly string[]> = {
    hudVisibility: ['always', 'hideDuringGameplay', 'never'],
    keyOverlayStyle: ['lazer', 'stable'],
};

const STORAGE_KEY = 'webosu.settings.v2';
const LEGACY_KEY = 'osugamesettings';

/**
 * Every user preference as a Bindable. UI controls bind to these and game
 * systems subscribe to them, so changes apply live without either side
 * knowing about the other. Values persist to localStorage (debounced).
 */
export class GameSettings {
    // Graphics
    readonly renderer = new Bindable<RendererPreference>('auto');
    readonly resolutionScale = new BindableNumber(1, 0.5, 1, 0.05);
    readonly uiScale = new BindableNumber(1, 0.8, 1.6, 0.05);
    readonly frameLimit = new Bindable<number>(0);
    readonly showFps = new Bindable(false);
    readonly antialias = new Bindable(true);
    readonly parallax = new Bindable(true);

    // Gameplay
    readonly backgroundDim = new BindableNumber(0.7, 0, 1, 0.01);
    readonly backgroundBlur = new BindableNumber(0, 0, 1, 0.01);
    readonly snakingIn = new Bindable(true);
    readonly snakingOut = new Bindable(true);
    readonly kiaiFlash = new Bindable(false);

    // HUD (lazer's HUD settings, plus per-element toggles)
    readonly hudVisibility = new Bindable<HudVisibility>('always');
    readonly hudScale = new BindableNumber(1, 0.5, 1.6, 0.05);
    readonly hudScore = new Bindable(true);
    readonly hudAccuracy = new Bindable(true);
    readonly hudCombo = new Bindable(true);
    readonly hudHealthBar = new Bindable(true);
    readonly hudHealthWhenCantFail = new Bindable(true);
    readonly hudBreakOverlay = new Bindable(true);
    readonly hitErrorMeter = new Bindable(true);
    readonly keyOverlay = new Bindable(true);
    readonly keyOverlayStyle = new Bindable<KeyOverlayStyle>('lazer');
    readonly progressBar = new Bindable(true);
    readonly progressGraph = new Bindable(true);
    readonly hitLighting = new Bindable(true);
    readonly hideNumbers = new Bindable(false);
    readonly hideGreat = new Bindable(false);
    readonly hideFollowPoints = new Bindable(false);
    readonly backgroundVideo = new Bindable(false);
    readonly fullscreenOnPlay = new Bindable(false);

    // Audio
    readonly masterVolume = new BindableNumber(0.6, 0, 1, 0.01);
    readonly musicVolume = new BindableNumber(1, 0, 1, 0.01);
    readonly effectsVolume = new BindableNumber(1, 0, 1, 0.01);
    readonly audioOffset = new BindableNumber(0, -300, 300, 1);
    readonly uiSounds = new Bindable(true);
    readonly menuMusic = new Bindable(true);
    readonly beatmapHitsounds = new Bindable(true);

    // Input
    readonly keyLeft = new Bindable('KeyZ');
    readonly keyRight = new Bindable('KeyX');
    readonly mouseButtons = new Bindable(true);
    readonly wheelVolumeInGameplay = new Bindable(true);

    // Skin / cursor (defaults and ranges are lazer's)
    readonly menuCursorSize = new BindableNumber(1, 0.5, 2, 0.01);
    /** Gameplay cursor size (lazer's GameplayCursorSize). */
    readonly cursorSize = new BindableNumber(1, 0.1, 2, 0.01);
    readonly autoCursorSize = new Bindable(false);
    readonly cursorTrail = new Bindable(true);
    readonly cursorExpand = new Bindable(true);
    readonly cursorRotation = new Bindable(true);
    readonly gameplayCursorDuringTouch = new Bindable(false);
    readonly hardwareCursor = new Bindable(false);

    // Online
    readonly browseProvider = new Bindable<ProviderId>('sayobot');
    readonly downloadProvider = new Bindable<ProviderId>('mino');

    // Session state worth remembering
    readonly selectedMods = new Bindable<readonly ModAcronym[]>([]);
    readonly playerName = new Bindable('Guest');
    readonly songSort = new Bindable<SongSort>('title');
    readonly lastBeatmap = new Bindable<string>('');

    private readonly registry = new Map<string, Bindable<unknown>>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    /** True when a renderer change needs a reload to apply. */
    readonly restartRequired = new Bindable(false);

    constructor() {
        for (const [key, value] of Object.entries(this)) {
            if (value instanceof Bindable && key !== 'restartRequired') {
                this.registry.set(key, value as Bindable<unknown>);
                value.changed.add(() => this.queueSave());
            }
        }
    }

    /** Load persisted values (or migrate the old site's settings once). */
    load(): void {
        const raw = storageGet(STORAGE_KEY);
        if (raw) {
            try {
                this.apply(JSON.parse(raw) as Record<string, unknown>);
                return;
            } catch (e) {
                console.warn('settings: corrupt saved settings, using defaults', e);
            }
        }
        const legacy = storageGet(LEGACY_KEY);
        if (legacy) {
            try {
                this.apply(migrateLegacySettings(JSON.parse(legacy) as Record<string, unknown>));
                this.saveNow();
            } catch (e) {
                console.warn('settings: legacy migration failed', e);
            }
        }
    }

    /** Apply a plain object of values; unknown keys and bad types are ignored. */
    apply(values: Record<string, unknown>): void {
        // "Show HUD" became lazer's HUD visibility mode.
        if (values.showHud === false && values.hudVisibility === undefined) values = { ...values, hudVisibility: 'never' };
        for (const [key, v] of Object.entries(values)) {
            const b = this.registry.get(key);
            if (!b || v === undefined || v === null) continue;
            const def = b.defaultValue;
            if (ENUM_VALUES[key] && !ENUM_VALUES[key].includes(v as string)) continue;
            if (key === 'selectedMods') {
                if (Array.isArray(v)) b.value = sortedMods(sanitizeMods(v.filter(isModAcronym)));
            } else if (typeof def === 'number') {
                const n = Number(v);
                if (Number.isFinite(n)) b.value = n;
            } else if (typeof v === typeof def) {
                b.value = v;
            }
        }
    }

    toJSON(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [k, b] of this.registry) out[k] = b.value;
        return out;
    }

    resetAll(): void {
        for (const [k, b] of this.registry) {
            if (k === 'selectedMods' || k === 'lastBeatmap' || k === 'playerName') continue;
            b.setDefault();
        }
    }

    private queueSave(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => this.saveNow(), 300);
    }

    saveNow(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        storageSet(STORAGE_KEY, JSON.stringify(this.toJSON()));
    }
}

/**
 * Map the old site's `osugamesettings` object onto the new schema. Old
 * values were percentages/keyCodes stored as strings or numbers.
 */
export function migrateLegacySettings(s: Record<string, unknown>): Record<string, unknown> {
    const num = (k: string): number | undefined => {
        const n = parseFloat(String(s[k]));
        return Number.isFinite(n) ? n : undefined;
    };
    const bool = (k: string): boolean | undefined => (typeof s[k] === 'boolean' ? (s[k] as boolean) : undefined);
    const out: Record<string, unknown> = {};
    const pct = (k: string, dst: string) => {
        const n = num(k);
        if (n !== undefined) out[dst] = Math.min(1, Math.max(0, n / 100));
    };
    pct('dim', 'backgroundDim');
    const blur = num('blur');
    if (blur !== undefined) out.backgroundBlur = Math.min(1, Math.max(0, blur / 8));
    const cs = num('cursorsize');
    if (cs !== undefined) out.cursorSize = cs;
    pct('mastervolume', 'masterVolume');
    pct('musicvolume', 'musicVolume');
    pct('effectvolume', 'effectsVolume');
    const off = num('audiooffset');
    if (off !== undefined) out.audioOffset = off;
    const map: [string, string][] = [
        ['showhwmouse', 'hardwareCursor'], ['snakein', 'snakingIn'], ['snakeout', 'snakingOut'],
        ['cursortrail', 'cursorTrail'], ['cursorpulse', 'cursorExpand'], ['autofullscreen', 'fullscreenOnPlay'],
        ['backgroundVideo', 'backgroundVideo'], ['hideNumbers', 'hideNumbers'], ['hideGreat', 'hideGreat'],
        ['hideFollowPoints', 'hideFollowPoints'], ['beatmapHitsound', 'beatmapHitsounds'],
    ];
    for (const [from, to] of map) {
        const b = bool(from);
        if (b !== undefined) out[to] = b;
    }
    if (bool('disableButton') !== undefined) out.mouseButtons = !s.disableButton;
    if (bool('disableWheel') !== undefined) out.wheelVolumeInGameplay = !s.disableWheel;
    const k1 = keyCodeToCode(num('K1keycode'));
    const k2 = keyCodeToCode(num('K2keycode'));
    if (k1) out.keyLeft = k1;
    if (k2) out.keyRight = k2;
    if (typeof s.apiBrowsing === 'string') out.browseProvider = s.apiBrowsing;
    if (typeof s.apiDownload === 'string') out.downloadProvider = s.apiDownload;
    const legacyMods: [string, ModAcronym][] = [
        ['easy', 'EZ'], ['halftime', 'HT'], ['daycore', 'DC'], ['hardrock', 'HR'], ['doubletime', 'DT'],
        ['nightcore', 'NC'], ['hidden', 'HD'], ['relax', 'RX'], ['autopilot', 'AP'], ['autoplay', 'AT'],
    ];
    out.selectedMods = sortedMods(sanitizeMods(legacyMods.filter(([k]) => s[k] === true).map(([, m]) => m)));
    return out;
}

/** Legacy keyCode → KeyboardEvent.code for the keys people bind. */
export function keyCodeToCode(keyCode: number | undefined): string | null {
    if (keyCode === undefined) return null;
    if (keyCode >= 65 && keyCode <= 90) return 'Key' + String.fromCharCode(keyCode);
    if (keyCode >= 48 && keyCode <= 57) return 'Digit' + String.fromCharCode(keyCode);
    if (keyCode >= 96 && keyCode <= 105) return 'Numpad' + (keyCode - 96);
    const special: Record<number, string> = {
        32: 'Space', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft', 13: 'Enter', 9: 'Tab',
        186: 'Semicolon', 188: 'Comma', 190: 'Period', 191: 'Slash', 219: 'BracketLeft', 221: 'BracketRight',
        222: 'Quote', 220: 'Backslash', 192: 'Backquote', 189: 'Minus', 187: 'Equal',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
    };
    return special[keyCode] ?? null;
}

function storageGet(key: string): string | null {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function storageSet(key: string, value: string): void {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        /* private mode: settings live for this session only */
    }
}
