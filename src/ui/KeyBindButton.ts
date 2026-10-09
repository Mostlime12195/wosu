import type { Text } from 'pixi.js';
import type { Bindable } from '../core/Bindable';
import { tween } from '../core/Tweener';
import { codeLabel } from '../input/bindings';
import { Box } from './Box';
import { label, fitText } from './text';
import { Colors } from './theme';
import { UIComponent } from './UIComponent';

/**
 * Settings row for one key binding (lazer KeyBindingRow): click, then
 * press a key. Escape cancels; the binding stores a KeyboardEvent.code.
 */
export class KeyBindButton extends UIComponent {
    private readonly caption: Text;
    private readonly keyBox: Box;
    private readonly keyText: Text;
    private listening = false;
    private release: (() => void) | null = null;
    /** Installed by the game: captures the next key at top priority. */
    static capture: ((fn: (e: KeyboardEvent) => boolean) => () => void) | null = null;

    constructor(captionText: string, private readonly bindable: Bindable<string>) {
        super();
        this.caption = label(captionText, { size: 15, weight: '500' });
        this.caption.anchor.set(0, 0.5);
        this.keyBox = new Box({ color: 0x000000, alpha: 0.5, radius: 5 });
        this.keyText = label('', { size: 14, weight: '700' });
        this.keyText.anchor.set(0.5);
        this.addChild(this.caption, this.keyBox, this.keyText);
        this.makeInteractive();
        this.disposer.add(bindable.bind(() => this.refresh(), true));
        this.resize(300, 36);
    }

    private refresh(): void {
        this.keyText.text = this.listening ? 'press a key…' : codeLabel(this.bindable.value);
        fitText(this.keyText, 110, this.keyText.text);
    }

    protected override onResize(w: number, h: number): void {
        this.caption.position.set(0, h / 2);
        fitText(this.caption, w - 140, this.caption.text);
        this.keyBox.position.set(w - 120, 3);
        this.keyBox.resize(120, h - 6);
        this.keyText.position.set(w - 60, h / 2);
    }

    protected override onClick(): void {
        if (this.listening) {
            this.stop();
            return;
        }
        if (!KeyBindButton.capture) return;
        this.listening = true;
        this.keyBox.setBorder({ width: 2, color: Colors.yellow });
        this.refresh();
        this.release = KeyBindButton.capture(e => {
            if (e.code !== 'Escape') this.bindable.value = e.code;
            this.stop();
            return true;
        });
    }

    /** Stop waiting for a key (the panel closed). */
    cancel(): void {
        if (this.listening) this.stop();
    }

    private stop(): void {
        this.listening = false;
        this.release?.();
        this.release = null;
        this.keyBox.setBorder(undefined);
        this.refresh();
        this.keyText.scale.set(1.2);
        tween(this.keyText, { scale: 1 }, { duration: 300, ease: 'OutElastic' });
    }

    override destroy(options?: Parameters<UIComponent['destroy']>[0]): void {
        this.release?.();
        super.destroy(options);
    }
}
