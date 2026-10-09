import { Container, Graphics, Sprite, type BitmapText, type FederatedWheelEvent, type Text } from 'pixi.js';
import type { Game } from '../app/Game';
import type { BindableNumber } from '../core/Bindable';
import { damp, lerpColor, scaleColor } from '../core/math';
import { tween } from '../core/Tweener';
import { IconButton } from '../ui/Button';
import { counterText, label } from '../ui/text';
import { Colors } from '../ui/theme';
import { UIComponent, tweenTint } from '../ui/UIComponent';

/** Gauge sweep: 270° with the gap (and caption) at the bottom. */
const ARC_START = Math.PI * 0.75;
const ARC_SWEEP = Math.PI * 1.5;
const SPACING = 10;
const MARGIN = 24;
const STEP = 0.05;
/** Idle time before the meters fade away (lazer: 1s). */
const HIDE_AFTER = 1000;

/**
 * One circular meter (lazer's VolumeMeter): a dark disc, a 270° gauge in
 * the meter colour with a soft glow, the percentage in the middle and the
 * channel name in the gap. The displayed value eases toward the setting.
 */
class VolumeMeter extends UIComponent {
    private readonly disc = new Graphics();
    private readonly gauge = new Graphics();
    private readonly number: BitmapText;
    private readonly caption: Text;
    private shown: number;
    private drawn = -1;
    muted = false;

    constructor(name: string, private readonly size: number, private readonly color: number, readonly bindable: BindableNumber) {
        super();
        this.number = counterText('0', { size: Math.round(size * 0.22) });
        this.number.anchor.set(0.5);
        this.caption = label(name, { size: 11, weight: '800', letterSpacing: 1.5 });
        this.caption.anchor.set(0.5);
        this.caption.tint = Colors.grayB;
        this.addChild(this.disc, this.gauge, this.number, this.caption);
        this.shown = bindable.value;
        this.makeInteractive({ sounds: false });
        this.resize(size, size);
        this.pivot.set(size / 2, size / 2);
    }

    protected override onResize(w: number, h: number): void {
        const c = w / 2;
        this.disc.clear()
            .circle(c, c, c).fill({ color: 0x000000, alpha: 0.75 })
            .circle(c, c, c - 1).stroke({ width: 2, color: 0xffffff, alpha: 0.08 });
        this.number.position.set(c, c - h * 0.02);
        this.caption.position.set(c, c + this.radius * 0.74);
        this.drawn = -1;
        this.draw();
    }

    private get radius(): number {
        return this.size / 2 - this.size * 0.09;
    }

    /** Snap (while hidden) or ease (while visible) to the bound value. */
    sync(animate: boolean): void {
        if (!animate) this.shown = this.bindable.value;
        this.draw();
    }

    tick(dt: number): void {
        const target = this.bindable.value;
        if (this.shown === target) return;
        this.shown = Math.abs(this.shown - target) < 0.001 ? target : damp(this.shown, target, 40, dt);
        this.draw();
    }

    private draw(): void {
        const v = this.shown;
        const key = Math.round(v * 1000) + (this.muted ? 0.5 : 0);
        if (key === this.drawn) return;
        this.drawn = key;
        const c = this.size / 2;
        const r = this.radius;
        const t = this.size * 0.075;
        const col = this.muted ? Colors.gray6 : this.color;
        const g = this.gauge.clear();
        g.arc(c, c, r, ARC_START, ARC_START + ARC_SWEEP).stroke({ width: t, color: scaleColor(col, 0.3) });
        if (v > 0.001) {
            const end = ARC_START + ARC_SWEEP * v;
            // Glow: wider, faint strokes under the solid arc.
            g.arc(c, c, r, ARC_START, end).stroke({ width: t * 2.6, color: lerpColor(col, 0xffffff, 0.2), alpha: 0.12 });
            g.arc(c, c, r, ARC_START, end).stroke({ width: t * 1.6, color: lerpColor(col, 0xffffff, 0.2), alpha: 0.2 });
            g.arc(c, c, r, ARC_START, end).stroke({ width: t, color: lerpColor(col, 0xffffff, 0.15) });
        }
        this.number.text = String(Math.round(v * 100));
    }

    protected override onHoverChange(hovered: boolean): void {
        tween(this, { scale: hovered ? 1.05 : 1 }, { duration: 300, ease: 'OutQuint' });
        tweenTint(this.caption, hovered ? 0xffffff : Colors.grayB, 200);
    }
}

/**
 * osu!lazer's volume overlay: three gauges (effects / master / music)
 * that pop up at the right edge whenever a volume changes and fade out
 * after a second of inactivity. Hover a gauge and scroll to adjust that
 * channel; the speaker button toggles mute.
 */
export class VolumeOverlay extends UIComponent {
    private readonly shade: Sprite;
    private readonly slide = new Container();
    private readonly stack = new Container();
    private readonly masterMeter: VolumeMeter;
    private readonly musicMeter: VolumeMeter;
    private readonly effectsMeter: VolumeMeter;
    private readonly meters: VolumeMeter[];
    private readonly muteBg = new Graphics();
    private readonly mute: IconButton;
    private idle = 0;
    private hiding = true;
    private restore = 0.6;
    private wheelAccum = 0;

    constructor(private readonly game: Game) {
        super();
        const s = game.settings;
        this.shade = new Sprite(game.skin.tex('fadeRight'));
        this.shade.tint = 0x000000;
        this.shade.alpha = 0.6;
        this.shade.eventMode = 'none';
        this.effectsMeter = new VolumeMeter('EFFECTS', 125, Colors.blueDarker, s.effectsVolume);
        this.masterMeter = new VolumeMeter('MASTER', 150, Colors.pinkDarker, s.masterVolume);
        this.musicMeter = new VolumeMeter('MUSIC', 125, Colors.blueDarker, s.musicVolume);
        this.meters = [this.effectsMeter, this.masterMeter, this.musicMeter];
        this.mute = new IconButton('volumeHigh', { size: 40, iconSize: 16, circle: true });
        this.mute.tooltip = 'toggle mute (Ctrl+F4)';
        this.mute.onActivate = () => this.toggleMute();
        this.muteBg.circle(20, 20, 20).fill({ color: 0x000000, alpha: 0.75 });
        this.mute.addChildAt(this.muteBg, 0);
        this.stack.addChild(this.mute, ...this.meters);
        this.slide.addChild(this.stack);
        this.addChild(this.shade, this.slide);

        for (const m of this.meters) {
            m.on('wheel', (e: FederatedWheelEvent) => this.onMeterWheel(m, e));
            this.disposer.add(m.bindable.bind(() => {
                if (m === this.masterMeter) this.updateMute();
                m.sync(this.visible);
            }));
        }
        this.updateMute();
        this.visible = false;
        this.alpha = 0;
        this.eventMode = 'passive';
        this.onFrame(dt => this.tick(dt));
    }

    /** A visible meter is under the pointer (it handles the wheel itself). */
    get meterHovered(): boolean {
        return this.visible && this.meters.some(m => m.hovered);
    }

    /** Change the hovered channel (master when none is hovered). */
    adjust(delta: number): void {
        const meter = this.meters.find(m => m.hovered) ?? this.masterMeter;
        this.change(meter, delta);
    }

    toggleMute(): void {
        const v = this.game.settings.masterVolume;
        if (v.value > 0) {
            this.restore = v.value;
            v.value = 0;
        } else {
            v.value = this.restore > 0 ? this.restore : v.defaultValue;
        }
        this.popUp();
    }

    private change(meter: VolumeMeter, delta: number): void {
        const b = meter.bindable;
        const before = b.value;
        b.value = before + delta;
        if (b.value !== before) this.game.uiSounds.play('UI/osd-change', { rate: 0.85 + b.value * 0.3, throttle: 30 });
        this.popUp();
    }

    private onMeterWheel(meter: VolumeMeter, e: FederatedWheelEvent): void {
        // Alt+wheel is handled globally (and routed to the hovered meter).
        if (e.altKey) return;
        e.stopPropagation();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 33;
        else if (e.deltaMode === 2) dy *= 100;
        // Mouse wheels send ~100 per notch; trackpads many small deltas.
        this.wheelAccum += dy;
        if (Math.abs(this.wheelAccum) < 50) return;
        const steps = Math.sign(this.wheelAccum) * Math.max(1, Math.round(Math.abs(this.wheelAccum) / 100));
        this.wheelAccum = 0;
        this.change(meter, -steps * STEP);
    }

    private updateMute(): void {
        const muted = this.game.settings.masterVolume.value <= 0;
        this.masterMeter.muted = muted;
        this.mute.setIcon(muted ? 'volumeMute' : 'volumeHigh');
        this.mute.active = muted;
    }

    private popUp(): void {
        this.idle = 0;
        if (!this.hiding) return;
        this.hiding = false;
        if (!this.visible) for (const m of this.meters) m.sync(false);
        this.visible = true;
        tween(this, { alpha: 1 }, { duration: 150, ease: 'OutQuint' });
        this.slide.x = 30;
        tween(this.slide, { x: 0 }, { duration: 400, ease: 'OutQuint' });
    }

    private tick(dt: number): void {
        for (const m of this.meters) m.tick(dt);
        if (this.hiding) return;
        const hovered = this.mute.hovered || this.meters.some(m => m.hovered);
        this.idle = hovered ? 0 : this.idle + dt;
        if (this.idle > HIDE_AFTER) {
            this.hiding = true;
            this.fadeOut(300);
        }
    }

    protected override onResize(w: number, h: number): void {
        // Flipped ramp: transparent toward the centre, dark at the edge.
        const tex = this.shade.texture;
        this.shade.scale.set(-300 / tex.width, h / tex.height);
        this.shade.position.set(w, 0);

        const total = 125 + 150 + 125 + SPACING * 2;
        const scale = Math.min(1, (h - 60) / total);
        // Meter centres share x = 0 (stack-local), stacked top to bottom.
        let y = 0;
        for (const m of this.meters) {
            m.position.set(0, y + m.h / 2);
            y += m.h + SPACING;
        }
        this.mute.position.set(-75 - 12 - 40, this.masterMeter.y - 20);
        this.stack.scale.set(scale);
        this.stack.pivot.set(0, total / 2);
        this.stack.position.set(w - MARGIN - 75 * scale, h / 2);
    }
}
