/**
 * The HUD layout model (lazer's SerialisedDrawableInfo + the skin
 * editor's anchoring maths), free of Pixi so it can be tested.
 *
 * A layout lists the HUD's components in draw order (later = in front).
 * Each one is anchored to a point of the HUD area (one of nine, like
 * osu-framework's Anchor), and its own origin point (a point of its box)
 * sits `x`/`y` layout units from that anchor. Layout units scale with the
 * screen: `layoutUnit` is lazer's legacy HUD unit (1024×768 fitted inside
 * the area) times the HUD scale setting, so a saved layout looks the same
 * at any resolution. `scale` multiplies the component's natural size (in
 * those units), `rotation` is in degrees about the origin.
 *
 * No saved layout means the built-in one (wosu!'s default layout for the
 * default skin, lazer's legacy layout for imported skins), positioned by
 * HUDOverlay's own rules; the editor captures it into a layout the first
 * time something changes.
 */

export type Anchor =
    | 'TopLeft' | 'TopCentre' | 'TopRight'
    | 'CentreLeft' | 'Centre' | 'CentreRight'
    | 'BottomLeft' | 'BottomCentre' | 'BottomRight';

export const ANCHORS: readonly Anchor[] = [
    'TopLeft', 'TopCentre', 'TopRight',
    'CentreLeft', 'Centre', 'CentreRight',
    'BottomLeft', 'BottomCentre', 'BottomRight',
];

const FACTORS: Record<Anchor, { x: number; y: number }> = {
    TopLeft: { x: 0, y: 0 }, TopCentre: { x: 0.5, y: 0 }, TopRight: { x: 1, y: 0 },
    CentreLeft: { x: 0, y: 0.5 }, Centre: { x: 0.5, y: 0.5 }, CentreRight: { x: 1, y: 0.5 },
    BottomLeft: { x: 0, y: 1 }, BottomCentre: { x: 0.5, y: 1 }, BottomRight: { x: 1, y: 1 },
};

/** Where an anchor sits in a box, as fractions of its width and height. */
export function anchorFactor(a: Anchor): { x: number; y: number } {
    return FACTORS[a];
}

export function anchorFromFactors(fx: number, fy: number): Anchor {
    const col = fx === 0 ? 0 : fx === 1 ? 2 : 1;
    const row = fy === 0 ? 0 : fy === 1 ? 2 : 1;
    return ANCHORS[row * 3 + col];
}

/** lazer's Anchor names, spaced ("Top left"). */
export function anchorLabel(a: Anchor): string {
    return a.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])/g, (_m, c: string) => ' ' + c.toLowerCase());
}

/** Built-in layouts: wosu!'s own (default skin) and lazer's legacy one (imported skins). */
export type LayoutKind = 'default' | 'legacy';

export type HudComponentType =
    | 'score'
    | 'accuracy'
    | 'combo'
    | 'health'
    | 'songProgress'
    | 'legacySongProgress'
    | 'hitErrorMeter'
    | 'legacyHitErrorMeter'
    | 'keyCounter'
    | 'leaderboard'
    | 'beatmapInfo'
    | 'unstableRate'
    | 'performancePoints'
    | 'judgementCounter'
    | 'modDisplay';

export interface HudComponentInfo {
    type: HudComponentType;
    name: string;
    description: string;
}

/** The skin editor's toolbox, in display order. */
export const HUD_COMPONENTS: readonly HudComponentInfo[] = [
    { type: 'score', name: 'Score', description: 'The score, in the skin\'s score font.' },
    { type: 'accuracy', name: 'Accuracy', description: 'Accuracy so far, in the skin\'s score font.' },
    { type: 'combo', name: 'Combo counter', description: 'The current combo, in the skin\'s combo font.' },
    { type: 'health', name: 'Health bar', description: 'The skin\'s health bar (scorebar).' },
    { type: 'songProgress', name: 'Song progress bar', description: 'Elapsed / remaining time across the screen, with the difficulty graph.' },
    { type: 'legacySongProgress', name: 'Song progress pie', description: 'osu!stable\'s progress pie.' },
    { type: 'hitErrorMeter', name: 'Hit error meter', description: 'wosu!\'s hit error meter: the timing windows with a tick per hit.' },
    { type: 'legacyHitErrorMeter', name: 'Hit error bar (stable)', description: 'osu!stable\'s hit error bar.' },
    { type: 'keyCounter', name: 'Key overlay', description: 'Key and mouse button presses.' },
    { type: 'leaderboard', name: 'Gameplay leaderboard', description: 'Your local scores on this difficulty, live.' },
    { type: 'beatmapInfo', name: 'Beatmap info', description: 'Artist, title, difficulty, mapper, star rating and mods.' },
    { type: 'unstableRate', name: 'Unstable rate', description: 'Hit timing consistency: 10 × the standard deviation of your hit errors (lower is better).' },
    { type: 'performancePoints', name: 'Performance points (pp)', description: 'A live estimate of the pp for what you have played so far (osu!standard formula, wosu!\'s own difficulty calculation).' },
    { type: 'judgementCounter', name: 'Judgement counter', description: 'How many 300s, 100s, 50s and misses so far.' },
    { type: 'modDisplay', name: 'Mod display', description: 'The mods in play: the skin\'s selection-mod icons where it has them, otherwise wosu!\'s mod badges.' },
];

const INFO = new Map(HUD_COMPONENTS.map(c => [c.type, c]));

export function componentInfo(type: HudComponentType): HudComponentInfo {
    return INFO.get(type) ?? { type, name: type, description: '' };
}

export function isComponentType(v: unknown): v is HudComponentType {
    return typeof v === 'string' && INFO.has(v as HudComponentType);
}

/**
 * The components of a built-in layout, in draw order: the health bar in
 * front for full-screen scorebar frames, and the mod display above all
 * (lazer's TopRightElements sit over the skinnable components).
 */
export function builtInComponents(kind: LayoutKind): HudComponentType[] {
    return kind === 'legacy'
        ? ['legacySongProgress', 'legacyHitErrorMeter', 'keyCounter', 'leaderboard', 'score', 'accuracy', 'combo', 'health', 'modDisplay']
        : ['songProgress', 'hitErrorMeter', 'keyCounter', 'leaderboard', 'score', 'accuracy', 'combo', 'health', 'modDisplay'];
}

export interface HudElementLayout {
    /** Unique within the layout (the type, or `type-2`… for extra copies). */
    id: string;
    type: HudComponentType;
    anchor: Anchor;
    origin: Anchor;
    /**
     * lazer's UsesFixedAnchor. False ("Closest"): moving the component
     * re-picks the nearest anchor (and origin) so it keeps its place
     * relative to that edge of the screen.
     */
    fixedAnchor: boolean;
    /** Origin's offset from the anchor point, in layout units. */
    x: number;
    y: number;
    scale: number;
    /** Degrees, clockwise, about the origin. */
    rotation: number;
    visible: boolean;
}

export interface HudLayout {
    version: 1;
    kind: LayoutKind;
    elements: HudElementLayout[];
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Point {
    x: number;
    y: number;
}

/** The HUD area's size (its top-left is the layout's origin). */
export interface Area {
    w: number;
    h: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 10;

/** One layout unit in pixels: lazer's 1024×768 HUD unit fitted inside the area, times the HUD scale. */
export function layoutUnit(areaW: number, h: number, hudScale = 1): number {
    return Math.max(1e-6, Math.min(areaW / 1024, h / 768) * hudScale);
}

export function anchorPoint(anchor: Anchor, area: Area): Point {
    const f = FACTORS[anchor];
    return { x: area.w * f.x, y: area.h * f.y };
}

/** The origin's point in a component's box (component units). */
export function originPoint(box: Rect, origin: Anchor): Point {
    const f = FACTORS[origin];
    return { x: box.x + box.w * f.x, y: box.y + box.h * f.y };
}

/** lazer's closest anchor: which third of the area a point is in, on each axis. */
export function closestAnchor(p: Point, area: Area): Anchor {
    const tier = (v: number, size: number) => {
        const r = size > 0 ? v / size : 0.5;
        return r < 1 / 3 ? 0 : r > 2 / 3 ? 1 : 0.5;
    };
    return anchorFromFactors(tier(p.x, area.w), tier(p.y, area.h));
}

export interface Placement {
    /** Where the origin lands, in area pixels. */
    x: number;
    y: number;
    /** Pixels per component unit. */
    scale: number;
    /** Radians. */
    rotation: number;
}

/** Where a laid-out element is drawn. */
export function resolvePlacement(el: HudElementLayout, area: Area, unit: number): Placement {
    const a = anchorPoint(el.anchor, area);
    return { x: a.x + el.x * unit, y: a.y + el.y * unit, scale: el.scale * unit, rotation: (el.rotation * Math.PI) / 180 };
}

/** A component-unit point of the element's box, in area pixels. */
export function toArea(el: HudElementLayout, box: Rect, p: Point, area: Area, unit: number): Point {
    const pl = resolvePlacement(el, area, unit);
    const o = originPoint(box, el.origin);
    const dx = (p.x - o.x) * pl.scale;
    const dy = (p.y - o.y) * pl.scale;
    const c = Math.cos(pl.rotation), s = Math.sin(pl.rotation);
    return { x: pl.x + dx * c - dy * s, y: pl.y + dx * s + dy * c };
}

/** The box's corners in area pixels: top-left, top-right, bottom-right, bottom-left. */
export function elementCorners(el: HudElementLayout, box: Rect, area: Area, unit: number): [Point, Point, Point, Point] {
    return [
        toArea(el, box, { x: box.x, y: box.y }, area, unit),
        toArea(el, box, { x: box.x + box.w, y: box.y }, area, unit),
        toArea(el, box, { x: box.x + box.w, y: box.y + box.h }, area, unit),
        toArea(el, box, { x: box.x, y: box.y + box.h }, area, unit),
    ];
}

/** Axis-aligned bounds of some points. */
export function boundsOf(points: readonly Point[]): Rect {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function elementBounds(el: HudElementLayout, box: Rect, area: Area, unit: number): Rect {
    return boundsOf(elementCorners(el, box, area, unit));
}

/** Inside a convex quad (corners in order). */
export function quadContains(q: readonly Point[], p: Point): boolean {
    let sign = 0;
    for (let i = 0; i < q.length; i++) {
        const a = q[i], b = q[(i + 1) % q.length];
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if (Math.abs(cross) < 1e-9) continue;
        const s = Math.sign(cross);
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
    }
    return true;
}

/**
 * Turn an element the built-in layout drew (its local origin at `pos`,
 * `pixelScale` pixels per unit, unrotated) into a layout entry: closest
 * anchor, origin on the same point of its box, offset and scale in
 * layout units. Applying the result draws it in exactly the same place.
 */
export function captureElement(
    id: string, type: HudComponentType, pos: Point, pixelScale: number, box: Rect, area: Area, unit: number, visible = true,
): HudElementLayout {
    const x = pos.x + box.x * pixelScale;
    const y = pos.y + box.y * pixelScale;
    const w = box.w * pixelScale;
    const h = box.h * pixelScale;
    const anchor = closestAnchor({ x: x + w / 2, y: y + h / 2 }, area);
    const f = FACTORS[anchor];
    const a = anchorPoint(anchor, area);
    return {
        id, type, anchor, origin: anchor, fixedAnchor: false,
        x: (x + w * f.x - a.x) / unit,
        y: (y + h * f.y - a.y) / unit,
        scale: pixelScale / unit,
        rotation: 0,
        visible,
    };
}

/** A new anchor, keeping the element where it is (the origin point stays put). */
export function withAnchor(el: HudElementLayout, anchor: Anchor, area: Area, unit: number): HudElementLayout {
    if (anchor === el.anchor) return el;
    const pl = resolvePlacement(el, area, unit);
    const a = anchorPoint(anchor, area);
    return { ...el, anchor, x: (pl.x - a.x) / unit, y: (pl.y - a.y) / unit };
}

/** A new origin, keeping the element where it is (the box stays put). */
export function withOrigin(el: HudElementLayout, origin: Anchor, box: Rect, area: Area, unit: number): HudElementLayout {
    if (origin === el.origin) return el;
    const p = toArea(el, box, originPoint(box, origin), area, unit);
    const a = anchorPoint(el.anchor, area);
    return { ...el, origin, x: (p.x - a.x) / unit, y: (p.y - a.y) / unit };
}

/** lazer's ApplyClosestAnchorOrigin: unless the anchor is fixed, re-pick anchor and origin from where the element is. */
export function withClosestAnchor(el: HudElementLayout, box: Rect, area: Area, unit: number): HudElementLayout {
    if (el.fixedAnchor) return el;
    const b = elementBounds(el, box, area, unit);
    const anchor = closestAnchor({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, area);
    if (anchor === el.anchor && anchor === el.origin) return el;
    return withAnchor(withOrigin(el, anchor, box, area, unit), anchor, area, unit);
}

/** Move by a pixel delta. */
export function movedBy(el: HudElementLayout, dx: number, dy: number, unit: number): HudElementLayout {
    return { ...el, x: el.x + dx / unit, y: el.y + dy / unit };
}

/**
 * Scale about a fixed point of the box (`fixed`, component units, e.g.
 * the corner opposite the dragged handle): the new scale, keeping that
 * point where it is on screen.
 */
export function scaledAbout(el: HudElementLayout, scale: number, fixed: Point, box: Rect, area: Area, unit: number): HudElementLayout {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const before = toArea(el, box, fixed, area, unit);
    const next = { ...el, scale: s };
    const after = toArea(next, box, fixed, area, unit);
    return movedBy(next, before.x - after.x, before.y - after.y, unit);
}

export interface Snap {
    dx: number;
    dy: number;
    /** Area x positions of vertical guide lines to show. */
    guidesX: number[];
    /** Area y positions of horizontal guide lines. */
    guidesY: number[];
}

/**
 * Snap a box being dragged to the area's edges and centre lines: its
 * left / centre / right (top / centre / bottom) edge to 0, half and the
 * full size, whichever is closest within `threshold` pixels.
 */
export function snapBox(b: Rect, area: Area, threshold: number): Snap {
    const axis = (start: number, size: number, full: number): { d: number; line: number | null } => {
        let best: { d: number; line: number | null } = { d: 0, line: null };
        let bestDist = threshold + 1e-9;
        for (const edge of [start, start + size / 2, start + size]) {
            for (const target of [0, full / 2, full]) {
                const dist = Math.abs(target - edge);
                if (dist <= bestDist) {
                    bestDist = dist;
                    best = { d: target - edge, line: target };
                }
            }
        }
        return best;
    };
    const sx = axis(b.x, b.w, area.w);
    const sy = axis(b.y, b.h, area.h);
    return { dx: sx.d, dy: sy.d, guidesX: sx.line === null ? [] : [sx.line], guidesY: sy.line === null ? [] : [sy.line] };
}

/** An id for another component of `type` (the type itself first, then `type-2`, `type-3`…). */
export function newElementId(type: HudComponentType, existing: readonly { id: string }[]): string {
    const taken = new Set(existing.map(e => e.id));
    if (!taken.has(type)) return type;
    for (let n = 2; ; n++) if (!taken.has(`${type}-${n}`)) return `${type}-${n}`;
}

/**
 * Where the toolbox puts a new component (anchor = origin, offset in
 * layout units): the extra components get spots that are free in both
 * built-in layouts; others start in the middle of the screen.
 */
const NEW_PLACEMENT: Partial<Record<HudComponentType, { anchor: Anchor; x: number; y: number }>> = {
    performancePoints: { anchor: 'TopRight', x: -10, y: 100 },
    unstableRate: { anchor: 'BottomCentre', x: 0, y: -72 },
    beatmapInfo: { anchor: 'TopCentre', x: 0, y: 36 },
    judgementCounter: { anchor: 'CentreRight', x: -10, y: 120 },
    modDisplay: { anchor: 'TopRight', x: -10, y: 130 },
};

/** A component added from the toolbox (another copy of a type goes a little lower, so it doesn't hide the first). */
export function newElement(type: HudComponentType, existing: readonly { id: string; type?: HudComponentType }[]): HudElementLayout {
    const spot = NEW_PLACEMENT[type] ?? { anchor: 'Centre' as Anchor, x: 0, y: 0 };
    const copies = existing.filter(e => e.type === type).length;
    const f = FACTORS[spot.anchor];
    return {
        id: newElementId(type, existing), type, anchor: spot.anchor, origin: spot.anchor, fixedAnchor: false,
        x: spot.x, y: spot.y + copies * 40 * (f.y === 1 ? -1 : 1), scale: 1, rotation: 0, visible: true,
    };
}

export function cloneLayout(l: HudLayout): HudLayout {
    return { version: 1, kind: l.kind, elements: l.elements.map(e => ({ ...e })) };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

export function serialiseLayout(l: HudLayout): string {
    return JSON.stringify({
        version: 1,
        kind: l.kind,
        elements: l.elements.map(e => ({ ...e, x: round(e.x), y: round(e.y), scale: round(e.scale), rotation: round(e.rotation) })),
    });
}

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function isAnchor(v: unknown): v is Anchor {
    return typeof v === 'string' && (ANCHORS as readonly string[]).includes(v);
}

/** Wrap degrees into (-180, 180]. */
export function normaliseDegrees(d: number): number {
    const r = ((d % 360) + 360) % 360;
    return r > 180 ? r - 360 : r;
}

/**
 * Read a stored layout (an object or its JSON). Unknown components and
 * malformed fields are dropped or defaulted, ids made unique; null when
 * it isn't a layout at all.
 */
export function parseLayout(raw: unknown): HudLayout | null {
    let v = raw;
    if (typeof v === 'string') {
        try {
            v = JSON.parse(v);
        } catch {
            return null;
        }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (o.version !== 1 || !Array.isArray(o.elements)) return null;
    const kind: LayoutKind = o.kind === 'legacy' ? 'legacy' : 'default';
    const elements: HudElementLayout[] = [];
    for (const item of o.elements) {
        if (!item || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        if (!isComponentType(e.type)) continue;
        const anchor = isAnchor(e.anchor) ? e.anchor : 'Centre';
        let id = typeof e.id === 'string' && e.id ? e.id.slice(0, 64) : e.type;
        if (elements.some(x => x.id === id)) id = newElementId(e.type, elements);
        elements.push({
            id,
            type: e.type,
            anchor,
            origin: isAnchor(e.origin) ? e.origin : anchor,
            fixedAnchor: e.fixedAnchor === true,
            x: num(e.x, 0),
            y: num(e.y, 0),
            scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, num(e.scale, 1))),
            rotation: normaliseDegrees(num(e.rotation, 0)),
            visible: e.visible !== false,
        });
    }
    return { version: 1, kind, elements };
}
