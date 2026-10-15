import { describe, expect, it } from 'vitest';
import {
    ANCHORS, anchorLabel, builtInComponents, captureElement, closestAnchor, elementBounds, elementCorners, layoutUnit, movedBy,
    newElement, newElementId, originPoint, parseLayout, quadContains, resolvePlacement, scaledAbout, serialiseLayout, snapBox,
    toArea, withAnchor, withClosestAnchor, withOrigin, type HudElementLayout, type HudLayout, type Rect,
} from '../../src/gameplay/hud/layout/HudLayout';
import { HudLayoutStore } from '../../src/gameplay/hud/layout/HudLayoutStore';
import { UnstableRateTracker, unstableRate } from '../../src/gameplay/hud/unstableRate';

const area = { w: 1280, h: 720 };
const unit = layoutUnit(area.w, area.h);
const box: Rect = { x: -100, y: 0, w: 100, h: 30 };

function el(o: Partial<HudElementLayout> = {}): HudElementLayout {
    return { id: 'score', type: 'score', anchor: 'TopRight', origin: 'TopRight', fixedAnchor: false, x: -10, y: 0, scale: 1, rotation: 0, visible: true, ...o };
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
};

describe('HUD layout units and anchors', () => {
    it('uses lazer\'s 1024×768 unit fitted in the area, times the HUD scale', () => {
        expect(layoutUnit(1280, 720)).toBeCloseTo(720 / 768, 12);
        expect(layoutUnit(1024, 1024)).toBeCloseTo(1, 12);
        expect(layoutUnit(1280, 720, 1.5)).toBeCloseTo((720 / 768) * 1.5, 12);
    });

    it('labels and lists the nine anchors', () => {
        expect(ANCHORS).toHaveLength(9);
        expect(anchorLabel('BottomCentre')).toBe('Bottom centre');
        expect(anchorLabel('Centre')).toBe('Centre');
    });

    it('picks the closest anchor by thirds of the area', () => {
        expect(closestAnchor({ x: 10, y: 10 }, area)).toBe('TopLeft');
        expect(closestAnchor({ x: 640, y: 700 }, area)).toBe('BottomCentre');
        expect(closestAnchor({ x: 1200, y: 360 }, area)).toBe('CentreRight');
        expect(closestAnchor({ x: 640, y: 360 }, area)).toBe('Centre');
    });

    it('places the origin at anchor + offset, scaled by the unit', () => {
        const p = resolvePlacement(el({ x: -10, y: 5, scale: 2, rotation: 90 }), area, unit);
        expect(p.x).toBeCloseTo(1280 - 10 * unit, 9);
        expect(p.y).toBeCloseTo(5 * unit, 9);
        expect(p.scale).toBeCloseTo(2 * unit, 9);
        expect(p.rotation).toBeCloseTo(Math.PI / 2, 12);
        // The box's top-right (its origin) sits exactly there; rotation turns the rest about it.
        close(toArea(el({ x: -10, y: 5, scale: 2, rotation: 90 }), box, originPoint(box, 'TopRight'), area, unit), p);
        const bl = toArea(el({ x: -10, y: 5, scale: 2, rotation: 90 }), box, { x: -100, y: 30 }, area, unit);
        close(bl, { x: p.x - 30 * p.scale, y: p.y - 100 * p.scale });
    });
});

describe('capturing and re-anchoring', () => {
    it('captures a built-in placement so that applying it draws in the same place', () => {
        const pos = { x: 1280 - 10 * unit, y: 0 };
        const captured = captureElement('score', 'score', pos, unit, box, area, unit);
        expect(captured.anchor).toBe('TopRight');
        expect(captured.origin).toBe('TopRight');
        expect(captured.x).toBeCloseTo(-10, 9);
        expect(captured.y).toBeCloseTo(0, 9);
        expect(captured.scale).toBeCloseTo(1, 9);
        // Every corner lands where the built-in placement drew it.
        const corners = elementCorners(captured, box, area, unit);
        close(corners[0], { x: pos.x + box.x * unit, y: 0 });
        close(corners[2], { x: pos.x, y: box.h * unit });
    });

    it('keeps the element in place when the anchor or origin changes', () => {
        const a = el({ x: -40, y: 20, scale: 1.5, rotation: 30 });
        const before = elementCorners(a, box, area, unit);
        for (const anchor of ANCHORS) {
            const b = withAnchor(a, anchor, area, unit);
            expect(b.anchor).toBe(anchor);
            elementCorners(b, box, area, unit).forEach((p, i) => close(p, before[i]));
            const c = withOrigin(b, 'BottomLeft', box, area, unit);
            expect(c.origin).toBe('BottomLeft');
            elementCorners(c, box, area, unit).forEach((p, i) => close(p, before[i]));
        }
    });

    it('re-anchors to the closest corner when moved, unless the anchor is fixed', () => {
        const moved = movedBy(el(), -1200, 650, unit);
        const closest = withClosestAnchor(moved, box, area, unit);
        expect(closest.anchor).toBe('BottomLeft');
        expect(closest.origin).toBe('BottomLeft');
        elementCorners(closest, box, area, unit).forEach((p, i) => close(p, elementCorners(moved, box, area, unit)[i]));
        expect(withClosestAnchor({ ...moved, fixedAnchor: true }, box, area, unit).anchor).toBe('TopRight');
    });

    it('scales about a fixed corner', () => {
        const a = el({ x: -10, y: 10 });
        const fixed = { x: box.x, y: box.y + box.h };
        const before = toArea(a, box, fixed, area, unit);
        const b = scaledAbout(a, 2.5, fixed, box, area, unit);
        expect(b.scale).toBe(2.5);
        close(toArea(b, box, fixed, area, unit), before);
        expect(scaledAbout(a, 100, fixed, box, area, unit).scale).toBe(10);
    });

    it('hit-tests rotated boxes', () => {
        const q = elementCorners(el({ x: -200, y: 200, rotation: 45, anchor: 'TopRight' }), box, area, unit);
        const b = elementBounds(el({ x: -200, y: 200, rotation: 45 }), box, area, unit);
        expect(quadContains(q, { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 })).toBe(true);
        expect(quadContains(q, { x: b.x + 1, y: b.y + 1 })).toBe(false);
    });
});

describe('snapping', () => {
    it('snaps the nearest edge or centre line within the threshold', () => {
        const s = snapBox({ x: 5, y: 300, w: 100, h: 40 }, area, 8);
        expect(s.dx).toBe(-5);
        expect(s.guidesX).toEqual([0]);
        // Box centre 4 px off the screen's vertical centre line.
        const c = snapBox({ x: 594, y: 100, w: 100, h: 40 }, area, 8);
        expect(c.dx).toBe(-4);
        expect(c.guidesX).toEqual([640]);
        expect(c.dy).toBe(0);
        expect(c.guidesY).toEqual([]);
        const bottom = snapBox({ x: 300, y: 674, w: 50, h: 40 }, area, 8);
        expect(bottom.dy).toBe(6);
        expect(bottom.guidesY).toEqual([720]);
    });
});

describe('layout defaults and serialisation', () => {
    it('lists the built-in layouts\' components, health bar in front', () => {
        expect(builtInComponents('default')).toEqual(['songProgress', 'hitErrorMeter', 'keyCounter', 'leaderboard', 'score', 'accuracy', 'combo', 'health']);
        expect(builtInComponents('legacy')).toEqual(['legacySongProgress', 'legacyHitErrorMeter', 'keyCounter', 'leaderboard', 'score', 'accuracy', 'combo', 'health']);
    });

    it('names extra copies and places new components', () => {
        expect(newElementId('unstableRate', [])).toBe('unstableRate');
        expect(newElementId('unstableRate', [{ id: 'unstableRate' }, { id: 'unstableRate-2' }])).toBe('unstableRate-3');
        const pp = newElement('performancePoints', []);
        expect(pp).toMatchObject({ id: 'performancePoints', anchor: 'TopRight', origin: 'TopRight', visible: true, scale: 1 });
        const again = newElement('performancePoints', [pp]);
        expect(again.id).toBe('performancePoints-2');
        expect(again.y).toBe(pp.y + 40);
        expect(newElement('score', [])).toMatchObject({ anchor: 'Centre', x: 0, y: 0 });
    });

    it('round-trips through JSON and sanitises what it reads', () => {
        const layout: HudLayout = { version: 1, kind: 'legacy', elements: [el(), el({ id: 'combo', type: 'combo', anchor: 'BottomLeft', origin: 'BottomLeft', x: 10.123456, y: -35.2, scale: 1.28, visible: false })] };
        const parsed = parseLayout(serialiseLayout(layout));
        expect(parsed).not.toBeNull();
        expect(parsed!.kind).toBe('legacy');
        expect(parsed!.elements[1]).toMatchObject({ id: 'combo', anchor: 'BottomLeft', x: 10.1235, scale: 1.28, visible: false });
        const messy = parseLayout({
            version: 1,
            elements: [
                { id: 'a', type: 'score', anchor: 'Nowhere', x: 'far', scale: 1000, rotation: 540 },
                { id: 'a', type: 'combo' },
                { type: 'notAComponent' },
                null,
            ],
        });
        expect(messy!.kind).toBe('default');
        expect(messy!.elements).toHaveLength(2);
        expect(messy!.elements[0]).toMatchObject({ id: 'a', anchor: 'Centre', origin: 'Centre', x: 0, scale: 10, rotation: 180, fixedAnchor: false });
        expect(messy!.elements[1].id).toBe('combo');
        expect(parseLayout('not json')).toBeNull();
        expect(parseLayout({ version: 2, elements: [] })).toBeNull();
    });

    it('stores layouts per skin, and resetting removes them', () => {
        const mem = new Map<string, string>();
        const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
        const store = new HudLayoutStore(storage);
        const changed: string[] = [];
        store.changed.add(id => changed.push(id));
        expect(store.get('')).toBeNull();
        const layout: HudLayout = { version: 1, kind: 'default', elements: [el()] };
        store.set('', layout);
        store.set('skin-1', { ...layout, kind: 'legacy' });
        expect(new HudLayoutStore(storage).get('')!.elements[0].id).toBe('score');
        expect(new HudLayoutStore(storage).get('skin-1')!.kind).toBe('legacy');
        store.set('', null);
        expect(new HudLayoutStore(storage).get('')).toBeNull();
        expect(new HudLayoutStore(storage).has('skin-1')).toBe(true);
        expect(changed).toEqual(['', 'skin-1', '']);
    });
});

describe('unstable rate', () => {
    it('is 10 × the population standard deviation of hit errors, in real time', () => {
        expect(unstableRate([])).toBeNull();
        expect(unstableRate([-10, 10])).toBeCloseTo(100, 10);
        expect(unstableRate([5, 5, 5])).toBeCloseTo(0, 10);
        // Song-time errors at 1.5× are 1.5× longer than the player's real ones.
        expect(unstableRate([-15, 15], 1.5)).toBeCloseTo(100, 10);
        const errs = [3, -12, 8, 0, 21, -7, 4];
        const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
        const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / errs.length);
        expect(unstableRate(errs)).toBeCloseTo(sd * 10, 10);
    });

    it('updates incrementally and starts over when the list shrinks', () => {
        const t = new UnstableRateTracker();
        const list: number[] = [];
        expect(t.update(list)).toBeNull();
        for (const e of [3, -12, 8, 0, 21]) {
            list.push(e);
            expect(t.update(list)).toBeCloseTo(unstableRate(list)!, 10);
        }
        expect(t.update([-10, 10])).toBeCloseTo(100, 10);
    });
});
