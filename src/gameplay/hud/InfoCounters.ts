import { Container, type BitmapText, type Text } from 'pixi.js';
import { Easing } from '../../core/easing';
import { counterText, fitText, label } from '../../ui/text';
import { Colors, starColor } from '../../ui/theme';

/** A box in a component's own units. */
export interface UnitBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** What the beatmap info component shows. */
export interface BeatmapInfo {
    artist: string;
    title: string;
    version: string;
    creator: string;
    /** Star rating with the mods played (null when unknown). */
    stars: number | null;
    /** Mod acronyms, in display order. */
    mods: readonly string[];
}

const INFO_WIDTH = 520;

/**
 * Beatmap info (lazer's BeatmapAttributeText, combined): "Artist - Title"
 * over "[Difficulty] mapped by Mapper" and the star rating with mods.
 * Origin: top-left; units are layout units.
 */
export class BeatmapInfoDisplay extends Container {
    private readonly texts: Text[];
    private readonly measured: UnitBox;

    constructor(info: BeatmapInfo) {
        super();
        this.eventMode = 'none';
        const title = label('', { size: 22, weight: '700', shadow: true });
        fitText(title, INFO_WIDTH, `${info.artist} - ${info.title}`);
        const diff = label('', { size: 16, weight: '600', color: Colors.grayD, shadow: true });
        fitText(diff, INFO_WIDTH, `[${info.version}] mapped by ${info.creator}`);
        diff.y = 27;
        const parts: string[] = [];
        if (info.stars !== null) parts.push(`★ ${info.stars.toFixed(2)}`);
        if (info.mods.length) parts.push(`+${info.mods.join('')}`);
        const stats = label(parts.join('   ') || 'No mods', { size: 16, weight: '700', color: info.stars !== null ? starColor(info.stars) : Colors.grayC, shadow: true });
        stats.y = 49;
        this.texts = [title, diff, stats];
        this.addChild(...this.texts);
        const w = Math.max(...this.texts.map(t => t.width));
        this.measured = { x: 0, y: 0, w: Math.max(40, w), h: stats.y + stats.height };
    }

    get box(): UnitBox {
        return this.measured;
    }

    /** Render text at the pixel scale it is shown at (stays crisp when scaled up). */
    setResolution(r: number): void {
        for (const t of this.texts) if (Math.abs(t.resolution - r) > 0.01) t.resolution = r;
    }
}

/** A value + small suffix counter (bitmap digits), top-left origin. */
abstract class SuffixCounter extends Container {
    protected readonly value: BitmapText;
    private readonly suffix: BitmapText;
    private measured: UnitBox = { x: 0, y: 0, w: 1, h: 32 };

    constructor(suffixText: string, sample: string, suffixColor: number) {
        super();
        this.eventMode = 'none';
        this.value = counterText(sample, { size: 30 });
        this.suffix = counterText(suffixText, { size: 16, color: suffixColor });
        this.value.anchor.set(0, 1);
        this.suffix.anchor.set(0, 1);
        this.value.y = this.suffix.y = 30;
        this.addChild(this.value, this.suffix);
        this.setText(sample);
        this.setText('0');
    }

    protected setText(t: string): void {
        if (this.value.text === t) return;
        this.value.text = t;
        this.suffix.x = this.value.width + 4;
        this.measured = { x: 0, y: 0, w: this.suffix.x + this.suffix.width, h: 32 };
    }

    /** Sized to the text shown (lazer's autosize): the layout's origin keeps that edge in place as it changes. */
    get box(): UnitBox {
        return this.measured;
    }
}

/**
 * lazer's UnstableRateCounter: "UR" after 10 × the standard deviation of
 * hit errors (rate-adjusted), dimmed until the first hit.
 */
export class UnstableRateCounter extends SuffixCounter {
    private shown = NaN;

    constructor() {
        super('UR', '000.00', Colors.blueLight);
        this.alpha = 0.5;
    }

    set(ur: number | null): void {
        this.alpha = ur === null ? 0.5 : 1;
        const v = ur === null ? 0 : Math.round(ur * 100) / 100;
        if (v === this.shown) return;
        this.shown = v;
        this.setText(v.toFixed(2));
    }
}

/**
 * lazer's PerformancePointsCounter: the pp the play so far is worth (an
 * estimate, see gameplay/performance), rolling to each new value.
 */
export class PerformancePointsCounter extends SuffixCounter {
    private from = 0;
    private to = 0;
    private shownValue = 0;
    private elapsed = 0;
    private shown = -1;

    constructor() {
        super('pp', '0000', Colors.pinkLight);
    }

    set(pp: number): void {
        if (Math.abs(pp - this.to) < 1e-9) return;
        this.from = this.shownValue;
        this.to = pp;
        this.elapsed = 0;
    }

    update(dt: number): void {
        this.elapsed += dt;
        const t = Math.min(1, this.elapsed / 500);
        this.shownValue = this.from + (this.to - this.from) * Easing.OutQuint(t);
        const v = Math.round(this.shownValue);
        if (v === this.shown) return;
        this.shown = v;
        this.setText(String(v));
    }
}

const ROW_H = 24;
const JUDGEMENTS = [
    { name: '300', color: Colors.great },
    { name: '100', color: Colors.ok },
    { name: '50', color: Colors.meh },
    { name: 'Miss', color: Colors.miss },
] as const;

/** lazer's JudgementCounterDisplay: one row per result (300 / 100 / 50 / miss). Origin top-left. */
export class JudgementCounter extends Container {
    private readonly counts: BitmapText[] = [];
    private readonly shown = [-1, -1, -1, -1];

    constructor() {
        super();
        this.eventMode = 'none';
        JUDGEMENTS.forEach((j, i) => {
            const name = counterText(j.name, { size: 18, color: j.color });
            const count = counterText('0', { size: 18 });
            name.y = count.y = i * ROW_H;
            count.x = 52;
            this.counts.push(count);
            this.addChild(name, count);
        });
    }

    get box(): UnitBox {
        return { x: 0, y: 0, w: 110, h: JUDGEMENTS.length * ROW_H - 4 };
    }

    set(great: number, ok: number, meh: number, miss: number): void {
        [great, ok, meh, miss].forEach((v, i) => {
            if (v === this.shown[i]) return;
            this.shown[i] = v;
            this.counts[i].text = String(v);
        });
    }
}
