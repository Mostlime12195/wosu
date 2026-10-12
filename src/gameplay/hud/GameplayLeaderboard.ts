import { BitmapText, Container, FillGradient, Graphics, Matrix, Sprite, Texture, type Text } from 'pixi.js';
import { Easing, type EasingFn } from '../../core/easing';
import { damp, formatNumber } from '../../core/math';
import { counterText, fitText, label } from '../../ui/text';
import { GameplayLeaderboardModel, type LeaderboardEntry, type LeaderboardSource } from './leaderboard';
import { formatAccuracy } from './ScoreDisplay';

// lazer's DrawableGameplayLeaderboardScore metrics (lazer units).
const PANEL_HEIGHT = 38;
/** OsuGame.SHEAR: panels lean right by 0.2 of their height. */
const SHEAR = 0.2;
const SHEAR_WIDTH = PANEL_HEIGHT * SHEAR;
const ELASTIC_WIDTH_LENIENCE = 10;
const AVATAR_SIZE = PANEL_HEIGHT;
const LEFT_EXTENSION = 20;
const REGULAR_LEFT = AVATAR_SIZE + AVATAR_SIZE / 2;
const EXTENDED_LEFT = REGULAR_LEFT + LEFT_EXTENSION;
const ACCURACY_COMBO_CUTOFF = 150;
const USERNAME_SCORE_CUTOFF = 50;
const CORNER_RADIUS = 10;
const BORDER = 2;
const PANEL_TRANSITION = 500;
const TEXT_TRANSITION = 200;
// DrawableGameplayLeaderboard.
const FLOW_X = SHEAR_WIDTH + ELASTIC_WIDTH_LENIENCE;
export const LEADERBOARD_WIDTH = 260 + FLOW_X;
export const LEADERBOARD_HEIGHT = 300;
const SPACING = 2.5;
const LAYOUT_DURATION = 450;
const FADE_DURATION = 100;
/** o!f ScrollContainer's distance-decay scroll (0.99 per ms) as a half-life. */
const SCROLL_HALF_LIFE = Math.log(0.5) / Math.log(0.99);
/** lazer's local leaderboard lists every score; this many keeps the cost bounded. */
export const MAX_SCORES = 50;

/** OsuColour: Lime2 (first place), Orange2 (the player), Blue4 (everyone else). */
const LIME = 0x99eb47;
const ORANGE = 0xebc247;
const BLUE = 0x2e576b;

/** The panel's right layer width (lazer's computeRightLayerWidth). */
const EXPANDED_RIGHT = LEADERBOARD_WIDTH - EXTENDED_LEFT - AVATAR_SIZE / 2;
const COLLAPSED_RIGHT = AVATAR_SIZE / 2;

/** One animated number (an o!f transform on a single property). */
class Anim {
    private from: number;
    private to: number;
    private elapsed = 0;
    private duration = 0;
    private easing: EasingFn = Easing.None;

    constructor(public value: number) {
        this.from = this.to = value;
    }

    set(to: number, duration: number, easing: EasingFn): void {
        if (to === this.to) return;
        this.from = this.value;
        this.to = to;
        this.elapsed = 0;
        this.duration = duration;
        this.easing = easing;
        if (duration <= 0) this.value = to;
    }

    finish(): void {
        this.value = this.from = this.to;
        this.duration = 0;
    }

    /** True while the value moved. */
    step(dt: number): boolean {
        if (this.value === this.to) return false;
        this.elapsed += dt;
        const t = this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
        this.value = t >= 1 ? this.to : this.from + (this.to - this.from) * this.easing(t);
        return true;
    }
}

const gradients = new Map<string, FillGradient>();

/** A vertical gradient of one colour between two alphas, shared by every panel. */
function verticalGradient(color: number, top: number, bottom: number): FillGradient {
    const key = `${color}|${top}|${bottom}`;
    let g = gradients.get(key);
    if (!g) {
        const rgb = (a: number) => ({ r: (color >> 16) & 255, g: (color >> 8) & 255, b: color & 255, a });
        g = new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 0, y: 1 },
            textureSpace: 'local',
            colorStops: [{ offset: 0, color: rgb(top) }, { offset: 1, color: rgb(bottom) }],
        });
        gradients.set(key, g);
    }
    return g;
}

const fadeMasks = new Map<string, Texture>();

/**
 * The scrolled list's alpha mask: opaque, fading to nothing over one
 * panel's height at the top and/or bottom edge. lazer fades each row by
 * where it sits relative to those same two lines, so this is exact.
 */
function fadeMask(top: boolean, bottom: boolean): Texture {
    const key = `${top}|${bottom}`;
    let t = fadeMasks.get(key);
    if (!t) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = LEADERBOARD_HEIGHT;
        const ctx = canvas.getContext('2d')!;
        const g = ctx.createLinearGradient(0, 0, 0, LEADERBOARD_HEIGHT);
        const edge = PANEL_HEIGHT / LEADERBOARD_HEIGHT;
        g.addColorStop(0, `rgba(255,255,255,${top ? 0 : 1})`);
        g.addColorStop(edge, 'rgba(255,255,255,1)');
        g.addColorStop(1 - edge, 'rgba(255,255,255,1)');
        g.addColorStop(1, `rgba(255,255,255,${bottom ? 0 : 1})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 1, LEADERBOARD_HEIGHT);
        t = Texture.from(canvas);
        fadeMasks.set(key, t);
    }
    return t;
}

/** A rectangle with only its left or right corners rounded. */
function halfRoundRect(g: Graphics, x: number, w: number, h: number, r: number, side: 'left' | 'right'): Graphics {
    const rr = Math.min(r, w, h / 2);
    if (side === 'left') {
        return g.moveTo(x + w, 0).lineTo(x + rr, 0).arcTo(x, 0, x, rr, rr).lineTo(x, h - rr).arcTo(x, h, x + rr, h, rr).lineTo(x + w, h).closePath();
    }
    return g.moveTo(x, 0).lineTo(x + w - rr, 0).arcTo(x + w, 0, x + w, rr, rr).lineTo(x + w, h - rr).arcTo(x + w, h, x + w - rr, h, rr).lineTo(x, h).closePath();
}

/**
 * lazer's DrawableGameplayLeaderboardScore: a sheared panel with the
 * position on the left, an avatar tile straddling the split, and the
 * name, accuracy, score and highest combo on the right. First place and
 * the player get lazer's wider, coloured panel (lime / orange); collapsed
 * (during gameplay) only the position and avatar show.
 */
class LeaderboardPanel extends Container {
    /** Panel shapes, drawn unsheared inside a sheared container (lazer's Shear). */
    private readonly sheared = new Container();
    private readonly shape = new Graphics();
    private readonly positionText: Text;
    private readonly initial: Text;
    private readonly nameText: Text;
    private readonly accuracyText: BitmapText;
    private readonly scoreText: BitmapText;
    private readonly comboText: BitmapText;
    private readonly panelX = new Anim(LEFT_EXTENSION);
    private readonly leftWidth = new Anim(REGULAR_LEFT);
    private readonly rightWidth = new Anim(COLLAPSED_RIGHT);
    private readonly componentsAlpha = new Anim(0);
    readonly layoutY = new Anim(0);
    private colour = BLUE;
    private dirty = true;
    private shownScore = NaN;
    private shownAccuracy = NaN;
    private shownCombo = NaN;
    private shownPosition: number | null | undefined = undefined;
    private nameFitted = false;

    constructor(readonly entry: LeaderboardEntry) {
        super();
        this.eventMode = 'none';
        this.sheared.setFromMatrix(new Matrix(1, 0, -SHEAR, 1, 0, 0));
        this.sheared.addChild(this.shape);
        this.positionText = label('', { size: 14, weight: '600' });
        this.positionText.anchor.set(0.5);
        this.initial = label((entry.name.trim()[0] ?? '?').toUpperCase(), { size: 18, weight: '700', color: 0x666666 });
        this.initial.anchor.set(0.5);
        this.nameText = label(entry.name, { size: 14, weight: '600' });
        this.nameText.anchor.set(0, 1);
        this.accuracyText = counterText('', { size: 12 });
        this.accuracyText.anchor.set(1, 1);
        this.scoreText = counterText('', { size: 16, light: true });
        this.scoreText.anchor.set(0, 1);
        this.comboText = counterText('', { size: 12 });
        this.comboText.anchor.set(1, 1);
        this.addChild(this.sheared, this.positionText, this.initial, this.nameText, this.accuracyText, this.scoreText, this.comboText);
    }

    get texts(): Text[] {
        return [this.positionText, this.initial, this.nameText];
    }

    setExpanded(expanded: boolean): void {
        if (expanded) {
            this.rightWidth.set(EXPANDED_RIGHT, PANEL_TRANSITION, Easing.OutQuint);
            this.componentsAlpha.set(1, PANEL_TRANSITION, Easing.OutQuint);
        } else {
            this.rightWidth.set(COLLAPSED_RIGHT, PANEL_TRANSITION, Easing.OutQuint);
            this.componentsAlpha.set(0, TEXT_TRANSITION, Easing.OutQuint);
        }
    }

    /** lazer's updatePanelState: position text, colour and the widened first / own panel. */
    private updatePanelState(): void {
        const e = this.entry;
        this.shownPosition = e.position;
        this.positionText.text = e.position !== null ? `#${e.position}` : '-';
        let extended = false;
        if (e.position === 1) {
            extended = true;
            this.colour = LIME;
        } else if (e.tracked) {
            extended = true;
            this.colour = ORANGE;
        } else this.colour = BLUE;
        this.panelX.set(extended ? 0 : LEFT_EXTENSION, PANEL_TRANSITION, Easing.OutElastic);
        this.leftWidth.set(extended ? EXTENDED_LEFT : REGULAR_LEFT, PANEL_TRANSITION, Easing.OutElastic);
        this.dirty = true;
    }

    /** Skip running transitions (the first frame, lazer's FinishTransforms). */
    finish(): void {
        this.update(0);
        for (const a of [this.panelX, this.leftWidth, this.rightWidth, this.componentsAlpha, this.layoutY]) a.finish();
        this.dirty = true;
        this.update(0);
    }

    update(dt: number): void {
        const e = this.entry;
        if (e.position !== this.shownPosition) this.updatePanelState();
        if (e.score !== this.shownScore) {
            this.shownScore = e.score;
            this.scoreText.text = formatNumber(e.score);
        }
        if (e.accuracy !== this.shownAccuracy) {
            this.shownAccuracy = e.accuracy;
            this.accuracyText.text = formatAccuracy(e.accuracy);
        }
        if (e.combo !== this.shownCombo) {
            this.shownCombo = e.combo;
            this.comboText.text = `${e.combo}x`;
        }
        let moved = this.panelX.step(dt);
        moved = this.leftWidth.step(dt) || moved;
        moved = this.rightWidth.step(dt) || moved;
        this.componentsAlpha.step(dt);
        this.layoutY.step(dt);
        this.y = this.layoutY.value;
        if (moved || this.dirty) this.redraw();
        const right = this.rightWidth.value;
        const a = this.componentsAlpha.value;
        const accCombo = right >= ACCURACY_COMBO_CUTOFF ? a : 0;
        const nameScore = right >= USERNAME_SCORE_CUTOFF ? a : 0;
        this.accuracyText.alpha = this.comboText.alpha = accCombo;
        this.nameText.alpha = this.scoreText.alpha = nameScore;
        this.accuracyText.visible = this.comboText.visible = accCombo > 0;
        this.nameText.visible = this.scoreText.visible = nameScore > 0;
    }

    private redraw(): void {
        this.dirty = false;
        const x = this.panelX.value;
        const left = this.leftWidth.value;
        const right = this.rightWidth.value;
        const w = left + right;
        const c = this.colour;
        this.sheared.x = x;
        const g = this.shape.clear();
        // The two layers meet at the avatar's centre; lazer masks both to the panel's rounded shape.
        halfRoundRect(g, 0, left, PANEL_HEIGHT, CORNER_RADIUS, 'left').fill(verticalGradient(c, 0.2, 0.5));
        halfRoundRect(g, left, right, PANEL_HEIGHT, CORNER_RADIUS, 'right').fill(verticalGradient(c, 0.1, 0.3));
        g.roundRect(0, 0, w, PANEL_HEIGHT, CORNER_RADIUS).stroke({ width: BORDER, fill: verticalGradient(c, 0.2, 1), alignment: 1 });
        // Avatar tile (lazer draws it in front of both layers): wosu! has no avatars, so the initial.
        const pad = 1.3;
        g.roundRect(left - AVATAR_SIZE / 2 + pad, pad, AVATAR_SIZE - pad * 2, AVATAR_SIZE - pad * 2, CORNER_RADIUS).fill(0x1a1a1a);
        // Text is counter-sheared: placed at its sheared position, drawn upright.
        const unshear = (sx: number, sy: number) => x + sx - SHEAR * sy;
        const mid = PANEL_HEIGHT / 2;
        this.positionText.position.set(unshear(left - REGULAR_LEFT + (REGULAR_LEFT - (AVATAR_SIZE / 2 - SHEAR_WIDTH / 2)) / 2, mid), mid);
        this.initial.position.set(unshear(left, mid), mid);
        // Score components: counter-sheared about the right layer's top-left, so only offset by x.
        const boxLeft = x + left + AVATAR_SIZE / 2 + 4;
        const boxRight = x + left + right - 20;
        const top = 5;
        const bottom = PANEL_HEIGHT - 5;
        const row1 = top + 16;
        this.nameText.position.set(boxLeft, row1);
        this.accuracyText.position.set(boxRight, row1);
        this.scoreText.position.set(boxLeft, bottom + 1);
        this.comboText.position.set(boxRight, bottom);
        if (!this.nameFitted && right >= EXPANDED_RIGHT - 0.5) {
            // Truncate once at full width, leaving room for "100.00%".
            this.nameFitted = true;
            fitText(this.nameText, EXPANDED_RIGHT - AVATAR_SIZE / 2 - 4 - 20 - 48, this.entry.name);
        }
    }
}

/**
 * lazer's DrawableGameplayLeaderboard with the solo (local scores)
 * provider: a 300-unit-tall column of panels, the player's live entry
 * moving up past local scores as it overtakes them (re-sorted once a
 * second, panels sliding to their new place). Panels expand while the
 * player isn't actively playing (intro, breaks, pause) or holds Ctrl, and
 * collapse during gameplay (lazer's "Collapse during gameplay", on by
 * default). With more entries than fit, the list scrolls to keep the
 * player centred and fades the rows at its edges. Units are lazer's; the
 * origin is the leaderboard's top-left.
 */
export class GameplayLeaderboard extends Container {
    private readonly flow = new Container();
    /** Clips and fades the list while it scrolls (lazer's scroll container + edge fade). */
    private readonly fade = new Sprite();
    private masked = false;
    private model: GameplayLeaderboardModel;
    private panels: LeaderboardPanel[] = [];
    private readonly alphaAnim = new Anim(1);
    private _expanded = true;
    private _shown = true;
    private scroll = 0;
    private textResolution = 0;
    private sortedVersion = -1;

    constructor(private readonly playerName: string) {
        super();
        this.eventMode = 'none';
        this.flow.x = FLOW_X;
        this.fade.texture = fadeMask(false, false);
        this.fade.setSize(LEADERBOARD_WIDTH, LEADERBOARD_HEIGHT);
        this.fade.visible = false;
        this.addChild(this.fade, this.flow);
        this.model = new GameplayLeaderboardModel([], playerName);
        this.rebuild();
    }

    /** The beatmap's local scores, best first (from the score store); the live score is kept. */
    setScores(scores: readonly LeaderboardSource[]): void {
        const live = this.model.tracked;
        this.model = new GameplayLeaderboardModel(scores, this.playerName, MAX_SCORES);
        this.model.setLive(live.score, live.accuracy, live.combo);
        this.model.sort();
        this.rebuild();
    }

    get entries(): readonly LeaderboardEntry[] {
        return this.model.entries;
    }

    /** lazer's OsuSetting.GameplayLeaderboard (Tab in game): fades the panels in or out. */
    set shown(v: boolean) {
        if (v === this._shown) return;
        this._shown = v;
        // lazer: snap back to the top before fading in.
        if (v && this.flow.alpha < 1) this.scroll = 0;
        this.alphaAnim.set(v ? 1 : 0, FADE_DURATION, Easing.OutQuint);
    }

    get shown(): boolean {
        return this._shown;
    }

    set expanded(v: boolean) {
        if (v === this._expanded) return;
        this._expanded = v;
        for (const p of this.panels) p.setExpanded(v);
    }

    get expanded(): boolean {
        return this._expanded;
    }

    /** Render the panels' text at `r` × the screen's pixel density (they are scaled up with the HUD). */
    setTextResolution(r: number): void {
        if (Math.abs(r - this.textResolution) < 0.01) return;
        this.textResolution = r;
        for (const p of this.panels) for (const t of p.texts) t.resolution = r;
    }

    private rebuild(): void {
        for (const p of this.panels) p.destroy({ children: true });
        this.panels = this.model.entries.map(e => {
            const p = new LeaderboardPanel(e);
            if (this.textResolution) for (const t of p.texts) t.resolution = this.textResolution;
            p.setExpanded(this._expanded);
            p.layoutY.set(this.slotY(e.displayOrder), 0, Easing.None);
            p.finish();
            this.flow.addChild(p);
            return p;
        });
        this.sortedVersion = this.model.version;
        this.scroll = 0;
    }

    private slotY(order: number): number {
        return (order - 1) * (PANEL_HEIGHT + SPACING);
    }

    update(dt: number, score: number, accuracy: number, combo: number): void {
        const m = this.model;
        m.setLive(score, accuracy, combo);
        m.update(dt);
        if (m.version !== this.sortedVersion) {
            this.sortedVersion = m.version;
            for (const p of this.panels) p.layoutY.set(this.slotY(p.entry.displayOrder), LAYOUT_DURATION, Easing.OutQuint);
        }
        this.alphaAnim.step(dt);
        this.flow.alpha = this.alphaAnim.value;
        this.flow.visible = this.flow.alpha > 0.001;
        if (!this.flow.visible) return;
        for (const p of this.panels) p.update(dt);
        this.updateScroll(dt);
    }

    /** lazer's DrawableGameplayLeaderboard.Update: follow the player, fade rows at the edges. */
    private updateScroll(dt: number): void {
        const n = this.panels.length;
        const flowHeight = n * PANEL_HEIGHT + Math.max(0, n - 1) * SPACING;
        const requiresScroll = flowHeight > LEADERBOARD_HEIGHT;
        const maxScroll = Math.max(0, flowHeight - LEADERBOARD_HEIGHT);
        const tracked = this.panels.find(p => p.entry.tracked);
        if (requiresScroll && tracked) {
            const target = Math.max(0, Math.min(maxScroll, tracked.y + PANEL_HEIGHT / 2 - LEADERBOARD_HEIGHT / 2));
            this.scroll = damp(this.scroll, target, SCROLL_HALF_LIFE, dt);
        } else this.scroll = Math.min(this.scroll, maxScroll);
        const current = this.scroll;
        this.flow.y = -current;
        // A list that fits needs no clipping (and no mask pass at all).
        if (requiresScroll !== this.masked) {
            this.masked = requiresScroll;
            this.flow.mask = requiresScroll ? this.fade : null;
            this.fade.visible = requiresScroll;
        }
        if (!requiresScroll) return;
        this.fade.texture = fadeMask(current > 0.5, current < maxScroll - 0.5);
        for (const p of this.panels) p.visible = p.y + PANEL_HEIGHT > current && p.y < current + LEADERBOARD_HEIGHT;
    }

    override destroy(): void {
        super.destroy({ children: true });
    }
}
