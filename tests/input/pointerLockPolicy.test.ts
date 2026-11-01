import { describe, expect, it } from 'vitest';
import { pointerLockWanted, type PointerLockDemand } from '../../src/input/pointerLockPolicy';

const base: PointerLockDemand = { highPrecision: false, confine: 'never', systemCursorInMenus: false, gameplay: false, aiming: false };
const wanted = (d: Partial<PointerLockDemand>) => pointerLockWanted({ ...base, ...d });

describe('pointerLockWanted', () => {
    it('never locks with both settings off', () => {
        expect(wanted({})).toBe(false);
        expect(wanted({ gameplay: true, aiming: true })).toBe(false);
    });

    it('locks everywhere with high precision mouse, menus included (lazer relative mode)', () => {
        expect(wanted({ highPrecision: true })).toBe(true);
        expect(wanted({ highPrecision: true, gameplay: true })).toBe(true);
        expect(wanted({ highPrecision: true, gameplay: true, aiming: true })).toBe(true);
    });

    it('confines during gameplay only while aiming', () => {
        expect(wanted({ confine: 'duringGameplay' })).toBe(false);
        expect(wanted({ confine: 'duringGameplay', gameplay: true })).toBe(false);
        expect(wanted({ confine: 'duringGameplay', gameplay: true, aiming: true })).toBe(true);
    });

    it('confines always everywhere', () => {
        expect(wanted({ confine: 'always' })).toBe(true);
    });

    it('leaves menus unlocked for the system cursor', () => {
        expect(wanted({ highPrecision: true, systemCursorInMenus: true })).toBe(false);
        expect(wanted({ confine: 'always', systemCursorInMenus: true })).toBe(false);
        expect(wanted({ highPrecision: true, systemCursorInMenus: true, gameplay: true })).toBe(true);
        expect(wanted({ confine: 'duringGameplay', systemCursorInMenus: true, gameplay: true, aiming: true })).toBe(true);
    });
});
