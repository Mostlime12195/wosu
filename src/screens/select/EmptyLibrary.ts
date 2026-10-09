import { Container, Graphics, type Text, type Texture } from 'pixi.js';
import { Button } from '../../ui/Button';
import { icon } from '../../ui/icons';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

/**
 * Shown instead of the carousel while the library has no beatmaps (every
 * new player starts here): where to get maps, as two big buttons, plus
 * the drag-and-drop hint.
 */
export class EmptyLibraryState extends UIComponent {
    readonly browse: Button;
    readonly importFiles: Button;
    private readonly content = new Container();
    private readonly ring = new Graphics();
    private readonly glyph: Text;
    private readonly title: Text;
    private readonly body: Text;
    private readonly hint: Text;
    private readonly hintIcon: Text;

    constructor(triangles: Texture) {
        super();
        this.glyph = icon('music', 34, 0xffffff);
        this.ring.circle(0, 0, 46).fill({ color: Colors.pink, alpha: 0.2 }).circle(0, 0, 46).stroke({ width: 3, color: Colors.pink });
        this.title = label('Your library is empty', { size: 32, weight: '700', align: 'center' });
        this.body = label('Download beatmaps from the online listing,\nor import .osz files you already have.', {
            size: 17, weight: '500', color: Colors.grayD, align: 'center', lineHeight: 26,
        });
        this.browse = new Button('Browse beatmaps', { color: Colors.purple, icon: 'download', width: 260, height: 54, fontSize: 18, triangles });
        this.importFiles = new Button('Import .osz', { color: Colors.blueDarker, icon: 'fileImport', width: 260, height: 54, fontSize: 18, triangles });
        this.hintIcon = icon('upload', 14, Colors.grayA);
        this.hint = label('Tip: drag and drop .osz files anywhere onto this window to import them.', { size: 14, weight: '500', color: Colors.grayA });
        for (const t of [this.title, this.body]) t.anchor.set(0.5, 0);
        this.hint.anchor.set(0, 0.5);
        this.content.addChild(this.ring, this.glyph, this.title, this.body, this.browse, this.importFiles, this.hintIcon, this.hint);
        this.addChild(this.content);
        this.eventMode = 'passive';
        this.resize(800, 500);
    }

    protected override onResize(w: number, h: number): void {
        // Content is laid out around x = 0 and centred vertically.
        let y = 46;
        this.ring.position.set(0, y);
        this.glyph.position.set(0, y);
        y += 46 + 26;
        this.title.position.set(0, y);
        y += 48;
        this.body.position.set(0, y);
        y += this.body.height + 30;
        const gap = 16;
        const side = w >= 2 * 260 + gap + 40;
        if (side) {
            this.browse.position.set(-260 - gap / 2, y);
            this.importFiles.position.set(gap / 2, y);
            y += 54;
        } else {
            this.browse.position.set(-130, y);
            this.importFiles.position.set(-130, y + 54 + 12);
            y += 54 * 2 + 12;
        }
        y += 30;
        const hintW = this.hint.width + 22;
        this.hintIcon.position.set(-hintW / 2 + 7, y);
        this.hint.position.set(-hintW / 2 + 22, y);
        y += 12;
        const scale = Math.min(1, (h - 20) / y, (w - 20) / Math.max(hintW, 540));
        this.content.scale.set(scale);
        this.content.position.set(Math.round(w / 2), Math.round((h - y * scale) / 2));
    }
}
