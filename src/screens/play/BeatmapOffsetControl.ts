import { Graphics, type Text } from 'pixi.js';
import { BindableNumber } from '../../core/Bindable';
import { tween } from '../../core/Tweener';
import {
    BEATMAP_OFFSET_MAX,
    BEATMAP_OFFSET_MIN,
    BEATMAP_OFFSET_PRECISION,
    canCalibrate,
    describeAverage,
    errorHistogram,
    formatBeatmapOffset,
    suggestOffset,
    type OffsetSuggestion,
} from '../../gameplay/offsetCalibration';
import { beatmapOffsets } from '../../storage/BeatmapOffsets';
import { Button } from '../../ui/Button';
import { Slider } from '../../ui/Slider';
import { fitText, label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

const SLIDER_H = 52;
const GRAPH_H = 34;
/** Graph range (ms either side of zero) and bars. */
const GRAPH_RANGE = 60;
const GRAPH_BINS = 31;
const BUTTON_H = 30;

/**
 * lazer's BeatmapOffsetControl (player loader → audio settings): this
 * difficulty's own offset, and after a play "Previous play" with its
 * timing distribution and a button that sets the offset which would have
 * centred those hits ("Calibrate using last play"). Only offered when the
 * play had enough timed hits.
 */
export class BeatmapOffsetControl extends UIComponent {
    private readonly current = new BindableNumber(0, BEATMAP_OFFSET_MIN, BEATMAP_OFFSET_MAX, BEATMAP_OFFSET_PRECISION);
    private readonly slider: Slider;
    private readonly heading: Text;
    private readonly verdict: Text;
    private readonly graph = new Graphics();
    private readonly calibrate: Button;
    private suggestion: OffsetSuggestion | null = null;
    private errors: readonly number[] = [];
    private rate = 1;
    /** Owner callback: the control's height changed (the reference play appeared or went). */
    onHeightChange: (() => void) | null = null;

    constructor(private readonly key: string) {
        super();
        const store = beatmapOffsets();
        this.current.value = store.get(key);
        this.slider = new Slider('Beatmap offset', this.current, { format: formatBeatmapOffset, keyStep: 1 });
        this.slider.tooltip = 'This difficulty only. Positive values delay hit timing (hit objects appear later).';
        this.disposer.add(this.current.bind(v => store.set(key, v)));
        this.disposer.add(store.changed.add((k, v) => {
            if (k === key) this.current.value = v;
        }));
        this.heading = label('Previous play:', { size: 13, weight: '600', color: Colors.grayC });
        this.verdict = label('', { size: 13, weight: '700' });
        this.verdict.anchor.set(1, 0);
        this.calibrate = new Button('Calibrate using last play', { color: Colors.pinkDark, height: BUTTON_H, fontSize: 13 });
        this.calibrate.onActivate = () => {
            if (this.suggestion) this.current.value = this.suggestion.offset;
        };
        this.addChild(this.slider, this.heading, this.verdict, this.graph, this.calibrate);
        this.disposer.add(this.current.bind(() => this.updateButton()));
        this.disposer.add(store.played.add(k => {
            if (k === key) this.refreshReference();
        }));
        this.refreshReference(false);
    }

    /** Re-read the difficulty's last play (after a retry, or coming back to the loader). */
    private refreshReference(notify = true): void {
        const play = beatmapOffsets().lastPlay(this.key);
        const suggestion = suggestOffset(play);
        const hadReference = !!this.suggestion;
        this.suggestion = suggestion;
        this.errors = play?.hitErrors ?? [];
        this.rate = play && play.rate > 0 ? play.rate : 1;
        const show = !!suggestion;
        this.heading.visible = this.verdict.visible = this.graph.visible = this.calibrate.visible = show;
        if (suggestion) this.verdict.text = describeAverage(suggestion.average);
        this.verdict.tint = suggestion && Math.abs(suggestion.average) >= 5 ? Colors.yellow : 0xffffff;
        this.updateButton();
        const h = this.preferredHeight;
        if (h !== this._h) this.resize(this._w, h);
        else this.layout();
        if (show) {
            this.graph.alpha = 0;
            tween(this.graph, { alpha: 1 }, { duration: 400 });
        }
        if (notify && hadReference !== show) this.onHeightChange?.();
    }

    private updateButton(): void {
        const can = canCalibrate(this.current.value, this.suggestion);
        if (this.calibrate.enabled !== can) this.calibrate.enabled = can;
    }

    get dragging(): boolean {
        return this.slider.pressed;
    }

    get preferredHeight(): number {
        return SLIDER_H + (this.suggestion ? 10 + 18 + GRAPH_H + 8 + BUTTON_H : 0);
    }

    protected override onResize(): void {
        this.layout();
    }

    private layout(): void {
        if (!this.calibrate) return;
        const w = this._w;
        this.slider.resize(w, SLIDER_H);
        let y = SLIDER_H + 10;
        this.heading.position.set(0, y);
        fitText(this.verdict, Math.max(40, w - this.heading.width - 8), this.verdict.text);
        this.verdict.position.set(w, y);
        y += 18;
        this.drawGraph(w, y);
        y += GRAPH_H + 8;
        this.calibrate.resize(w, BUTTON_H);
        this.calibrate.position.set(0, y);
    }

    /** A small HitEventTimingDistributionGraph: bars per error bucket, the centre line, the mean marker. */
    private drawGraph(w: number, y: number): void {
        const g = this.graph.clear();
        if (!this.suggestion) return;
        // Errors in real ms, like the suggestion.
        const real = this.errors.map(e => e / this.rate);
        const bins = errorHistogram(real, GRAPH_RANGE, GRAPH_BINS);
        const bw = w / GRAPH_BINS;
        g.roundRect(0, y, w, GRAPH_H, 4).fill({ color: 0x000000, alpha: 0.25 });
        bins.forEach((v, i) => {
            if (v <= 0) return;
            const bh = Math.max(2, v * (GRAPH_H - 6));
            const centre = Math.abs(i - (GRAPH_BINS - 1) / 2) / ((GRAPH_BINS - 1) / 2);
            // Greats in the middle, then goods/mehs outwards (lazer's judgement colours).
            const color = centre < 0.35 ? 0x66ccff : centre < 0.7 ? 0x88b300 : 0xffcc22;
            g.roundRect(i * bw + 1, y + GRAPH_H - 3 - bh, Math.max(1, bw - 2), bh, 1).fill({ color, alpha: 0.9 });
        });
        g.rect(w / 2 - 0.5, y + 2, 1, GRAPH_H - 4).fill({ color: 0xffffff, alpha: 0.5 });
        const mx = w / 2 + Math.max(-1, Math.min(1, this.suggestion.average / GRAPH_RANGE)) * (w / 2);
        g.poly([mx - 4, y - 1, mx + 4, y - 1, mx, y + 5]).fill(Colors.yellow);
    }
}
