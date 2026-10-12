import { Container, Graphics, Rectangle } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import type { LibrarySet } from '../../beatmap/Library';
import type { DifficultySummary } from '../../beatmap/types';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { IconButton } from '../../ui/Button';
import { fitText, label } from '../../ui/text';
import { Colors, starColor } from '../../ui/theme';
import { coverFill, formatBpm, formatLength, formatStars, relativeDate, setThumbnail, shadeGradient } from './visuals';

const WIDTH = 460;
const COVER_H = 120;
const ROW_H = 22;

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Beatmap info for sets without an online page (lazer's context menu
 * "Details" opens the beatmap set overlay, which needs an online id):
 * cover, metadata and the difficulty's (or every difficulty's) stats.
 */
export class BeatmapDetailsDialog extends Overlay {
    override readonly exclusive = false;
    private readonly card = new Container();
    private content = new Container();
    private cardH = 0;
    private token = 0;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.5;
        this.card.eventMode = 'static';
        this.addChild(this.card);
    }

    open(set: LibrarySet, diff: DifficultySummary | null): void {
        this.build(set, diff);
        this.show();
    }

    private build(set: LibrarySet, diff: DifficultySummary | null): void {
        this.content.destroy({ children: true });
        this.content = new Container();
        this.card.addChild(this.content);
        const c = this.content;
        const bg = new Graphics();
        const cover = new Graphics();
        c.addChild(bg, cover);
        const pad = 20;
        const inner = WIDTH - pad * 2;
        const drawCover = (fill: ReturnType<typeof coverFill> | number) => {
            cover.clear().roundRect(0, 0, WIDTH, COVER_H, 10).fill(fill);
            cover.roundRect(0, 0, WIDTH, COVER_H, 10).fill(shadeGradient(0.15, 0.85, true));
        };
        drawCover(0x2a2a36);
        const token = ++this.token;
        void setThumbnail(this.game, set).then(tex => {
            if (tex && token === this.token && !cover.destroyed) drawCover(coverFill(tex, 0, 0, WIDTH, COVER_H));
        });
        const title = label('', { size: 22, weight: '700', shadow: true });
        const artist = label('', { size: 15, weight: '600', shadow: true });
        fitText(title, inner, set.title);
        fitText(artist, inner, set.artist);
        title.position.set(pad, COVER_H - 56);
        artist.position.set(pad, COVER_H - 28);
        const close = new IconButton('close', { size: 30, circle: true });
        close.position.set(WIDTH - 38, 8);
        close.onActivate = () => this.hide();
        c.addChild(title, artist, close);

        let y = COVER_H + 14;
        const row = (key: string, value: string, color = 0xffffff) => {
            if (!value) return;
            const k = label(key, { size: 13, weight: '600', color: Colors.grayA });
            const v = label('', { size: 13, weight: '600', color });
            fitText(v, inner - 110, value);
            k.position.set(pad, y);
            v.position.set(pad + 110, y);
            c.addChild(k, v);
            y += ROW_H;
        };
        row('Mapped by', set.creator);
        row('Source', set.source);
        if (set.tags) row('Tags', set.tags);
        row('Added', new Date(set.addedAt).toLocaleDateString());
        if (set.lastPlayedAt) {
            const r = relativeDate(set.lastPlayedAt);
            row('Last played', r === 'now' ? 'just now' : `${r} ago`);
        }
        row('Size', formatSize(set.sizeBytes));
        if (set.hidden?.length) row('Deleted', `${set.hidden.length} difficult${set.hidden.length === 1 ? 'y' : 'ies'} (restorable)`, Colors.grayB);
        y += 6;
        const sep = new Graphics().rect(pad, y, inner, 1).fill({ color: 0xffffff, alpha: 0.12 });
        c.addChild(sep);
        y += 12;
        const diffs = diff ? [diff] : set.difficulties;
        for (const d of diffs) {
            const color = starColor(d.stars);
            const dot = new Graphics().circle(pad + 6, y + 9, 6).fill(color);
            const name = label('', { size: 14, weight: '700' });
            fitText(name, inner - 24, `${d.version}  ★ ${formatStars(d.stars)}`);
            name.position.set(pad + 20, y);
            const stats = label(
                `${formatLength(d.length)} · ${formatBpm(d.bpmMin, d.bpmMax, d.bpm)} BPM · CS ${d.cs} AR ${d.ar} OD ${d.od} HP ${d.hp} · ${d.circles + d.sliders + d.spinners} objects`,
                { size: 12, weight: '500', color: Colors.grayC },
            );
            fitText(stats, inner - 20, stats.text);
            stats.position.set(pad + 20, y + 20);
            c.addChild(dot, name, stats);
            y += 44;
            if (y > 520) break;
        }
        this.cardH = y + 10;
        bg.roundRect(0, 0, WIDTH, this.cardH, 10).fill(0x1e1c24);
        this.card.hitArea = new Rectangle(0, 0, WIDTH, this.cardH);
        this.card.pivot.set(WIDTH / 2, this.cardH / 2);
    }

    private baseScale = 1;

    protected layout(w: number, h: number): void {
        this.card.position.set(w / 2, h / 2);
        // Phones: shrink the card to fit.
        this.baseScale = Math.max(0.5, Math.min(1, (w - 24) / WIDTH, (h - 24) / Math.max(1, this.cardH)));
        this.card.scale.set(this.baseScale);
    }

    protected popIn(): void {
        this.relayout();
        const s = this.baseScale;
        this.card.alpha = 0;
        this.card.scale.set(s * 0.92);
        tween(this.card, { alpha: 1, scale: s }, { duration: 400, ease: 'OutQuint' });
    }

    protected async popOut(): Promise<void> {
        await tween(this.card, { alpha: 0, scale: this.baseScale * 0.96 }, { duration: 200, ease: 'OutQuint' }).finished;
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (super.onKey(e, action)) return true;
        return true;
    }
}
