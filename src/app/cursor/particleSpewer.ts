/**
 * lazer's ParticleSpewer and LegacyCursorParticleSpewer logic (osu.Game/
 * Graphics/ParticleSpewer.cs, osu.Game.Rulesets.Osu/Skinning/Legacy/
 * LegacyCursorParticles.cs) without any drawing, so it can be tested:
 * a ring buffer of falling particles spawned at a fixed rate while active.
 */

/** LegacyCursorParticleSpewer: particles live 300–1000 ms. */
export const PARTICLE_DURATION_MIN = 300;
export const PARTICLE_DURATION_MAX = 1000;
/** LegacyCursorParticleSpewer.ParticleGravity (units per max duration, scaled by progress). */
export const PARTICLE_GRAVITY = 240;
/** Cursor velocity is measured over at least this long (max_velocity_frame_length). */
const VELOCITY_FRAME = 15;

/** Which way the break spewer throws particles: from the buttons held (left, right, both = omni). */
export type SpewDirection = 'none' | 'left' | 'right' | 'omni';

export interface FallingParticle {
    startTime: number;
    /** Spawn point, in the drawing's pixels. */
    x: number;
    y: number;
    /** Pixels per particle unit when it spawned (velocities and gravity are in units). */
    unit: number;
    /** Units travelled per max duration. */
    vx: number;
    vy: number;
    duration: number;
    /** Radians. */
    startAngle: number;
    endAngle: number;
    endScale: number;
}

export interface ParticleFrame {
    x: number;
    y: number;
    alpha: number;
    /** Multiplier on the particle's base size. */
    scale: number;
    rotation: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** FallingParticle's state `t` ms after it spawned (null once gone or before it exists). */
export function particleAt(p: FallingParticle, t: number, maxDuration = PARTICLE_DURATION_MAX, gravity = PARTICLE_GRAVITY): ParticleFrame | null {
    if (t < 0 || p.duration <= 0) return null;
    const progress = Math.min(1, t / p.duration);
    const alpha = 1 - progress;
    if (alpha <= 0) return null;
    const g = (gravity * p.duration / maxDuration) * progress;
    const k = (t / maxDuration) * p.unit;
    return {
        x: p.x + p.vx * k,
        y: p.y + (p.vy + g) * k,
        alpha,
        scale: lerp(1, p.endScale, progress),
        rotation: lerp(p.startAngle, p.endAngle, progress),
    };
}

/** LegacyCursorParticleSpewer.getVelocity before the cursor's own motion is added. */
export function spewVelocity(direction: SpewDirection, random: () => number): { x: number; y: number } {
    const between = (a: number, b: number) => a + (b - a) * random();
    switch (direction) {
        case 'left': return { x: between(-460, 0), y: between(-40, 40) };
        case 'right': return { x: between(0, 460), y: between(-40, 40) };
        case 'omni': return { x: between(-460, 460), y: between(-160, 160) };
        default: return { x: 0, y: 0 };
    }
}

/** The break spewer's direction from the gameplay buttons held (LegacyCursorParticles.handleInput). */
export function spewDirection(left: boolean, right: boolean): SpewDirection {
    return left && right ? 'omni' : left ? 'left' : right ? 'right' : 'none';
}

/**
 * One spewer: while active it spawns `perSecond` particles a second at the
 * cursor (once the cursor has moved since it became active, like lazer's
 * CanSpawnParticles), each thrown by `direction` plus 40× the cursor's
 * velocity. The newest particles overwrite the oldest.
 */
export class ParticleSpewer {
    readonly particles: (FallingParticle | null)[];
    direction: SpewDirection = 'none';
    private active = false;
    private lastAdded: number | null = null;
    private index = 0;
    private readonly between: number;
    /** Cursor tracking (screen pixels), reset whenever the spewer turns on or off. */
    private cursor: { x: number; y: number } | null = null;
    private velocity = { x: 0, y: 0 };
    private frameLength = 0;
    private diff = { x: 0, y: 0 };

    constructor(readonly perSecond: number, private readonly random: () => number = Math.random, readonly maxDuration = PARTICLE_DURATION_MAX) {
        this.particles = new Array<FallingParticle | null>(perSecond * Math.ceil(maxDuration / 1000)).fill(null);
        this.between = 1000 / perSecond;
    }

    get isActive(): boolean {
        return this.active;
    }

    setActive(active: boolean): void {
        if (active === this.active) return;
        this.active = active;
        // ensure that particles can be spawned immediately after the spewer becomes active.
        if (active) this.lastAdded = null;
        this.cursor = null;
        this.diff = { x: 0, y: 0 };
        this.frameLength = 0;
    }

    /** The cursor moved to (x, y) screen pixels, `elapsed` ms after its last sample (OnMouseMove). */
    moveTo(x: number, y: number, elapsed: number): void {
        const c = this.cursor;
        if (!c) {
            this.cursor = { x, y };
            return;
        }
        if (c.x === x && c.y === y) return;
        this.diff.x += x - c.x;
        this.diff.y += y - c.y;
        c.x = x;
        c.y = y;
        this.frameLength += Math.abs(elapsed);
        if (this.frameLength > VELOCITY_FRAME) {
            this.velocity = { x: this.diff.x / this.frameLength, y: this.diff.y / this.frameLength };
            this.diff = { x: 0, y: 0 };
            this.frameLength = 0;
        }
    }

    /** Spawn what's due by `now` (ParticleSpewer.Update), `unit` pixels per particle unit. */
    update(now: number, unit: number): void {
        if (!this.active || !this.cursor) return;
        if (this.lastAdded === null || Math.abs(now - this.lastAdded) > this.maxDuration) {
            // Avoid spawning too many particles if a long amount of time has passed.
            this.lastAdded = now;
            this.spawn(unit);
            return;
        }
        const elapsed = now - this.lastAdded;
        for (let i = 0; i < elapsed / this.between; i++) {
            this.lastAdded += this.between;
            this.spawn(unit);
        }
    }

    /** Forget every particle (a new play, a seek). */
    clear(): void {
        this.particles.fill(null);
        this.lastAdded = null;
    }

    private spawn(unit: number): void {
        const c = this.cursor!;
        const r = this.random;
        const v = spewVelocity(this.direction, r);
        this.particles[this.index] = {
            startTime: this.lastAdded!,
            x: c.x,
            y: c.y,
            unit,
            vx: v.x + this.velocity.x * 40,
            vy: v.y + this.velocity.y * 40,
            duration: PARTICLE_DURATION_MIN + r() * (PARTICLE_DURATION_MAX - PARTICLE_DURATION_MIN),
            startAngle: r() * 4 - 2,
            endAngle: r() * 4 - 2,
            endScale: r() * 2,
        };
        this.index = (this.index + 1) % this.particles.length;
    }
}
