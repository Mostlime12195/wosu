import { BitmapText, Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import { LegacyFont, LegacySpriteText } from '../../gameplay/hud/SpriteText';
import { extendedModInfo, sanitizeMods, sortedMods } from '../../gameplay/mods';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import { ModIcon } from '../../overlays/mods/ModIcon';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { modIconElement } from '../../skin/modIcons';
import { opaqueBounds } from '../../skin/opaqueBounds';
import { fitText, label } from '../../ui/text';
import { Colors, Fonts, gradeColor, gradeLabel } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import {
    HIT_COUNT_IMAGES,
    DEFAULT_DIGIT_WIDTH,
    formatLegacyAccuracy,
    healthGraphPoints,
    legacyRankingLayout,
    legacyRankingScale,
    rankingGradeElements,
    type LegacyRankingLayout,
} from './rankingLayout';
import { clamp01, easeOutQuint, formatDate } from './resultsMath';

/** Centre height of the pp under the grade (McOsu: 400 of its 480 units). */
const PP_Y = 640;

/** Timeline (ms from entry): the screen fades in, the buttons slide in, then the grade lands. */
const T_FADE = 300;
const T_BUTTONS = 150;
export const LEGACY_T_GRADE = 500;
export const LEGACY_T_END = LEGACY_T_GRADE + 700;

/** A sprite sized and placed in stable units (the @2x convention applied). */
function skinSprite(t: SkinTexture, scale = 1): Sprite {
    const s = new Sprite(t.texture);
    s.scale.set(t.scale * scale);
    return s;
}

/** ranking-retry / ranking-replay: a right-origin image at the screen's right edge that slides out on hover. */
class RankingButton extends UIComponent {
    private readonly sprite: Sprite;
    private slide = 0;

    constructor(t: SkinTexture) {
        super();
        this.sprite = skinSprite(t);
        this.addChild(this.sprite);
        this.resize(this.sprite.width, this.sprite.height);
        this.makeInteractive();
        this.cursor = 'pointer';
        this.onFrame(dt => {
            const target = this.hovered ? 1 : 0;
            if (this.slide === target) return;
            this.slide += (target - this.slide) * Math.min(1, dt / 60);
            if (Math.abs(target - this.slide) < 0.01) this.slide = target;
            this.sprite.x = -12 * this.slide;
        });
    }

    protected override onResize(): void {
        // Clickable where the image is drawn (full-frame images exist), with a
        // little slack on the left so the slid-out image stays clickable.
        const b = opaqueBounds(this.sprite.texture);
        const k = this.sprite.scale.x;
        this.hitArea = new Rectangle(b.x * k - 12, b.y * k, b.width * k + 12, b.height * k);
    }
}

export interface LegacyRankingOptions {
    /** skin.ini Version of the skin that provides the ranking panel. */
    version: number;
    allowRetry: boolean;
    hasReplay: boolean;
    onRetry: () => void;
    onReplay: () => void;
}

/**
 * osu!stable's ranking screen for skins with a ranking-panel: the panel
 * with the score in the skin's score font, judgement images and counts
 * (gekis and katus too), max combo and accuracy, the HP graph, "perfect"
 * for a full combo, the grade, mod icons, ranking-title and the
 * ranking-retry / ranking-replay buttons, at stable's Version 1 or 2+
 * positions in its 1024×768 space (right-anchored items stay at the
 * right edge on widescreen).
 */
export class LegacyRanking extends UIComponent {
    private readonly layout: LegacyRankingLayout;
    private readonly content = new Container();
    private readonly header = new Graphics();
    private readonly title: Sprite | null;
    private readonly info: Container;
    private readonly grade: Container | null;
    /** The play's pp under the grade (McOsu shows it there; stable has no pp on this screen). */
    private readonly pp: Container | null;
    private readonly mods = new Container();
    private readonly buttons: { button: RankingButton; y: number }[] = [];
    private gradeShown = false;
    private wide = 1024;
    /** Fired once when the grade lands (the screen plays the applause). */
    onGradeShown: (() => void) | null = null;

    constructor(private readonly chain: SkinChain, private readonly result: ScoreResult, opts: LegacyRankingOptions) {
        super();
        const r = result;
        const L = (this.layout = legacyRankingLayout(opts.version));
        const first = (name: string): SkinTexture | null => chain.frames(name)[0] ?? null;

        const panelTex = first('ranking-panel');
        if (panelTex) {
            const panel = skinSprite(panelTex);
            panel.position.set(L.panel.x, L.panel.y);
            this.content.addChild(panel);
        }

        // --- score and counts (the skin's score font) -------------------------
        const font = new LegacyFont(chain, 'score');
        // Stable draws the numbers at the font's own size times a fixed factor;
        // the layout's sizes are those factors applied to the classic default
        // digit (33 units wide), so other fonts keep their proportions
        // (odometer-style skins line their digits up with slots in the panel).
        const number = (text: string, x: number, y: number, size: number): void => {
            const t = new LegacySpriteText(font);
            t.text = text;
            t.scale.set(size / DEFAULT_DIGIT_WIDTH);
            t.position.set(x, y);
            this.content.addChild(t);
        };
        number(String(Math.max(0, Math.round(r.score))).padStart(8, '0'), L.score.x, L.score.y, L.scoreHeight);
        const counts = [r.count300, r.count100, r.count50, r.countGeki, r.countKatu, r.countMiss];
        counts.forEach((n, i) => {
            const col = Math.floor(i / 3), row = i % 3;
            const tex = HIT_COUNT_IMAGES[i].map(n => first(n)).find(t => !!t) ?? null;
            if (tex) {
                const s = skinSprite(tex, L.hitImageScale);
                s.anchor.set(0.5);
                s.position.set(L.hitImage.x + col * L.column, L.hitImage.y + row * L.row);
                this.content.addChild(s);
            }
            number(`${Math.max(0, n)}x`, L.hitCount.x + col * L.column, L.hitCount.y + row * L.row, L.numberHeight);
        });

        // --- max combo and accuracy -------------------------------------------
        for (const [name, at] of [['ranking-maxcombo', L.maxComboLabel], ['ranking-accuracy', L.accuracyLabel]] as const) {
            const tex = first(name);
            if (!tex) continue;
            const s = skinSprite(tex);
            s.position.set(at.x, at.y);
            this.content.addChild(s);
        }
        number(`${Math.max(0, r.maxCombo)}x`, L.maxCombo.x, L.maxCombo.y, L.numberHeight);
        number(formatLegacyAccuracy(r.accuracy), L.accuracy.x, L.accuracy.y, L.numberHeight);

        // --- HP graph ---------------------------------------------------------------
        const graphTex = first('ranking-graph');
        if (graphTex) {
            const s = skinSprite(graphTex);
            s.position.set(L.graph.x, L.graph.y);
            this.content.addChild(s);
        }
        this.content.addChild(this.healthGraph());

        if (r.perfect) {
            const tex = first('ranking-perfect');
            if (tex) {
                const s = skinSprite(tex);
                s.anchor.set(0.5);
                s.position.set(L.perfect.x, L.perfect.y);
                this.content.addChild(s);
            }
        }

        // --- header: song info on a dark bar, ranking-title on the right (added last) ---
        this.info = this.songInfo();
        const titleTex = first('ranking-title');
        this.title = titleTex ? skinSprite(titleTex) : null;
        if (this.title) this.title.anchor.set(1, 0);

        // --- mods and grade --------------------------------------------------
        this.buildMods();
        this.content.addChild(this.mods);
        this.grade = this.buildGrade(r.passed ? r.grade : 'F');
        if (this.grade) {
            this.grade.alpha = 0;
            this.content.addChild(this.grade);
        }
        this.pp = r.pp != null ? this.ppLabel(r.pp) : null;
        if (this.pp) {
            this.pp.alpha = 0;
            this.content.addChild(this.pp);
        }

        // --- buttons ---------------------------------------------------------------
        const retryTex = opts.allowRetry ? first('ranking-retry') ?? first('pause-retry') : null;
        if (retryTex) {
            const b = new RankingButton(retryTex);
            b.onActivate = opts.onRetry;
            this.buttons.push({ button: b, y: L.retryY });
        }
        const replayTex = opts.hasReplay ? first('ranking-replay') : null;
        if (replayTex) {
            const b = new RankingButton(replayTex);
            b.onActivate = opts.onReplay;
            this.buttons.push({ button: b, y: retryTex ? L.replayY : L.replayAloneY });
        }
        for (const { button } of this.buttons) this.content.addChild(button);
        // The top bar goes over everything (skins' big grade images often reach up into it).
        this.content.addChild(this.header, this.info);
        if (this.title) this.content.addChild(this.title);
        this.skinnedRetry = !!retryTex;
        this.skinnedReplay = !!replayTex;

        this.addChild(this.content);
        this.eventMode = 'passive';
    }

    /** The skin brought ranking-retry (or pause-retry) / ranking-replay; the screen adds its own buttons for the rest. */
    readonly skinnedRetry: boolean;
    readonly skinnedReplay: boolean;

    private songInfo(): Container {
        const r = this.result;
        const c = new Container();
        const title = label('', { size: 22, weight: '600', shadow: true });
        fitText(title, 640, `${r.artist} - ${r.title} [${r.version}]`);
        const mapper = label(`Beatmap by ${r.creator || 'unknown'}`, { size: 15, weight: '500', color: Colors.grayD, shadow: true });
        const player = label(`Played by ${r.player || 'Guest'} on ${formatDate(r.date)}.`, { size: 15, weight: '500', color: Colors.grayD, shadow: true });
        const v2 = this.layout.headerHeight > 80;
        title.position.set(6, v2 ? 8 : 4);
        mapper.position.set(6, v2 ? 40 : 30);
        player.position.set(6, v2 ? 62 : 48);
        c.addChild(title, mapper, player);
        return c;
    }

    private healthGraph(): Graphics {
        const g = new Graphics();
        const { points, high } = healthGraphPoints(this.result.healthGraph, this.layout.graphBox);
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 2.5, color: high[i - 1] ? 0x99ff33 : 0xff3333, cap: 'round' });
        }
        return g;
    }

    private buildMods(): void {
        const r = this.result;
        const mods = sortedMods(sanitizeMods(r.mods, r.modSettings));
        // First mod rightmost; each next one overlaps it from the left, drawn on top (stable).
        let x = 0;
        for (const m of mods) {
            const name = modIconElement(m);
            const tex = name ? this.chain.texture(name) : null;
            let icon: Container;
            let w: number;
            if (tex) {
                const s = skinSprite(tex);
                w = s.width;
                icon = s;
            } else {
                const own = new ModIcon(m, 40, extendedModInfo(m, r.modSettings));
                w = own.iconWidth;
                icon = own;
            }
            icon.position.set(x - w, 0);
            this.mods.addChild(icon);
            x -= this.layout.modStep;
        }
    }

    private buildGrade(grade: ScoreResult['grade']): Container | null {
        const c = new Container();
        const tex = rankingGradeElements(grade).map(n => this.chain.texture(n)).find(t => !!t) ?? null;
        if (tex) {
            const s = skinSprite(tex);
            s.anchor.set(0.5);
            c.addChild(s);
            return c;
        }
        const letter = new BitmapText({ text: gradeLabel(grade), style: { fontFamily: Fonts.venera, fontSize: 160 } });
        letter.anchor.set(0.5);
        letter.tint = gradeColor(grade);
        c.addChild(letter);
        return c;
    }

    /** "123pp", centred, in wosu!'s font with a shadow so it reads on any skin. */
    private ppLabel(pp: number): Container {
        const c = new Container();
        const t = label(`${Math.round(pp).toLocaleString()}pp`, { size: 44, weight: '800', color: 0xffffff, shadow: true });
        t.anchor.set(0.5);
        c.addChild(t);
        return c;
    }

    protected override onResize(w: number, h: number): void {
        const L = this.layout;
        const s = legacyRankingScale(w, h);
        this.content.scale.set(s);
        const wide = (this.wide = w / s);
        // Narrower than 4:3: centre the 768-high space vertically.
        this.content.position.set(0, Math.max(0, (h - 768 * s) / 2));
        this.header.clear().rect(0, 0, wide, L.headerHeight).fill({ color: 0x000000, alpha: 0.8 });
        if (this.title) {
            this.title.position.set(wide - L.title.right, L.title.y);
            // Long song titles stop short of ranking-title.
            const room = wide - L.title.right - this.title.width - 16;
            this.info.scale.set(Math.min(1, room / Math.max(1, this.info.width)));
        }
        this.mods.position.set(wide - L.mods.right, L.mods.y);
        this.grade?.position.set(wide - L.grade.right, L.grade.y);
        this.pp?.position.set(wide - L.grade.right, PP_Y);
        for (const { button, y } of this.buttons) button.position.set(wide - button.w, y - button.h / 2);
    }

    /** Drive the reveals from the screen's clock (ms). */
    applyTime(t: number): void {
        this.content.alpha = clamp01(t / T_FADE);
        this.buttons.forEach(({ button }, i) => {
            const k = easeOutQuint((t - T_BUTTONS - i * 80) / 500);
            button.x = this.wide - button.w + (1 - k) * (button.w + 20);
        });
        if (this.grade) {
            const k = clamp01((t - LEGACY_T_GRADE) / 200);
            this.grade.alpha = k;
            this.grade.scale.set(1 + 0.4 * (1 - easeOutQuint((t - LEGACY_T_GRADE) / 500)));
        }
        if (this.pp) this.pp.alpha = clamp01((t - LEGACY_T_GRADE - 300) / 300);
        if (t >= LEGACY_T_GRADE && !this.gradeShown) {
            this.gradeShown = true;
            this.onGradeShown?.();
        }
    }
}
