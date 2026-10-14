import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app/App';
import { GameplayInput } from '../../src/gameplay/input/GameplayInput';
import type { GameSettings } from '../../src/settings/Settings';

/** Pointer events with the fields GameplayInput reads (node has no PointerEvent). */
function pointer(type: string, button: number, buttons: number): Event {
    return Object.assign(new Event(type), { pointerType: 'mouse', pointerId: 1, clientX: 10, clientY: 20, button, buttons });
}

describe('GameplayInput mouse buttons', () => {
    let win: EventTarget;
    let input: GameplayInput;

    beforeEach(() => {
        win = new EventTarget();
        (globalThis as { window?: unknown }).window = win;
        const app = { toLogical: (x: number, y: number) => ({ x, y }) } as unknown as App;
        const settings = {
            mouseButtons: { value: true },
            keyLeft: { value: 'KeyZ' },
            keyRight: { value: 'KeyX' },
            keySmoke: { value: 'KeyC' },
        } as unknown as GameSettings;
        input = new GameplayInput(app, settings, () => 0, { x: 0, y: 0 });
        input.enabled = true;
    });

    afterEach(() => {
        input.dispose();
        delete (globalThis as { window?: unknown }).window;
    });

    it('follows a second button pressed and released while the first is held', () => {
        const presses: string[] = [];
        input.pressed.add((_t, _x, _y, b) => presses.push(b));
        win.dispatchEvent(pointer('pointerdown', 0, 1));
        // Chorded: the right button goes down and up with only pointermoves.
        win.dispatchEvent(pointer('pointermove', 2, 3));
        expect(input.down.M2).toBe(true);
        win.dispatchEvent(pointer('pointermove', 2, 1));
        expect(input.down.M2).toBe(false);
        expect(presses).toEqual(['M1', 'M2']);
    });

    it('releases the first button when it goes up while the second is held', () => {
        win.dispatchEvent(pointer('pointerdown', 0, 1));
        win.dispatchEvent(pointer('pointermove', 2, 3));
        // Left released while right is still down: a pointermove, not a pointerup.
        win.dispatchEvent(pointer('pointermove', 0, 2));
        expect(input.down.M1).toBe(false);
        expect(input.down.M2).toBe(true);
        win.dispatchEvent(pointer('pointerup', 2, 0));
        expect(input.held).toBe(false);
    });

    it('drops a button whose release was missed on the next move', () => {
        win.dispatchEvent(pointer('pointerdown', 0, 1));
        win.dispatchEvent(pointer('pointermove', -1, 0));
        expect(input.down.M1).toBe(false);
    });

    it('holds the smoke key without pressing a gameplay button', () => {
        const presses: string[] = [];
        input.pressed.add((_t, _x, _y, b) => presses.push(b));
        const key = (code: string) => ({ code, repeat: false }) as KeyboardEvent;
        expect(input.keyDown(key('KeyC'))).toBe(true);
        expect(input.smoke).toBe(true);
        expect(input.held).toBe(false);
        expect(input.keyDown(key('KeyQ'))).toBe(false);
        input.keyUp(key('KeyC'));
        expect(input.smoke).toBe(false);
        input.keyDown(key('KeyC'));
        input.releaseAll();
        expect(input.smoke).toBe(false);
        expect(presses).toEqual([]);
    });
});
