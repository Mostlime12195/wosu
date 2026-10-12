import { Container, Graphics, type Text } from 'pixi.js';
import { icon } from '../../ui/icons';
import { fitText, label } from '../../ui/text';
import { Colors } from '../../ui/theme';

/**
 * Shown while watching a replay: a "REPLAY" tag and osu!'s "Watching
 * <player> play <map>" line at the top centre of gameplay.
 */
export class ReplayIndicator extends Container {
    private readonly pill = new Graphics();
    private readonly glyph: Text;
    private readonly tag: Text;
    private readonly line: Text;

    constructor(private readonly text: string) {
        super();
        this.glyph = icon('play', 10, 0x222222);
        this.glyph.anchor.set(0, 0.5);
        this.tag = label('REPLAY', { size: 12, weight: '800', color: 0x222222, letterSpacing: 1 });
        this.tag.anchor.set(0, 0.5);
        this.line = label(text, { size: 15, weight: '600', shadow: true });
        this.line.anchor.set(0.5, 0);
        this.addChild(this.pill, this.glyph, this.tag, this.line);
        this.eventMode = 'none';
    }

    layout(w: number, h: number): void {
        const pillW = 10 + this.glyph.width + 5 + this.tag.width + 10;
        const top = Math.round(Math.max(10, h * 0.02));
        this.pill.clear().roundRect(-pillW / 2, top, pillW, 20, 10).fill(Colors.yellow);
        this.glyph.position.set(-pillW / 2 + 10, top + 10);
        this.tag.position.set(this.glyph.x + this.glyph.width + 5, top + 10);
        fitText(this.line, Math.max(100, w * 0.5), this.text);
        this.line.position.set(0, top + 26);
        this.x = Math.round(w / 2);
    }
}
