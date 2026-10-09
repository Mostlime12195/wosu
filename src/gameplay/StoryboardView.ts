import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { OszArchive } from '../beatmap/archive';
import {
    animationFramePaths, CommandTrack, normalizeStoryboardPath, STORYBOARD_LAYERS,
    type Storyboard, type StoryboardCommand, type StoryboardLayer, type StoryboardSprite,
} from '../beatmap/storyboard';
import type { AudioEngine } from '../audio/AudioEngine';

/** osu!'s storyboard space. */
const SB_W = 640;
const SB_H = 480;
/** Images larger than this are downscaled (and drawn scaled back up). */
const MAX_TEXTURE = 4096;

interface LoadedImage {
    texture: Texture;
    /** Logical size ÷ texture size (1 unless the image was downscaled). */
    scale: number;
}

interface Entry {
    def: StoryboardSprite;
    sprite: Sprite;
    frames: (LoadedImage | null)[];
    alpha: CommandTrack;
    x: CommandTrack;
    y: CommandTrack;
    scale: CommandTrack;
    vector: CommandTrack;
    rotation: CommandTrack;
    colour: CommandTrack;
    params: StoryboardCommand[];
    active: boolean;
}

/**
 * Draws a parsed storyboard in sync with song time. `back` holds the
 * Background, Fail, Pass and Foreground layers (it goes behind the
 * playfield, inside the dimmed background); `front` is the Overlay layer
 * (above the playfield). Only sprites inside their lifetime are evaluated
 * each frame, so long storyboards with thousands of sprites stay cheap.
 */
export class StoryboardView {
    readonly back = new Container();
    readonly front = new Container();
    private readonly layers = new Map<StoryboardLayer, Container>();
    private readonly entries: Entry[];
    private readonly active: Entry[] = [];
    private next = 0;
    private nextSample = 0;
    private readonly images = new Map<string, LoadedImage | null>();
    private readonly sounds = new Map<string, AudioBuffer | null>();
    private failed = false;
    private disposed = false;
    private lastTime = -Infinity;
    private readonly tmp = [0, 0, 0];
    private readonly mask = new Graphics();
    /** The four layers behind the playfield (one container, so one mask crops them). */
    private readonly stage = new Container();

    constructor(private readonly storyboard: Storyboard, widescreen: boolean) {
        this.back.eventMode = this.front.eventMode = 'none';
        this.back.addChild(this.stage);
        for (const name of STORYBOARD_LAYERS) {
            const layer = new Container();
            this.layers.set(name, layer);
            if (name === 'Overlay') this.front.addChild(layer);
            else this.stage.addChild(layer);
        }
        this.layers.get('Fail')!.visible = false;
        this.entries = storyboard.sprites
            .map(def => this.makeEntry(def))
            .sort((a, b) => a.def.start - b.def.start);
        if (!widescreen) {
            // 4:3 storyboards are cropped to their area, like osu!.
            this.back.addChild(this.mask);
            this.stage.mask = this.mask;
        }
    }

    get hasVisuals(): boolean {
        return this.entries.length > 0;
    }

    /** True when a sprite uses the beatmap's background image (osu! then hides the plain background). */
    usesImage(file: string | null): boolean {
        if (!file) return false;
        const want = normalizeStoryboardPath(file);
        return this.storyboard.sprites.some(s => normalizeStoryboardPath(s.path) === want);
    }

    /** Decode every image and sample the storyboard uses. Safe to call once. */
    async load(archive: OszArchive, engine: AudioEngine): Promise<void> {
        const paths = new Set<string>();
        for (const s of this.storyboard.sprites) {
            for (const p of s.kind === 'animation' ? animationFramePaths(s) : [s.path]) paths.add(p);
        }
        const loadImage = async (path: string): Promise<void> => {
            const name = archive.find(path);
            let img: LoadedImage | null = null;
            if (name) {
                try {
                    img = await decodeImage(await archive.readBlob(name));
                } catch {
                    img = null;
                }
            }
            if (this.disposed) {
                img?.texture.destroy(true);
                return;
            }
            this.images.set(normalizeStoryboardPath(path), img);
        };
        // A few at a time: decoding everything at once stalls the loader.
        const queue = [...paths];
        const workers = Array.from({ length: 6 }, async () => {
            while (queue.length && !this.disposed) await loadImage(queue.shift()!);
        });
        const samplePaths = new Set(this.storyboard.samples.map(s => s.path));
        const sampleLoads = [...samplePaths].map(async path => {
            const name = archive.find(path);
            let buf: AudioBuffer | null = null;
            if (name) {
                try {
                    const bytes = await archive.readBytes(name);
                    buf = await engine.context.decodeAudioData(bytes.slice().buffer);
                } catch {
                    buf = null;
                }
            }
            this.sounds.set(normalizeStoryboardPath(path), buf);
        });
        await Promise.all([...workers, ...sampleLoads]);
        if (this.disposed) return;
        for (const e of this.entries) {
            e.frames = (e.def.kind === 'animation' ? animationFramePaths(e.def) : [e.def.path])
                .map(p => this.images.get(normalizeStoryboardPath(p)) ?? null);
        }
    }

    /** Fit the 640×480 storyboard space to the screen (height-fitted and centred, like osu!). */
    layout(w: number, h: number): void {
        const scale = h / SB_H;
        const x = (w - SB_W * scale) / 2;
        for (const layer of this.layers.values()) {
            layer.scale.set(scale);
            layer.position.set(x, 0);
        }
        this.mask.clear().rect(x, 0, SB_W * scale, h).fill(0xffffff);
    }

    /** osu! swaps the Pass layer for the Fail layer once the player fails. */
    setFailed(failed: boolean): void {
        this.failed = failed;
        this.layers.get('Pass')!.visible = !failed;
        this.layers.get('Fail')!.visible = failed;
    }

    /**
     * Advance to song time `time`. Samples fire only while `playing` and
     * only when their time is crossed (a seek or retry doesn't replay them).
     */
    update(time: number, playing: boolean, engine: AudioEngine | null): void {
        if (this.disposed) return;
        if (time < this.lastTime) this.rewind(time);
        this.lastTime = time;
        const entries = this.entries;
        while (this.next < entries.length && entries[this.next].def.start <= time) {
            const e = entries[this.next++];
            if (e.def.end >= time) {
                e.active = true;
                this.active.push(e);
            }
        }
        for (let i = this.active.length - 1; i >= 0; i--) {
            const e = this.active[i];
            if (time > e.def.end) {
                e.active = false;
                e.sprite.visible = false;
                this.active.splice(i, 1);
                continue;
            }
            this.apply(e, time);
        }
        this.playSamples(time, playing, engine);
    }

    destroy(): void {
        this.disposed = true;
        this.back.destroy({ children: true });
        this.front.destroy({ children: true });
        for (const img of this.images.values()) img?.texture.destroy(true);
        this.images.clear();
        this.sounds.clear();
    }

    // ------------------------------------------------------------------

    private makeEntry(def: StoryboardSprite): Entry {
        const sprite = new Sprite(Texture.EMPTY);
        sprite.anchor.set(def.origin.x, def.origin.y);
        sprite.visible = false;
        sprite.eventMode = 'none';
        this.layers.get(def.layer)!.addChild(sprite);
        const of = (t: StoryboardCommand['type']) => def.commands.filter(c => c.type === t);
        const component = (c: StoryboardCommand, i: number): StoryboardCommand => ({ ...c, from: [c.from[i]], to: [c.to[i]] });
        // M moves both axes; MX/MY one each. Merged per axis, the latest command wins.
        const xs = [...of('M').map(c => component(c, 0)), ...of('MX')].sort((a, b) => a.start - b.start);
        const ys = [...of('M').map(c => component(c, 1)), ...of('MY')].sort((a, b) => a.start - b.start);
        return {
            def, sprite, frames: [],
            alpha: new CommandTrack(of('F')),
            x: new CommandTrack(xs),
            y: new CommandTrack(ys),
            scale: new CommandTrack(of('S')),
            vector: new CommandTrack(of('V')),
            rotation: new CommandTrack(of('R')),
            colour: new CommandTrack(of('C')),
            params: of('P'),
            active: false,
        };
    }

    private apply(e: Entry, time: number): void {
        const s = e.sprite, d = e.def, v = this.tmp;
        const img = this.frameAt(e, time);
        if (!img) {
            s.visible = false;
            return;
        }
        let alpha = 1;
        if (e.alpha.valueAt(time, v)) alpha = v[0];
        if (alpha <= 0) {
            s.visible = false;
            return;
        }
        let sx = 1, sy = 1;
        if (e.scale.valueAt(time, v)) sx = sy = v[0];
        if (e.vector.valueAt(time, v)) {
            sx *= v[0];
            sy *= v[1];
        }
        if (sx === 0 || sy === 0) {
            s.visible = false;
            return;
        }
        let flipH = false, flipV = false, additive = false;
        for (const p of e.params) {
            // A parameter with no duration lasts the sprite's whole life.
            if (p.start === p.end ? true : time >= p.start && time < p.end) {
                if (p.from[0] === 0) flipH = true;
                else if (p.from[0] === 1) flipV = true;
                else additive = true;
            }
        }
        if (s.texture !== img.texture) s.texture = img.texture;
        s.visible = true;
        s.alpha = Math.min(1, alpha);
        s.position.set(e.x.valueAt(time, v) ? v[0] : d.x, e.y.valueAt(time, v) ? v[0] : d.y);
        s.scale.set(sx * img.scale * (flipH ? -1 : 1), sy * img.scale * (flipV ? -1 : 1));
        s.rotation = e.rotation.valueAt(time, v) ? v[0] : 0;
        if (e.colour.valueAt(time, v)) {
            const c = (Math.round(clamp255(v[0])) << 16) | (Math.round(clamp255(v[1])) << 8) | Math.round(clamp255(v[2]));
            if (s.tint !== c) s.tint = c;
        }
        const blend = additive ? 'add' : 'normal';
        if (s.blendMode !== blend) s.blendMode = blend;
    }

    private frameAt(e: Entry, time: number): LoadedImage | null {
        const n = e.frames.length;
        if (n <= 1) return e.frames[0] ?? null;
        const d = e.def;
        let i = d.frameDelay > 0 ? Math.floor((time - d.start) / d.frameDelay) : 0;
        if (i < 0) i = 0;
        i = d.loopForever ? i % n : Math.min(i, n - 1);
        return e.frames[i];
    }

    private playSamples(time: number, playing: boolean, engine: AudioEngine | null): void {
        const samples = this.storyboard.samples;
        while (this.nextSample < samples.length && samples[this.nextSample].time <= time) {
            const smp = samples[this.nextSample++];
            // Late by more than a moment (a skip or a seek): don't blast it now.
            if (!playing || !engine || time - smp.time > 150) continue;
            if (smp.layer === 'Fail' ? !this.failed : smp.layer === 'Pass' ? this.failed : false) continue;
            const buf = this.sounds.get(normalizeStoryboardPath(smp.path));
            if (!buf || engine.context.state !== 'running') continue;
            try {
                const src = engine.context.createBufferSource();
                src.buffer = buf;
                const gain = engine.context.createGain();
                gain.gain.value = smp.volume;
                src.connect(gain);
                gain.connect(engine.effectsBus);
                src.onended = () => {
                    try { gain.disconnect(); } catch { /* ignore */ }
                };
                src.start();
            } catch {
                /* a missing sample is decoration */
            }
        }
    }

    /** Time went backwards (rare: seeks): rebuild the active set from scratch. */
    private rewind(time: number): void {
        for (const e of this.active) {
            e.active = false;
            e.sprite.visible = false;
        }
        this.active.length = 0;
        this.next = 0;
        let lo = 0, hi = this.storyboard.samples.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.storyboard.samples[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        this.nextSample = lo;
    }
}

function clamp255(v: number): number {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

async function decodeImage(blob: Blob): Promise<LoadedImage | null> {
    let bitmap = await createImageBitmap(blob);
    let scale = 1;
    if (bitmap.width > MAX_TEXTURE || bitmap.height > MAX_TEXTURE) {
        const s = MAX_TEXTURE / Math.max(bitmap.width, bitmap.height);
        const scaled = await createImageBitmap(bitmap, {
            resizeWidth: Math.max(1, Math.round(bitmap.width * s)),
            resizeHeight: Math.max(1, Math.round(bitmap.height * s)),
            resizeQuality: 'high',
        });
        bitmap.close();
        bitmap = scaled;
        scale = 1 / s;
    }
    const texture = Texture.from(bitmap);
    texture.source.autoGenerateMipmaps = false;
    return { texture, scale };
}
