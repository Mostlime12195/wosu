import { BitmapText, Container, FillGradient, Graphics, Sprite, type Texture } from 'pixi.js';
import { tween } from '../../core/Tweener';
import { label } from '../../ui/text';
import { Fonts, gradeColor, gradeLabel } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';
import { uiSounds } from '../../ui/UIContext';
import type { Grade } from '../../storage/ScoreStore';
import { GRADE_SPACING, RANK_CUTOFFS, VIRTUAL_SS } from './resultsMath';

type BandGrade = 'D' | 'C' | 'B' | 'A' | 'S' | 'X';

/** Rank bands in gauge units; SS is a virtual 1% slice so it stays visible. */
const BANDS: { from: number; to: number; grade: BandGrade }[] = [
    { from: RANK_CUTOFFS.D, to: RANK_CUTOFFS.C, grade: 'D' },
    { from: RANK_CUTOFFS.C, to: RANK_CUTOFFS.B, grade: 'C' },
    { from: RANK_CUTOFFS.B, to: RANK_CUTOFFS.A, grade: 'B' },
    { from: RANK_CUTOFFS.A, to: RANK_CUTOFFS.S, grade: 'A' },
    { from: RANK_CUTOFFS.S, to: 1 - VIRTUAL_SS, grade: 'S' },
    { from: 1 - VIRTUAL_SS, to: 1, grade: 'X' },
];

/**
 * Rank badges: `at` is the gauge value that lights the badge, `pos` where
 * it sits around the ring (lazer: mid-band for D/C/B, A and S nudged
 * clockwise so they don't collide with the SS badge at the top).
 */
const BADGES: { at: number; pos: number; grade: BandGrade }[] = [
    { at: RANK_CUTOFFS.D, pos: 0.35, grade: 'D' },
    { at: RANK_CUTOFFS.C, pos: 0.75, grade: 'C' },
    { at: RANK_CUTOFFS.B, pos: 0.85, grade: 'B' },
    { at: RANK_CUTOFFS.A, pos: 0.9125, grade: 'A' },
    { at: RANK_CUTOFFS.S, pos: 0.96, grade: 'S' },
    { at: 1, pos: 1, grade: 'X' },
];

const ORDER: Record<BandGrade, number> = { D: 0, C: 1, B: 2, A: 3, S: 4, X: 5 };

function bandOf(grade: Grade): BandGrade | null {
    switch (grade) {
        case 'XH': case 'X': return 'X';
        case 'SH': case 'S': return 'S';
        case 'A': case 'B': case 'C': case 'D': return grade;
        default: return null;
    }
}

export interface CircleTextures {
    triangle: Texture;
    glow: Texture;
    circle: Texture;
}

interface Particle {
    s: Sprite;
    vx: number;
    vy: number;
    vr: number;
    life: number;
}

const angleAt = (p: number): number => -Math.PI / 2 + p * Math.PI * 2;

/** Ring thickness of the accuracy gauge (lazer: 20% of the radius). */
const GAUGE_W = 0.2;
/** Graded-band ring: 80% of the gauge size, 5% thick (lazer's GradedCircles). */
const BANDS_R = 0.8;
const BANDS_W = 0.05;

/**
 * lazer's AccuracyCircle: a thick gradient gauge that fills to the
 * accuracy, the coloured rank bands just inside it, rank badges around
 * the outside that appear as the gauge passes them, and the rank letter.
 * Drawn centred on (0, 0) with outer radius `radius`.
 */
export class AccuracyCircle extends UIComponent {
    private readonly innerDisc = new Graphics();
    private readonly track = new Graphics();
    private readonly fill = new Graphics();
    private readonly bandRing = new Graphics();
    private readonly badges: { c: Container; at: number; lit: boolean; eligible: boolean }[] = [];
    private readonly rankLayer = new Container();
    private readonly glow: Sprite;
    private readonly flash: Sprite;
    private readonly superFlash: Sprite;
    private readonly letter: BitmapText;
    private readonly particleLayer = new Container();
    private readonly particles: Particle[] = [];
    private readonly gradient: FillGradient;
    /** Letter scale that fits the inner disc. */
    private readonly letterScale: number;
    private readonly band: BandGrade | null;
    private progress = -1;
    private bandsProgress = -1;
    private glowClock = 0;
    private glowLive = false;
    revealed = false;

    constructor(
        private readonly textures: CircleTextures,
        private readonly grade: Grade,
        private readonly passed: boolean,
        readonly radius = 105,
    ) {
        super();
        const r = radius;
        this.band = passed ? bandOf(grade) : null;
        // Silver S/SS (HD/FL) recolour the matching badges too.
        const silver = grade === 'XH' || grade === 'SH';
        const badgeColor = (g: BandGrade) => gradeColor(silver && (g === 'S' || g === 'X') ? `${g}H` : g);
        this.gradient = new FillGradient({
            type: 'linear',
            start: { x: 0, y: -r },
            end: { x: 0, y: r },
            colorStops: passed
                ? [{ offset: 0, color: '#7CF6FF' }, { offset: 1, color: '#BAFFA9' }]
                : [{ offset: 0, color: '#ff8a8a' }, { offset: 1, color: '#ff5a5a' }],
            textureSpace: 'global',
        });

        const gaugeW = r * GAUGE_W;
        this.innerDisc.circle(0, 0, r * BANDS_R - 6).fill({ color: 0x000000, alpha: 0.28 });
        // Background track: a touch wider inwards so no seam shows under the gauge.
        this.track.circle(0, 0, r - gaugeW / 2 - 0.5).stroke({ width: gaugeW + 1, color: 0x2f2f2f, alpha: 0.5 });

        for (const b of BADGES) {
            const c = new Container();
            const text = label(gradeLabel(b.grade), { size: 10, weight: '800', color: 0x16161c });
            text.anchor.set(0.5);
            const w = Math.max(28, text.width + 12);
            const bg = new Graphics().roundRect(-w / 2, -7, w, 14, 7).fill(badgeColor(b.grade));
            c.addChild(bg, text);
            // lazer lays badges on an ellipse 20px out sideways, 15px out vertically.
            const a = angleAt(b.pos);
            c.position.set(Math.cos(a) * (r + 20), Math.sin(a) * (r + 15));
            c.alpha = 0;
            const eligible = this.band !== null && ORDER[b.grade] <= ORDER[this.band];
            this.badges.push({ c, at: b.at, lit: false, eligible });
        }

        const color = gradeColor(grade);
        this.glow = new Sprite(textures.glow);
        this.glow.anchor.set(0.5);
        this.glow.tint = color;
        this.glow.alpha = 0;
        this.glow.blendMode = 'add';
        // lazer's flash is a blurred copy of the letter in the rank colour,
        // added on top; a soft glow sprite reads the same at this size.
        this.flash = new Sprite(textures.glow);
        this.flash.anchor.set(0.5);
        this.flash.alpha = 0;
        this.flash.blendMode = 'add';
        this.flash.tint = color;
        this.superFlash = new Sprite(textures.glow);
        this.superFlash.anchor.set(0.5);
        this.superFlash.alpha = 0;
        this.superFlash.blendMode = 'add';
        this.letter = new BitmapText({ text: gradeLabel(grade), style: { fontFamily: Fonts.venera, fontSize: 96 } });
        this.letter.anchor.set(0.5);
        this.letter.tint = color;
        // Keep wide letters ("SS") inside the inner disc.
        const maxW = (r * BANDS_R - 12) * 1.6;
        const maxH = (r * BANDS_R - 12) * 1.25;
        this.letterScale = Math.min(1, maxW / this.letter.width, maxH / this.letter.height);
        this.letter.scale.set(this.letterScale);
        this.rankLayer.addChild(this.glow, this.letter, this.flash, this.superFlash);
        this.rankLayer.visible = false;

        this.addChild(this.innerDisc, this.track, this.fill, this.bandRing);
        for (const b of this.badges) this.addChild(b.c);
        this.addChild(this.particleLayer, this.rankLayer);
        this.eventMode = 'none';
        this.onFrame(dt => this.tick(dt));
        this.setBandsProgress(0);
        this.setProgress(0);
    }

    /** Reveal of the coloured rank bands (0..1, sweeping clockwise). */
    setBandsProgress(p: number): void {
        p = Math.max(0, Math.min(1, p));
        if (Math.abs(p - this.bandsProgress) < 1e-4) return;
        this.bandsProgress = p;
        const g = this.bandRing.clear();
        if (p <= 0) return;
        const outer = this.radius * BANDS_R - 2.5;
        const w = outer * BANDS_W * 2;
        const rr = outer - w / 2;
        const half = GRADE_SPACING / 2;
        for (const band of BANDS) {
            const from = band.from + half;
            const to = Math.min(p, band.to - half);
            if (to <= from) continue;
            const a0 = angleAt(from), a1 = angleAt(to);
            g.moveTo(Math.cos(a0) * rr, Math.sin(a0) * rr).arc(0, 0, rr, a0, a1).stroke({ width: w, color: gradeColor(band.grade) });
        }
    }

    /**
     * Gauge fill in accuracy units (0..1). Badges only light once the fill
     * has `started` (else the D badge, at 0%, would pop before the gauge).
     */
    setProgress(p: number, started = p > 0): void {
        p = Math.max(0, Math.min(1, p));
        if (started) this.lightBadges(p);
        if (Math.abs(p - this.progress) < 1e-5) return;
        this.progress = p;
        const gaugeW = this.radius * GAUGE_W;
        const rr = this.radius - gaugeW / 2;
        const g = this.fill.clear();
        if (p >= 0.9999) {
            g.circle(0, 0, rr).stroke({ width: gaugeW, fill: this.gradient });
        } else if (p > 0.0005) {
            // Butt caps: a round cap would overshoot the accuracy by half the
            // ring's thickness at both ends.
            const a0 = angleAt(0);
            const a1 = angleAt(p);
            g.moveTo(Math.cos(a0) * rr, Math.sin(a0) * rr).arc(0, 0, rr, a0, a1).stroke({ width: gaugeW, fill: this.gradient, cap: 'butt' });
        }
    }

    private lightBadges(p: number): void {
        for (const b of this.badges) {
            if (!b.eligible || b.lit) continue;
            if (b.at >= 1 ? p >= 0.9999 : p >= b.at) {
                b.lit = true;
                // lazer's badge dinks rise in pitch; the SS badge gets its own.
                if (b.at >= 1) uiSounds()?.play('Results/badge-dink-max');
                else uiSounds()?.play('Results/badge-dink', { rate: 1 + b.at * 0.25 });
                // lazer's RankBadge.Appear: quick fade in with a glow pulse.
                b.c.alpha = 1;
                b.c.scale.set(1.35);
                tween(b.c, { scale: 1 }, { duration: 500, ease: 'OutQuint' });
            }
        }
    }

    /** Land the rank letter (lazer's RankText.Appear). */
    revealRank(): void {
        if (this.revealed) return;
        this.revealed = true;
        const ls = this.letterScale;
        const g = this.grade;
        this.rankLayer.visible = true;
        const high = this.passed && (g === 'A' || g === 'S' || g === 'SH' || g === 'X' || g === 'XH');
        const s = g === 'S' || g === 'SH' || g === 'X' || g === 'XH';
        const ss = g === 'X' || g === 'XH';
        if (!high) {
            // Below A: drop in with a bounce; D and failed tip over a little.
            this.letter.alpha = 0;
            this.letter.y = -20;
            const tip = g === 'D' || !this.passed;
            tween(this.letter, { alpha: 1 }, { duration: 200, ease: 'OutQuint' });
            // Chained, not delayed: a second tween on `y` would replace the drop.
            tween(this.letter, { y: 0 }, {
                duration: 200,
                ease: 'OutBounce',
                onComplete: () => {
                    if (tip && !this.destroyed) tween(this.letter, { rotation: (5 * Math.PI) / 180, y: 3 }, { duration: 150, delay: 500, ease: 'In' });
                },
            });
            return;
        }
        this.letter.alpha = 1;
        const d = this.radius * 2.1;
        this.flash.width = this.flash.height = d;
        this.flash.alpha = 1;
        tween(this.flash, { alpha: 0 }, { duration: ss ? 3000 : 1200, ease: ss ? 'Out' : 'OutQuint' });
        if (s) {
            this.letter.scale.set(ls * 1.05);
            tween(this.letter, { scale: ls }, { duration: 3000, ease: 'OutQuint' });
            this.glow.width = this.glow.height = this.radius * 2.3;
            tween(this.glow, { alpha: 0.45 }, { duration: 600, onComplete: () => (this.glowLive = true) });
        }
        if (ss) {
            this.superFlash.tint = 0xffffff;
            this.superFlash.width = this.superFlash.height = this.radius * 3;
            this.superFlash.alpha = 1;
            tween(this.superFlash, { alpha: 0 }, { duration: 800, ease: 'OutQuint' });
        }
        this.burst(gradeColor(g), s ? 36 : 20);
    }

    private burst(color: number, n: number): void {
        for (let i = 0; i < n; i++) {
            const s = new Sprite(this.textures.triangle);
            s.anchor.set(0.5);
            s.tint = i % 3 === 0 ? 0xffffff : color;
            const size = 6 + Math.random() * 12;
            s.scale.set(size / this.textures.triangle.width);
            s.rotation = Math.random() * Math.PI * 2;
            const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
            const speed = 0.1 + Math.random() * 0.18;
            const r0 = this.radius * 0.35;
            s.position.set(Math.cos(a) * r0, Math.sin(a) * r0);
            this.particleLayer.addChild(s);
            this.particles.push({ s, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, vr: (Math.random() - 0.5) * 0.01, life: 0 });
        }
    }

    private tick(dt: number): void {
        if (this.particles.length) {
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const p = this.particles[i];
                p.life += dt;
                const k = Math.exp(-p.life / 500);
                p.s.x += p.vx * dt * k;
                p.s.y += p.vy * dt * k;
                p.s.rotation += p.vr * dt;
                p.s.alpha = Math.max(0, 1 - p.life / 1100);
                if (p.life > 1100) {
                    p.s.destroy();
                    this.particles.splice(i, 1);
                }
            }
        }
        if (this.glowLive) {
            // Slow breathing on S/SS ranks, continuing from the fade-in's 0.45.
            this.glowClock += dt;
            this.glow.alpha = 0.39 + 0.06 * Math.cos(this.glowClock / 500);
        }
    }
}
