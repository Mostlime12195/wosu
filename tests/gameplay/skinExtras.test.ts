import { describe, expect, it } from 'vitest';
import {
    ParticleSpewer, particleAt, spewDirection, spewVelocity, type FallingParticle,
} from '../../src/app/cursor/particleSpewer';
import type { PlayableBeatmap } from '../../src/beatmap/types';
import {
    LEGACY_KIAI_FLASH_OPACITY, layerVersion, legacyKiaiTint, legacyVersion, makeBeatLookup, makeLegacyKiaiFlash,
} from '../../src/gameplay/drawables/context';
import { rowLayout, skinModIcon } from '../../src/gameplay/hud/ModDisplay';
import type { LegacySkin, SkinTexture } from '../../src/skin/LegacySkin';
import { SkinChain } from '../../src/skin/SkinChain';
import { parseSkinIni, SKIN_DEFAULTS, type SkinConfig } from '../../src/skin/SkinIni';

/** A beatmap with one red line (500 ms beats from 1000) and kiai from 3000 to 5000. */
function kiaiMap(): PlayableBeatmap {
    return {
        data: { timingPoints: [{ time: 1000, beatLength: 500, uninherited: true }] },
        controlPoints: { at: (t: number) => ({ kiai: t >= 3000 && t < 5000 }) },
    } as unknown as PlayableBeatmap;
}

describe('stable kiai flash (LegacyKiaiFlashingDrawable)', () => {
    it('finds the last beat of the governing red line', () => {
        const at = makeBeatLookup(kiaiMap());
        expect(at(1000)).toEqual({ beat: 1000, beatLength: 500 });
        expect(at(1749)).toEqual({ beat: 1500, beatLength: 500 });
    });

    it('jumps to 30% on each kiai beat and fades over beatLength − 80 ms', () => {
        const flash = makeLegacyKiaiFlash(kiaiMap());
        expect(flash(2500)).toBe(0); // not kiai
        expect(flash(3000)).toBeCloseTo(LEGACY_KIAI_FLASH_OPACITY);
        expect(flash(3000 + 420)).toBeCloseTo(0);
        const mid = flash(3210);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(LEGACY_KIAI_FLASH_OPACITY);
        // No early activation: just before a beat the previous flash has finished.
        expect(flash(3499)).toBeCloseTo(0);
        expect(flash(3500)).toBeCloseTo(LEGACY_KIAI_FLASH_OPACITY);
        expect(flash(5000)).toBe(0);
    });

    it('brightens the combo colour like LegacyMainCirclePiece', () => {
        // Dark colours get 300 − r − g − b added to each channel, bright ones at least 25.
        expect(legacyKiaiTint(0x000000)).toBe(0xffffff);
        expect(legacyKiaiTint(0x404040)).toBe(0xacacac);
        expect(legacyKiaiTint(0xff0000)).toBe(0xff2d2d);
        expect(legacyKiaiTint(0xffffff)).toBe(0xffffff);
    });
});

describe('cursor particles (LegacyCursorParticles)', () => {
    const particle: FallingParticle = {
        startTime: 0, x: 100, y: 50, unit: 2, vx: 100, vy: 0, duration: 500, startAngle: 1, endAngle: -1, endScale: 2,
    };

    it('falls, fades, scales and spins over its life', () => {
        expect(particleAt(particle, -1)).toBeNull();
        const start = particleAt(particle, 0)!;
        expect(start).toMatchObject({ x: 100, y: 50, alpha: 1, scale: 1, rotation: 1 });
        const half = particleAt(particle, 250)!;
        expect(half.alpha).toBeCloseTo(0.5);
        expect(half.scale).toBeCloseTo(1.5);
        expect(half.rotation).toBeCloseTo(0);
        // 100 units/s × 0.25 s × 2 px per unit; gravity 240 × 0.5 (duration share) × 0.5 (progress).
        expect(half.x).toBeCloseTo(150);
        expect(half.y).toBeCloseTo(50 + 60 * 0.25 * 2);
        expect(particleAt(particle, 500)).toBeNull();
    });

    it('throws break stars the way the held buttons point', () => {
        expect(spewDirection(true, false)).toBe('left');
        expect(spewDirection(false, true)).toBe('right');
        expect(spewDirection(true, true)).toBe('omni');
        expect(spewDirection(false, false)).toBe('none');
        expect(spewVelocity('left', () => 0)).toEqual({ x: -460, y: -40 });
        expect(spewVelocity('right', () => 1)).toEqual({ x: 460, y: 40 });
        expect(spewVelocity('omni', () => 0)).toEqual({ x: -460, y: -160 });
        expect(spewVelocity('none', () => 0.3)).toEqual({ x: 0, y: 0 });
    });

    it('spawns at its rate once the cursor is known, into a one-second ring', () => {
        const sp = new ParticleSpewer(20, () => 0.5);
        expect(sp.particles.length).toBe(20);
        sp.setActive(true);
        sp.update(0, 1);
        expect(sp.particles.filter(Boolean).length).toBe(0); // no cursor position yet
        sp.moveTo(10, 10, 16);
        sp.update(0, 1);
        expect(sp.particles.filter(Boolean).length).toBe(1);
        sp.update(500, 1);
        expect(sp.particles.filter(Boolean).length).toBe(11);
        sp.update(2000, 1); // a long gap: one particle, not a burst
        expect(sp.particles.filter(Boolean).length).toBe(12);
        sp.setActive(false);
        sp.update(2500, 1);
        expect(sp.particles.filter(Boolean).length).toBe(12);
    });

    it('adds 40× the cursor velocity to each star', () => {
        const sp = new ParticleSpewer(60, () => 0.5);
        sp.setActive(true);
        sp.moveTo(0, 0, 0);
        sp.moveTo(20, 0, 20); // 1 px/ms over more than 15 ms
        sp.update(0, 1);
        expect(sp.particles[0]).toMatchObject({ x: 20, y: 0, vx: 40, vy: 0 });
    });
});

function fakeSkin(textures: Record<string, SkinTexture>, config: SkinConfig = {}): LegacySkin {
    return {
        config,
        texture: (n: string) => textures[n.toLowerCase()] ?? null,
        frames: (n: string) => (textures[n.toLowerCase()] ? [textures[n.toLowerCase()]] : []),
        sample: () => undefined,
    } as unknown as LegacySkin;
}

const tex = (w: number): SkinTexture => ({ texture: { width: w, height: w } as never, scale: 1 });

describe('skin lookups', () => {
    it('takes mod icons from osu! skins, never from wosu!\'s default skin', () => {
        const hd = tex(64);
        const chain = new SkinChain([{ skin: fakeSkin({ 'selection-mod-hidden': hd }) }, { skin: fakeSkin({ 'selection-mod-hardrock': tex(64) }) }]);
        expect(skinModIcon(chain, 'HD')).toBe(hd);
        expect(skinModIcon(chain, 'HR')).toBeNull();
        expect(skinModIcon(chain, 'DA')).toBeNull();
    });

    it('lays a row out with gaps', () => {
        expect(rowLayout([10, 20, 30], 5)).toEqual({ xs: [0, 15, 40], width: 70 });
        expect(rowLayout([], 5)).toEqual({ xs: [], width: 0 });
    });

    it('treats a skin.ini without Version as 1.0, a missing skin.ini as latest', () => {
        expect(layerVersion({})).toBe(2.7);
        expect(layerVersion({ name: 'x' })).toBe(1);
        const v1 = new SkinChain([{ skin: fakeSkin({}, { name: 'old' }) }, { skin: fakeSkin({}, { version: 2.7 }) }]);
        expect(legacyVersion(v1)).toBe(1);
        // chain.config falls through to the default skin's 2.7, which is why StablePlayOverlay uses legacyVersion.
        expect(v1.config('version')).toBe(2.7);
    });

    it('reads StarBreakAdditive', () => {
        expect(parseSkinIni('[Colours]\nStarBreakAdditive: 10,20,30').starBreakAdditive).toBe(0x0a141e);
        expect(SKIN_DEFAULTS.starBreakAdditive).toBe(0xffb6c1);
    });
});
