import { Container, Graphics, Sprite, type Text } from 'pixi.js';
import { lerpColor, scaleColor } from '../../../core/math';
import type { LegacySkin, SkinTexture } from '../../../skin/LegacySkin';
import type { Grade } from '../../../storage/ScoreStore';
import { rankingGradeElements } from '../../results/rankingLayout';
import { SHEAR } from '../../../ui/ShearedButton';
import { label } from '../../../ui/text';
import { gradeColor, gradeLabel } from '../../../ui/theme';

export const RANK_BADGE_W = 38;
export const RANK_BADGE_H = 17;

/** An imported skin's small grade image (ranking-A-small…), or null. */
export function smallGradeTexture(skin: LegacySkin | null | undefined, grade: Grade): SkinTexture | null {
    if (!skin) return null;
    for (const name of rankingGradeElements(grade, true)) {
        const t = skin.frames(name)[0];
        if (t) return t;
    }
    return null;
}

/**
 * wosu!'s take on lazer's TopLocalRank: the best local grade as a small
 * sheared tag in the grade's colour (wosu!'s footer/wedge shear), with a
 * glossy top edge and a soft glow. Silver grades (Hidden / Flashlight)
 * get a brushed-metal sheen; SS ranks a little sparkle. An imported skin's
 * ranking-*-small image replaces it (osu!stable's song select).
 */
export class RankBadge extends Container {
    private readonly g = new Graphics();
    private readonly text: Text;
    private readonly image = new Sprite();
    private grade: Grade | null = null;
    private skin: LegacySkin | null = null;

    constructor() {
        super();
        this.text = label('', { size: 12, weight: '800', italic: true, color: 0xffffff });
        this.text.anchor.set(0.5);
        this.image.anchor.set(0.5);
        this.image.visible = false;
        this.addChild(this.g, this.text, this.image);
        this.eventMode = 'none';
        this.visible = false;
    }

    /** `skin`: the selected imported skin, whose small grade image is used when it has one. */
    setGrade(grade: Grade | null, skin: LegacySkin | null = null): void {
        if (grade === this.grade && skin === this.skin) return;
        this.grade = grade;
        this.skin = skin;
        this.visible = !!grade;
        if (!grade) return;
        const tex = smallGradeTexture(skin, grade);
        this.image.visible = !!tex;
        this.g.visible = this.text.visible = !tex;
        if (tex) {
            // Fitted to the badge's slot, a little taller (the images are 34×40).
            const k = Math.min((RANK_BADGE_H + 6) / tex.texture.height, RANK_BADGE_W / tex.texture.width);
            this.image.texture = tex.texture;
            this.image.scale.set(k);
            this.image.position.set(RANK_BADGE_W / 2, RANK_BADGE_H / 2);
        } else {
            this.draw(grade);
        }
    }

    private draw(grade: Grade): void {
        const w = RANK_BADGE_W, h = RANK_BADGE_H;
        const s = h * SHEAR;
        const silver = grade === 'XH' || grade === 'SH';
        const ss = grade === 'X' || grade === 'XH';
        const color = gradeColor(grade);
        const light = lerpColor(color, 0xffffff, 0.45);
        // Parallelogram leaning like the rest of wosu!'s sheared chrome.
        const shape = (x0: number, y0: number, x1: number, y1: number): number[] => {
            const k = (y1 - y0) * SHEAR;
            return [x0 + k, y0, x1, y0, x1 - k, y1, x0, y1];
        };
        const g = this.g.clear();
        g.poly(shape(-2, -2, w + 2, h + 2)).fill({ color, alpha: 0.22 });
        g.poly(shape(0, 0, w, h)).fill(color);
        // Glossy upper half.
        g.poly(shape(1 + s / 2, 1, w - 1, h * 0.48)).fill({ color: 0xffffff, alpha: silver ? 0.4 : 0.22 });
        if (silver) {
            // Brushed metal: two thin diagonal glints.
            for (const x of [w * 0.62, w * 0.74]) g.poly([x, 0, x + 3, 0, x + 3 - h * 0.45, h, x - h * 0.45, h]).fill({ color: 0xffffff, alpha: 0.35 });
        }
        g.poly(shape(0, 0, w, h)).stroke({ width: 1, color: light, alpha: 0.9 });
        if (ss) {
            // Four-point sparkle on the top-right corner.
            const cx = w - 1, cy = 0, r = 5, t = 1.3;
            g.poly([cx, cy - r, cx + t, cy - t, cx + r, cy, cx + t, cy + t, cx, cy + r, cx - t, cy + t, cx - r, cy, cx - t, cy - t]).fill(0xffffff);
        }
        this.text.text = gradeLabel(grade);
        this.text.tint = silver ? 0x34343f : scaleColor(color, 0.3);
        this.text.position.set(w / 2 + 0.5, h / 2 + 0.5);
    }
}
