import { lzmaCompress } from '../../core/lzma';
import { md5Hex } from '../../core/md5';
import type { ModAcronym } from '../mods';
import { BUTTON_BITS, type ReplayEvent } from './Replay';

/**
 * Export to osu!'s .osr replay format (lazer's LegacyScoreEncoder, as a
 * stable-version replay so both clients open it): the score header, then
 * LZMA-compressed "w|x|y|z" frames. Custom mod settings (e.g. DT's speed)
 * have no place in the legacy format and are dropped.
 */

/** A stable client version (yyyymmdd); lazer reads anything below its own 30000000 range as stable. */
const OSR_VERSION = 20240411;

/** osu!stable's mod bits (lazer's LegacyMods). Daycore has none and exports as Half Time, like lazer. */
const LEGACY_MODS: Record<ModAcronym, number> = {
    NF: 1, EZ: 2, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, DC: 256,
    NC: 64 | 512, FL: 1024, AT: 2048, SO: 4096, AP: 8192, PF: 32 | 16384,
};

export function legacyModBits(mods: readonly ModAcronym[]): number {
    return mods.reduce((n, m) => n | (LEGACY_MODS[m] ?? 0), 0);
}

/** osu!'s ReplayButtonState: M1 = 1, M2 = 2, and K1 / K2 set their mouse bit too (5 / 10). */
function legacyButtons(buttons: number): number {
    let z = 0;
    if (buttons & BUTTON_BITS.M1) z |= 1;
    if (buttons & BUTTON_BITS.M2) z |= 2;
    if (buttons & BUTTON_BITS.K1) z |= 4 | 1;
    if (buttons & BUTTON_BITS.K2) z |= 8 | 2;
    return z;
}

/**
 * The replay as stable frames: every recorded frame from the song's start,
 * plus one at each press time with that button already down (a tap
 * shorter than a frame still shows up), in time order with whole-ms deltas.
 */
export function legacyFrames(events: readonly ReplayEvent[]): string {
    const frames: { time: number; x: number; y: number; z: number }[] = [];
    let held = 0;
    for (const e of events) {
        if (e.kind === 'frame') {
            held = e.buttons;
            frames.push({ time: e.time, x: e.x, y: e.y, z: legacyButtons(held) });
        } else if (e.kind === 'press') {
            frames.push({ time: e.time, x: e.x, y: e.y, z: legacyButtons(held | BUTTON_BITS[e.button]) });
        }
    }
    frames.sort((a, b) => a.time - b.time);
    // stable opens every replay with two placeholder frames (lazer skips them when reading).
    const parts = ['0|256|-500|0', '-1|256|-500|0'];
    let last = -1;
    for (const f of frames) {
        const t = Math.round(f.time);
        // Lead-in before the song starts: nothing to judge, and readers skip negative deltas.
        if (t < 0) continue;
        parts.push(`${t - last}|${+f.x.toFixed(4)}|${+f.y.toFixed(4)}|${f.z}`);
        last = t;
    }
    // The RNG seed frame stable writes last.
    parts.push('-12345|0|0|0');
    return parts.join(',') + ',';
}

export interface OsrScore {
    beatmapMd5: string;
    player: string;
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    score: number;
    maxCombo: number;
    perfect: boolean;
    mods: readonly ModAcronym[];
    /** ms since the epoch. */
    date: number;
    events: readonly ReplayEvent[];
}

class OsrWriter {
    private readonly chunks: Uint8Array[] = [];

    private push(bytes: Uint8Array): void {
        this.chunks.push(bytes);
    }

    private sized(n: number, fn: (v: DataView) => void): void {
        const b = new Uint8Array(n);
        fn(new DataView(b.buffer));
        this.push(b);
    }

    byte(v: number): void {
        this.push(new Uint8Array([v & 0xff]));
    }

    short(v: number): void {
        this.sized(2, d => d.setUint16(0, Math.max(0, Math.min(0xffff, v)), true));
    }

    int(v: number): void {
        this.sized(4, d => d.setInt32(0, v, true));
    }

    long(v: bigint): void {
        this.sized(8, d => d.setBigInt64(0, v, true));
    }

    /** .NET BinaryWriter string as osu! writes it: 0x0b, ULEB128 length, UTF-8 (0x00 when empty). */
    string(s: string): void {
        if (!s) {
            this.byte(0);
            return;
        }
        const utf8 = new TextEncoder().encode(s);
        this.byte(0x0b);
        let n = utf8.length;
        do {
            let b = n & 0x7f;
            n >>>= 7;
            if (n) b |= 0x80;
            this.byte(b);
        } while (n);
        this.push(utf8);
    }

    bytes(data: Uint8Array): void {
        this.int(data.length);
        this.push(data);
    }

    finish(): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of this.chunks) {
            out.set(c, o);
            o += c.length;
        }
        return out;
    }
}

/** .NET DateTime ticks (100 ns since 0001-01-01) for a JS time. */
function dotNetTicks(ms: number): bigint {
    return (BigInt(Math.round(ms)) + 62135596800000n) * 10000n;
}

export function encodeOsr(s: OsrScore): Uint8Array<ArrayBuffer> {
    const w = new OsrWriter();
    const mods = legacyModBits(s.mods);
    w.byte(0); // osu!standard
    w.int(OSR_VERSION);
    w.string(s.beatmapMd5);
    w.string(s.player);
    // stable's replay hash; nothing checks it for local replays, so any summary of the score does.
    w.string(md5Hex(`${s.count100 + s.count300}p${s.count50}o0o0t${s.countMiss}a${s.beatmapMd5}r${s.maxCombo}e${s.perfect}y${s.player}o${s.score}u${mods}`));
    w.short(s.count300);
    w.short(s.count100);
    w.short(s.count50);
    w.short(0); // gekis
    w.short(0); // katus
    w.short(s.countMiss);
    w.int(Math.min(2 ** 31 - 1, Math.round(s.score)));
    w.short(s.maxCombo);
    w.byte(s.perfect ? 1 : 0);
    w.int(mods);
    w.string(''); // life bar graph
    w.long(dotNetTicks(s.date));
    w.bytes(lzmaCompress(new TextEncoder().encode(legacyFrames(s.events))));
    w.long(0n); // online score id
    return w.finish();
}
