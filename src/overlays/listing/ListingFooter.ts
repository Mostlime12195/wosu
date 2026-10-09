import { Container, type Text } from 'pixi.js';
import { Button } from '../../ui/Button';
import { icon, Icons, type IconName } from '../../ui/icons';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { label } from '../../ui/text';
import { Colors, type ColorProvider } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

export type FooterState =
    | { kind: 'none' }
    | { kind: 'loading'; initial: boolean }
    | { kind: 'error'; message: string }
    | { kind: 'empty'; icon: IconName; message: string; detail?: string };

/**
 * Below the grid: the loading spinner (big while the first page loads),
 * an error with a Retry button, or the empty-results message.
 */
export class ListingFooter extends UIComponent {
    private readonly spinner = new LoadingSpinner(18, 0xffffff, 4);
    private readonly notice = new Container();
    private readonly glyph: Text;
    private readonly message: Text;
    private readonly detail: Text;
    private readonly retry: Button;
    private state: FooterState = { kind: 'none' };
    onRetry: (() => void) | null = null;

    constructor(colors: ColorProvider) {
        super();
        this.glyph = icon('search', 34, colors.light3);
        this.message = label('', { size: 18, weight: '600', align: 'center' });
        this.message.anchor.set(0.5, 0);
        this.detail = label('', { size: 13, weight: '500', color: colors.light3, align: 'center' });
        this.detail.anchor.set(0.5, 0);
        this.retry = new Button('Retry', { color: Colors.blueDarker, width: 120, height: 36, fontSize: 14 });
        this.retry.onActivate = () => this.onRetry?.();
        this.notice.addChild(this.glyph, this.message, this.detail, this.retry);
        this.addChild(this.spinner, this.notice);
        this.eventMode = 'passive';
        this.setState({ kind: 'none' });
    }

    setState(s: FooterState): void {
        this.state = s;
        this.spinner.visible = s.kind === 'loading';
        this.notice.visible = s.kind === 'error' || s.kind === 'empty';
        if (s.kind === 'error') {
            this.glyph.text = Icons.warning;
            this.message.text = "couldn't load beatmaps";
            this.detail.text = `${s.message} — the mirror may be down; try again or switch mirrors in settings.`;
        } else if (s.kind === 'empty') {
            this.glyph.text = Icons[s.icon];
            this.message.text = s.message;
            this.detail.text = s.detail ?? '';
        }
        this.retry.visible = s.kind === 'error';
        this.relayout();
    }

    /** Space the footer needs below the grid. */
    get preferredHeight(): number {
        switch (this.state.kind) {
            case 'loading': return this.state.initial ? 220 : 90;
            case 'error': return 210;
            case 'empty': return 200;
            default: return 30;
        }
    }

    protected override onResize(w: number): void {
        const cx = w / 2;
        const initial = this.state.kind === 'loading' && this.state.initial;
        this.spinner.position.set(cx - this.spinner.w / 2, initial ? 80 : 26);
        this.glyph.position.set(cx, 50);
        this.message.position.set(cx, 82);
        this.detail.position.set(cx, 110);
        this.retry.position.set(cx - this.retry.w / 2, 142);
    }
}
