import { Container, type Sprite } from 'pixi.js';
import type { PlayableBeatmap } from '../../beatmap/types';
import type { SkinTexture } from '../../skin/LegacySkin';
import { clamp01, ease, frameAt, sprite } from './context';

const SPACING = 32;

interface Point {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    rotation: number;
    fadeIn: number;
    fadeOut: number;
}

/**
 * Follow points between consecutive objects of a combo (lazer's
 * FollowPointConnection): each point slides into place as it fades in
 * ahead of the next object, and fades out as the cursor's path passes it.
 * All points are precomputed and drawn from a small sprite pool.
 *
 * An animated followpoint (followpoint-0, -1…) loops at the skin's
 * AnimationFramerate (or all frames over a second), each point's
 * animation starting when it starts fading in (lazer's FollowPoint is the
 * animation's time reference). Skin follow points draw normally; wosu!'s
 * default skin's are additive.
 */
export class FollowPoints extends Container {
    private readonly points: Point[] = [];
    private readonly pool: Sprite[] = [];
    private first = 0;
    private readonly scaleBase: number;

    constructor(
        beatmap: PlayableBeatmap, private readonly frames: SkinTexture[], private readonly frameLength: number, preempt: number,
        private readonly fadeInTime: number, radius: number, scaleBase?: number, private readonly additive = true,
    ) {
        super();
        this.eventMode = 'none';
        this.scaleBase = scaleBase ?? (radius / 120) * 0.9;
        const objs = beatmap.hitObjects;
        for (let i = 0; i + 1 < objs.length; i++) {
            const a = objs[i], b = objs[i + 1];
            if (a.kind === 'spinner' || b.kind === 'spinner' || b.newCombo) continue;
            const sx = a.kind === 'slider' ? a.endX : a.x;
            const sy = a.kind === 'slider' ? a.endY : a.y;
            const dx = b.x - sx, dy = b.y - sy;
            const distance = Math.hypot(dx, dy);
            const startTime = a.endTime;
            const duration = b.time - startTime;
            const rotation = Math.atan2(dy, dx);
            for (let d = SPACING * 1.5; d < distance - SPACING; d += SPACING) {
                const f = d / distance;
                const fadeOut = startTime + f * duration;
                this.points.push({
                    x0: sx + (f - 0.1) * dx, y0: sy + (f - 0.1) * dy,
                    x1: sx + f * dx, y1: sy + f * dy,
                    rotation, fadeIn: fadeOut - preempt, fadeOut,
                });
            }
        }
        this.points.sort((p, q) => p.fadeIn - q.fadeIn);
    }

    update(time: number): void {
        const fade = this.fadeInTime;
        const animated = this.frames.length > 1;
        // Points never come back once fully faded; advance the window start.
        while (this.first < this.points.length && time > this.points[this.first].fadeOut + fade) this.first++;
        let used = 0;
        for (let i = this.first; i < this.points.length; i++) {
            const p = this.points[i];
            if (p.fadeIn > time) break;
            if (time > p.fadeOut + fade) continue;
            const s = this.pool[used] ?? this.grow();
            used++;
            const k = clamp01((time - p.fadeIn) / fade);
            const e = ease.OutQuint(k);
            s.visible = true;
            s.position.set(p.x0 + (p.x1 - p.x0) * e, p.y0 + (p.y1 - p.y0) * e);
            s.rotation = p.rotation;
            s.scale.set(this.scaleBase * (1.5 - 0.5 * e));
            s.alpha = time < p.fadeOut ? k : 1 - clamp01((time - p.fadeOut) / fade);
            if (animated) {
                const f = frameAt(this.frames, time - p.fadeIn, this.frameLength, true);
                if (s.texture !== f.texture) s.texture = f.texture;
            }
        }
        for (let i = used; i < this.pool.length; i++) this.pool[i].visible = false;
    }

    private grow(): Sprite {
        const s = sprite(this.frames[0].texture);
        if (this.additive) s.blendMode = 'add';
        this.pool.push(s);
        this.addChild(s);
        return s;
    }
}
