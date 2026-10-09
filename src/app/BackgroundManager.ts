import { BlurFilter, Container, Graphics, Sprite, Texture, type Renderer } from 'pixi.js';
import { damp } from '../core/math';
import { tween } from '../core/Tweener';

/** Blur levels pre-rendered on demand; intermediate values crossfade. */
const BLUR_LEVELS = [0, 0.25, 0.5, 0.75, 1];
/** Blurred copies are rendered at this width: blur hides the detail anyway. */
const BLUR_WIDTH = 720;

class BackgroundLayer extends Container {
    readonly sharp: Sprite;
    private readonly blurred = new Map<number, Texture>();
    private readonly lo = new Sprite();
    private readonly hi = new Sprite();
    /** Screen scale of the sharp texture (blurred copies are smaller: scaled up to match). */
    private coverScale = 1;

    constructor(readonly key: string, readonly texture: Texture, private readonly owned: boolean, private readonly renderer: Renderer) {
        super();
        this.sharp = new Sprite(texture);
        this.addChild(this.sharp, this.lo, this.hi);
        for (const s of [this.sharp, this.lo, this.hi]) s.anchor.set(0.5);
    }

    private blurredAt(level: number): Texture {
        if (level === 0) return this.texture;
        let t = this.blurred.get(level);
        if (t) return t;
        const src = new Sprite(this.texture);
        const scale = Math.min(1, BLUR_WIDTH / Math.max(1, this.texture.width));
        src.scale.set(scale);
        // Blur is specified in screen terms: a small source (900×250 cover)
        // is magnified more on screen, so it needs a smaller texel radius.
        const sourceH = this.texture.height * scale;
        const strength = (4 + 26 * level) * Math.min(1, Math.max(0.2, sourceH / 540));
        const blur = new BlurFilter({ strength, quality: 4 });
        blur.repeatEdgePixels = true;
        src.filters = [blur];
        t = this.renderer.generateTexture({
            target: src,
            frame: undefined,
            resolution: 1,
            antialias: false,
        });
        src.destroy();
        blur.destroy();
        this.blurred.set(level, t);
        return t;
    }

    applyBlur(amount: number): void {
        if (amount <= 0.001) {
            this.sharp.visible = true;
            this.lo.visible = this.hi.visible = false;
            return;
        }
        let i = 0;
        while (i < BLUR_LEVELS.length - 2 && BLUR_LEVELS[i + 1] < amount) i++;
        const a = BLUR_LEVELS[i], b = BLUR_LEVELS[i + 1];
        const t = Math.min(1, Math.max(0, (amount - a) / (b - a)));
        this.sharp.visible = a === 0;
        this.sharp.alpha = 1;
        this.lo.visible = a !== 0;
        if (this.lo.visible) this.lo.texture = this.blurredAt(a);
        this.hi.visible = t > 0.001;
        if (this.hi.visible) {
            this.hi.texture = this.blurredAt(b);
            this.hi.alpha = t;
        }
        this.scaleBlurred();
    }

    cover(w: number, h: number, extraScale: number): void {
        const tw = this.texture.width || 1, th = this.texture.height || 1;
        this.coverScale = Math.max(w / tw, h / th) * extraScale;
        this.sharp.scale.set(this.coverScale);
        this.scaleBlurred();
    }

    /** Blurred copies may be rendered smaller than the source; match the sharp sprite's size. */
    private scaleBlurred(): void {
        const tw = this.texture.width || 1;
        for (const sp of [this.lo, this.hi]) {
            const k = sp.texture.width > 1 ? tw / sp.texture.width : 1;
            sp.scale.set(this.coverScale * k);
        }
    }

    override destroy(): void {
        for (const t of this.blurred.values()) t.destroy(true);
        this.blurred.clear();
        if (this.owned) this.texture.destroy(true);
        super.destroy({ children: true });
    }
}

/**
 * The global background (lazer's BackgroundScreenStack, simplified):
 * crossfades between textures, applies animated blur/dim, and drifts with
 * the cursor (parallax). Screens describe what they want; this does the
 * transitions.
 */
export class BackgroundManager {
    readonly root = new Container({ label: 'background-root' });
    private readonly content = new Container();
    private readonly dimRect = new Graphics();
    private layers: BackgroundLayer[] = [];
    private custom: Container | null = null;
    private w = 1;
    private h = 1;
    private blur = { v: 0 };
    private dim = { v: 0.2 };
    private parallaxX = 0;
    private parallaxY = 0;
    parallaxEnabled = true;
    parallaxAmount = 0.02;
    /** Screens that switched parallax off (gameplay: lazer's Player uses no parallax). */
    private readonly parallaxBlockers = new Set<object>();
    private requestSeq = 0;

    constructor(private readonly renderer: Renderer, private readonly defaultTexture: () => Texture) {
        this.root.addChild(this.content, this.dimRect);
        this.root.eventMode = 'none';
    }

    get currentKey(): string | null {
        return this.layers[this.layers.length - 1]?.key ?? null;
    }

    setDefault(): void {
        this.setTexture('default', this.defaultTexture(), false);
    }

    /**
     * Load and show a texture identified by `key`; repeated requests for
     * the current key are ignored, stale async loads are dropped.
     */
    async setFrom(key: string, load: () => Promise<Texture | null>): Promise<void> {
        if (this.currentKey === key) return;
        const seq = ++this.requestSeq;
        let tex: Texture | null = null;
        try {
            tex = await load();
        } catch (e) {
            console.warn('background load failed', e);
        }
        if (seq !== this.requestSeq) {
            tex?.destroy(true);
            return;
        }
        if (!tex || !(tex.width > 0)) {
            this.setDefault();
            return;
        }
        this.setTexture(key, tex, true);
    }

    setTexture(key: string, texture: Texture, owned: boolean): void {
        if (this.currentKey === key) {
            if (owned) texture.destroy(true);
            return;
        }
        this.requestSeq++;
        const layer = new BackgroundLayer(key, texture, owned, this.renderer);
        layer.alpha = 0;
        this.layers.push(layer);
        this.content.addChild(layer);
        this.layoutLayer(layer);
        layer.applyBlur(this.blur.v);
        tween(layer, { alpha: 1 }, { duration: 800, ease: 'OutQuad' }).finished.then(() => {
            // Drop everything beneath the fully-opaque newest layer.
            const idx = this.layers.indexOf(layer);
            if (idx <= 0) return;
            for (const old of this.layers.splice(0, idx)) old.destroy();
        });
    }

    /** Put an arbitrary display (e.g. a video sprite) above the image. */
    setCustom(display: Container | null): void {
        if (this.custom) this.content.removeChild(this.custom);
        this.custom = display;
        if (display) this.content.addChild(display);
    }

    setBlur(amount: number, duration = 500): void {
        tween(this.blur, { v: Math.max(0, Math.min(1, amount)) }, {
            duration,
            ease: 'OutQuint',
            onUpdate: () => {
                for (const l of this.layers) l.applyBlur(this.blur.v);
            },
        });
    }

    setDim(amount: number, duration = 500): void {
        tween(this.dim, { v: Math.max(0, Math.min(1, amount)) }, { duration, ease: 'OutQuint' });
    }

    get dimLevel(): number {
        return this.dim.v;
    }

    resize(w: number, h: number): void {
        this.w = w;
        this.h = h;
        for (const l of this.layers) this.layoutLayer(l);
        this.dimRect.clear().rect(0, 0, w, h).fill(0x000000);
    }

    private layoutLayer(l: BackgroundLayer): void {
        l.position.set(this.w / 2, this.h / 2);
        l.cover(this.w, this.h, 1 + this.parallaxAmount * 2);
    }

    /**
     * Turn parallax off while `owner` holds the returned release (or until
     * `release(owner)`); the background eases back to centre.
     */
    suppressParallax(owner: object): () => void {
        this.parallaxBlockers.add(owner);
        return () => this.parallaxBlockers.delete(owner);
    }

    releaseParallax(owner: object): void {
        this.parallaxBlockers.delete(owner);
    }

    get parallaxActive(): boolean {
        return this.parallaxEnabled && this.parallaxBlockers.size === 0;
    }

    update(dt: number, pointer: { x: number; y: number }): void {
        const on = this.parallaxActive;
        const tx = on ? -((pointer.x / Math.max(1, this.w)) - 0.5) * this.w * this.parallaxAmount : 0;
        const ty = on ? -((pointer.y / Math.max(1, this.h)) - 0.5) * this.h * this.parallaxAmount : 0;
        this.parallaxX = damp(this.parallaxX, tx, 120, dt);
        this.parallaxY = damp(this.parallaxY, ty, 120, dt);
        this.content.position.set(this.parallaxX, this.parallaxY);
        this.dimRect.alpha = this.dim.v;
    }
}
