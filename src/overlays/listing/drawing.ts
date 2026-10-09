/** Small shared visuals for listing cards and the details panel. */
import { Container, Graphics, type Text } from 'pixi.js';
import type { OnlineDifficulty } from '../../online/providers';
import { icon, Icons } from '../../ui/icons';
import { drawRulesetIcon } from '../../ui/RulesetIcon';
import { label } from '../../ui/text';
import { starColor, starTextColor, statusInfo } from '../../ui/theme';

/** 1234 → "1.2k", 12345678 → "12.3M" (lazer's compact statistic). */
export function formatCount(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n < 1000) return String(Math.round(n));
    const [v, unit] = n < 1e6 ? [n / 1e3, 'k'] : n < 1e9 ? [n / 1e6, 'M'] : [n / 1e9, 'B'];
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

/** Ranked-status pill (lazer's BeatmapSetOnlineStatusPill). */
export class StatusPill extends Container {
    private readonly bg = new Graphics();
    private readonly text: Text;
    private status = NaN;
    pillWidth = 0;

    constructor(private readonly pillHeight = 18, size = 10) {
        super();
        this.text = label('', { size, weight: '800', letterSpacing: 0.6 });
        this.text.anchor.set(0.5);
        this.addChild(this.bg, this.text);
    }

    setStatus(approved: number): void {
        if (approved === this.status) return;
        this.status = approved;
        const info = statusInfo(approved);
        this.text.text = info.label;
        this.text.tint = info.text;
        const h = this.pillHeight;
        this.pillWidth = Math.ceil(this.text.width) + h;
        this.bg.clear().roundRect(0, 0, this.pillWidth, h, h / 2).fill(info.color);
        this.text.position.set(this.pillWidth / 2, h / 2);
    }
}

/** Star rating pill (lazer's StarRatingDisplay): star glyph + value on the star colour. */
export class StarPill extends Container {
    private readonly bg = new Graphics();
    private readonly star: Text;
    private readonly value: Text;
    pillWidth = 0;

    constructor(private readonly pillHeight = 20) {
        super();
        this.star = icon('star', 10, 0xffffff);
        this.value = label('', { size: 12, weight: '700' });
        this.value.anchor.set(0, 0.5);
        this.addChild(this.bg, this.star, this.value);
    }

    setStars(stars: number): void {
        const h = this.pillHeight;
        const color = starColor(stars);
        const text = starTextColor(stars);
        this.value.text = stars.toFixed(2);
        this.star.tint = this.value.tint = text;
        this.star.position.set(h / 2 + 2, h / 2);
        this.value.position.set(h / 2 + 10, h / 2);
        this.pillWidth = Math.ceil(h / 2 + 10 + this.value.width + h / 2 - 2);
        this.bg.clear().roundRect(0, 0, this.pillWidth, h, h / 2).fill(color);
    }
}

const DOT_W = 5;
const DOT_H = 11;
const DOT_GAP = 2;
const MAX_DOTS = 14;

/**
 * lazer's DifficultySpectrumDisplay: the ruleset glyph followed by one
 * star-coloured pill per difficulty (a count instead when there are many).
 * Returns the drawn width.
 */
export function drawDifficultySpectrum(g: Graphics, countText: Text, x: number, cy: number, diffs: readonly OnlineDifficulty[] | null): number {
    drawRulesetIcon(g, x + 6, cy, 12, 0xffffff, 0.9);
    let cx = x + 16;
    countText.visible = false;
    if (!diffs || !diffs.length) return cx - x;
    if (diffs.length > MAX_DOTS) {
        countText.visible = true;
        countText.text = String(diffs.length);
        countText.position.set(cx, cy - countText.height / 2);
        return cx + countText.width - x;
    }
    for (const d of diffs) {
        g.roundRect(cx, cy - DOT_H / 2, DOT_W, DOT_H, DOT_W / 2).fill(starColor(d.stars));
        cx += DOT_W + DOT_GAP;
    }
    return cx - DOT_GAP - x;
}

/** Icon + compact count statistic (favourites, plays). */
export class Statistic extends Container {
    private readonly glyph: Text;
    private readonly value: Text;

    constructor(iconName: 'heart' | 'play' | 'clock' | 'music', size = 12) {
        super();
        this.glyph = icon(iconName, size - 2, 0xffffff);
        this.glyph.anchor.set(0, 0.5);
        this.value = label('', { size, weight: '600' });
        this.value.anchor.set(0, 0.5);
        this.addChild(this.glyph, this.value);
    }

    set(value: string, glyph?: keyof typeof Icons, tint = 0xffffff): void {
        if (glyph) this.glyph.text = Icons[glyph];
        this.glyph.tint = tint;
        this.value.text = value;
        this.value.position.set(this.glyph.width + 4, 0);
    }

    get statWidth(): number {
        return this.glyph.width + 4 + this.value.width;
    }
}
