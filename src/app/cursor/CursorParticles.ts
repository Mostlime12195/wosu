import { Container, Sprite } from 'pixi.js';
import type { SkinTexture } from '../../skin/LegacySkin';
import { STABLE_MAGIC_SCALE } from './CursorSkin';
import { ParticleSpewer, particleAt, spewDirection, type FallingParticle } from './particleSpewer';

/** What the particles draw from (see CursorSkin.particles). */
export interface ParticleSkin {
    /** star2 from the first osu! skin that has it. */
    texture: SkinTexture;
    /** skin.ini [Colours] StarBreakAdditive: the tint of the stars thrown during breaks. */
    breakTint: number;
}

/** What gameplay tells the particles each frame. */
export interface ParticleState {
    /** In a kiai section, sliding a kiai slider or spinning a kiai spinner (LegacyCursorParticles.isTracking). */
    kiai: boolean;
    /** A break is on (Player.IsBreakTime). */
    breakTime: boolean;
    /** Gameplay buttons held (left = K1 / M1, right = K2 / M2): the break stars' direction. */
    left: boolean;
    right: boolean;
    /** The gameplay clock is running (particles freeze while paused, like lazer's). */
    running: boolean;
    /** Gameplay clock rate (particles live on the gameplay clock). */
    rate: number;
}

/**
 * osu!stable's star2 cursor particles, ported from lazer's
 * LegacyCursorParticles: during breaks the cursor sheds 20 stars a second
 * (tinted with StarBreakAdditive) that the held buttons throw left, right
 * or everywhere; in kiai time, sliding or spinning a kiai object sheds 60
 * a second (untinted: the osu! wiki only tints star2 during breaks). The
 * stars fall under gravity, shrink or grow, spin and fade. Only skins with
 * star2 have them.
 *
 * Drawn in screen space with sizes in playfield units (star2 at its
 * legacy size: pixels × 0.5 for @2x, / 1.6), additive.
 */
export class CursorParticles extends Container {
    private skin: ParticleSkin | null = null;
    private readonly breakSpewer = new ParticleSpewer(20);
    private readonly kiaiSpewer = new ParticleSpewer(60);
    private readonly sprites: Sprite[] = [];
    private time = 0;
    state: ParticleState = { kiai: false, breakTime: false, left: false, right: false, running: false, rate: 1 };

    constructor() {
        super();
        this.eventMode = 'none';
    }

    setSkin(skin: ParticleSkin | null): void {
        this.skin = skin;
        for (const s of this.sprites) {
            s.texture = skin?.texture.texture ?? s.texture;
            s.visible = false;
        }
        if (!skin) this.clear();
    }

    clear(): void {
        this.breakSpewer.clear();
        this.kiaiSpewer.clear();
        this.breakSpewer.setActive(false);
        this.kiaiSpewer.setActive(false);
        for (const s of this.sprites) s.visible = false;
    }

    /**
     * Advance by `dt` wall ms with the cursor at (x, y) logical px;
     * `unit` is logical px per playfield unit.
     */
    tick(dt: number, x: number, y: number, unit: number): void {
        const skin = this.skin;
        if (!skin) return;
        const st = this.state;
        const step = st.running ? dt * st.rate : 0;
        this.time += step;
        this.breakSpewer.setActive(st.breakTime);
        this.kiaiSpewer.setActive(st.kiai);
        this.breakSpewer.direction = spewDirection(st.left, st.right);
        for (const sp of [this.breakSpewer, this.kiaiSpewer]) {
            if (!st.running) continue;
            sp.moveTo(x, y, step);
            sp.update(this.time, unit);
        }
        const base = (skin.texture.scale / STABLE_MAGIC_SCALE);
        let n = 0;
        n = this.draw(this.breakSpewer.particles, skin.breakTint, base, n);
        n = this.draw(this.kiaiSpewer.particles, 0xffffff, base, n);
        for (let i = n; i < this.sprites.length; i++) this.sprites[i].visible = false;
    }

    private draw(particles: readonly (FallingParticle | null)[], tint: number, base: number, n: number): number {
        for (const p of particles) {
            if (!p) continue;
            const f = particleAt(p, this.time - p.startTime);
            if (!f) continue;
            const s = this.sprites[n] ?? this.makeSprite();
            n++;
            s.visible = true;
            s.position.set(f.x, f.y);
            s.alpha = f.alpha;
            s.scale.set(base * p.unit * f.scale);
            s.rotation = f.rotation;
            s.tint = tint;
        }
        return n;
    }

    private makeSprite(): Sprite {
        const s = new Sprite(this.skin!.texture.texture);
        s.anchor.set(0.5);
        s.blendMode = 'add';
        s.eventMode = 'none';
        this.sprites.push(s);
        this.addChild(s);
        return s;
    }
}
