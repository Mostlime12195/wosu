import type { TextInputHost, TextSink } from '../ui/UIContext';

/**
 * Bridge between the browser's text-entry machinery and Pixi text boxes.
 *
 * All text fields are drawn by Pixi, but only a focused native input can
 * receive IME composition (e.g. Japanese song titles), paste, autocorrect
 * and — on phones — summon the soft keyboard. One invisible input element
 * does that job for every Pixi TextBox; it is never visible UI.
 */
export class TextInputProxy implements TextInputHost {
    private readonly el: HTMLInputElement;
    private sink: TextSink | null = null;
    private composing = false;
    /**
     * Set when a text box takes focus during the current pointer press. The
     * canvas is focusable, so the browser's default mousedown action would
     * move focus to it and blur this input straight after the box focused
     * it (the "click does nothing, typing still works" bug).
     */
    private holdPress = false;
    /** Blur events caused by our own re-focus dance (touch keyboard). */
    private refocusing = false;

    constructor() {
        const el = document.createElement('input');
        el.type = 'text';
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocorrect', 'off');
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('spellcheck', 'false');
        el.setAttribute('aria-hidden', 'true');
        el.tabIndex = -1;
        // 16px font stops iOS from zooming the page when focusing.
        el.style.cssText =
            'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;margin:0;' +
            'font-size:16px;pointer-events:none;caret-color:transparent;background:transparent;color:transparent;z-index:-1;';
        document.body.appendChild(el);
        this.el = el;

        el.addEventListener('input', () => this.push());
        el.addEventListener('compositionstart', () => (this.composing = true));
        el.addEventListener('compositionend', () => {
            this.composing = false;
            this.push();
        });
        el.addEventListener('keydown', e => this.onKeyDown(e));
        el.addEventListener('keyup', () => this.push());
        el.addEventListener('select', () => this.push());
        el.addEventListener('blur', () => {
            // The browser took focus away (tab switch, tapping elsewhere on
            // mobile); keep our state consistent.
            if (this.refocusing) return;
            if (this.sink && document.activeElement !== el) {
                const s = this.sink;
                this.sink = null;
                s.onFocusLost();
            }
        });

        // Capture phase on window: runs before Pixi's canvas listener, so a
        // new press starts unclaimed and a text box can claim it.
        window.addEventListener('pointerdown', () => (this.holdPress = false), { capture: true });
        window.addEventListener('mousedown', e => {
            if (this.holdPress && this.sink) e.preventDefault();
        }, { capture: true });
        window.addEventListener('pointerup', e => {
            // Soft keyboards only open for a focus() inside a user-activation
            // event, and a touch pointerdown isn't one; pointerup is.
            if (e.pointerType === 'mouse' || !this.holdPress || !this.sink) return;
            const el = this.el;
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? el.value.length;
            const dir = el.selectionDirection ?? 'none';
            this.refocusing = true;
            try {
                if (document.activeElement === el) el.blur();
                el.focus({ preventScroll: true });
                el.setSelectionRange(start, end, dir);
            } catch {
                /* ignore */
            } finally {
                this.refocusing = false;
            }
        }, { capture: true });
    }

    get focused(): TextSink | null {
        return this.sink;
    }

    get isComposing(): boolean {
        return this.composing;
    }

    /** Keep native focus on the proxy through the current pointer press. */
    holdFocus(): void {
        this.holdPress = true;
    }

    focus(sink: TextSink): () => void {
        this.holdPress = true;
        if (this.sink === sink) return () => {
            if (this.sink === sink) this.blur();
        };
        if (this.sink && this.sink !== sink) {
            const prev = this.sink;
            this.sink = null;
            prev.onFocusLost();
        }
        this.sink = sink;
        this.el.value = sink.value;
        try {
            this.el.focus({ preventScroll: true });
            const end = sink.value.length;
            this.el.setSelectionRange(end, end);
        } catch {
            /* focusing can fail outside a user gesture; keyboard still works */
        }
        return () => {
            if (this.sink === sink) this.blur();
        };
    }

    blur(): void {
        const s = this.sink;
        this.sink = null;
        try {
            this.el.blur();
        } catch {
            /* ignore */
        }
        s?.onFocusLost();
    }

    /**
     * Keep the native element in sync after a programmatic change. `caret`
     * is the moving end of the selection and `anchor` the fixed one, so a
     * backwards selection (drag or shift+click to the left) survives the
     * round trip instead of collapsing.
     */
    sync(value: string, caret: number, anchor: number = caret): void {
        if (!this.sink) return;
        if (this.el.value !== value) this.el.value = value;
        try {
            this.el.setSelectionRange(Math.min(caret, anchor), Math.max(caret, anchor), caret < anchor ? 'backward' : 'forward');
        } catch {
            /* ignore */
        }
    }

    private push(): void {
        const s = this.sink;
        if (!s) return;
        const len = this.el.value.length;
        const start = this.el.selectionStart ?? len;
        const end = this.el.selectionEnd ?? len;
        const backward = this.el.selectionDirection === 'backward';
        s.applyInput(this.el.value, backward ? start : end, backward ? end : start);
    }

    private onKeyDown(e: KeyboardEvent): void {
        const s = this.sink;
        if (!s) return;
        if (this.composing || e.isComposing) return;
        if (s.onSpecialKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // Caret movement keys change the selection without an input event.
        setTimeout(() => this.push(), 0);
    }
}
