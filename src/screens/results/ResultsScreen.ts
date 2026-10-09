import { Container, Rectangle } from 'pixi.js';
import { Screen } from '../../app/Screen';
import type { Selection } from '../../app/Game';
import type { ScoreResult } from '../../gameplay/ScoreResult';
import type { Action } from '../../input/bindings';
import { BackButton, Button } from '../../ui/Button';
import { Colors } from '../../ui/theme';
import { ScorePanel, PANEL_H, PANEL_W, T_END, T_RANK } from './ScorePanel';
import { StatisticsPanel, STATS_W } from './StatisticsPanel';
import { clamp01, easeOutQuint } from './resultsMath';

const GAP = 24;
const MAX_SCALE = 1.3;

/**
 * osu!lazer's results screen: the expanded score panel (accuracy circle,
 * rank, score, statistics) beside the statistics panel (timing
 * distribution, health graph). Every reveal is driven by one clock, so a
 * click anywhere jumps straight to the final state.
 */
export class ResultsScreen extends Screen {
    override readonly catchesClicks = true;
    private panel!: ScorePanel;
    private stats!: StatisticsPanel;
    private readonly panelWrap = new Container();
    private readonly statsWrap = new Container();
    private readonly buttons = new Container();
    private retryButton!: Button;
    private doneButton!: Button;
    private backButton!: BackButton;
    private clock = 0;
    private panelScale = 1;
    private top = 0;
    private leaving = false;

    constructor(readonly result: ScoreResult, readonly selection: Selection) {
        super();
    }

    override load(): void {
        const g = this.game;
        this.panel = new ScorePanel(g, this.result, this.selection);
        this.panel.onRankRevealed = () => (this.result.passed ? g.uiSounds.select() : g.uiSounds.error());
        this.stats = new StatisticsPanel(this.result, this.selection);
        this.panelWrap.addChild(this.panel);
        this.statsWrap.addChild(this.stats);

        const triangles = g.skin.tex('triangle');
        this.retryButton = new Button('Retry', { color: Colors.pink, icon: 'retry', triangles, width: 170, height: 44 });
        this.retryButton.onActivate = () => this.retry();
        this.doneButton = new Button('Back to song select', { color: 0x4a4a5a, icon: 'list', triangles, width: 220, height: 44 });
        this.doneButton.onActivate = () => this.goBack();
        this.buttons.addChild(this.retryButton, this.doneButton);
        this.buttons.alpha = 0;
        this.backButton = new BackButton();
        this.backButton.onActivate = () => this.goBack();

        this.addChild(this.statsWrap, this.panelWrap, this.buttons, this.backButton);
        // The toolbar comes back only after this screen is pushed (gameplay hides it).
        this.disposer.add(g.toolbarVisible.bind(() => this.relayout()));
        // Full-screen hit area: a click anywhere skips the reveal sequence.
        this.hitArea = new Rectangle(0, 0, 1, 1);
        this.on('pointerdown', () => this.skip());
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        if (!this.panel) return;
        const toolbar = this.game.toolbarVisible.value ? this.game.toolbar.h : 0;
        const groupW = PANEL_W + GAP + STATS_W;
        const retry = this.retryButton, done = this.doneButton;
        const back = this.backButton;
        const rowW = retry.w + 16 + done.w;
        // Short landscape screens (phones): a button row under the panels
        // shrinks them a lot, so the buttons stack in a column on the right
        // (clear of the back button) and the panels use the full height.
        const colW = Math.max(retry.w, done.w);
        const normalTop = toolbar + 16;
        const normalScale = Math.max(0.3, Math.min(MAX_SCALE, (h - normalTop - 76) / PANEL_H, (w - 32) / groupW));
        const compactTop = toolbar + 8;
        const left = back.w + 8;
        const compactScale = Math.max(0.3, Math.min(MAX_SCALE, (h - compactTop - 12) / PANEL_H, (w - left - colW - 32) / groupW));
        const compact = h < 700 && compactScale > normalScale * 1.08;
        let x0: number;
        if (compact) {
            this.top = compactTop;
            this.panelScale = compactScale;
            const used = groupW * compactScale + 16 + colW;
            x0 = Math.max(left, Math.round((w - used) / 2));
            retry.position.set(0, 0);
            done.position.set(0, retry.h + 12);
            const stackH = retry.h + 12 + done.h;
            this.buttons.position.set(Math.round(x0 + groupW * compactScale + 16), Math.round(this.top + (PANEL_H * compactScale - stackH) / 2));
        } else {
            this.top = normalTop;
            this.panelScale = normalScale;
            x0 = (w - groupW * normalScale) / 2;
            retry.position.set(0, 0);
            done.position.set(retry.w + 16, 0);
            this.buttons.position.set(Math.round((w - rowW) / 2), h - 60);
        }
        const s = this.panelScale;
        this.panelWrap.scale.set(s);
        this.statsWrap.scale.set(s);
        this.panelWrap.x = Math.round(x0);
        this.statsWrap.position.set(Math.round(x0 + (PANEL_W + GAP) * s), this.top);
        back.position.set(0, h - back.h);
        this.applyTime();
    }

    override onEntering(): void {
        const bg = this.game.background;
        bg.setBlur(0.5, 800);
        bg.setDim(0.6, 800);
        this.game.music.loopFromPreview = false;
        this.alpha = 0;
        this.fadeIn(300);
        this.clock = 0;
        this.applyTime();
    }

    override onExiting(): number {
        this.fadeOut(250);
        return 250;
    }

    override update(dt: number): void {
        if (this.clock < T_END + 1000) {
            this.clock += dt;
            this.applyTime();
        }
    }

    private applyTime(): void {
        const t = this.clock;
        this.panel.applyTime(t);
        this.stats.applyTime(t);
        const a = clamp01(t / 500);
        this.panelWrap.alpha = a;
        this.panelWrap.y = this.top + (1 - easeOutQuint(a)) * 40 * this.panelScale;
        this.buttons.alpha = clamp01((t - T_RANK) / 400);
    }

    /** Jump every animation to its final state. */
    skip(): void {
        if (this.clock < T_END) {
            this.clock = T_END;
            this.applyTime();
        }
    }

    private goBack(): void {
        if (this.leaving) return;
        this.leaving = true;
        this.game.uiSounds.back();
        this.game.openSongSelect();
    }

    private retry(): void {
        if (this.leaving) return;
        this.leaving = true;
        // Return to song select first so the stack stays select → loader → player.
        this.game.openSongSelect();
        this.game.play(this.selection);
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back') {
            this.goBack();
            return true;
        }
        if (action === 'quickRetry') {
            this.retry();
            return true;
        }
        if ((action === 'select' || e.code === 'Space') && this.clock < T_END) {
            this.skip();
            return true;
        }
        return false;
    }
}
