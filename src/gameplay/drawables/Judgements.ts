import { BitmapText, Container, Texture, type Sprite } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { Colors, Fonts } from '../../ui/theme';
import type { HitResult } from '../scoring/ScoreProcessor';
import { SIXTY_FRAME_TIME, clamp01, ease, frameAt, fromDefaultSkin, layerVersion, legacyScale, legacyVersion, sprite } from './context';

const LIFETIME = 800;
const LIGHTING_LIFETIME = 600;
/** lazer's DrawableOsuJudgement lighting: 0.8× → 1.2× over 600ms, in over 200ms, out from 400ms to 1400ms. */
const LEGACY_LIGHTING_LIFETIME = 1400;
/** LegacyJudgementPieceOld/New: fade in over 120ms, fade out from 500ms over 600ms. */
const FADE_IN = 120;
const FADE_OUT_DELAY = 500;
const FADE_OUT = 600;
const LEGACY_LIFETIME = FADE_OUT_DELAY + FADE_OUT;
/** ParticleExplosion(texture, 150, 1600) in a 140-unit box, started 100ms early. */
const PARTICLES = 150;
const PARTICLE_DURATION = 1600;
const PARTICLE_AREA = 140;
/** LegacyJudgementPieceSliderTickHit: rises 10 units over 300ms, then fades over 60ms. */
const TICK_HIT_LIFETIME = 360;

const TEXT: Record<HitResult, string> = { great: 'GREAT', ok: 'OK', meh: 'MEH', miss: 'MISS' };
const COLOR: Record<HitResult, number> = { great: Colors.great, ok: Colors.ok, meh: Colors.meh, miss: Colors.miss };
const IMAGE: Record<HitResult, string> = { great: 'hit300', ok: 'hit100', meh: 'hit50', miss: 'hit0' };
const PARTICLE: Record<HitResult, string | null> = { great: 'particle300', ok: 'particle100', meh: 'particle50', miss: null };

/**
 * What a judgement can show: the four results, plus the slider's nested
 * ones (lazer's LargeTickHit / LargeTickMiss: a slider head, tick or repeat).
 */
export type JudgementKind = HitResult | 'tickHit' | 'tickMiss';

/**
 * A skin's judgement for one kind (lazer's LegacySkin / OsuLegacySkinTransformer):
 * `old` = LegacyJudgementPieceOld, `new` = LegacyJudgementPieceNew (the
 * same skin also has particleNNN), `tickHit` = LegacyJudgementPieceSliderTickHit.
 */
interface Piece {
    frames: SkinTexture[];
    particle: SkinTexture | null;
    style: 'old' | 'new' | 'tickHit';
    /** From wosu!'s default skin: wosu!'s own animation. */
    defaultLook: boolean;
}

/** One particle of an explosion (osu!stable's randomised pattern). */
interface Particle {
    distance: number;
    duration: number;
    direction: number;
}

interface SpriteEntry {
    kind: JudgementKind;
    piece: Piece;
    /** The judgement image: below hit objects for the new style, above for the rest. */
    main: Sprite;
    /** New style: the additive old-style flash above hit objects. */
    temp: Sprite | null;
    particles: Sprite[];
    parts: Particle[];
    x: number;
    y: number;
    time: number;
    /** wosu!'s default misses tilt by up to ±0.2 rad; legacy ones by ±8.6° then twice that. */
    spin: number;
}

interface Entry {
    text: BitmapText;
    result: HitResult;
    x: number;
    y: number;
    time: number;
    /** Miss judgements tilt to one side. */
    spin: number;
}

interface Light {
    sprite: Sprite;
    time: number;
}

/** A pool of sprites in one container. */
class SpritePool {
    private readonly free: Sprite[] = [];

    constructor(readonly layer: Container, private readonly additive: boolean) {}

    get(texture: Texture): Sprite {
        const s = this.free.pop() ?? this.make();
        s.visible = true;
        s.texture = texture;
        s.rotation = 0;
        s.alpha = 1;
        return s;
    }

    release(s: Sprite): void {
        s.visible = false;
        this.free.push(s);
    }

    private make(): Sprite {
        const s = sprite(Texture.EMPTY);
        if (this.additive) s.blendMode = 'add';
        this.layer.addChild(s);
        return s;
    }
}

/** LegacyJudgementPieceOld's hit pop: 0.6 → 1.1 (96ms), hold, → 0.9 (to 144ms), then 0.95 → `final` (to 168ms). */
function legacyHitScale(dt: number, final: number): number {
    if (dt < 96) return 0.6 + 0.5 * clamp01(dt / 96);
    if (dt < 120) return 1.1;
    if (dt < 144) return 1.1 - 0.2 * ((dt - 120) / 24);
    if (dt < 168) return 0.95 + (final - 0.95) * ((dt - 144) / 24);
    return final;
}

const legacyAlpha = (dt: number): number => Math.min(clamp01(dt / FADE_IN), 1 - clamp01((dt - FADE_OUT_DELAY) / FADE_OUT));

/**
 * Judgements and hit lighting, pooled. Like the objects, every frame is
 * computed from song time.
 *
 * Skin judgements follow lazer's legacy pieces: LegacyJudgementPieceOld,
 * or LegacyJudgementPieceNew when the skin that has the hitNNN image also
 * has particleNNN (an explosion of particles and the image under the hit
 * objects, with a brief additive old-style flash above them), and slider
 * point judgements (slidertickmiss; sliderpoint30 for Version 1 skins).
 * wosu!'s default skin keeps its own animations; our text is the last
 * fallback.
 */
export class Judgements extends Container {
    /**
     * What lazer draws under the hit objects: new-style judgements and their
     * particles. The playfield places (and destroys) it.
     */
    readonly below = new Container();
    private readonly lights = new Container();
    private readonly texts = new Container();
    private readonly active: Entry[] = [];
    private readonly free: BitmapText[] = [];
    private readonly activeLights: Light[] = [];
    private readonly freeLights: Sprite[] = [];
    hideGreat = false;
    hitLighting = true;
    /** The skin's judgement for each kind; our text is only a fallback for the four results. */
    private readonly pieces: Partial<Record<JudgementKind, Piece>> = {};
    private readonly lighting: SkinTexture | null;
    private readonly legacyLighting: boolean;
    private readonly version: number;
    private readonly activeSprites: SpriteEntry[] = [];
    private readonly mains: SpritePool;
    private readonly belowMains: SpritePool;
    private readonly temps: SpritePool;
    private readonly particleSprites: SpritePool;

    constructor(private readonly chain: SkinChain, private readonly radius: number) {
        super();
        // osu!'s lighting.png: an additive glow under every hit (only when the skin has one).
        this.lighting = chain.texture('lighting');
        this.legacyLighting = !fromDefaultSkin(chain, 'lighting');
        this.version = legacyVersion(chain);
        for (const kind of ['great', 'ok', 'meh', 'miss', 'tickHit', 'tickMiss'] as const) {
            const p = this.resolve(kind);
            if (p) this.pieces[kind] = p;
        }
        const particles = new Container(), belowMains = new Container(), mains = new Container(), temps = new Container();
        this.particleSprites = new SpritePool(particles, true);
        this.belowMains = new SpritePool(belowMains, false);
        this.mains = new SpritePool(mains, false);
        this.temps = new SpritePool(temps, true);
        this.eventMode = 'none';
        this.below.eventMode = 'none';
        this.below.addChild(particles, belowMains);
        this.addChild(this.lights, this.texts, mains, temps);
    }

    /**
     * The first skin in the chain with an image for `kind` provides it
     * (with its own particle, for the new style). Slider point hits only
     * show for Version 1 skins with sliderpoint30; such a skin also stops a
     * missing slidertickmiss from falling through to the skins below.
     */
    private resolve(kind: JudgementKind): Piece | null {
        const layers = this.chain.layers;
        for (let i = 0; i < layers.length; i++) {
            const l = layers[i];
            if (!l.skin || l.textures === false) continue;
            const skin = l.skin;
            const defaultLook = i === layers.length - 1;
            // Beatmap skins have no version of their own.
            const oldPoints = l.config === undefined && layerVersion(skin.config) < 2 && !!skin.texture('sliderpoint30');
            if (kind === 'tickHit') {
                const t = oldPoints ? skin.texture('sliderpoint30') : null;
                if (t) return { frames: [t], particle: null, style: 'tickHit', defaultLook };
                continue;
            }
            if (kind === 'tickMiss') {
                const frames = skin.frames('slidertickmiss');
                if (frames.length) return { frames, particle: null, style: 'old', defaultLook };
                if (oldPoints) return null;
                continue;
            }
            const frames = skin.frames(IMAGE[kind]);
            if (!frames.length) continue;
            const name = PARTICLE[kind];
            const particle = name ? skin.texture(name) : null;
            return { frames, particle, style: particle ? 'new' : 'old', defaultLook };
        }
        return null;
    }

    add(result: HitResult, x: number, y: number, time: number, color: number): void {
        if (result !== 'miss' && this.hitLighting && this.lighting) this.addLight(x, y, time, color);
        if (result === 'great' && this.hideGreat) return;
        if (this.addPiece(result, x, y, time)) return;
        const text = this.free.pop() ?? this.makeText();
        text.visible = true;
        text.text = TEXT[result];
        text.tint = COLOR[result];
        this.active.push({ text, result, x, y, time, spin: Math.random() < 0.5 ? -1 : 1 });
    }

    /** A slider head, tick or repeat was hit or missed (shown only if the skin has art for it). */
    addNested(hit: boolean, x: number, y: number, time: number): void {
        this.addPiece(hit ? 'tickHit' : 'tickMiss', x, y, time);
    }

    private addPiece(kind: JudgementKind, x: number, y: number, time: number): boolean {
        const piece = this.pieces[kind];
        if (!piece) return false;
        const tex = piece.frames[0].texture;
        const isNew = piece.style === 'new' && !piece.defaultLook;
        const main = (isNew ? this.belowMains : this.mains).get(tex);
        main.position.set(x, y);
        const legacyMiss = kind === 'miss' && !piece.defaultLook;
        const e: SpriteEntry = {
            kind, piece, main, x, y, time,
            temp: isNew ? this.temps.get(tex) : null,
            particles: [], parts: [],
            spin: legacyMiss ? (((Math.random() * 2 - 1) * 8.6) * Math.PI) / 180 : (Math.random() * 2 - 1) * 0.2,
        };
        e.temp?.position.set(x, y);
        if (isNew && piece.particle) {
            for (let i = 0; i < PARTICLES; i++) {
                e.parts.push({
                    distance: Math.random() * 0.5,
                    duration: PARTICLE_DURATION / 3 + Math.random() * (PARTICLE_DURATION * 2 / 3),
                    direction: Math.random() * Math.PI * 2,
                });
                e.particles.push(this.particleSprites.get(piece.particle.texture));
            }
        }
        this.activeSprites.push(e);
        return true;
    }

    private release(e: SpriteEntry): void {
        (e.piece.style === 'new' && !e.piece.defaultLook ? this.belowMains : this.mains).release(e.main);
        if (e.temp) this.temps.release(e.temp);
        for (const p of e.particles) this.particleSprites.release(p);
    }

    private lifetime(e: SpriteEntry): number {
        if (e.piece.defaultLook) return LIFETIME;
        if (e.piece.style === 'tickHit') return TICK_HIT_LIFETIME;
        return LEGACY_LIFETIME;
    }

    private updateSprites(time: number): void {
        const base = this.radius / 64;
        for (let i = this.activeSprites.length - 1; i >= 0; i--) {
            const e = this.activeSprites[i];
            const dt = time - e.time;
            if (dt > this.lifetime(e) || dt < -50) {
                this.release(e);
                this.activeSprites.splice(i, 1);
                continue;
            }
            if (e.piece.defaultLook) this.updateDefault(e, dt, base);
            else this.updateLegacy(e, dt, base);
        }
    }

    /**
     * wosu!'s default-skin judgements: pop 0.6 → 1.1 → 0.9 → 1 while
     * fading in over 120ms, hold, fade out by 800ms; misses drop and tilt.
     * Animated judgements play their frames once over their lifetime.
     */
    private updateDefault(e: SpriteEntry, dt: number, base: number): void {
        const s = e.main;
        const frames = e.piece.frames;
        const n = frames.length;
        // Animated judgements play once at the skin's frame rate, holding the last frame.
        const f = frameAt(frames, dt, this.chain.frameDuration(n), false);
        if (s.texture !== f.texture) s.texture = f.texture;
        s.alpha = Math.min(clamp01(dt / 120), 1 - clamp01((dt - 600) / 200));
        let pop: number;
        if (e.kind === 'miss' || e.kind === 'tickMiss') {
            pop = 1.6 - 0.6 * ease.OutQuad(clamp01(dt / 100));
            s.rotation = e.spin * clamp01(dt / LIFETIME);
            s.y = e.y + 20 * ease.InQuad(clamp01(dt / LIFETIME));
        } else if (n > 1) {
            pop = 1;
        } else if (dt < 96) {
            pop = 0.6 + 0.5 * ease.OutQuad(dt / 96);
        } else if (dt < 120) {
            pop = 1.1 - 0.2 * ((dt - 96) / 24);
        } else {
            pop = 0.9 + 0.1 * clamp01((dt - 120) / 100);
        }
        s.scale.set(base * f.scale * pop);
    }

    /**
     * lazer's legacy judgement pieces, `dt` ms after the judgement.
     * Animations play once at 60fps; an animated judgement skips the
     * scale/move/rotate transforms (except the new style's flash).
     *
     * - Old style: fade in over 120ms, out from 500ms over 600ms. Hits pop
     *   0.6 → 1.1 → 0.9 → 1; misses shrink 1.6 → 1 (100ms, ease in), tilt
     *   by up to ±8.6° (120ms) then twice that (ease in), and for Version
     *   2+ skins drop from −5 to +75 units (ease in). Slider point misses
     *   shrink 1.2 → 1 and fade out from 250ms.
     * - New style: the image fades the same way while growing 0.9 → 1.05;
     *   150 particles fly out from 100ms before the judgement over up to
     *   1.6s; an additive copy flashes to 50% (56ms from −16ms, ease out)
     *   and fades over 300ms while popping like the old style (to 1.05).
     * - Slider point hits rise 10 units over 300ms (ease out), then fade
     *   in 60ms.
     */
    private updateLegacy(e: SpriteEntry, dt: number, base: number): void {
        const s = e.main;
        const frames = e.piece.frames;
        const animated = frames.length > 1;
        const f = frameAt(frames, dt, SIXTY_FRAME_TIME, false);
        if (s.texture !== f.texture) s.texture = f.texture;
        const scale = base * f.scale;
        s.position.set(e.x, e.y);
        s.rotation = 0;
        if (e.piece.style === 'tickHit') {
            s.alpha = 1 - clamp01((dt - 300) / 60);
            s.y = e.y - 10 * ease.OutQuad(clamp01(dt / 300));
            s.scale.set(scale);
            return;
        }
        s.alpha = legacyAlpha(dt);
        if (e.piece.style === 'new') {
            s.scale.set(scale * (animated ? 1 : 0.9 + 0.15 * clamp01(dt / LEGACY_LIFETIME)));
            const t = e.temp;
            if (t) {
                if (t.texture !== f.texture) t.texture = f.texture;
                t.alpha = dt < 40 ? 0.5 * ease.OutQuad(clamp01((dt + 16) / 56)) : 0.5 * (1 - clamp01((dt - 40) / 300));
                t.visible = t.alpha > 0.001;
                t.scale.set(scale * legacyHitScale(dt, 1.05));
            }
            const p = e.piece.particle;
            if (p) {
                const pt = dt + 100;
                const explosion = (1 - clamp01(pt / PARTICLE_DURATION)) * s.alpha;
                const ps = legacyScale(this.radius, p);
                const area = PARTICLE_AREA * base;
                for (let i = 0; i < e.parts.length; i++) {
                    const part = e.parts[i], sp = e.particles[i];
                    const progress = clamp01(pt / part.duration);
                    const d = part.distance * progress * area;
                    sp.position.set(e.x + d * Math.sin(part.direction), e.y + d * Math.cos(part.direction));
                    sp.alpha = (1 - progress) * explosion;
                    sp.visible = sp.alpha > 0.001;
                    sp.scale.set(ps);
                }
            }
            return;
        }
        if (animated) {
            s.scale.set(scale);
            return;
        }
        if (e.kind === 'tickMiss') {
            s.alpha = Math.min(clamp01(dt / FADE_IN), 1 - clamp01((dt - FADE_OUT_DELAY / 2) / FADE_OUT));
            s.scale.set(scale * (1.2 - 0.2 * ease.InQuad(clamp01(dt / 100))));
        } else if (e.kind === 'miss') {
            s.scale.set(scale * (1.6 - 0.6 * ease.InQuad(clamp01(dt / 100))));
            if (this.version > 1) s.y = e.y - 5 + 80 * ease.InQuad(clamp01(dt / LEGACY_LIFETIME));
            s.rotation = dt < FADE_IN
                ? e.spin * (dt / FADE_IN)
                : e.spin * (1 + ease.InQuad(clamp01((dt - FADE_IN) / (LEGACY_LIFETIME - FADE_IN))));
        } else {
            s.scale.set(scale * legacyHitScale(dt, 1));
        }
    }

    private makeText(): BitmapText {
        const t = new BitmapText({ text: '', style: { fontFamily: Fonts.venera, fontSize: 20 } });
        t.anchor.set(0.5);
        this.texts.addChild(t);
        return t;
    }

    private addLight(x: number, y: number, time: number, color: number): void {
        const s = this.freeLights.pop() ?? this.makeLight();
        s.visible = true;
        s.tint = color;
        s.position.set(x, y);
        this.activeLights.push({ sprite: s, time });
    }

    private makeLight(): Sprite {
        const s = sprite(this.lighting?.texture ?? Texture.EMPTY);
        s.blendMode = 'add';
        this.lights.addChild(s);
        return s;
    }

    update(time: number): void {
        this.updateSprites(time);
        const scale = this.radius / 48;
        for (let i = this.active.length - 1; i >= 0; i--) {
            const e = this.active[i];
            const dt = time - e.time;
            if (dt > LIFETIME || dt < -50) {
                e.text.visible = false;
                this.free.push(e.text);
                this.active.splice(i, 1);
                continue;
            }
            const t = clamp01(dt / LIFETIME);
            const fadeIn = clamp01(dt / 100);
            e.text.alpha = Math.min(fadeIn, 1 - ease.InQuad(t));
            if (e.result === 'miss') {
                const k = ease.InQuint(t);
                const pop = 1.6 - 0.6 * ease.InQuad(clamp01(dt / 100));
                e.text.scale.set(scale * pop);
                e.text.position.set(e.x, e.y + 40 * k);
                e.text.rotation = e.spin * 0.7 * k;
            } else {
                const k = ease.OutQuint(clamp01(dt / 1800));
                e.text.scale.set(scale * (0.8 + 0.4 * k), scale);
                e.text.position.set(e.x, e.y);
                e.text.rotation = 0;
            }
        }
        const lightBase = legacyScale(this.radius, this.lighting);
        const lifetime = this.legacyLighting ? LEGACY_LIGHTING_LIFETIME : LIGHTING_LIFETIME;
        for (let i = this.activeLights.length - 1; i >= 0; i--) {
            const l = this.activeLights[i];
            const dt = time - l.time;
            if (dt > lifetime || dt < -50) {
                l.sprite.visible = false;
                this.freeLights.push(l.sprite);
                this.activeLights.splice(i, 1);
                continue;
            }
            if (this.legacyLighting) {
                l.sprite.scale.set(lightBase * (0.8 + 0.4 * ease.OutQuad(clamp01(dt / 600))));
                l.sprite.alpha = Math.min(clamp01(dt / 200), 1 - clamp01((dt - 400) / 1000));
                continue;
            }
            const t = clamp01(dt / LIGHTING_LIFETIME);
            l.sprite.scale.set(lightBase * (0.8 + 0.4 * ease.OutQuint(t)));
            l.sprite.alpha = 0.6 * (1 - ease.OutQuad(t));
        }
    }

    clear(): void {
        for (const e of this.activeSprites) this.release(e);
        this.activeSprites.length = 0;
        for (const e of this.active) {
            e.text.visible = false;
            this.free.push(e.text);
        }
        this.active.length = 0;
        for (const l of this.activeLights) {
            l.sprite.visible = false;
            this.freeLights.push(l.sprite);
        }
        this.activeLights.length = 0;
    }
}
