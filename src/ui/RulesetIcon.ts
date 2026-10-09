import type { Graphics } from 'pixi.js';

/**
 * osu!standard's ruleset glyph (lazer's OsuIcon.RulesetOsu): a ring
 * around a solid dot, centred on (x, y) with diameter `size`.
 */
export function drawRulesetIcon(g: Graphics, x: number, y: number, size: number, color = 0xffffff, alpha = 1): Graphics {
    const r = size / 2;
    const stroke = Math.max(1, r * 0.24);
    g.circle(x, y, r - stroke / 2).stroke({ width: stroke, color, alpha });
    g.circle(x, y, r * 0.4).fill({ color, alpha });
    return g;
}
