import { Graphics, type Text } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { icon, Icons } from '../../ui/icons';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

export type PreviewState = 'idle' | 'loading' | 'playing';

/** Ring thickness relative to its radius (lazer's CircularProgress InnerRadius = 0.2). */
const RING_THICKNESS = 0.2;

/**
 * Audio preview toggle (lazer's PlayButton + the CircularProgress in
 * BeatmapCardThumbnail): play glyph, stop glyph while playing with a
 * progress ring sweeping clockwise from the top, and a small spinner in
 * place of the glyph while the clip loads. Taps don't bubble to the card.
 */
export class PreviewButton extends UIComponent {
    private readonly disc = new Graphics();
    private readonly ring = new Graphics();
    private readonly spinner = new Graphics();
    private readonly glyph: Text;
    private state: PreviewState = 'idle';
    private spin = 0;
    /** Displayed progress, advanced every frame and re-synced to the clip. */
    private shown = 0;
    private lastDrawn = -1;

    /**
     * @param radius button radius; the ring's outer edge sits on it
     * @param ringColor lazer uses the overlay's Highlight1
     */
    constructor(
        private readonly radius: number,
        private readonly iconSize: number,
        private readonly discAlpha = 0,
        private readonly ringColor = 0xffffff,
    ) {
        super();
        this.glyph = icon('play', iconSize, 0xffffff);
        this.spinner.alpha = 0;
        this.addChild(this.disc, this.ring, this.glyph, this.spinner);
        this.makeInteractive();
        this.on('pointertap', e => e.stopPropagation());
        this.resize(radius * 2, radius * 2);
        this.tooltip = 'preview';
    }

    get previewState(): PreviewState {
        return this.state;
    }

    setState(s: PreviewState): void {
        if (s === this.state) return;
        const prev = this.state;
        this.state = s;
        this.glyph.text = Icons[s === 'idle' ? 'play' : 'stop'];
        this.layoutGlyph();
        this.tooltip = s === 'idle' ? 'preview' : 'stop preview';
        // lazer swaps the glyph for a spinner while the clip loads.
        const loading = s === 'loading';
        tween(this.glyph, { alpha: loading ? 0 : 1 }, { duration: 200, ease: 'OutQuint' });
        tween(this.spinner, { alpha: loading ? 1 : 0 }, { duration: 200, ease: 'OutQuint' });
        if (s === 'playing') {
            this.shown = 0;
            this.lastDrawn = -1;
            this.ring.alpha = 1;
            this.ring.clear();
        } else if (prev === 'playing') {
            // Stopped or finished: fade the ring rather than snapping it away.
            tween(this.ring, { alpha: 0 }, { duration: 200, ease: 'OutQuint', onComplete: () => this.state !== 'playing' && this.ring.clear() });
        }
    }

    /**
     * Per-frame while not idle. `progress` is 0..1 (NaN while unknown) and
     * `durationMs` the clip length: media clocks report in coarse steps, so
     * the ring advances at the clip's rate and only re-syncs on drift.
     */
    tick(dt: number, progress: number, durationMs = NaN): void {
        if (this.spinner.alpha > 0) this.drawSpinner(dt);
        if (this.state !== 'playing') return;
        if (!Number.isFinite(progress)) return;
        const p = Math.max(0, Math.min(1, progress));
        if (Number.isFinite(durationMs) && durationMs > 0) {
            this.shown += dt / durationMs;
            if (Math.abs(p - this.shown) > 0.03 || p >= 1) this.shown = p;
        } else {
            this.shown = p;
        }
        this.shown = Math.max(0, Math.min(1, this.shown));
        this.drawRing(this.shown);
    }

    private drawRing(p: number): void {
        const key = Math.round(p * 2000);
        if (key === this.lastDrawn) return;
        this.lastDrawn = key;
        const g = this.ring.clear();
        if (p <= 0) return;
        const w = this.radius * RING_THICKNESS;
        const r = this.radius - w / 2;
        const c = this.radius;
        if (p >= 1) {
            g.circle(c, c, r).stroke({ width: w, color: this.ringColor });
            return;
        }
        const a0 = -Math.PI / 2;
        const a1 = a0 + p * Math.PI * 2;
        // moveTo first: without it the arc is joined to the previous path
        // point by a straight segment (the old stray line from the left).
        g.moveTo(c + Math.cos(a0) * r, c + Math.sin(a0) * r)
            .arc(c, c, r, a0, a1)
            .stroke({ width: w, color: this.ringColor, cap: 'butt' });
    }

    private drawSpinner(dt: number): void {
        this.spin += dt / 300;
        const c = this.radius;
        const r = this.iconSize * 0.42;
        const a0 = this.spin;
        const a1 = a0 + Math.PI * 1.4;
        this.spinner.clear()
            .moveTo(c + Math.cos(a0) * r, c + Math.sin(a0) * r)
            .arc(c, c, r, a0, a1)
            .stroke({ width: Math.max(2, this.iconSize * 0.16), color: 0xffffff, cap: 'round' });
    }

    private layoutGlyph(): void {
        // Optical centring: the play triangle is weighted to the left.
        this.glyph.position.set(this._w / 2 + (this.state === 'idle' ? 1 : 0), this._h / 2);
    }

    protected override onResize(w: number, h: number): void {
        this.disc.clear().circle(w / 2, h / 2, Math.min(w, h) / 2).fill({ color: 0x000000, alpha: 1 });
        this.disc.alpha = this.discAlpha;
        this.layoutGlyph();
        this.lastDrawn = -1;
    }

    protected override onHoverChange(hovered: boolean): void {
        // lazer's OsuHoverContainer turns the icon yellow on hover.
        this.glyph.tint = hovered ? Colors.yellow : 0xffffff;
        tween(this.glyph, { scale: hovered ? 1.15 : 1 }, { duration: 300, ease: 'OutQuint' });
        tween(this.disc, { alpha: hovered ? Math.min(1, this.discAlpha + 0.25) : this.discAlpha }, { duration: 200 });
    }

    protected override onPressChange(pressed: boolean): void {
        tween(this.glyph, { scale: pressed ? 0.9 : this.hovered ? 1.15 : 1 }, { duration: pressed ? 200 : 500, ease: pressed ? 'OutQuint' : 'OutElastic' });
    }
}
