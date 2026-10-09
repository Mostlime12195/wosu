import { BitmapText, Container, Texture, type Sprite } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import type { SkinChain } from '../../skin/SkinChain';
import { Colors, Fonts } from '../../ui/theme';
import type { HitResult } from '../scoring/ScoreProcessor';
import { clamp01, ease, legacyScale, sprite } from './context';

const LIFETIME = 800;
const LIGHTING_LIFETIME = 600;

const TEXT: Record<HitResult, string> = { great: 'GREAT', ok: 'OK', meh: 'MEH', miss: 'MISS' };
const COLOR: Record<HitResult, number> = { great: Colors.great, ok: Colors.ok, meh: Colors.meh, miss: Colors.miss };

/** A beatmap skin's hit300/hit100/hit50/hit0 (each possibly animated). */
export type LegacyJudgements = Partial<Record<HitResult, SkinTexture[]>>;

interface SpriteEntry {
    sprite: Sprite;
    frames: SkinTexture[];
    result: HitResult;
    y: number;
    time: number;
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

/**
 * Judgement text (lazer's DefaultJudgementPiece) and hit lighting, pooled.
 * Like the objects, every frame is computed from song time.
 */
export class Judgements extends Container {
    private readonly lights = new Container();
    private readonly texts = new Container();
    private readonly active: Entry[] = [];
    private readonly free: BitmapText[] = [];
    private readonly activeLights: Light[] = [];
    private readonly freeLights: Sprite[] = [];
    hideGreat = false;
    hitLighting = true;
    /** The skin's judgement images (hit300/100/50/0); our text is only a fallback. */
    legacy: LegacyJudgements = {};
    private readonly lighting: SkinTexture | null;
    private readonly sprites = new Container();
    private readonly activeSprites: SpriteEntry[] = [];
    private readonly freeSprites: Sprite[] = [];

    constructor(private readonly chain: SkinChain, private readonly radius: number) {
        super();
        // osu!'s lighting.png: an additive glow under every hit (only when the skin has one).
        this.lighting = chain.texture('lighting');
        for (const [result, name] of [['great', 'hit300'], ['ok', 'hit100'], ['meh', 'hit50'], ['miss', 'hit0']] as const) {
            const frames = chain.frames(name);
            if (frames.length) this.legacy[result] = frames;
        }
        this.eventMode = 'none';
        this.addChild(this.lights, this.texts, this.sprites);
    }

    add(result: HitResult, x: number, y: number, time: number, color: number): void {
        if (result !== 'miss' && this.hitLighting && this.lighting) this.addLight(x, y, time, color);
        if (result === 'great' && this.hideGreat) return;
        const frames = this.legacy[result];
        if (frames?.length) {
            const s = this.freeSprites.pop() ?? this.makeSprite();
            s.visible = true;
            s.texture = frames[0].texture;
            s.position.set(x, y);
            this.activeSprites.push({ sprite: s, frames, result, y, time, spin: (Math.random() * 2 - 1) * 0.2 });
            return;
        }
        const text = this.free.pop() ?? this.makeText();
        text.visible = true;
        text.text = TEXT[result];
        text.tint = COLOR[result];
        this.active.push({ text, result, x, y, time, spin: Math.random() < 0.5 ? -1 : 1 });
    }

    private makeSprite(): Sprite {
        const s = sprite(Texture.EMPTY);
        this.sprites.addChild(s);
        return s;
    }

    /**
     * lazer's LegacyJudgementPieceOld: pop 0.6 → 1.1 → 0.9 → 1 while fading
     * in over 120ms, hold, fade out by 800ms; misses drop and tilt.
     * Animated judgements play their frames once over their lifetime.
     */
    private updateSprites(time: number): void {
        const base = this.radius / 64;
        for (let i = this.activeSprites.length - 1; i >= 0; i--) {
            const e = this.activeSprites[i];
            const dt = time - e.time;
            if (dt > LIFETIME || dt < -50) {
                e.sprite.visible = false;
                this.freeSprites.push(e.sprite);
                this.activeSprites.splice(i, 1);
                continue;
            }
            const n = e.frames.length;
            // Animated judgements play once at the skin's frame rate, holding the last frame.
            const f = e.frames[Math.min(n - 1, Math.floor(Math.max(0, dt) / this.chain.frameDuration(n)))];
            if (e.sprite.texture !== f.texture) e.sprite.texture = f.texture;
            e.sprite.alpha = Math.min(clamp01(dt / 120), 1 - clamp01((dt - 600) / 200));
            let pop: number;
            if (e.result === 'miss') {
                pop = 1.6 - 0.6 * ease.OutQuad(clamp01(dt / 100));
                e.sprite.rotation = e.spin * clamp01(dt / LIFETIME);
                e.sprite.y = e.y + 20 * ease.InQuad(clamp01(dt / LIFETIME));
            } else if (n > 1) {
                pop = 1;
            } else if (dt < 96) {
                pop = 0.6 + 0.5 * ease.OutQuad(dt / 96);
            } else if (dt < 120) {
                pop = 1.1 - 0.2 * ((dt - 96) / 24);
            } else {
                pop = 0.9 + 0.1 * clamp01((dt - 120) / 100);
            }
            e.sprite.scale.set(base * f.scale * pop);
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
        for (let i = this.activeLights.length - 1; i >= 0; i--) {
            const l = this.activeLights[i];
            const dt = time - l.time;
            if (dt > LIGHTING_LIFETIME || dt < -50) {
                l.sprite.visible = false;
                this.freeLights.push(l.sprite);
                this.activeLights.splice(i, 1);
                continue;
            }
            const t = clamp01(dt / LIGHTING_LIFETIME);
            l.sprite.scale.set(lightBase * (0.8 + 0.4 * ease.OutQuint(t)));
            l.sprite.alpha = 0.6 * (1 - ease.OutQuad(t));
        }
    }

    clear(): void {
        for (const e of this.activeSprites) {
            e.sprite.visible = false;
            this.freeSprites.push(e.sprite);
        }
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
