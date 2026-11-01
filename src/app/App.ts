import { Application, Container, type Renderer } from 'pixi.js';
import { Signal } from '../core/Signal';
import { tweener } from '../core/Tweener';
import { frame, frameStats, scene } from '../core/frame';
import { FrameLoop } from './FrameLoop';

export type RendererPreference = 'auto' | 'webgl' | 'webgpu';
export type RendererKind = 'webgl' | 'webgpu';

export interface AppOptions {
    host: HTMLElement;
    preference: RendererPreference;
    /** Fraction of device pixel ratio to render at (1 = native). */
    resolutionScale: number;
    antialias: boolean;
    /** Ask for a desynchronized (low latency) WebGL canvas. */
    lowLatency: boolean;
}

/**
 * Owns the single Pixi Application and the fixed layer stack every part
 * of the game renders into. Layers are created once and never reordered,
 * so z-order is structural rather than managed per object.
 */
export class App {
    readonly pixi = new Application();
    readonly resized = new Signal<[width: number, height: number]>();
    /** Per-frame hook (dt in ms), run before rendering. */
    readonly frame = new Signal<[dt: number]>();

    readonly root = new Container({ label: 'root' });
    readonly backgroundLayer = new Container({ label: 'background' });
    readonly screenLayer = new Container({ label: 'screens' });
    readonly overlayLayer = new Container({ label: 'overlays' });
    readonly toolbarLayer = new Container({ label: 'toolbar' });
    readonly popupLayer = new Container({ label: 'popups' });
    readonly toastLayer = new Container({ label: 'toasts' });
    readonly tooltipLayer = new Container({ label: 'tooltips' });
    readonly cursorLayer = new Container({ label: 'cursor' });
    readonly debugLayer = new Container({ label: 'debug' });

    rendererKind: RendererKind = 'webgl';
    /** Logical size in UI units (CSS px / uiScale). */
    width = 0;
    height = 0;
    uiScale = 1;
    private userUiScale = 1;
    private resolutionScale = 1;
    private resizeQueued = false;
    /** Set when WebGPU was requested but we had to fall back. */
    fellBackFrom: RendererKind | null = null;
    /** The renderer setting this session started with. */
    bootPreference: RendererPreference = 'auto';
    /** The low latency setting this session started with. */
    bootLowLatency = false;
    /** Antialiasing the renderer was created with (changing it needs a restart). */
    bootAntialias = true;
    /** The canvas is desynchronized: frames reach the screen without waiting for the compositor. */
    lowLatency = false;
    /** Low latency was asked for, but this browser / OS can't desynchronize a WebGL canvas. */
    lowLatencyUnsupported = false;
    /** Runs update and draw (requestAnimationFrame, or faster for the frame limiter). */
    loop!: FrameLoop;

    get renderer(): Renderer {
        return this.pixi.renderer;
    }

    get canvas(): HTMLCanvasElement {
        return this.pixi.canvas;
    }

    async init(opts: AppOptions): Promise<void> {
        this.resolutionScale = opts.resolutionScale;
        // "auto" prefers WebGPU where the browser has it: on some systems (notably
        // Windows, where WebGL is translated to Direct3D) WebGL blocks the main thread
        // enough to delay input and hitsounds. It falls back to WebGL quietly.
        this.bootPreference = opts.preference;
        this.bootAntialias = opts.antialias;
        this.bootLowLatency = opts.lowLatency;
        // Low latency needs WebGL: WebGPU canvases have no desynchronized mode.
        const desync = opts.lowLatency ? createLowLatencyContext(opts.antialias) : null;
        this.lowLatencyUnsupported = opts.lowLatency && !desync;
        const order: RendererKind[] = desync || opts.preference === 'webgl' ? ['webgl'] : ['webgpu', 'webgl'];
        const explicit = opts.preference === 'webgpu';
        let lastError: unknown = null;
        for (const kind of order) {
            if (kind === 'webgpu' && !(await webGpuAvailable())) {
                if (explicit) this.fellBackFrom = 'webgpu';
                continue;
            }
            try {
                await this.pixi.init({
                    preference: kind,
                    width: window.innerWidth,
                    height: window.innerHeight,
                    resolution: this.targetResolution(),
                    autoDensity: true,
                    antialias: opts.antialias,
                    backgroundColor: 0x000000,
                    powerPreference: 'high-performance',
                    hello: false,
                    preserveDrawingBuffer: false,
                    // Pixi's own resize plugin is bypassed; we resize in
                    // `applyResize` so UI scaling and DPR changes stay in sync.
                    // Its ticker is too: the FrameLoop drives update and render.
                    autoStart: false,
                    ...(desync && kind === 'webgl' ? { canvas: desync.canvas, context: desync.context } : {}),
                });
                this.lowLatency = !!desync && this.pixi.renderer.name === 'webgl';
                this.rendererKind = this.pixi.renderer.name === 'webgpu' ? 'webgpu' : 'webgl';
                if (explicit && kind === 'webgpu' && this.rendererKind !== 'webgpu') this.fellBackFrom = 'webgpu';
                lastError = null;
                break;
            } catch (e) {
                console.error(`${kind} renderer failed to initialise`, e);
                lastError = e;
                if (explicit && kind === 'webgpu') this.fellBackFrom = 'webgpu';
            }
        }
        if (lastError || !this.pixi.renderer) throw lastError ?? new Error('No renderer available');

        const canvas = this.pixi.canvas;
        canvas.tabIndex = 0;
        canvas.setAttribute('aria-label', 'wosu! game');
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        opts.host.appendChild(canvas);

        scene.stage = this.pixi.stage;
        this.pixi.stage.addChild(this.root);
        this.root.addChild(
            this.backgroundLayer,
            this.screenLayer,
            this.overlayLayer,
            this.toolbarLayer,
            this.popupLayer,
            this.toastLayer,
            this.tooltipLayer,
            this.cursorLayer,
            this.debugLayer,
        );
        // Whole-layer render groups: their transforms are applied on the GPU,
        // so moving/fading a layer doesn't re-walk its subtree on the CPU.
        this.backgroundLayer.isRenderGroup = true;
        this.screenLayer.isRenderGroup = true;
        this.overlayLayer.isRenderGroup = true;

        this.pixi.ticker.stop();
        this.loop = new FrameLoop({ update: dt => this.tick(dt), draw: () => this.draw(), ready: () => this.gpuCaughtUp() });
        this.loop.setLowLatency(this.lowLatency);
        this.loop.start();

        const queue = () => this.queueResize();
        window.addEventListener('resize', queue);
        window.visualViewport?.addEventListener('resize', queue);
        // DPR changes (moving between monitors, browser zoom).
        this.watchDevicePixelRatio();
        this.applyResize();
    }

    setUiScale(scale: number): void {
        this.userUiScale = scale;
        this.queueResize();
    }

    setResolutionScale(scale: number): void {
        this.resolutionScale = scale;
        this.queueResize();
    }

    /** Settings.frameLimit (VSync, a multiple of the refresh rate, unlimited or a fixed rate). */
    setFrameLimit(limit: number): void {
        this.loop.setLimit(limit);
    }

    private targetResolution(): number {
        const dpr = window.devicePixelRatio || 1;
        return Math.max(0.5, Math.min(3, dpr * this.resolutionScale));
    }

    private queueResize(): void {
        if (this.resizeQueued) return;
        this.resizeQueued = true;
        requestAnimationFrame(() => {
            this.resizeQueued = false;
            this.applyResize();
        });
    }

    private applyResize(): void {
        const vw = Math.max(1, Math.round(window.visualViewport?.width ?? window.innerWidth));
        const vh = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight));
        const res = this.targetResolution();
        if (this.renderer.resolution !== res) this.renderer.resolution = res;
        this.renderer.resize(vw, vh, res);
        // Small screens (phones) get a smaller UI automatically so osu!'s
        // desktop layout still fits; the user's UI scale multiplies on top.
        const auto = Math.min(1, Math.max(0.6, Math.min(vw / 1100, vh / 640)));
        this.uiScale = auto * this.userUiScale;
        this.root.scale.set(this.uiScale);
        this.width = vw / this.uiScale;
        this.height = vh / this.uiScale;
        this.resized.emit(this.width, this.height);
    }

    private watchDevicePixelRatio(): void {
        const listen = () => {
            const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            mq.addEventListener('change', () => {
                this.queueResize();
                listen();
            }, { once: true });
        };
        try {
            listen();
        } catch {
            /* matchMedia resolution queries unsupported */
        }
    }

    private draw(): void {
        this.pixi.render();
        this.trackGpuWork();
    }

    // Above the refresh rate the loop draws as fast as it's allowed, and nothing in the browser
    // stops it queueing frames faster than the GPU finishes them (latency would pile up), so it
    // only draws once the GPU has caught up with the last frame.
    private gpuFence: WebGLSync | null = null;
    private gpuFrames = 0;

    private trackGpuWork(): void {
        if (this.loop.currentPlan.driver !== 'timer') return;
        const r = this.renderer as Renderer & { gl?: WebGL2RenderingContext; gpu?: { device: { queue: { onSubmittedWorkDone(): Promise<void> } } } };
        if (r.gpu) {
            this.gpuFrames++;
            r.gpu.device.queue.onSubmittedWorkDone().then(() => this.gpuFrames--, () => this.gpuFrames--);
        } else if (r.gl && typeof r.gl.fenceSync === 'function') {
            if (this.gpuFence) r.gl.deleteSync(this.gpuFence);
            this.gpuFence = r.gl.fenceSync(r.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            r.gl.flush();
        }
    }

    private gpuCaughtUp(): boolean {
        if (this.gpuFrames >= 1) return false;
        const gl = (this.renderer as Renderer & { gl?: WebGL2RenderingContext }).gl;
        if (!this.gpuFence || !gl) return true;
        if (gl.getSyncParameter(this.gpuFence, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
        gl.deleteSync(this.gpuFence);
        this.gpuFence = null;
        return true;
    }

    private tick(dt: number): void {
        // Clamp huge gaps (tab switch, breakpoint) so animations don't jump.
        const step = Math.min(dt, 100);
        frameStats.count++;
        frameStats.time += step;
        tweener.update(step);
        this.frame.emit(step);
        frame.emit(step);
    }

    /** Convert client (CSS px) coordinates to logical UI coordinates. */
    toLogical(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.pixi.canvas.getBoundingClientRect();
        return { x: (clientX - rect.left) / this.uiScale, y: (clientY - rect.top) / this.uiScale };
    }
}

/**
 * A WebGL2 context with the `desynchronized` hint, or null where the
 * browser ignores it. Chrome / Edge honour it on Windows, ChromeOS and
 * Android: the canvas then skips the compositor and frames show as soon
 * as they're drawn (front-buffer or overlay presentation, which can tear).
 */
function createLowLatencyContext(antialias: boolean): { canvas: HTMLCanvasElement; context: WebGL2RenderingContext } | null {
    try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2', {
            // What Pixi would ask for itself (opaque background, stencil for masks).
            alpha: false,
            premultipliedAlpha: true,
            antialias,
            stencil: true,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
            desynchronized: true,
        });
        if (!context) return null;
        if (!context.getContextAttributes()?.desynchronized) {
            context.getExtension('WEBGL_lose_context')?.loseContext();
            return null;
        }
        return { canvas, context };
    } catch {
        return null;
    }
}

async function webGpuAvailable(): Promise<boolean> {
    try {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
        if (!gpu) return false;
        const adapter = await gpu.requestAdapter();
        return !!adapter;
    } catch {
        return false;
    }
}
