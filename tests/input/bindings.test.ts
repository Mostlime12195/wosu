import { describe, expect, it } from 'vitest';
import {
    ACTIONS,
    BINDING_SECTIONS,
    DEFAULT_BINDINGS,
    actionFor,
    actionsForBinding,
    bindAction,
    bindingFromEvent,
    bindingLabel,
    isValidBinding,
    overridesFor,
    resolveBindings,
} from '../../src/input/bindings';

const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
    ({ code, ctrlKey: !!mods.ctrl, metaKey: false, altKey: !!mods.alt, shiftKey: !!mods.shift }) as KeyboardEvent;

describe('binding resolution', () => {
    it('formats events as modifiers + code', () => {
        expect(bindingFromEvent(key('KeyO', { ctrl: true }))).toBe('Ctrl+KeyO');
        expect(bindingFromEvent(key('F2', { shift: true }))).toBe('Shift+F2');
        expect(bindingFromEvent(key('Backquote', { ctrl: true }))).toBe('Ctrl+Backquote');
    });

    it('matches modifiers exactly', () => {
        expect(actionFor(key('Backquote'))).toBe('quickRetry');
        expect(actionFor(key('Backquote', { ctrl: true }))).toBe('quickExit');
        expect(actionFor(key('Tab'))).toBe('toggleInGameLeaderboard');
        expect(actionFor(key('Tab', { shift: true }))).toBe('toggleInGameInterface');
        expect(actionFor(key('F2'))).toBe('random');
        expect(actionFor(key('F2', { shift: true }))).toBe('randomRewind');
    });

    it('lets one key serve actions of different contexts (lazer defaults)', () => {
        // F3: beatmap options in song select, play/pause elsewhere.
        expect(actionsForBinding('F3')).toEqual(['toggleBeatmapOptions', 'musicPlay']);
        expect(actionsForBinding('Space')).toEqual(['skip', 'togglePauseReplay']);
        expect(actionsForBinding('ArrowLeft')).toEqual(['left', 'seekReplayBackward']);
    });

    it('lists every action in exactly one settings section', () => {
        const listed = BINDING_SECTIONS.flatMap(s => s.actions.map(a => a.action));
        expect(new Set(listed).size).toBe(listed.length);
        expect([...listed].sort()).toEqual([...ACTIONS].sort());
    });

    it('validates binding strings', () => {
        expect(isValidBinding('Ctrl+Shift+KeyF')).toBe(true);
        expect(isValidBinding('MouseMiddle')).toBe(true);
        expect(isValidBinding('Ctrl+')).toBe(false);
        expect(isValidBinding('Hyper+KeyA')).toBe(false);
        expect(isValidBinding(3)).toBe(false);
    });

    it('labels bindings', () => {
        expect(bindingLabel('Ctrl+Backquote')).toBe('Ctrl+`');
        expect(bindingLabel('MouseMiddle')).toBe('Mouse 3');
        expect(bindingLabel('Alt+Equal')).toBe('Alt+=');
    });
});

describe('saved overrides', () => {
    it('falls back to the defaults and ignores junk', () => {
        const b = resolveBindings({ random: ['KeyR', 'bad binding', 'KeyR'], nonsense: ['KeyQ'], skip: 'Space' });
        expect(b.random).toEqual(['KeyR']);
        expect(b.skip).toEqual(DEFAULT_BINDINGS.skip);
        expect(resolveBindings(null)).toEqual(DEFAULT_BINDINGS);
        expect(resolveBindings(null).back).not.toBe(DEFAULT_BINDINGS.back);
    });

    it('keeps an explicitly emptied action unbound', () => {
        expect(resolveBindings({ quickExit: [] }).quickExit).toEqual([]);
    });

    it('persists only changed actions and round-trips', () => {
        const b = resolveBindings({});
        expect(overridesFor(b)).toEqual({});
        b.toggleMods = ['KeyM'];
        const o = overridesFor(b);
        expect(o).toEqual({ toggleMods: ['KeyM'] });
        expect(resolveBindings(o)).toEqual(b);
    });
});

describe('rebinding', () => {
    it('replaces a slot, appends past the end and clears', () => {
        const base = resolveBindings({});
        let r = bindAction(base, 'toggleMods', 0, 'KeyM');
        expect(r.bindings.toggleMods).toEqual(['KeyM']);
        r = bindAction(r.bindings, 'toggleMods', 1, 'F1');
        expect(r.bindings.toggleMods).toEqual(['KeyM', 'F1']);
        r = bindAction(r.bindings, 'toggleMods', 0, null);
        expect(r.bindings.toggleMods).toEqual(['F1']);
        // The input is never mutated.
        expect(base.toggleMods).toEqual(['F1']);
    });

    it('takes the key away from other actions in the same scope only', () => {
        const base = resolveBindings({});
        const r = bindAction(base, 'random', 0, 'F1');
        expect(r.bindings.random).toEqual(['F1']);
        expect(r.bindings.toggleMods).toEqual([]);
        expect(r.displaced).toEqual(['toggleMods']);
        // Global music keys keep F1-style overlaps with song select (different scopes).
        const s = bindAction(base, 'quickRetry', 0, 'Space');
        expect(s.bindings.skip).toEqual(['MouseForward']);
        expect(s.bindings.togglePauseReplay).toEqual(['Space', 'MouseMiddle']);
        expect(s.displaced).toEqual(['skip']);
    });

    it('does not duplicate a binding within an action', () => {
        const r = bindAction(resolveBindings({}), 'back', 1, 'Escape');
        expect(r.bindings.back).toEqual(['MouseBack', 'Escape']);
    });
});
