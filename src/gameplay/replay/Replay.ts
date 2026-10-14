import { deflateSync, inflateSync } from 'fflate';
import type { GameplayButton } from '../input/GameplayInput';
import type { ModAcronym, ModSettingsMap } from '../mods';
import type { GameplayMechanics } from '../scoring/mechanics';

/**
 * Score replays (lazer's Replay / LegacyReplayFrame). A replay is the
 * exact sequence of inputs the Player fed GameplayRules: frames (cursor in
 * osu!pixels + held buttons, at gameplay-clock times), presses (with their
 * own event time and position) and resumes after a pause. Replaying them
 * in order through the same RulesDriver reproduces every judgement.
 */

/** Bits of a frame's `buttons`. */
export const BUTTON_BITS: Readonly<Record<GameplayButton, number>> = { K1: 1, K2: 2, M1: 4, M2: 8 };
const BUTTON_ORDER: readonly GameplayButton[] = ['K1', 'K2', 'M1', 'M2'];
/** A frame's `buttons` bit for the smoke key (lazer's ReplayButtonState.Smoke); never judged. */
export const SMOKE_BIT = 16;
/** The bits of a frame's `buttons` that judge (all but smoke). */
export const PRESS_BITS = 15;

export interface ReplayFrame {
    kind: 'frame';
    time: number;
    x: number;
    y: number;
    /** Held buttons (BUTTON_BITS, plus SMOKE_BIT). */
    buttons: number;
}

export interface ReplayPress {
    kind: 'press';
    time: number;
    x: number;
    y: number;
    button: GameplayButton;
}

/** Gameplay resumed after a pause (spinners forget their last angle). */
export interface ReplayResume {
    kind: 'resume';
    time: number;
}

export type ReplayEvent = ReplayFrame | ReplayPress | ReplayResume;

/** Everything a replay player needs besides the beatmap. */
export interface ReplayInfo {
    events: readonly ReplayEvent[];
    mods: ModAcronym[];
    modSettings?: ModSettingsMap;
    mechanics: GameplayMechanics;
    player: string;
    date: number;
}

export function buttonMask(down: Readonly<Record<GameplayButton, boolean>>): number {
    return (down.K1 ? 1 : 0) | (down.K2 ? 2 : 0) | (down.M1 ? 4 : 0) | (down.M2 ? 8 : 0);
}

/**
 * Times (ms) and positions (osu!px) are kept in 1/16ths. Live play judges
 * the quantised values too, so a decoded replay is bit-identical input.
 */
const UNITS = 16;

export function quantize(v: number): number {
    return Math.round(v * UNITS) / UNITS;
}

// ---------------------------------------------------------------------------
// Binary format: deflate([version, varint count, events...]). Each event is a
// tag byte (kind in the low 2 bits, buttons / button index above) followed by
// zigzag varint deltas of time, x and y in 1/16ths.
// ---------------------------------------------------------------------------

const FORMAT_VERSION = 1;
const KIND_FRAME = 0;
const KIND_PRESS = 1;
const KIND_RESUME = 2;

class ByteWriter {
    private buf = new Uint8Array(1024);
    length = 0;

    byte(b: number): void {
        if (this.length === this.buf.length) {
            const next = new Uint8Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = b;
    }

    /** Unsigned varint (arithmetic, so values past 2^31 survive). */
    varint(n: number): void {
        while (n >= 0x80) {
            this.byte((n % 0x80) | 0x80);
            n = Math.floor(n / 0x80);
        }
        this.byte(n);
    }

    zigzag(n: number): void {
        this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
    }

    bytes(): Uint8Array {
        return this.buf.subarray(0, this.length);
    }
}

class ByteReader {
    pos = 0;
    constructor(private readonly buf: Uint8Array) {}

    byte(): number {
        if (this.pos >= this.buf.length) throw new Error('replay data is truncated');
        return this.buf[this.pos++];
    }

    varint(): number {
        let n = 0, mul = 1;
        for (;;) {
            const b = this.byte();
            n += (b & 0x7f) * mul;
            if (b < 0x80) return n;
            mul *= 0x80;
            if (mul > 2 ** 49) throw new Error('replay data is corrupt');
        }
    }

    zigzag(): number {
        const n = this.varint();
        return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
    }
}

export function encodeReplay(events: readonly ReplayEvent[]): Uint8Array {
    const w = new ByteWriter();
    w.byte(FORMAT_VERSION);
    w.varint(events.length);
    let t = 0, x = 0, y = 0;
    for (const e of events) {
        const et = Math.round(e.time * UNITS);
        if (e.kind === 'resume') {
            w.byte(KIND_RESUME);
            w.zigzag(et - t);
            t = et;
            continue;
        }
        const extra = e.kind === 'frame' ? e.buttons & (PRESS_BITS | SMOKE_BIT) : BUTTON_ORDER.indexOf(e.button);
        w.byte((e.kind === 'frame' ? KIND_FRAME : KIND_PRESS) | (extra << 2));
        const ex = Math.round(e.x * UNITS), ey = Math.round(e.y * UNITS);
        w.zigzag(et - t);
        w.zigzag(ex - x);
        w.zigzag(ey - y);
        t = et;
        x = ex;
        y = ey;
    }
    return deflateSync(w.bytes(), { level: 9 });
}

export function decodeReplay(data: Uint8Array): ReplayEvent[] {
    const r = new ByteReader(inflateSync(data));
    const version = r.byte();
    if (version !== FORMAT_VERSION) throw new Error(`unsupported replay format ${version}`);
    const count = r.varint();
    const events: ReplayEvent[] = [];
    let t = 0, x = 0, y = 0;
    for (let i = 0; i < count; i++) {
        const tag = r.byte();
        const kind = tag & 3, extra = tag >> 2;
        t += r.zigzag();
        if (kind === KIND_RESUME) {
            events.push({ kind: 'resume', time: t / UNITS });
            continue;
        }
        x += r.zigzag();
        y += r.zigzag();
        if (kind === KIND_FRAME) {
            events.push({ kind: 'frame', time: t / UNITS, x: x / UNITS, y: y / UNITS, buttons: extra & (PRESS_BITS | SMOKE_BIT) });
        } else if (kind === KIND_PRESS && extra < BUTTON_ORDER.length) {
            events.push({ kind: 'press', time: t / UNITS, x: x / UNITS, y: y / UNITS, button: BUTTON_ORDER[extra] });
        } else {
            throw new Error('replay data is corrupt');
        }
    }
    return events;
}
