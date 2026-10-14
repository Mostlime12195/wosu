import type { FederatedPointerEvent, Text } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Bindable } from '../../core/Bindable';
import { tween } from '../../core/Tweener';
import {
    BINDING_SECTIONS,
    DEFAULT_BINDINGS,
    MAX_BINDINGS_PER_ACTION,
    bindAction,
    bindingFromEvent,
    bindingLabel,
    captionOf,
    isModifierCode,
    overridesFor,
    resolveBindings,
    type Action,
} from '../../input/bindings';
import { Box } from '../../ui/Box';
import { KeyBindButton } from '../../ui/KeyBindButton';
import { fitText, label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { buttonRow, SettingsRow } from './rows';
import type { SubsectionDef } from './types';

const SEP = '\n';
const SLOT_GAP = 6;
const SLOT_MIN_W = 46;
const SLOT_MAX_W = 120;

/**
 * One key combination of an action (lazer's KeyButton): click, then press
 * the new combination (modifiers + key, or the middle / side mouse
 * buttons). Esc cancels (except for Back, which it binds); right-click
 * clears the slot.
 */
class BindingSlot extends UIComponent {
    private readonly box = new Box({ color: 0x000000, alpha: 0.5, radius: 5 });
    private readonly text: Text;
    binding: string | null = null;
    listening = false;
    onStart: ((slot: BindingSlot) => void) | null = null;
    onClear: ((slot: BindingSlot) => void) | null = null;

    constructor() {
        super();
        this.text = label('', { size: 13, weight: '700' });
        this.text.anchor.set(0.5);
        this.addChild(this.box, this.text);
        this.makeInteractive();
        this.on('rightclick', (e: FederatedPointerEvent) => {
            e.stopPropagation();
            if (this.binding) this.onClear?.(this);
        });
        this.tooltip = 'Click to change, right-click to clear';
    }

    /** Width this slot wants for its label. */
    get preferredWidth(): number {
        return Math.max(SLOT_MIN_W, Math.min(SLOT_MAX_W, this.text.width + 20));
    }

    setBinding(binding: string | null): void {
        this.binding = binding;
        this.refresh();
    }

    setListening(on: boolean): void {
        if (this.listening === on) return;
        this.listening = on;
        this.box.setBorder(on ? { width: 2, color: Colors.yellow } : undefined);
        this.refresh();
        if (!on) {
            this.text.scale.set(1.2);
            tween(this.text, { scale: 1 }, { duration: 300, ease: 'OutElastic' });
        }
    }

    private refresh(): void {
        const t = this.listening ? 'press a key…' : this.binding ? bindingLabel(this.binding) : '+';
        this.text.text = t;
        fitText(this.text, SLOT_MAX_W - 12, t);
        this.text.alpha = this.binding || this.listening ? 1 : 0.45;
    }

    protected override onResize(w: number, h: number): void {
        this.box.resize(w, h);
        this.text.position.set(w / 2, h / 2);
    }

    protected override onHoverChange(hovered: boolean): void {
        this.box.alpha = hovered ? 0.7 : 0.5;
    }

    protected override onClick(): void {
        this.onStart?.(this);
    }
}

/** lazer's KeyBindingRow: the action's name, then its bindings as buttons (plus an empty slot to add one). */
export class ActionBindControl extends UIComponent {
    private readonly caption: Text;
    private readonly slots: BindingSlot[] = [];
    private release: (() => void) | null = null;
    private active: BindingSlot | null = null;

    constructor(private readonly game: Game, private readonly action: Action) {
        super();
        this.caption = label(captionOf(action), { size: 15, weight: '500' });
        this.caption.anchor.set(0, 0.5);
        this.addChild(this.caption);
        for (let i = 0; i < MAX_BINDINGS_PER_ACTION; i++) {
            const slot = new BindingSlot();
            slot.onStart = s => this.start(s);
            slot.onClear = s => this.write(this.slots.indexOf(s), null);
            this.slots.push(slot);
            this.addChild(slot);
        }
        this.disposer.add(game.settings.keyBindings.bind(() => this.refresh(), true));
        this.resize(300, 36);
    }

    private refresh(): void {
        const list = this.game.input.bindings[this.action] ?? [];
        this.slots.forEach((s, i) => {
            s.setBinding(list[i] ?? null);
            // Bound slots, then one empty slot to add another.
            s.visible = i <= list.length;
        });
        this.layout();
    }

    private start(slot: BindingSlot): void {
        if (this.active === slot) {
            this.cancel();
            return;
        }
        this.cancel();
        if (!KeyBindButton.capture) return;
        this.active = slot;
        slot.setListening(true);
        this.layout();
        this.release = KeyBindButton.capture(e => {
            if (isModifierCode(e.code)) return true; // wait for the key itself
            if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && this.action !== 'back') {
                this.cancel();
                return true;
            }
            this.write(this.slots.indexOf(slot), bindingFromEvent(e));
            this.cancel();
            return true;
        });
    }

    /** Stop waiting for a key (the panel closed, or another slot was clicked). */
    cancel(): void {
        this.release?.();
        this.release = null;
        const a = this.active;
        this.active = null;
        a?.setListening(false);
        this.layout();
    }

    private write(slot: number, binding: string | null): void {
        const s = this.game.settings;
        const { bindings, displaced } = bindAction(this.game.input.bindings, this.action, slot, binding);
        s.keyBindings.value = overridesFor(bindings);
        if (binding && displaced.length) {
            this.game.notifications.info(`${bindingLabel(binding)} was unbound from ${displaced.map(captionOf).join(', ')}.`);
        }
    }

    protected override onResize(): void {
        this.layout();
    }

    private layout(): void {
        if (!this.slots?.length) return;
        const w = this._w, h = this._h;
        let x = w;
        for (let i = this.slots.length - 1; i >= 0; i--) {
            const s = this.slots[i];
            if (!s.visible) continue;
            const sw = s.preferredWidth;
            x -= sw;
            s.resize(sw, h - 6);
            s.position.set(x, 3);
            x -= SLOT_GAP;
        }
        this.caption.position.set(0, h / 2);
        fitText(this.caption, Math.max(40, x - 8), captionOf(this.action));
    }

    override destroy(options?: Parameters<UIComponent['destroy']>[0]): void {
        this.release?.();
        super.destroy(options);
    }
}

/**
 * The action's bindings as one restorable value (joined), so the settings
 * row's restore-default pill shows while they differ from lazer's defaults.
 */
function actionBindable(game: Game, action: Action): { bindable: Bindable<string>; dispose: () => void } {
    const s = game.settings.keyBindings;
    const b = new Bindable(DEFAULT_BINDINGS[action].join(SEP));
    let syncing = false;
    const off = s.bind(v => {
        syncing = true;
        b.value = resolveBindings(v)[action].join(SEP);
        syncing = false;
    }, true);
    const offB = b.bind(v => {
        if (syncing) return;
        const next = resolveBindings(s.value);
        next[action] = v ? v.split(SEP) : [];
        s.value = overridesFor(next);
    });
    return { bindable: b, dispose: () => { off(); offB(); } };
}

export function actionBindRow(game: Game, action: Action, keywords = ''): SettingsRow {
    const control = new ActionBindControl(game, action);
    const { bindable, dispose } = actionBindable(game, action);
    const row = new SettingsRow(control, `${captionOf(action)} key binding hotkey shortcut`, bindable, { keywords });
    row.onPanelHide = () => control.cancel();
    row.on('destroyed', dispose);
    return row;
}

/** lazer's global key binding sections, plus "reset all". */
export function actionBindingSubsections(game: Game): SubsectionDef[] {
    const subsections: SubsectionDef[] = BINDING_SECTIONS.map(section => ({
        title: `${section.title} key bindings`,
        rows: section.actions.map(a => actionBindRow(game, a.action, `${section.title} ${a.keywords ?? ''}`)),
    }));
    subsections[subsections.length - 1].rows.push(buttonRow('Reset all key bindings', () => {
        game.settings.keyBindings.value = {};
        game.notifications.info('Key bindings were reset to their defaults.');
    }, { color: Colors.pinkDark, icon: 'rotate', keywords: 'restore default hotkeys shortcuts' }));
    return subsections;
}
