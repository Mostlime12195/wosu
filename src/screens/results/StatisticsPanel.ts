import { Container, Graphics, type Text } from 'pixi.js';
import type { Selection } from '../../app/Game';
import { formatNumber, formatTime } from '../../core/math';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import { fitText, label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { PANEL_H } from './ScorePanel';
import { clamp01, easeOutQuint, errorStats, formatSigned, hitWindowsFor, timingHistogram, type HitWindows } from './resultsMath';

export const STATS_W = 480;
const PAD = 24;
const HIST_TOP = 104;
const HIST_H = 200;
const GRAPH_TOP = 404;
/** The health graph takes whatever height the shared panel size leaves. */
const GRAPH_H = PANEL_H - 518;
const RADIUS = 18;

/** Timeline offsets relative to the screen clock (ms). */
const T_IN = 600;
const T_BARS = 900;
const T_GRAPH = 1200;

/**
 * lazer's StatisticsPanel: hit timing distribution (bars coloured by the
 * hit window they fall in, centred on "on time") plus the HP graph.
 */
export class StatisticsPanel extends UIComponent {
    private readonly bg = new Graphics();
    private readonly bars = new Graphics();
    private readonly graphLayer = new Container();
    private readonly graphMask = new Graphics();
    private readonly counts: number[];
    private readonly binWidth: number;
    private readonly range: number;
    private readonly windows: HitWindows;
    private lastBarK = -1;
    private lastGraphK = -1;
    private readonly histW = STATS_W - PAD * 2;

    constructor(private readonly result: ScoreResult, selection: Selection) {
        super();
        const r = result;
        this.windows = hitWindowsFor(selection.diff.od ?? 5, r.mods);
        const hist = timingHistogram(r.hitErrors, this.windows.w50);
        this.counts = hist.counts;
        this.binWidth = hist.binWidth;
        this.range = hist.range;

        this.bg.roundRect(0, 0, STATS_W, PANEL_H, RADIUS).fill({ color: 0x1b1b22, alpha: 0.94 });
        this.bg.roundRect(0, 0, STATS_W, PANEL_H, RADIUS).stroke({ width: 1, color: 0xffffff, alpha: 0.06 });
        this.addChild(this.bg);

        // --- timing distribution -------------------------------------------
        this.addChild(this.heading('Hit timing distribution', 20));
        const stats = errorStats(r.hitErrors);
        const mean = r.hitErrors.length ? `${formatSigned(stats.mean)}ms average` : 'no timed hits';
        const tendency = Math.abs(stats.mean) < 1 ? 'on time' : stats.mean < 0 ? 'early' : 'late';
        const sub = label(r.hitErrors.length ? `${mean} (${tendency})` : mean, { size: 13, weight: '600', color: Colors.grayC });
        sub.position.set(PAD, 46);
        const ur = label(`${r.unstableRate.toFixed(2)} UR`, { size: 13, weight: '700', color: Colors.blueLight });
        ur.anchor.set(1, 0);
        ur.position.set(STATS_W - PAD, 46);
        this.addChild(sub, ur);
        this.addChild(this.legend(70));

        const axis = new Graphics();
        const baseY = HIST_TOP + HIST_H;
        axis.rect(PAD, baseY, this.histW, 1).fill({ color: 0xffffff, alpha: 0.15 });
        axis.rect(PAD + this.histW / 2 - 0.5, HIST_TOP - 6, 1, HIST_H + 10).fill({ color: 0xffffff, alpha: 0.25 });
        this.addChild(axis, this.bars);
        const early = label('early', { size: 12, weight: '700', color: Colors.grayA });
        early.position.set(PAD, baseY + 8);
        const late = label('late', { size: 12, weight: '700', color: Colors.grayA });
        late.anchor.set(1, 0);
        late.position.set(STATS_W - PAD, baseY + 8);
        const zero = label('0', { size: 11, weight: '700', color: Colors.grayA });
        zero.anchor.set(0.5, 0);
        zero.position.set(STATS_W / 2, baseY + 8);
        const minus = label(`-${Math.round(this.range)}ms`, { size: 11, weight: '600', color: Colors.gray7 });
        minus.position.set(PAD + 44, baseY + 9);
        const plus = label(`+${Math.round(this.range)}ms`, { size: 11, weight: '600', color: Colors.gray7 });
        plus.anchor.set(1, 0);
        plus.position.set(STATS_W - PAD - 36, baseY + 9);
        this.addChild(early, late, zero, minus, plus);
        const counts = label(`${stats.early} early · ${stats.late} late`, { size: 12, weight: '600', color: Colors.grayB });
        counts.anchor.set(0.5, 0);
        counts.position.set(STATS_W / 2, baseY + 30);
        this.addChild(counts);

        // --- health graph -----------------------------------------------------
        this.addChild(this.heading('Health', GRAPH_TOP - 34));
        const graphBg = new Graphics()
            .roundRect(PAD, GRAPH_TOP, this.histW, GRAPH_H, 8).fill({ color: 0x000000, alpha: 0.25 })
            .rect(PAD, GRAPH_TOP + GRAPH_H / 2, this.histW, 1).fill({ color: 0xffffff, alpha: 0.08 });
        this.addChild(graphBg, this.graphLayer, this.graphMask);
        this.drawHealth();
        this.graphLayer.mask = this.graphMask;

        // --- footer facts -------------------------------------------------------
        const facts: [string, string][] = [
            ['LENGTH', formatTime(r.length)],
            ['MAP COMBO', `${formatNumber(r.maxCombo)}/${formatNumber(r.mapMaxCombo)}x`],
            ['HITS', formatNumber(r.count300 + r.count100 + r.count50 + r.countMiss)],
        ];
        const colW = this.histW / facts.length;
        facts.forEach(([k, v], i) => {
            const c = new Container();
            const t = label(k, { size: 10, weight: '800', color: Colors.grayA, letterSpacing: 1 });
            t.anchor.set(0.5, 0);
            const val = label(v, { size: 16, weight: '700' });
            val.anchor.set(0.5, 0);
            val.position.set(0, 15);
            c.addChild(t, val);
            c.position.set(PAD + colW * i + colW / 2, GRAPH_TOP + GRAPH_H + 26);
            this.addChild(c);
        });

        this.eventMode = 'none';
        this.resize(STATS_W, PANEL_H);
    }

    private heading(text: string, y: number): Text {
        const t = label(text, { size: 17, weight: '700' });
        fitText(t, STATS_W - PAD * 2, text);
        t.position.set(PAD, y);
        return t;
    }

    private legend(y: number): Container {
        const c = new Container();
        const items: [string, number, number][] = [
            ['great', Colors.great, this.windows.w300],
            ['ok', Colors.ok, this.windows.w100],
            ['meh', Colors.meh, this.windows.w50],
        ];
        let x = PAD;
        for (const [name, color, w] of items) {
            const dot = new Graphics().roundRect(x, 4, 10, 10, 3).fill(color);
            const t = label(`${name} ±${Math.round(w)}ms`, { size: 11, weight: '600', color: Colors.grayB });
            t.position.set(x + 15, 1);
            c.addChild(dot, t);
            x += 15 + t.width + 16;
        }
        c.position.set(0, y);
        return c;
    }

    private barColor(center: number): number {
        const a = Math.abs(center);
        if (a <= this.windows.w300) return Colors.great;
        if (a <= this.windows.w100) return Colors.ok;
        return Colors.meh;
    }

    /** Draw bars at `k` (0..1) of their final height. */
    private drawBars(k: number): void {
        const g = this.bars;
        g.clear();
        const n = this.counts.length;
        const max = Math.max(1, ...this.counts);
        const slot = this.histW / n;
        const bw = Math.max(1.5, slot * 0.72);
        const baseY = HIST_TOP + HIST_H;
        for (let i = 0; i < n; i++) {
            const center = -this.range + this.binWidth * (i + 0.5);
            const x = PAD + slot * i + (slot - bw) / 2;
            const c = this.counts[i];
            if (c === 0) {
                // lazer draws empty bins as faint dots so the scale stays readable.
                g.roundRect(x, baseY - 3, bw, 3, Math.min(1.5, bw / 2)).fill({ color: this.barColor(center), alpha: 0.18 });
                continue;
            }
            const h = Math.max(3, (c / max) * (HIST_H - 4) * k);
            g.roundRect(x, baseY - h, bw, h, Math.min(3, bw / 2)).fill(this.barColor(center));
        }
    }

    private drawHealth(): void {
        const pts = this.result.healthGraph;
        const g = new Graphics();
        this.graphLayer.addChild(g);
        if (pts.length < 2) return;
        const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
        const span = Math.max(1, t1 - t0);
        const x = (t: number) => PAD + ((t - t0) / span) * this.histW;
        const y = (hp: number) => GRAPH_TOP + GRAPH_H - 4 - Math.max(0, Math.min(1, hp)) * (GRAPH_H - 8);
        const base = GRAPH_TOP + GRAPH_H;
        // Filled area per segment, green above half HP and red below (stable's ranking graph).
        for (let i = 1; i < pts.length; i++) {
            const [ta, ha] = pts[i - 1];
            const [tb, hb] = pts[i];
            const col = (ha + hb) / 2 >= 0.5 ? Colors.lime : Colors.red;
            g.poly([x(ta), y(ha), x(tb), y(hb), x(tb), base, x(ta), base]).fill({ color: col, alpha: 0.12 });
        }
        for (let i = 1; i < pts.length; i++) {
            const [ta, ha] = pts[i - 1];
            const [tb, hb] = pts[i];
            const col = (ha + hb) / 2 >= 0.5 ? Colors.lime : Colors.red;
            g.moveTo(x(ta), y(ha)).lineTo(x(tb), y(hb)).stroke({ width: 2, color: col, cap: 'round', join: 'round' });
        }
    }

    applyTime(t: number): void {
        const a = clamp01((t - T_IN) / 400);
        this.alpha = a;
        this.pivot.x = -(1 - easeOutQuint(a)) * 30;
        const k = easeOutQuint((t - T_BARS) / 900);
        if (Math.abs(k - this.lastBarK) > 0.001) {
            this.lastBarK = k;
            this.drawBars(k);
        }
        const g = easeOutQuint((t - T_GRAPH) / 1100);
        if (Math.abs(g - this.lastGraphK) > 0.001) {
            this.lastGraphK = g;
            this.graphMask.clear().rect(PAD, GRAPH_TOP - 4, Math.max(0.01, this.histW * g), GRAPH_H + 8).fill(0xffffff);
        }
    }
}
