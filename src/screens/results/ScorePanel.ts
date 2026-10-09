import { BitmapText, Container, Graphics, Sprite, type Text } from 'pixi.js';
import type { Game, Selection } from '../../app/Game';
import { formatNumber } from '../../core/math';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import { sortedMods, sanitizeMods } from '../../gameplay/mods';
import { textureFromBlob, textureFromUrl } from '../../graphics/textures';
import { coverUrl } from '../../online/providers';
import { icon } from '../../ui/icons';
import { counterText, fitText, label } from '../../ui/text';
import { Colors, starColor, starTextColor } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { AccuracyCircle } from './AccuracyCircle';
import { ModPill } from './ModPill';
import { clamp01, easeOutPow, easeOutQuint, formatDate, gaugeTarget } from './resultsMath';

export const PANEL_W = 360;
export const PANEL_H = 700;
const HEADER_H = 128;
const RADIUS = 18;
const PAD = 20;
const CONTENT_W = PANEL_W - PAD * 2;
/** Vertical layout (design px). Badges reach 15px past the ring, so the
 * circle sits low enough that the SS badge clears the header. */
const CIRCLE_Y = 270;
const SCORE_Y = 426;
const PILLS_Y = 468;
const GRID_Y = 494;
const ROW_H = 54;
const FOOTER_Y = GRID_Y + ROW_H * 3 + 8;

/** Animation timeline (ms from entry). */
export const T_FILL_START = 450;
export const T_FILL_DURATION = 1500;
export const T_RANK = T_FILL_START + T_FILL_DURATION;
export const T_STATS = T_RANK + 100;
/** The rank bands sweep in before the gauge starts (lazer: 150ms, 800ms). */
const T_BANDS = 150;
const T_BANDS_DURATION = 800;
export const T_END = T_RANK + 1700;

interface StatCell {
    root: Container;
    value: BitmapText;
    target: number;
    /** Scale that keeps the final value inside its column. */
    fit: number;
    /** Counts roll through whole numbers; accuracy/UR roll continuously. */
    integer: boolean;
    format: (v: number) => string;
    row: number;
}

/**
 * lazer's expanded ScorePanel: beatmap header, accuracy circle with the
 * rank, rolling total score, mods and the statistics grid. Built at a
 * fixed design size (PANEL_W × PANEL_H) and scaled by the screen.
 */
export class ScorePanel extends UIComponent {
    readonly circle: AccuracyCircle;
    private readonly bg = new Graphics();
    private readonly header = new Container();
    private readonly headerMask = new Graphics();
    private readonly scoreText: BitmapText;
    private readonly cells: StatCell[] = [];
    private readonly rows: Container[] = [];
    private lastScoreShown = -1;
    private readonly rowBaseY: number[] = [];
    private readonly gauge: number;
    private readonly scoreWrap = new Container();
    /** Fired once when the rank lands (screen plays the sound). */
    onRankRevealed: (() => void) | null = null;

    constructor(private readonly game: Game, private readonly result: ScoreResult, selection: Selection) {
        super();
        const r = result;
        this.bg.roundRect(0, 0, PANEL_W, PANEL_H, RADIUS).fill({ color: 0x1b1b22, alpha: 0.94 });
        this.bg.roundRect(0, 0, PANEL_W, PANEL_H, RADIUS).stroke({ width: 1, color: 0xffffff, alpha: 0.06 });
        // Exactly the header: rounded top corners, square bottom (the art must not spill below).
        this.headerMask.roundRect(0, 0, PANEL_W, HEADER_H, RADIUS).rect(0, RADIUS, PANEL_W, HEADER_H - RADIUS).fill(0xffffff);
        this.header.mask = this.headerMask;
        const headerBg = new Graphics().rect(0, 0, PANEL_W, HEADER_H).fill(0x262630);
        this.header.addChild(headerBg);
        this.addChild(this.bg, this.header, this.headerMask);
        this.loadThumbnail(selection);

        // --- beatmap metadata -------------------------------------------
        const title = label('', { size: 20, weight: '700', shadow: true });
        fitText(title, CONTENT_W, r.title);
        title.anchor.set(0.5, 0);
        title.position.set(PANEL_W / 2, 18);
        const artist = label('', { size: 14, weight: '600', color: Colors.grayD, shadow: true });
        fitText(artist, CONTENT_W, r.artist);
        artist.anchor.set(0.5, 0);
        artist.position.set(PANEL_W / 2, 46);
        const diffRow = this.difficultyRow(r.stars ?? selection.diff.stars ?? null, r.version);
        diffRow.position.set(PANEL_W / 2 - diffRow.width / 2, 72);
        const mapper = label('', { size: 12, weight: '500', color: Colors.grayB });
        fitText(mapper, CONTENT_W, `mapped by ${r.creator || 'unknown'}`);
        mapper.anchor.set(0.5, 0);
        mapper.position.set(PANEL_W / 2, 98);
        this.addChild(title, artist, diffRow, mapper);

        // --- accuracy circle ---------------------------------------------
        const skin = game.skin;
        this.circle = new AccuracyCircle(
            { triangle: skin.tex('triangle'), glow: skin.tex('glow'), circle: skin.tex('circle') },
            r.passed ? r.grade : 'F',
            r.passed,
        );
        this.circle.position.set(PANEL_W / 2, CIRCLE_Y);
        this.addChild(this.circle);
        this.gauge = gaugeTarget(r.accuracy, r.grade, r.passed);

        // --- score ------------------------------------------------------------
        this.scoreText = counterText(formatNumber(r.score), { size: 46, light: true });
        this.scoreText.anchor.set(0.5);
        // Huge scores shrink to fit instead of running off the panel.
        const scoreFit = Math.min(1, CONTENT_W / Math.max(1, this.scoreText.width));
        this.scoreText.text = '0';
        this.scoreWrap.scale.set(scoreFit);
        this.scoreWrap.addChild(this.scoreText);
        this.addChild(this.scoreWrap);

        // --- status + mods (one centred row of pills) -------------------------
        const mods = sortedMods(sanitizeMods(r.mods));
        const pills = new Container();
        let px = 0;
        if (!r.passed) {
            const t = label('FAILED', { size: 11, weight: '800', color: 0xffffff, letterSpacing: 1.5 });
            t.anchor.set(0.5);
            const w = Math.round(t.width + 20);
            t.position.set(w / 2, 10.5);
            pills.addChild(new Graphics().roundRect(0, 0, w, 20, 10).fill(Colors.red), t);
            px = w + 8;
        }
        for (const m of mods) {
            const pill = new ModPill(m);
            pill.x = px;
            pills.addChild(pill);
            px += pill.w + 4;
        }
        const pillsW = Math.max(0, px - (mods.length ? 4 : 8));
        if (pillsW > 0) {
            const k = Math.min(1, CONTENT_W / pillsW);
            pills.scale.set(k);
            pills.position.set(Math.round(PANEL_W / 2 - (pillsW * k) / 2), PILLS_Y - 10 * k);
            this.addChild(pills);
        }
        // Without a pill row the score takes the middle of the free space.
        this.scoreWrap.position.set(PANEL_W / 2, pillsW > 0 ? SCORE_Y : (SCORE_Y + PILLS_Y) / 2);

        // --- statistics grid -------------------------------------------------
        const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
        const int = (v: number) => formatNumber(v);
        this.grid([
            { title: 'ACCURACY', value: r.accuracy, format: pct, color: Colors.grayC, integer: false },
            { title: 'MAX COMBO', value: r.maxCombo, format: v => `${formatNumber(v)}x`, color: Colors.grayC, badge: r.perfect ? 'PERFECT' : null },
        ], GRID_Y, 0);
        this.grid([
            { title: 'GREAT', value: r.count300, format: int, color: Colors.great },
            { title: 'OK', value: r.count100, format: int, color: Colors.ok },
            { title: 'MEH', value: r.count50, format: int, color: Colors.meh },
            { title: 'MISS', value: r.countMiss, format: int, color: Colors.miss },
        ], GRID_Y + ROW_H, 1);
        this.grid([
            { title: 'SLIDER TICKS', value: r.sliderTicksHit, format: v => `${int(v)}/${int(r.sliderTicksTotal)}`, color: Colors.grayC },
            { title: 'UNSTABLE RATE', value: r.unstableRate, format: v => v.toFixed(2), color: Colors.grayC, integer: false },
        ], GRID_Y + ROW_H * 2, 2);

        // --- footer ----------------------------------------------------------
        const footer = new Container();
        const date = label(formatDate(r.date), { size: 12, weight: '500', color: Colors.gray9 });
        date.anchor.set(1, 0);
        date.position.set(PANEL_W - PAD, 11);
        const player = label('', { size: 12, weight: '600', color: Colors.grayB });
        fitText(player, CONTENT_W - date.width - 16, `played by ${r.player || 'Guest'}`);
        player.position.set(PAD, 11);
        footer.addChild(new Graphics().rect(PAD, 0, CONTENT_W, 1).fill({ color: 0xffffff, alpha: 0.08 }), player, date);
        footer.position.set(0, FOOTER_Y);
        this.addChild(footer);
        this.rows.push(footer);
        this.rowBaseY.push(FOOTER_Y);

        this.eventMode = 'passive';
        this.resize(PANEL_W, PANEL_H);
    }

    private difficultyRow(stars: number | null, version: string): Container {
        const row = new Container();
        let x = 0;
        if (stars !== null && Number.isFinite(stars)) {
            const fg = starTextColor(stars);
            const star = icon('star', 10, fg);
            const num = label(stars.toFixed(2), { size: 12, weight: '800', color: fg });
            num.anchor.set(0, 0.5);
            const w = 22 + num.width + 10;
            const pill = new Graphics().roundRect(0, -10, w, 20, 10).fill(starColor(stars));
            star.position.set(13, 0);
            num.position.set(22, 0);
            row.addChild(pill, star, num);
            x = w + 8;
        }
        const v = label('', { size: 14, weight: '700', color: 0xffffff, shadow: true });
        fitText(v, CONTENT_W - x, version);
        v.anchor.set(0, 0.5);
        v.position.set(x, 0);
        row.addChild(v);
        row.pivot.set(0, -10);
        return row;
    }

    private grid(
        items: { title: string; value: number; format: (v: number) => string; color: number; badge?: string | null; integer?: boolean }[],
        y: number,
        rowIndex: number,
    ): void {
        const row = new Container();
        const colW = CONTENT_W / items.length;
        // Hairline separator at the top of each row.
        row.addChild(new Graphics().rect(PAD, 0, CONTENT_W, 1).fill({ color: 0xffffff, alpha: 0.06 }));
        items.forEach((it, i) => {
            const cell = new Container();
            const title = label(it.title, { size: 10, weight: '800', color: it.color, letterSpacing: 1 });
            title.anchor.set(0.5, 0);
            title.y = 11;
            cell.addChild(title);
            if (it.badge) {
                // Inline after the title (it used to sit on the separator line).
                const b: Text = label(it.badge, { size: 8, weight: '800', color: 0x16161c, letterSpacing: 0.5 });
                b.anchor.set(0.5);
                const bw = Math.round(b.width + 10);
                const badge = new Container();
                badge.addChild(new Graphics().roundRect(-bw / 2, -6, bw, 12, 6).fill(Colors.yellow), b);
                const shift = (bw + 6) / 2;
                title.x = -shift;
                badge.position.set(title.x + title.width / 2 + 6 + bw / 2, title.y + title.height / 2);
                cell.addChild(badge);
            }
            const value = counterText(it.format(it.value), { size: 19 });
            const fit = Math.min(1, (colW - 8) / Math.max(1, value.width));
            value.text = it.format(0);
            value.anchor.set(0.5, 0);
            value.scale.set(fit);
            value.y = 26;
            cell.addChild(value);
            cell.position.set(PAD + colW * i + colW / 2, 0);
            row.addChild(cell);
            this.cells.push({ root: cell, value, target: it.value, fit, integer: it.integer ?? true, format: it.format, row: rowIndex });
        });
        row.position.set(0, y);
        this.rowBaseY.push(y);
        this.addChild(row);
        this.rows.push(row);
    }

    private async loadThumbnail(selection: Selection): Promise<void> {
        try {
            const blob = await this.game.library.getThumbnail(selection.set.key);
            if (this.destroyed) return;
            // No art in the archive: use the online cover, like song select does.
            const sid = selection.set.onlineSetId;
            const tex = blob ? await textureFromBlob(blob, 640) : sid ? await textureFromUrl(coverUrl(sid, 'jpg'), undefined, 640) : null;
            if (!tex || this.destroyed) {
                tex?.destroy(true);
                return;
            }
            const sprite = new Sprite(tex);
            sprite.anchor.set(0.5);
            const s = Math.max(PANEL_W / tex.width, HEADER_H / tex.height);
            sprite.scale.set(s);
            sprite.position.set(PANEL_W / 2, HEADER_H / 2);
            sprite.alpha = 0;
            const shade = new Sprite(this.game.skin.tex('fadeDown'));
            shade.tint = 0x262630;
            shade.width = PANEL_W;
            shade.height = HEADER_H;
            shade.scale.y *= -1;
            shade.y = HEADER_H;
            const dim = new Graphics().rect(0, 0, PANEL_W, HEADER_H).fill({ color: 0x000000, alpha: 0.35 });
            this.header.addChild(sprite, dim, shade);
            this.disposer.add(() => tex.destroy(true));
            const start = performance.now();
            const fade = () => {
                if (this.destroyed) return;
                sprite.alpha = Math.min(0.9, (performance.now() - start) / 400);
                if (sprite.alpha < 0.9) requestAnimationFrame(fade);
            };
            fade();
        } catch {
            /* thumbnail is decoration only */
        }
    }

    /** Drive every timed reveal from the screen's clock (ms). */
    applyTime(t: number): void {
        const r = this.result;
        // lazer: the circle pops in (200ms), the bands sweep, then the gauge fills.
        this.circle.scale.set(easeOutQuint(t / 200));
        this.circle.setBandsProgress(easeOutPow((t - T_BANDS) / T_BANDS_DURATION, 10));
        const kFill = easeOutPow((t - T_FILL_START) / T_FILL_DURATION, 7);
        this.circle.setProgress(this.gauge * kFill, t >= T_FILL_START);
        if (t >= T_RANK && !this.circle.revealed) {
            this.circle.revealRank();
            this.onRankRevealed?.();
        }
        // The total rolls up alongside the gauge (lazer starts both at 450ms).
        this.scoreWrap.alpha = clamp01((t - T_FILL_START) / 150);
        const shown = Math.round(r.score * kFill);
        if (shown !== this.lastScoreShown) {
            this.lastScoreShown = shown;
            this.scoreText.text = formatNumber(shown);
        }
        const kStats = easeOutQuint((t - T_STATS) / 900);
        for (const c of this.cells) {
            const v = c.target * kStats;
            // (Rounding by Number.isInteger(target) made 100% accuracy jump 0% → 100%.)
            const txt = c.format(c.integer ? Math.round(v) : v);
            if (c.value.text !== txt) c.value.text = txt;
        }
        // Rows fade in staggered, sliding up from 10px below their slot.
        this.rows.forEach((row, i) => {
            const a = clamp01((t - T_STATS - i * 110) / 300);
            row.alpha = a;
            row.y = this.rowBaseY[i] + (1 - easeOutQuint(a)) * 10;
        });
    }
}
