import { BitmapText, Container, type Sprite, type Texture } from 'pixi.js';
import { Colors, Fonts } from '../../ui/theme';
import type { HitResult } from '../scoring/ScoreProcessor';
import { clamp01, ease, sprite } from './context';

const LIFETIME = 800;
const LIGHTING_LIFETIME = 600;

const TEXT: Record<HitResult, string> = { great: 'GREAT', ok: 'OK', meh: 'MEH', miss: 'MISS' };
const COLOR: Record<HitResult, number> = { great: Colors.great, ok: Colors.ok, meh: Colors.meh, miss: Colors.miss };

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

    constructor(private readonly glow: Texture, private readonly radius: number) {
        super();
        this.eventMode = 'none';
        this.addChild(this.lights, this.texts);
    }

    add(result: HitResult, x: number, y: number, time: number, color: number): void {
        if (result !== 'miss' && this.hitLighting) this.addLight(x, y, time, color);
        if (result === 'great' && this.hideGreat) return;
        const text = this.free.pop() ?? this.makeText();
        text.visible = true;
        text.text = TEXT[result];
        text.tint = COLOR[result];
        this.active.push({ text, result, x, y, time, spin: Math.random() < 0.5 ? -1 : 1 });
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
        const s = sprite(this.glow);
        s.blendMode = 'add';
        this.lights.addChild(s);
        return s;
    }

    update(time: number): void {
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
        const lightBase = (this.radius * 2.6) / this.glow.width;
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
