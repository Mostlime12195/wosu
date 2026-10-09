import {
    Buffer, BufferImageSource, BufferUsage, Container, Geometry, GlProgram, GpuProgram, Mesh, RenderTexture, Shader, Texture,
    UniformGroup, type Renderer,
} from 'pixi.js';
import type { PathPoint } from '../../beatmap/types';
import {
    COMPOSITE_GLSL_FRAGMENT, COMPOSITE_GLSL_VERTEX, COMPOSITE_WGSL,
    PREPASS_GLSL_FRAGMENT, PREPASS_GLSL_VERTEX, PREPASS_WGSL,
} from './shaders';
import { boundsOf, capsuleQuads, partialPoints, sliderLutData, type Bounds, type CapsuleQuads } from './sliderGeometry';

/** Coverage textures never exceed this size (huge sliders on 4K screens). */
const MAX_RT_DIM = 2048;

/**
 * Per-beatmap shared GPU state: compiled programs (both GL and WGSL) and
 * the gradient LUT built from the map's combo colours.
 */
export class SliderResources {
    private static glPrepass: GlProgram | null = null;
    private static gpuPrepass: GpuProgram | null = null;
    private static glComposite: GlProgram | null = null;
    private static gpuComposite: GpuProgram | null = null;

    readonly lut: Texture;
    readonly rows: number;

    constructor(readonly renderer: Renderer, colors: readonly number[], trackOverride: number | null, border: number | null) {
        const d = sliderLutData(colors, trackOverride, border);
        this.rows = d.height;
        // The buffer is already premultiplied; declaring it avoids a second
        // premultiply on upload (which darkened every slider). Pixi's default
        // format is BGRA, which WebGPU takes literally (red/blue swapped).
        this.lut = new Texture({
            source: new BufferImageSource({
                resource: d.data, width: d.width, height: d.height, alphaMode: 'premultiplied-alpha', format: 'rgba8unorm',
                scaleMode: 'linear', addressMode: 'clamp-to-edge',
            }),
        });
    }

    static programs() {
        const S = SliderResources;
        S.glPrepass ??= new GlProgram({
            name: 'slider-prepass', vertex: PREPASS_GLSL_VERTEX, fragment: PREPASS_GLSL_FRAGMENT,
            preferredFragmentPrecision: 'highp',
        });
        S.gpuPrepass ??= new GpuProgram({
            name: 'slider-prepass',
            vertex: { source: PREPASS_WGSL, entryPoint: 'mainVertex' },
            fragment: { source: PREPASS_WGSL, entryPoint: 'mainFragment' },
        });
        S.glComposite ??= new GlProgram({
            name: 'slider-composite', vertex: COMPOSITE_GLSL_VERTEX, fragment: COMPOSITE_GLSL_FRAGMENT,
            preferredFragmentPrecision: 'highp',
        });
        S.gpuComposite ??= new GpuProgram({
            name: 'slider-composite',
            vertex: { source: COMPOSITE_WGSL, entryPoint: 'mainVertex' },
            fragment: { source: COMPOSITE_WGSL, entryPoint: 'mainFragment' },
        });
        return { glPrepass: S.glPrepass, gpuPrepass: S.gpuPrepass, glComposite: S.glComposite, gpuComposite: S.gpuComposite };
    }

    destroy(): void {
        this.lut.destroy(true);
    }
}

/**
 * One slider body. Lives in the playfield (osu! pixel space). Call
 * `setRange` with the visible path range (snaking) and `sync` once per
 * frame before rendering; the coverage texture is only re-rendered when
 * the geometry or its on-screen pixel size changes.
 */
export class SliderBody extends Container {
    private readonly prepassGeom: Geometry;
    private readonly prepassMesh: Mesh<Geometry, Shader>;
    private readonly prepassRoot = new Container();
    private readonly quadCap: number;
    readonly bounds: Bounds;
    private composite: Mesh<Geometry, Shader> | null = null;
    private compositeShader: Shader | null = null;
    private compositeGeom: Geometry | null = null;
    private rt: RenderTexture | null = null;
    private rtW = 0;
    private rtH = 0;
    private geoKey = 'full';
    private dirty = true;
    private fromT = 0;
    private toT = 1;

    constructor(
        private readonly res: SliderResources,
        private readonly points: readonly PathPoint[],
        private readonly radius: number,
        private readonly colorIndex: number,
    ) {
        super();
        this.quadCap = Math.max(1, Math.max(2, points.length) - 1);
        const full = capsuleQuads(points, radius);
        this.bounds = boundsOf(full.pos);
        // Snaking rewrites these every frame: WebGPU only accepts writes to
        // buffers created with COPY_DST.
        const vertices = () => new Buffer({ data: new Float32Array(this.quadCap * 8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        const g = new Geometry();
        g.addAttribute('aPosition', { buffer: vertices(), format: 'float32x2' });
        g.addAttribute('aSegA', { buffer: vertices(), format: 'float32x2' });
        g.addAttribute('aSegB', { buffer: vertices(), format: 'float32x2' });
        g.addIndex(new Buffer({ data: new Uint32Array(this.quadCap * 6), usage: BufferUsage.INDEX | BufferUsage.COPY_DST }));
        this.prepassGeom = g;
        this.upload(full);
        const p = SliderResources.programs();
        const shader = new Shader({
            glProgram: p.glPrepass,
            gpuProgram: p.gpuPrepass,
            resources: {
                prepassUniforms: new UniformGroup({ uRadius: { value: radius, type: 'f32' } }),
            },
        });
        this.prepassMesh = new Mesh({ geometry: g, shader });
        // MAX blending merges overlapping capsules into one coverage field.
        this.prepassMesh.blendMode = 'max';
        this.prepassRoot.addChild(this.prepassMesh);
    }

    /** Visible path range in [0, 1]; snaking in grows toT, snaking out moves fromT/toT. */
    setRange(fromT: number, toT: number): void {
        this.fromT = Math.max(0, Math.min(1, fromT));
        this.toT = Math.max(0, Math.min(1, toT));
    }

    /**
     * @param pixelsPerUnit device pixels per osu! pixel on screen (playfield
     *        scale × renderer resolution).
     */
    sync(pixelsPerUnit: number): void {
        if (this.destroyed) return;
        const visible = this.toT > this.fromT + 1e-6;
        if (this.composite) this.composite.visible = visible;
        if (!visible) return;
        const key = this.fromT <= 0 && this.toT >= 1 ? 'full' : `${this.fromT.toFixed(5)},${this.toT.toFixed(5)}`;
        if (key !== this.geoKey) {
            const pts = key === 'full' ? this.points : partialPoints(this.points, this.fromT, this.toT);
            const out = capsuleQuads(pts, this.radius);
            if (out.quads <= this.quadCap) {
                this.upload(out);
                this.geoKey = key;
                this.dirty = true;
            }
        }
        this.ensureTarget(pixelsPerUnit);
        if (this.dirty && this.rt) {
            this.res.renderer.render({ container: this.prepassRoot, target: this.rt, clear: true, clearColor: [0, 0, 0, 0] });
            this.dirty = false;
        }
    }

    private upload(q: CapsuleQuads): void {
        const g = this.prepassGeom;
        const pos = g.getBuffer('aPosition');
        const a = g.getBuffer('aSegA');
        const b = g.getBuffer('aSegB');
        (pos.data as Float32Array).set(q.pos);
        (a.data as Float32Array).set(q.segA);
        (b.data as Float32Array).set(q.segB);
        pos.update();
        a.update();
        b.update();
        const idx = g.indexBuffer.data as Uint32Array;
        idx.set(q.index);
        // Unused slots degenerate to zero-area triangles.
        idx.fill(0, q.index.length);
        g.indexBuffer.update();
    }

    private ensureTarget(pixelsPerUnit: number): void {
        const b = this.bounds;
        const s = pixelsPerUnit > 0 ? pixelsPerUnit : 1;
        const w = Math.min(MAX_RT_DIM, Math.max(1, Math.ceil((b.x1 - b.x0) * s)));
        const h = Math.min(MAX_RT_DIM, Math.max(1, Math.ceil((b.y1 - b.y0) * s)));
        if (this.rt && this.rtW === w && this.rtH === h) return;
        // Unbind the old target from its shader before destroying it.
        this.dropComposite();
        this.rt?.destroy(true);
        this.rt = RenderTexture.create({ width: w, height: h, resolution: 1, antialias: false });
        this.rtW = w;
        this.rtH = h;
        // Map bounds → texture pixels for the prepass.
        const sx = w / Math.max(1e-6, b.x1 - b.x0);
        const sy = h / Math.max(1e-6, b.y1 - b.y0);
        this.prepassRoot.scale.set(sx, sy);
        this.prepassRoot.position.set(-b.x0 * sx, -b.y0 * sy);
        this.buildComposite();
        this.dirty = true;
    }

    private buildComposite(): void {
        this.dropComposite();
        const b = this.bounds;
        const g = new Geometry();
        g.addAttribute('aPosition', { buffer: new Float32Array([b.x0, b.y0, b.x1, b.y0, b.x0, b.y1, b.x1, b.y1]), format: 'float32x2' });
        g.addAttribute('aUV', { buffer: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), format: 'float32x2' });
        // Texel centre of this slider's LUT row (linear filtering would
        // otherwise bleed half into the neighbouring combo colour). A vertex
        // attribute rather than a uniform: identical on WebGL and WebGPU.
        const row = (this.colorIndex + 0.5) / this.res.rows;
        g.addAttribute('aRow', { buffer: new Float32Array([row, row, row, row]), format: 'float32' });
        g.addIndex(new Uint32Array([0, 1, 2, 2, 1, 3]));
        const p = SliderResources.programs();
        const rt = this.rt!;
        const lut = this.res.lut;
        this.compositeShader = new Shader({
            glProgram: p.glComposite,
            gpuProgram: p.gpuComposite,
            resources: {
                uCoverage: rt.source,
                uCoverageSampler: rt.source.style,
                uLut: lut.source,
                uLutSampler: lut.source.style,
            },
        });
        this.compositeGeom = g;
        this.composite = new Mesh({ geometry: g, shader: this.compositeShader });
        this.addChild(this.composite);
    }

    private dropComposite(): void {
        if (this.composite) {
            this.removeChild(this.composite);
            this.composite.destroy();
        }
        this.compositeShader?.destroy();
        this.compositeGeom?.destroy();
        this.composite = null;
        this.compositeShader = null;
        this.compositeGeom = null;
    }

    override destroy(): void {
        this.dropComposite();
        this.prepassMesh.destroy();
        this.prepassRoot.destroy();
        this.prepassGeom.destroy();
        this.rt?.destroy(true);
        this.rt = null;
        super.destroy({ children: true });
    }
}
