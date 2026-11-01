import { Container, Graphics, Sprite } from 'pixi.js';
import { comboNumber } from '../../gameplay/drawables/context';
import type { SkinTexture } from '../../skin/LegacySkin';
import { SkinChain } from '../../skin/SkinChain';
import type { SkinManager } from '../../skin/SkinManager';
import { STABLE_MAGIC_SCALE } from '../../app/cursor/CursorSkin';
import { Box } from '../../ui/Box';
import { UIComponent } from '../../ui/UIComponent';

/** Circle radius in the preview (px); osu! units scale so a circle is 128 of them. */
const R = 24;
const UNIT = (R * 2) / 128;
const HEIGHT = 150;

/**
 * A small still of wosu!'s skin as the options make it: a slider with
 * its ball, ticks and reverse arrow, two circles (one approaching), a 100
 * and a miss, and the cursor with its trail. Redrawn whenever the skin is.
 */
export class WosuSkinPreview extends UIComponent {
    private readonly bg = new Box({ color: 0x15151c, radius: 8, border: { width: 1, color: 0xffffff, alpha: 0.08 } });
    private readonly scene = new Container();

    constructor(private readonly skins: SkinManager) {
        super();
        this.addChild(this.bg, this.scene);
        this.scene.eventMode = 'none';
        this.disposer.add(skins.defaultChanged.add(() => this.draw()));
        if (!skins.loaded) void skins.ready.then(() => !this.destroyed && this.draw());
        this.resize(300, HEIGHT);
    }

    protected override onResize(w: number, h: number): void {
        this.bg.resize(w, h);
        this.draw();
    }

    private draw(): void {
        for (const c of this.scene.removeChildren()) c.destroy({ children: true });
        if (!this.skins.loaded || this._w <= 0) return;
        const skin = this.skins.default;
        const chain = new SkinChain([{ skin }]);
        const tex = (name: string): SkinTexture | null => skin.texture(name);
        const colours = skin.config.comboColours ?? [0xffffff];
        const colour = (i: number) => colours[i % colours.length];
        const extras = skin.extras?.slider;
        const sprite = (t: SkinTexture | null, x: number, y: number, scale = UNIT, tint = 0xffffff): Sprite | null => {
            if (!t) return null;
            const s = new Sprite(t.texture);
            s.anchor.set(0.5);
            s.position.set(x, y);
            s.scale.set(t.scale * scale);
            s.tint = tint;
            this.scene.addChild(s);
            return s;
        };
        const hitCircle = (x: number, y: number, n: number, c: number) => {
            sprite(tex('hitcircle'), x, y, UNIT, c);
            sprite(tex('hitcircleoverlay'), x, y);
            const num = comboNumber(chain, n, R);
            if (num) {
                num.position.set(x, y);
                this.scene.addChild(num);
            }
        };

        // Lay the scene out across the row's width.
        const w = this._w, cy = HEIGHT / 2;
        const k = Math.min(1.3, Math.max(0.8, w / 380));

        // The slider: border, then the track (wosu!'s body profile), ticks, ball, reverse arrow.
        const sx0 = 18 + R, sx1 = sx0 + 150 * k, sy = cy + 22;
        const border = extras?.comboBorder ? colour(0) : skin.config.sliderBorder ?? 0xffffff;
        const track = skin.config.sliderTrackOverride ?? colour(0);
        const shade = 1 - (extras?.shade ?? 0);
        const shaded = (((track >> 16) & 255) * shade) << 16 | (((track >> 8) & 255) * shade) << 8 | (track & 255) * shade;
        const inner = R * (1 - (extras?.borderWidth ?? 0.128));
        const body = new Graphics()
            .moveTo(sx0, sy).lineTo(sx1, sy).stroke({ width: R * 2, color: border, cap: 'round' })
            .moveTo(sx0, sy).lineTo(sx1, sy).stroke({ width: inner * 2, color: 0x15151c, cap: 'round' })
            .moveTo(sx0, sy).lineTo(sx1, sy).stroke({
                width: inner * 2, color: Math.round(shaded), cap: 'round',
                alpha: ((extras?.edgeOpacity ?? 0.8) + (extras?.centreOpacity ?? 0.3)) / 2,
            });
        this.scene.addChild(body);
        for (const f of [0.3, 0.48]) sprite(tex('sliderscorepoint'), sx0 + (sx1 - sx0) * f, sy);
        const arrow = sprite(tex('reversearrow'), sx1, sy);
        if (arrow) arrow.rotation = Math.PI;
        sprite(tex('sliderb'), sx0 + (sx1 - sx0) * 0.72, sy);
        hitCircle(sx0, sy, 1, colour(0));

        // Two circles: the second still approaching.
        const c2x = Math.max(sx1 + R * 2.2, w * 0.6), c2y = cy - 24;
        hitCircle(c2x, c2y, 2, colour(1));
        const c3x = c2x + R * 2.3, c3y = cy + 18;
        hitCircle(c3x, c3y, 3, colour(2));
        sprite(tex('approachcircle'), c3x, c3y, UNIT * 1.7, colour(2));

        // Judgements over the first circle's spot and beside the last.
        const j100 = tex('hit100');
        if (j100 && j100.texture.width > 2) sprite(j100, sx0 + R * 1.4, cy - 30);
        sprite(tex('hit0'), Math.min(w - 22, c3x + R * 2), cy - 34);

        // The cursor, its trail trailing in from the left.
        const cursorScale = (0.5 / STABLE_MAGIC_SCALE) * UNIT * 2;
        const cx = Math.min(w - 26, c3x + R * 2), ccy = cy + 44;
        const trail = tex('cursortrail');
        if (trail) {
            for (let i = 1; i <= 14; i++) {
                const t = sprite(trail, cx - i * 5, ccy + i * 0.8, cursorScale);
                if (t) {
                    t.alpha = Math.pow(1 - i / 15, 1.7);
                    t.blendMode = 'add';
                }
            }
        }
        sprite(tex('cursor'), cx, ccy, cursorScale);
        sprite(tex('cursormiddle'), cx, ccy, cursorScale);
    }
}
