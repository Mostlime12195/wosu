import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { Easing } from '../../core/easing';
import { lerpColor } from '../../core/math';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';

/** lazer's LegacySkin.STABLE_MAGIC_SCALE_FACTOR (stable's 640 → 1024 layout). */
const MAGIC = 1.6;
/** Above this, health is "epic": white fill, additive marker, bigger flash. */
const EPIC_CUTOFF = 0.5;
/** HealthDisplay's initial fill-up: +0.05 every 150 ms. */
const INCREASE_DELAY = 150;

/** lazer's LegacyHealthDisplay.getFillColour (stable's low-HP darkening, then red). */
function fillColour(hp: number): number {
    if (hp < 0.2) return lerpColor(0x000000, 0xff0000, Math.min(1, (0.2 - hp) / 0.2));
    if (hp < EPIC_CUTOFF) return lerpColor(0xffffff, 0x000000, Math.min(1, (0.5 - hp) / 0.5));
    return 0xffffff;
}

/** A texture sharing `t`'s image whose frame can be cut short (the fill's masking). */
function croppable(t: Texture): Texture {
    const f = t.frame;
    return new Texture({
        source: t.source,
        frame: new Rectangle(f.x, f.y, f.width, f.height),
        orig: new Rectangle(0, 0, f.width, f.height),
        dynamic: true,
    });
}

/**
 * lazer's LegacyHealthDisplay (top-left, in lazer's 1024×768 HUD units):
 * scorebar-bg with a fill on top whose width eases (OutQuint, 200 ms) to
 * the current health, and a marker riding the fill's end.
 *
 * Style follows the skin that provides scorebar-bg (lazer looks every
 * part up on that skin first): skin.ini Version 2.0 and above is the new
 * style (scorebar-colour, animated frames allowed, fill at (7.5, 7.8)×1.6,
 * tinted darker below 50% HP and towards red below 20%; scorebar-marker
 * tinted the same, additive while HP ≥ 50%); below 2.0 the old style
 * (fill at (3, 10)×1.6, untinted; scorebar-ki marker swapping to
 * scorebar-kidanger below 50% and scorebar-kidanger2 below 20%).
 *
 * The marker bulges (1.2× → 0.8× over 150 ms) whenever HP rises, and on
 * every successful judgement flashes: an extra copy grows (to 2× while HP
 * is epic, else 1.6×) and fades over 120 ms. At the start the bar fills
 * from empty in 0.05 steps every 150 ms, flashing each step, until the
 * first change in health (HealthDisplay's initial increase).
 */
export class HealthBar extends Container {
    readonly newStyle: boolean;
    private readonly bg = new Sprite();
    private readonly fill = new Sprite();
    private readonly fillFrames: Texture[] = [];
    private readonly fillScale: number;
    private readonly frameDuration: number;
    private readonly maxFillWidth: number;
    private readonly fillHeight: number;
    private readonly fillPos: { x: number; y: number };
    private readonly marker = new Container();
    private readonly main = new Sprite();
    private readonly explode = new Sprite();
    private readonly markerTex: { normal: SkinTexture | null; danger: SkinTexture | null; superDanger: SkinTexture | null };
    private mainScale = 1;

    private clock = 0;
    private started = false;
    private current = 0;
    private lastValue = 0;
    private fillWidth = 0;
    private initialHealth = 0;
    private initial: { nextAt: number; from: number; to: number; start: number } | null = null;
    private flashPending = false;
    private bulgeAt = -1e9;
    private explodeAt = -1e9;
    private explodeTarget = 1.6;
    private shownFrame = -1;
    private shownCrop = -1;

    constructor(chain: SkinChain) {
        super();
        this.eventMode = 'none';
        // lazer: source.FindProvider(s => getTexture(s, "bg") != null), then every part from that skin.
        const layers = chain.layers.filter(l => l.skin && l.textures !== false);
        let start = layers.findIndex(l => l.skin!.texture('scorebar-bg'));
        if (start < 0) start = 0;
        const from = layers.slice(start);
        const tex = (name: string): SkinTexture | null => {
            for (const l of from) {
                const t = l.skin!.texture(name);
                if (t) return t;
            }
            return null;
        };
        const provider = from[0]?.skin ?? null;
        // osu!: no skin.ini at all means "latest"; a skin.ini without Version means 1.0.
        const cfg = provider?.config ?? {};
        const version = cfg.version ?? (Object.keys(cfg).length ? 1 : 2.7);
        this.newStyle = version >= 2;

        const bg = tex('scorebar-bg');
        if (bg) {
            this.bg.texture = bg.texture;
            this.bg.scale.set(bg.scale);
        }

        let frames: SkinTexture[] = [];
        for (const l of from) {
            frames = l.skin!.frames('scorebar-colour');
            if (frames.length) break;
        }
        for (const f of frames) this.fillFrames.push(croppable(f.texture));
        this.fillScale = frames[0]?.scale ?? 1;
        this.frameDuration = chain.frameDuration(frames.length);
        this.maxFillWidth = frames.length ? frames[0].texture.width * this.fillScale : 0;
        this.fillHeight = frames.length ? frames[0].texture.height * this.fillScale : 0;
        this.fillPos = this.newStyle ? { x: 7.5 * MAGIC, y: 7.8 * MAGIC } : { x: 3 * MAGIC, y: 10 * MAGIC };
        this.fill.position.set(this.fillPos.x, this.fillPos.y);
        this.fill.scale.set(this.fillScale);
        this.fill.visible = false;

        this.markerTex = this.newStyle
            ? { normal: tex('scorebar-marker'), danger: null, superDanger: null }
            : { normal: tex('scorebar-ki'), danger: tex('scorebar-kidanger'), superDanger: tex('scorebar-kidanger2') };
        this.main.anchor.set(0.5);
        this.explode.anchor.set(0.5);
        this.explode.alpha = 0;
        this.explode.blendMode = 'add';
        this.setMarker(this.markerTex.normal);
        this.marker.addChild(this.main, this.explode);
        this.addChild(this.bg, this.fill, this.marker);
    }

    private setMarker(t: SkinTexture | null): void {
        this.main.visible = !!t;
        if (!t) return;
        if (this.main.texture !== t.texture) this.main.texture = t.texture;
        this.mainScale = t.scale;
    }

    private markerFor(hp: number): SkinTexture | null {
        const m = this.markerTex;
        if (this.newStyle) return m.normal;
        if (hp < 0.2) return m.superDanger ?? m.normal;
        if (hp < EPIC_CUTOFF) return m.danger ?? m.normal;
        return m.normal;
    }

    /** A successful judgement (lazer's HealthDisplay.NewJudgement, debounced to once per frame). */
    onJudgement(): void {
        this.flashPending = true;
    }

    update(hp: number, dt: number): void {
        const now = (this.clock += dt);
        if (!this.started) {
            this.started = true;
            this.initialHealth = hp;
            if (this.current < hp) this.initial = { nextAt: now + INCREASE_DELAY, from: 0, to: 0, start: now };
            else this.current = hp;
        }
        const init = this.initial;
        if (init) {
            this.current = init.to === init.from ? init.to : init.from + (init.to - init.from) * Math.min(1, (now - init.start) / INCREASE_DELAY);
            if (now >= init.nextAt) {
                const next = Math.min(this.current + 0.05, hp);
                init.from = this.current;
                init.to = next;
                init.start = init.nextAt;
                init.nextAt += INCREASE_DELAY;
                this.flashPending = true;
                if (next >= hp) {
                    this.current = next;
                    this.initial = null;
                }
            }
        }
        if (!this.initial || hp !== this.initialHealth) {
            this.current = hp;
            this.initial = null;
        }
        // lazer's HealthChanged: the marker bulges whenever health rises.
        if (Math.abs(this.lastValue - this.current) > 0.001) {
            if (this.current > this.lastValue) this.bulgeAt = now;
            this.lastValue = this.current;
        }
        if (this.flashPending) {
            this.flashPending = false;
            const epic = this.current >= EPIC_CUTOFF;
            this.bulgeAt = now;
            this.explodeAt = now;
            this.explodeTarget = epic ? 2 : 1.6;
            this.explode.texture = this.main.texture;
            this.explode.blendMode = epic ? 'add' : 'normal';
        }

        // Fill: width eases toward health (Interpolation.ValueAt over 200 ms, OutQuint).
        const k = Easing.OutQuint(Math.min(200, Math.max(0, dt)) / 200);
        this.fillWidth += (this.current * this.maxFillWidth - this.fillWidth) * k;
        this.updateFill(now);

        const colour = fillColour(this.current);
        if (this.newStyle) this.fill.tint = colour;

        this.marker.position.set(this.fillPos.x + this.fillWidth, this.fillPos.y + (this.newStyle ? this.fillHeight / 2 : 0));
        this.setMarker(this.markerFor(this.current));
        if (this.newStyle) {
            this.main.tint = colour;
            this.main.blendMode = this.current < EPIC_CUTOFF ? 'normal' : 'add';
        }
        const b = now - this.bulgeAt;
        const bulge = b < 0 || this.bulgeAt < -1e8 ? 1 : 1.2 + (0.8 - 1.2) * Math.min(1, b / 150);
        this.main.scale.set(this.mainScale * bulge);
        const e = Math.min(1, (now - this.explodeAt) / 120);
        this.explode.visible = e < 1 && this.main.visible;
        if (this.explode.visible) {
            this.explode.scale.set(this.mainScale * (1 + (this.explodeTarget - 1) * Easing.Out(e)));
            this.explode.alpha = 1 - Easing.Out(e);
        }
    }

    /** Show the current fill frame cut to the fill width (lazer masks the fill container). */
    private updateFill(now: number): void {
        const n = this.fillFrames.length;
        if (!n) return;
        const frame = n > 1 ? Math.floor(now / this.frameDuration) % n : 0;
        const tex = this.fillFrames[frame];
        const width = Math.min(this.fillWidth, this.maxFillWidth) / this.fillScale;
        this.fill.visible = width > 0.01;
        if (!this.fill.visible) return;
        if (frame !== this.shownFrame) {
            this.shownFrame = frame;
            this.fill.texture = tex;
            this.shownCrop = -1;
        }
        if (Math.abs(width - this.shownCrop) < 0.01) return;
        this.shownCrop = width;
        tex.frame.width = width;
        tex.orig.width = width;
        tex.update();
    }

    override destroy(): void {
        for (const t of this.fillFrames) t.destroy(false);
        this.fillFrames.length = 0;
        super.destroy({ children: true });
    }
}
