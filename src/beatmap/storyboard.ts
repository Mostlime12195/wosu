/**
 * osu! storyboards: the `.osb` file of a set plus the `[Events]` section of
 * each difficulty. Pure parsing and evaluation (no rendering), following
 * the osu!stable format as lazer's LegacyStoryboardDecoder reads it:
 * sprites, animations and samples on five layers, scripted with timed
 * commands (fade, move, scale, rotate, colour, flip/additive), loops, and
 * `$variables`. Trigger groups (hitsound/pass/fail triggers) are skipped.
 */

export type StoryboardLayer = 'Background' | 'Fail' | 'Pass' | 'Foreground' | 'Overlay';
export const STORYBOARD_LAYERS: readonly StoryboardLayer[] = ['Background', 'Fail', 'Pass', 'Foreground', 'Overlay'];

/** Anchor point of a sprite, as fractions of its size. */
export interface Origin { x: number; y: number }

const ORIGINS: Record<string, Origin> = {
    TopLeft: { x: 0, y: 0 },
    Centre: { x: 0.5, y: 0.5 },
    CentreLeft: { x: 0, y: 0.5 },
    TopRight: { x: 1, y: 0 },
    BottomCentre: { x: 0.5, y: 1 },
    TopCentre: { x: 0.5, y: 0 },
    Custom: { x: 0, y: 0 },
    CentreRight: { x: 1, y: 0.5 },
    BottomLeft: { x: 0, y: 1 },
    BottomRight: { x: 1, y: 1 },
};
const ORIGIN_BY_NUMBER = ['TopLeft', 'Centre', 'CentreLeft', 'TopRight', 'BottomCentre', 'TopCentre', 'Custom', 'CentreRight', 'BottomLeft', 'BottomRight'];

export type CommandType = 'F' | 'M' | 'MX' | 'MY' | 'S' | 'V' | 'R' | 'C' | 'P';

export interface StoryboardCommand {
    type: CommandType;
    easing: number;
    start: number;
    end: number;
    /** Start values (1 for F/MX/MY/S/R, 2 for M/V, 3 for C; P: 0 = H flip, 1 = V flip, 2 = additive). */
    from: number[];
    to: number[];
}

export interface StoryboardSprite {
    kind: 'sprite' | 'animation';
    layer: StoryboardLayer;
    origin: Origin;
    /** Image path as written (animations: without the frame number). */
    path: string;
    x: number;
    y: number;
    frameCount: number;
    frameDelay: number;
    loopForever: boolean;
    /** Every command, loops expanded, sorted by start time. */
    commands: StoryboardCommand[];
    /** Lifetime: first command start to last command end. */
    start: number;
    end: number;
}

export interface StoryboardSample {
    time: number;
    layer: StoryboardLayer;
    path: string;
    /** 0..1 */
    volume: number;
}

export interface Storyboard {
    sprites: StoryboardSprite[];
    samples: StoryboardSample[];
}

/** Image paths an animation uses ("sb/a.png" with 3 frames → sb/a0.png, sb/a1.png, sb/a2.png). */
export function animationFramePaths(s: Pick<StoryboardSprite, 'path' | 'frameCount'>): string[] {
    const dot = s.path.lastIndexOf('.');
    const stem = dot > 0 ? s.path.slice(0, dot) : s.path;
    const ext = dot > 0 ? s.path.slice(dot) : '';
    return Array.from({ length: Math.max(1, s.frameCount) }, (_, i) => `${stem}${i}${ext}`);
}

/** Normalise a storyboard path for comparisons (slashes, quotes, case). */
export function normalizeStoryboardPath(p: string): string {
    return p.replace(/^"|"$/g, '').replace(/\\/g, '/').trim().toLowerCase();
}

/**
 * Parse storyboard sources (the .osb text, then the .osu text; either may
 * be empty). Returns null when nothing visible or audible is defined.
 */
export function parseStoryboard(...sources: string[]): Storyboard | null {
    const sprites: StoryboardSprite[] = [];
    const samples: StoryboardSample[] = [];
    for (const text of sources) if (text) parseSource(text, sprites, samples);
    for (const s of sprites) finishSprite(s);
    const visible = sprites.filter(s => s.commands.length > 0 && s.end >= s.start);
    if (!visible.length && !samples.length) return null;
    samples.sort((a, b) => a.time - b.time);
    return { sprites: visible, samples };
}

function parseSource(text: string, sprites: StoryboardSprite[], samples: StoryboardSample[]): void {
    const lines = text.split(/\r?\n/);
    const vars: [string, string][] = [];
    let section = '';
    let current: StoryboardSprite | null = null;
    /** Open loop: its nested commands collect here until the indentation drops. */
    let loop: { start: number; count: number; commands: StoryboardCommand[] } | null = null;
    /** Skipping a trigger group's nested lines. */
    let skipDepth = -1;

    const closeLoop = (): void => {
        if (!loop || !current) {
            loop = null;
            return;
        }
        expandLoop(loop, current.commands);
        loop = null;
    };

    for (const rawLine of lines) {
        if (rawLine.startsWith('//')) continue;
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            closeLoop();
            current = null;
            section = trimmed.slice(1, -1);
            continue;
        }
        if (section === 'Variables') {
            const eq = trimmed.indexOf('=');
            if (trimmed.startsWith('$') && eq > 0) vars.push([trimmed.slice(0, eq), trimmed.slice(eq + 1)]);
            continue;
        }
        if (section !== 'Events') continue;

        let line = rawLine;
        if (vars.length && line.includes('$')) {
            // Longest names first so $ab isn't eaten by $a.
            for (const [k, v] of [...vars].sort((a, b) => b[0].length - a[0].length)) line = line.split(k).join(v);
        }
        let depth = 0;
        while (depth < line.length && (line[depth] === ' ' || line[depth] === '_')) depth++;
        const body = line.slice(depth).trim();
        const f = splitFields(body);

        if (depth === 0) {
            closeLoop();
            skipDepth = -1;
            current = null;
            const type = f[0];
            if (type === 'Sprite' || type === '4') {
                current = makeSprite('sprite', f);
                if (current) sprites.push(current);
            } else if (type === 'Animation' || type === '6') {
                current = makeSprite('animation', f);
                if (current) sprites.push(current);
            } else if (type === 'Sample' || type === '5') {
                const layer = parseLayer(f[2]);
                const time = Number(f[1]);
                if (layer && Number.isFinite(time) && f[3]) {
                    const vol = f[4] !== undefined ? Number(f[4]) : 100;
                    samples.push({ time, layer, path: unquote(f[3]), volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, vol)) / 100 : 1 });
                }
            }
            continue;
        }
        if (!current) continue;
        if (skipDepth >= 0) {
            if (depth > skipDepth) continue;
            skipDepth = -1;
        }
        if (depth === 1) closeLoop();
        const cmd = f[0];
        if (depth === 1 && cmd === 'L') {
            const start = Number(f[1]);
            const count = Number(f[2]);
            loop = { start: Number.isFinite(start) ? start : 0, count: Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1, commands: [] };
            continue;
        }
        if (cmd === 'T') {
            skipDepth = depth;
            continue;
        }
        const parsed = parseCommand(f);
        if (!parsed) continue;
        if (depth >= 2 && loop) loop.commands.push(...parsed);
        else if (depth === 1) current.commands.push(...parsed);
    }
    closeLoop();
}

/** Loops repeat their commands `count` times, each pass as long as its last command's end. */
function expandLoop(loop: { start: number; count: number; commands: StoryboardCommand[] }, out: StoryboardCommand[]): void {
    if (!loop.commands.length) return;
    const length = Math.max(0, ...loop.commands.map(c => c.end));
    for (let i = 0; i < loop.count; i++) {
        const offset = loop.start + i * length;
        for (const c of loop.commands) out.push({ ...c, start: c.start + offset, end: c.end + offset });
    }
}

function makeSprite(kind: 'sprite' | 'animation', f: string[]): StoryboardSprite | null {
    const layer = parseLayer(f[1]);
    if (!layer || !f[3]) return null;
    const originName = /^\d+$/.test(f[2] ?? '') ? ORIGIN_BY_NUMBER[Number(f[2])] : f[2];
    const x = Number(f[4]), y = Number(f[5]);
    const sprite: StoryboardSprite = {
        kind, layer,
        origin: ORIGINS[originName ?? ''] ?? ORIGINS.Centre,
        path: unquote(f[3]),
        x: Number.isFinite(x) ? x : 320,
        y: Number.isFinite(y) ? y : 240,
        frameCount: 1, frameDelay: 0, loopForever: true,
        commands: [], start: 0, end: 0,
    };
    if (kind === 'animation') {
        const n = Number(f[6]), d = Number(f[7]);
        sprite.frameCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
        sprite.frameDelay = Number.isFinite(d) && d > 0 ? d : 0;
        sprite.loopForever = (f[8] ?? 'LoopForever') !== 'LoopOnce';
    }
    return sprite;
}

const ARITY: Record<CommandType, number> = { F: 1, M: 2, MX: 1, MY: 1, S: 1, V: 2, R: 1, C: 3, P: 1 };

/** One command line → one or more segments (extra value sets chain with the same duration). */
function parseCommand(f: string[]): StoryboardCommand[] | null {
    const type = f[0] as CommandType;
    const n = ARITY[type];
    if (!n) return null;
    const easing = Number(f[1]) || 0;
    const start = Number(f[2]);
    if (!Number.isFinite(start)) return null;
    const endRaw = f[3];
    const end = endRaw === undefined || endRaw === '' ? start : Number(endRaw);
    if (!Number.isFinite(end)) return null;
    if (type === 'P') {
        const code = { H: 0, V: 1, A: 2 }[(f[4] ?? '').trim() as 'H' | 'V' | 'A'];
        if (code === undefined) return null;
        return [{ type, easing: 0, start, end, from: [code], to: [code] }];
    }
    const values = f.slice(4).map(Number);
    if (values.length < n || values.slice(0, n).some(v => !Number.isFinite(v))) return null;
    const sets: number[][] = [];
    for (let i = 0; i + n <= values.length; i += n) sets.push(values.slice(i, i + n));
    if (sets.some(s => s.some(v => !Number.isFinite(v)))) return null;
    if (sets.length === 1) return [{ type, easing, start, end, from: sets[0], to: sets[0] }];
    const duration = end - start;
    const out: StoryboardCommand[] = [];
    for (let i = 0; i + 1 < sets.length; i++) {
        out.push({ type, easing, start: start + duration * i, end: end + duration * i, from: sets[i], to: sets[i + 1] });
    }
    return out;
}

function finishSprite(s: StoryboardSprite): void {
    s.commands.sort((a, b) => a.start - b.start);
    if (!s.commands.length) return;
    let start = Infinity, end = -Infinity;
    for (const c of s.commands) {
        start = Math.min(start, c.start);
        end = Math.max(end, c.end);
    }
    s.start = start;
    s.end = end;
}

function parseLayer(v: string | undefined): StoryboardLayer | null {
    if (v === undefined) return null;
    if (/^\d+$/.test(v)) return STORYBOARD_LAYERS[Number(v)] ?? null;
    return (STORYBOARD_LAYERS as readonly string[]).includes(v) ? (v as StoryboardLayer) : null;
}

function unquote(s: string): string {
    return s.trim().replace(/"/g, '').replace(/\\/g, '/');
}

/** Comma split that keeps quoted paths (which may contain commas) whole. */
function splitFields(s: string): string[] {
    const out: string[] = [];
    let cur = '', quoted = false;
    for (const ch of s) {
        if (ch === '"') quoted = !quoted;
        if (ch === ',' && !quoted) {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur.trim());
    return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** osu!'s storyboard easings (index = the number in the command). */
export const STORYBOARD_EASINGS: ((t: number) => number)[] = (() => {
    const outBounce = (t: number): number => {
        if (t < 1 / 2.75) return 7.5625 * t * t;
        if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
        if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
        return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
    };
    const inOut = (inF: (t: number) => number) => (t: number): number => (t < 0.5 ? inF(2 * t) / 2 : 1 - inF(2 - 2 * t) / 2);
    const out = (inF: (t: number) => number) => (t: number): number => 1 - inF(1 - t);
    const quad = (t: number) => t * t, cubic = (t: number) => t * t * t, quart = (t: number) => t ** 4, quint = (t: number) => t ** 5;
    const sine = (t: number) => 1 - Math.cos((t * Math.PI) / 2);
    const expo = (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1)));
    const circ = (t: number) => 1 - Math.sqrt(1 - t * t);
    const outElastic = (t: number, period: number) => Math.pow(2, -10 * t) * Math.sin(((t - period / 4) * (2 * Math.PI)) / period) + 1;
    const inElastic = (t: number) => 1 - outElastic(1 - t, 0.3);
    const back = (t: number) => t * t * ((1.70158 + 1) * t - 1.70158);
    const backInOut = (t: number) => {
        const s = 1.70158 * 1.525;
        return t < 0.5 ? ((2 * t) ** 2 * ((s + 1) * 2 * t - s)) / 2 : ((2 * t - 2) ** 2 * ((s + 1) * (t * 2 - 2) + s) + 2) / 2;
    };
    const inBounce = (t: number) => 1 - outBounce(1 - t);
    return [
        t => t, // 0 Linear
        out(quad), quad, // 1 Out, 2 In
        quad, out(quad), inOut(quad), // 3-5 Quad
        cubic, out(cubic), inOut(cubic), // 6-8 Cubic
        quart, out(quart), inOut(quart), // 9-11 Quart
        quint, out(quint), inOut(quint), // 12-14 Quint
        sine, out(sine), inOut(sine), // 15-17 Sine
        expo, out(expo), inOut(expo), // 18-20 Expo
        circ, out(circ), inOut(circ), // 21-23 Circ
        inElastic, t => outElastic(t, 0.3), t => outElastic(t, 0.6), t => outElastic(t, 1.2), // 24 In, 25 Out, 26 OutHalf, 27 OutQuarter (framework: half/quarter frequency)
        t => (t < 0.5 ? (1 - outElastic(1 - 2 * t, 0.45)) / 2 : outElastic(2 * t - 1, 0.45) / 2 + 0.5), // 28 InOut
        back, out(back), backInOut, // 29-31 Back
        inBounce, outBounce, t => (t < 0.5 ? inBounce(2 * t) / 2 : outBounce(2 * t - 1) / 2 + 0.5), // 32-34 Bounce
    ];
})();

/**
 * A command track: every command of one kind, sorted. `valueAt` gives
 * osu!'s value at `time`: the first command's start value before it
 * begins, the eased value inside a command, and the last ended command's
 * end value between and after commands.
 */
export class CommandTrack {
    private index = 0;

    constructor(readonly commands: StoryboardCommand[]) {}

    get length(): number {
        return this.commands.length;
    }

    /** Write the value at `time` into `out`; returns false for an empty track. Time should mostly move forward. */
    valueAt(time: number, out: number[]): boolean {
        const cs = this.commands;
        if (!cs.length) return false;
        if (time < cs[0].start) {
            copy(cs[0].from, out);
            return true;
        }
        // Monotonic time: advance the cached index; a seek back rescans.
        let i = this.index < cs.length && cs[this.index].start <= time ? this.index : 0;
        while (i + 1 < cs.length && cs[i + 1].start <= time) i++;
        this.index = i;
        const c = cs[i];
        if (time >= c.end || c.end <= c.start) {
            copy(c.to, out);
            return true;
        }
        const k = (STORYBOARD_EASINGS[c.easing] ?? STORYBOARD_EASINGS[0])((time - c.start) / (c.end - c.start));
        for (let j = 0; j < c.from.length; j++) out[j] = c.from[j] + (c.to[j] - c.from[j]) * k;
        return true;
    }
}

function copy(src: number[], out: number[]): void {
    for (let j = 0; j < src.length; j++) out[j] = src[j];
}
