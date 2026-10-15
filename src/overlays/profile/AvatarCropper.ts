import { Graphics, Matrix, Texture, type FederatedPointerEvent, type FederatedWheelEvent, type Text } from 'pixi.js';
import { BindableNumber } from '../../core/Bindable';
import { cropRect, CROP_ZOOM_MAX, CROP_ZOOM_MIN, panCrop, type CropRect } from '../../storage/profile';
import { Slider } from '../../ui/Slider';
import { label } from '../../ui/text';
import { Colors } from '../../ui/theme';
import { UIComponent } from '../../ui/UIComponent';

const PREVIEW_SIZES = [72, 40, 26];

/**
 * The profile picture crop editor: the picked image in a square frame
 * (drag to move it, wheel or the slider to zoom), with live previews at
 * the sizes the avatar is shown. `crop` is the chosen square in image
 * pixels.
 */
export class AvatarCropper extends UIComponent {
    readonly zoom = new BindableNumber(1, CROP_ZOOM_MIN, CROP_ZOOM_MAX, 0.01);
    private readonly texture: Texture;
    private readonly frame = new Graphics();
    private readonly outline = new Graphics();
    private readonly previews = PREVIEW_SIZES.map(() => new Graphics());
    private readonly hint: Text;
    private readonly slider: Slider;
    private centre: { x: number; y: number };
    private drag: { x: number; y: number } | null = null;

    constructor(private readonly image: ImageBitmap, private readonly frameSize = 260) {
        super();
        this.texture = Texture.from(image);
        this.centre = { x: image.width / 2, y: image.height / 2 };
        this.slider = new Slider('Zoom', this.zoom, { format: v => `${v.toFixed(2)}x` });
        this.hint = label('Drag to move the picture, scroll or use the slider to zoom.', { size: 12, weight: '500', color: Colors.grayA });
        this.frame.eventMode = 'static';
        this.frame.cursor = 'grab';
        this.frame.on('pointerdown', this.onDown, this);
        this.frame.on('wheel', this.onWheel, this);
        this.addChild(this.frame, this.outline, ...this.previews, this.slider, this.hint);
        this.eventMode = 'passive';
        this.disposer.add(this.zoom.bind(() => this.draw()));
        this.resize(frameSize + 24 + PREVIEW_SIZES[0], frameSize + 80);
    }

    /** The chosen square, in image pixels. */
    get crop(): CropRect {
        return cropRect(this.image.width, this.image.height, 1, this.zoom.value, this.centre.x, this.centre.y);
    }

    protected override onResize(w: number, _h: number): void {
        const f = this.frameSize;
        let y = 0;
        const px = f + 24;
        for (let i = 0; i < this.previews.length; i++) {
            this.previews[i].position.set(px, y);
            y += PREVIEW_SIZES[i] + 14;
        }
        this.slider.resize(w, 52);
        this.slider.position.set(0, f + 8);
        this.hint.position.set(0, f + 62);
        this.draw();
    }

    private fill(g: Graphics, size: number, radius: number): void {
        const c = this.crop;
        const s = size / c.w;
        g.clear().roundRect(0, 0, size, size, radius).fill({
            texture: this.texture,
            matrix: new Matrix(s, 0, 0, s, -c.x * s, -c.y * s),
            textureSpace: 'global',
        });
    }

    private draw(): void {
        if (this.texture.destroyed) return;
        const f = this.frameSize;
        this.fill(this.frame, f, 8);
        this.outline.clear().roundRect(0, 0, f, f, 8).stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
        this.previews.forEach((g, i) => this.fill(g, PREVIEW_SIZES[i], Math.round(PREVIEW_SIZES[i] * 0.2)));
    }

    private onDown(e: FederatedPointerEvent): void {
        if (e.button > 0) return;
        this.drag = { x: e.global.x, y: e.global.y };
        this.frame.cursor = 'grabbing';
        this.frame.on('globalpointermove', this.onMove, this);
        const up = () => {
            this.drag = null;
            this.frame.cursor = 'grab';
            this.frame.off('globalpointermove', this.onMove, this);
            this.frame.off('pointerup', up);
            this.frame.off('pointerupoutside', up);
        };
        this.frame.on('pointerup', up);
        this.frame.on('pointerupoutside', up);
    }

    private onMove(e: FederatedPointerEvent): void {
        if (!this.drag) return;
        // Global pixels to this frame's pixels (the UI may be scaled).
        const k = this.frame.worldTransform.a || 1;
        const dx = (e.global.x - this.drag.x) / k;
        const dy = (e.global.y - this.drag.y) / k;
        this.drag = { x: e.global.x, y: e.global.y };
        this.centre = panCrop(this.crop, this.frameSize, dx, dy, this.image.width, this.image.height);
        this.draw();
    }

    private onWheel(e: FederatedWheelEvent): void {
        this.zoom.value = this.zoom.value * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
        e.preventDefault();
    }

    override destroy(): void {
        super.destroy({ children: true });
        this.texture.destroy(true);
    }
}
