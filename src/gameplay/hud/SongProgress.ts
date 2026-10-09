import { Container, Graphics, type BitmapText } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import { formatTime } from '../../core/math';
import { counterText } from '../../ui/text';

const COLUMNS = 100;
const GRAPH_H = 36;
const BAR_H = 5;
const LABEL_H = 22;

/**
 * lazer's song progress (bottom): object-density graph that lights up as
 * the song passes, a thin fill bar, and elapsed / percent / remaining.
 */
export class SongProgress extends Container {
    private readonly graph = new Graphics();
    private readonly bar = new Graphics();
    private readonly elapsed: BitmapText;
    private readonly percent: BitmapText;
    private readonly remaining: BitmapText;
    private readonly density: number[];
    private readonly start: number;
    private readonly end: number;
    private w = 800;
    private drawnColumn = -2;
    private lastSecond = NaN;
    private _showGraph = true;

    constructor(beatmap: PlayableBeatmap) {
        super();
        this.eventMode = 'none';
        this.start = beatmap.startTime;
        this.end = Math.max(beatmap.endTime, this.start + 1);
        const counts = new Array<number>(COLUMNS).fill(0);
        for (const h of beatmap.hitObjects) {
            const a = Math.floor(((h.time - this.start) / (this.end - this.start)) * COLUMNS);
            const b = Math.floor(((h.endTime - this.start) / (this.end - this.start)) * COLUMNS);
            for (let c = Math.max(0, a); c <= Math.min(COLUMNS - 1, b); c++) counts[c]++;
        }
        const max = Math.max(1, ...counts);
        this.density = counts.map(c => c / max);
        this.elapsed = counterText('0:00', { size: 14 });
        this.percent = counterText('0%', { size: 14 });
        this.remaining = counterText('0:00', { size: 14 });
        this.percent.anchor.set(0.5, 1);
        this.elapsed.anchor.set(0, 1);
        this.remaining.anchor.set(1, 1);
        this.addChild(this.graph, this.bar, this.elapsed, this.percent, this.remaining);
    }

    /** lazer's "show difficulty graph": without it only the bar and times remain. */
    set showGraph(v: boolean) {
        if (v === this._showGraph) return;
        this._showGraph = v;
        this.graph.visible = v;
        this.layout(this.w);
    }

    /** Height above the origin, including the time labels (unscaled). */
    get blockHeight(): number {
        return BAR_H + (this._showGraph ? GRAPH_H : 0) + LABEL_H;
    }

    /** Lay out across `width`; the component's origin is its bottom-left. */
    layout(width: number): void {
        this.w = width;
        this.drawnColumn = -2;
        const y = -BAR_H - (this._showGraph ? GRAPH_H : 0) - 4;
        this.elapsed.position.set(8, y);
        this.percent.position.set(width / 2, y);
        this.remaining.position.set(width - 8, y);
    }

    update(time: number, rate: number): void {
        const p = Math.max(0, Math.min(1, (time - this.start) / (this.end - this.start)));
        const col = Math.floor(p * COLUMNS);
        if (col !== this.drawnColumn && this._showGraph) {
            this.drawnColumn = col;
            const g = this.graph;
            g.clear();
            const cw = this.w / COLUMNS;
            for (let i = 0; i < COLUMNS; i++) {
                const hgt = Math.max(1, this.density[i] * GRAPH_H);
                g.rect(i * cw + 0.5, -BAR_H - hgt, Math.max(1, cw - 1), hgt).fill({ color: i < col ? 0x99eeff : 0xffffff, alpha: i < col ? 0.5 : 0.15 });
            }
        }
        this.bar.clear().rect(0, -BAR_H, this.w, BAR_H).fill({ color: 0xffffff, alpha: 0.12 });
        this.bar.rect(0, -BAR_H, this.w * p, BAR_H).fill({ color: 0xbbf4ff });
        const second = Math.floor(time / 1000);
        if (second !== this.lastSecond) {
            this.lastSecond = second;
            this.elapsed.text = formatTime(Math.max(0, time - this.start) / rate);
            this.remaining.text = `-${formatTime(Math.max(0, this.end - time) / rate)}`;
            this.percent.text = `${Math.floor(p * 100)}%`;
        }
    }
}
