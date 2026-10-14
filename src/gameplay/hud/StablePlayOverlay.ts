import { Container, Sprite, type Text } from 'pixi.js';
import type { BreakPeriod } from '../../beatmap/types';
import type { SkinChain } from '../../skin/SkinChain';
import type { SkinTexture } from '../../skin/LegacySkin';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import {
    countdownFrame, crossed, sectionAlpha, sectionPassed, sectionTime, warningArrowsShown,
    type CountdownElement, type CountdownSchedule,
} from '../legacyPlayEvents';

/** wosu!'s own countdown, for skins without the images (the default skin). */
const OWN_COUNTDOWN: Record<CountdownElement, { text: string; color: number; size: number }> = {
    ready: { text: 'READY?', color: Colors.white, size: 0.11 },
    count3: { text: '3', color: Colors.pink, size: 0.24 },
    count2: { text: '2', color: Colors.yellow, size: 0.24 },
    count1: { text: '1', color: Colors.blue, size: 0.24 },
    go: { text: 'GO!', color: Colors.green, size: 0.2 },
};
const ELEMENTS: readonly CountdownElement[] = ['ready', 'count3', 'count2', 'count1', 'go'];
/** A warning arrow at least this tall (in 768-high units) is a full-frame overlay: drawn once, centred. */
const FULL_FRAME_ARROW = 384;

interface CountdownPiece {
    /** The skin's image, or wosu!'s own text. */
    view: Sprite | Text;
    tex: SkinTexture | null;
}

/**
 * osu!stable's play-screen extras over the playfield (below the HUD):
 * the countdown before the first object (ready, count3/2/1, go), the
 * section pass / fail at a long break's midpoint and the warning arrows
 * flashing at the screen sides before a break ends. Images come from the
 * skin chain at stable's size (768-high units); the countdown falls back
 * to wosu!'s own text, the break extras only show when a skin has them.
 * Sounds go through `playSample` (readys, count3s… gos, sectionpass/fail).
 * The arrows draw in `arrowLayer`, which the player places above the HUD.
 */
export class StablePlayOverlay extends Container {
    private readonly countdown = new Map<CountdownElement, CountdownPiece>();
    /** skin.ini Version below 2: 3 on the left, 2 on the right, all staying up until "go". */
    private readonly stacked: boolean;
    private readonly section = new Sprite();
    private readonly passTex: SkinTexture | null;
    private readonly failTex: SkinTexture | null;
    private readonly arrows: Sprite[] = [];
    /**
     * The warning arrows' own layer, for the player to put over the HUD: a
     * full-frame arrow-warning (Phosphor's lamp on its TV frame) lights up
     * on the skin's full-screen scorebar, so it has to draw above it.
     */
    readonly arrowLayer = new Container();
    private readonly arrowTex: SkinTexture | null;
    private readonly arrowFullFrame: boolean;
    private lastTime = NaN;
    /** Section pass / fail being shown: its time and outcome. */
    private sectionShown: { time: number; passed: boolean } | null = null;
    private w = 0;
    private unit = 1;
    /** Plays the first of `names` the skins have. */
    playSample: (names: readonly string[]) => void = () => {};

    constructor(chain: SkinChain, private readonly schedule: CountdownSchedule | null, private readonly breaks: readonly BreakPeriod[]) {
        super();
        this.eventMode = 'none';
        this.arrowLayer.eventMode = 'none';
        this.arrowLayer.visible = false;
        const v1 = chain.config('version') < 2;
        this.stacked = v1;
        if (schedule) {
            for (const e of ELEMENTS) {
                const tex = chain.texture(e);
                let view: Sprite | Text;
                if (tex) {
                    view = new Sprite(tex.texture);
                    // Version 1: count3 hangs off the left edge, count2 off the right.
                    view.anchor.set(v1 && e === 'count3' ? 0 : v1 && e === 'count2' ? 1 : 0.5, 0.5);
                } else {
                    const own = OWN_COUNTDOWN[e];
                    view = label(own.text, { size: 100, weight: '800', italic: true, color: own.color, letterSpacing: 4, shadow: true });
                    // Its own style: the size follows the screen (shared label styles must not change).
                    view.style = view.style.clone();
                    view.anchor.set(0.5);
                }
                view.visible = false;
                this.countdown.set(e, { view, tex });
                this.addChild(view);
            }
        }
        this.passTex = chain.texture('section-pass');
        this.failTex = chain.texture('section-fail');
        this.section.anchor.set(0.5);
        this.section.visible = false;
        this.addChild(this.section);
        // arrow-warning (not tinted) overrides play-warningarrow (red from Version 2, white before).
        const warning = chain.texture('arrow-warning');
        this.arrowTex = warning ?? chain.texture('play-warningarrow');
        this.arrowFullFrame = !!this.arrowTex && this.arrowTex.texture.height * this.arrowTex.scale >= FULL_FRAME_ARROW;
        if (this.arrowTex) {
            for (let i = 0; i < (this.arrowFullFrame ? 1 : 4); i++) {
                const a = new Sprite(this.arrowTex.texture);
                a.anchor.set(0.5);
                a.tint = warning || v1 ? 0xffffff : 0xff0000;
                this.arrows.push(a);
                this.arrowLayer.addChild(a);
            }
        }
    }

    layout(w: number, h: number): void {
        this.w = w;
        const u = (this.unit = h / 768);
        // Version 1 counts sit in the 4:3 area osu! was drawn for.
        const side = Math.max(0, (w - 1024 * u) / 2);
        for (const [e, p] of this.countdown) {
            if (p.tex) {
                p.view.scale.set(u * p.tex.scale);
                const x = !this.stacked ? w / 2 : e === 'count3' ? side : e === 'count2' ? w - side : w / 2;
                p.view.position.set(x, h / 2);
            } else {
                const size = Math.max(12, Math.round(h * OWN_COUNTDOWN[e].size));
                if ((p.view as Text).style.fontSize !== size) (p.view as Text).style.fontSize = size;
                p.view.position.set(w / 2, h / 2);
            }
        }
        this.section.position.set(w / 2, h / 2);
        if (this.arrowTex) {
            const s = u * this.arrowTex.scale;
            if (this.arrowFullFrame) {
                this.arrows[0].scale.set(s);
                this.arrows[0].position.set(w / 2, h / 2);
            } else {
                // Two on each side of the (≤16:9) play area, the right pair mirrored to point inwards.
                const area = Math.min(w, h * 16 / 9);
                const left = (w - area) / 2 + area * 0.16;
                this.arrows.forEach((a, i) => {
                    const right = i >= 2;
                    a.scale.set(right ? -s : s, s);
                    a.position.set(right ? w - left : left, h * (i % 2 === 0 ? 0.25 : 0.75));
                });
            }
        }
    }

    /** The clock jumped (skip): nothing between the old and new time fires. */
    seeked(): void {
        this.lastTime = NaN;
    }

    update(time: number, hp: number): void {
        if (!this.w) return;
        const prev = this.lastTime;
        this.lastTime = time;
        this.updateCountdown(time, prev);
        this.updateSection(time, prev, hp);
        this.arrowLayer.visible = !!this.arrowTex && warningArrowsShown(this.breaks, time);
    }

    private updateCountdown(time: number, prev: number): void {
        const s = this.schedule;
        if (!s) return;
        for (const p of this.countdown.values()) p.view.visible = false;
        for (const f of countdownFrame(s, time, this.stacked)) {
            const p = this.countdown.get(f.element)!;
            p.view.visible = f.alpha > 0;
            p.view.alpha = f.alpha;
        }
        if (!Number.isNaN(prev)) {
            for (const step of s.steps) {
                if (crossed(step.time, prev, time)) this.playSample(step.samples);
            }
        }
    }

    private updateSection(time: number, prev: number, hp: number): void {
        if (!Number.isNaN(prev)) {
            for (const b of this.breaks) {
                const at = sectionTime(b);
                if (at === null || !crossed(at, prev, time)) continue;
                const passed = sectionPassed(hp);
                this.sectionShown = { time: at, passed };
                this.playSample([passed ? 'sectionpass' : 'sectionfail']);
            }
        }
        const shown = this.sectionShown;
        const tex = shown ? (shown.passed ? this.passTex : this.failTex) : null;
        const alpha = shown && tex ? sectionAlpha(time - shown.time) : 0;
        if (shown && time - shown.time > 2000) this.sectionShown = null;
        this.section.visible = alpha > 0;
        if (!tex || alpha <= 0) return;
        this.section.texture = tex.texture;
        this.section.scale.set(this.unit * tex.scale);
        this.section.alpha = alpha;
    }
}
