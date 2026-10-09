/**
 * Interface sounds: osu!lazer's own UI samples (public/assets/samples,
 * from ppy/osu-resources), played through the effects bus so the effect
 * volume applies. Samples load in the background at startup; anything
 * asked for before it has loaded is simply skipped.
 */
import type { AudioEngine } from './AudioEngine';
import { resolveAssetUrl } from './base';

/** Every sample, by its lazer path (folder/name, no extension). */
export const UI_SAMPLES = [
    'UI/default-hover', 'UI/default-select', 'UI/default-select-disabled',
    'UI/button-hover', 'UI/button-select', 'UI/button-sidebar-hover', 'UI/button-sidebar-select',
    'UI/check-on', 'UI/check-off',
    'UI/dialog-cancel-select', 'UI/dialog-dangerous-select', 'UI/dialog-dangerous-tick', 'UI/dialog-ok-select',
    'UI/dialog-pop-in', 'UI/dialog-pop-out',
    'UI/dropdown-open', 'UI/dropdown-close', 'UI/generic-error',
    'UI/menu-open', 'UI/menu-close', 'UI/notch-tick',
    'UI/notification-default', 'UI/notification-done', 'UI/notification-error', 'UI/notification-cancel',
    'UI/osd-change', 'UI/osd-on', 'UI/osd-off',
    'UI/overlay-pop-in', 'UI/overlay-pop-out', 'UI/overlay-big-pop-in', 'UI/overlay-big-pop-out',
    'UI/screen-back', 'UI/settings-pop-in', 'UI/tabselect-select',
    'UI/toolbar-hover', 'UI/toolbar-select', 'UI/wave-pop-in', 'UI/wave-pop-out',
    'UI/cursor-tap', 'UI/scroll-to-top', 'UI/submit-select',
    'Menu/back-to-logo', 'Menu/back-to-top', 'Menu/button-default-select', 'Menu/button-hover',
    'Menu/button-play-select', 'Menu/osu-logo-select', 'Menu/osu-logo-swoosh', 'Menu/reappear-swoosh',
    'Keyboard/key-press-1', 'Keyboard/key-press-2', 'Keyboard/key-press-3', 'Keyboard/key-press-4',
    'Keyboard/key-delete', 'Keyboard/key-confirm', 'Keyboard/key-movement', 'Keyboard/key-caps', 'Keyboard/key-invalid',
    'Keyboard/select-all', 'Keyboard/select-char', 'Keyboard/select-word', 'Keyboard/deselect',
    'SongSelect/confirm-selection', 'SongSelect/select-difficulty', 'SongSelect/select-expand',
    'SongSelect/select-random', 'SongSelect/random-spin', 'SongSelect/options-pop-in', 'SongSelect/options-pop-out',
    'SongSelect/mod-column-pop-in', 'SongSelect/mod-select-overlay-pop-out',
    'Results/rank-impact-pass', 'Results/rank-impact-pass-ss', 'Results/rank-impact-fail', 'Results/rank-impact-fail-d',
    'Results/badge-dink', 'Results/badge-dink-max', 'Results/score-tick', 'Results/swoosh-up',
    'Results/applause-s', 'Results/applause-a', 'Results/applause-b', 'Results/applause-c', 'Results/applause-d',
    'Gameplay/failsound',
] as const;

export type UISampleName = (typeof UI_SAMPLES)[number];

export interface UIPlayOptions {
    /** Linear gain on top of the effects bus (default 1). */
    volume?: number;
    /** Playback rate / pitch (default 1). */
    rate?: number;
    /** Per-sample minimum gap in ms, so rapid repeats don't pile up. */
    throttle?: number;
}

/** lazer's HoverSampleSet: which hover/select pair an element uses. */
export type SampleSet = 'default' | 'button' | 'toolbar' | 'tab' | 'submit' | 'sidebar' | 'menu';

const SETS: Record<SampleSet, [hover: UISampleName, select: UISampleName]> = {
    default: ['UI/default-hover', 'UI/default-select'],
    button: ['UI/button-hover', 'UI/button-select'],
    toolbar: ['UI/toolbar-hover', 'UI/toolbar-select'],
    tab: ['UI/default-hover', 'UI/tabselect-select'],
    submit: ['UI/button-hover', 'UI/submit-select'],
    sidebar: ['UI/button-sidebar-hover', 'UI/button-sidebar-select'],
    menu: ['Menu/button-hover', 'Menu/button-default-select'],
};

/** lazer's HoverSampleDebounceTime. */
const HOVER_DEBOUNCE_MS = 50;

export class UISounds {
    /** Master switch (bound to the "Interface sounds" setting). */
    enabled = true;
    /** Extra scale on top of the effects bus. */
    volume = 1;

    private readonly buffers = new Map<UISampleName, AudioBuffer>();
    private readonly lastPlayed = new Map<string, number>();
    private loading: Promise<void> | null = null;

    constructor(private readonly engine: AudioEngine, private readonly fetcher: (url: string) => Promise<Response> = url => fetch(url)) {}

    /** Fetch and decode every sample (failures are skipped). Idempotent. */
    load(baseUrl: string = resolveAssetUrl('assets/samples/')): Promise<void> {
        this.loading ??= Promise.all(UI_SAMPLES.map(async name => {
            try {
                const res = await this.fetcher(`${baseUrl}${name}.mp3`);
                if (!res.ok) return;
                const buffer = await this.engine.context.decodeAudioData(await res.arrayBuffer());
                this.buffers.set(name, buffer);
            } catch {
                /* a missing UI sound is not worth an error */
            }
        })).then(() => undefined);
        return this.loading;
    }

    /** Play one sample. Returns false when it couldn't (muted, not loaded, throttled). */
    play(name: UISampleName, opts: UIPlayOptions = {}): boolean {
        if (!this.enabled || !(this.volume > 0) || this.engine.context.state !== 'running') return false;
        const buffer = this.buffers.get(name);
        if (!buffer) return false;
        if (opts.throttle) {
            const now = performance.now();
            if (now - (this.lastPlayed.get(name) ?? -Infinity) < opts.throttle) return false;
            this.lastPlayed.set(name, now);
        }
        const ctx = this.engine.context;
        try {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            if (opts.rate && opts.rate !== 1) src.playbackRate.value = opts.rate;
            const gain = ctx.createGain();
            gain.gain.value = Math.min(2, (opts.volume ?? 1) * this.volume);
            src.connect(gain);
            gain.connect(this.engine.effectsBus);
            src.onended = () => {
                try { gain.disconnect(); } catch { /* ignore */ }
            };
            src.start();
            return true;
        } catch {
            return false;
        }
    }

    // Generic interactions (lazer's HoverSampleSet.Default and friends).

    hover(set: SampleSet = 'default'): void {
        // One shared debounce across sets, like lazer's.
        const now = performance.now();
        if (now - (this.lastPlayed.get('hover') ?? -Infinity) < HOVER_DEBOUNCE_MS) return;
        if (this.play(SETS[set][0], { rate: 0.98 + Math.random() * 0.04 })) this.lastPlayed.set('hover', now);
    }

    click(set: SampleSet = 'default'): void {
        this.play(SETS[set][1]);
    }

    /** A click on something disabled. */
    denied(): void {
        this.play('UI/default-select-disabled');
    }

    select(): void {
        this.play('UI/button-select');
    }

    back(): void {
        this.play('UI/screen-back');
    }

    toggleOn(): void {
        this.play('UI/check-on');
    }

    toggleOff(): void {
        this.play('UI/check-off');
    }

    notify(): void {
        this.play('UI/notification-default');
    }

    error(): void {
        this.play('UI/notification-error');
    }

    /** lazer's OsuTextBox: a random key press, pitch-shifted slightly. */
    typed(): void {
        const n = 1 + Math.floor(Math.random() * 4);
        this.play(`Keyboard/key-press-${n}` as UISampleName, { rate: 0.96 + Math.random() * 0.08, throttle: 15 });
    }

    /** Slider bars: a notch tick, pitched up with the value (lazer's OsuSliderBar). */
    tick(normalized: number): void {
        this.play('UI/notch-tick', { rate: 1 + Math.max(0, Math.min(1, normalized)) * 0.2, throttle: 30 });
    }
}
