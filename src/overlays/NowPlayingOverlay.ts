import { Container, FillGradient, Graphics, Rectangle, type BitmapText, type FederatedPointerEvent, type Text, type Texture } from 'pixi.js';
import type { Game } from '../app/Game';
import type { NowPlaying } from '../app/MusicController';
import { Overlay } from '../app/Overlay';
import { clamp, formatTime } from '../core/math';
import { tween } from '../core/Tweener';
import { textureFromBlob } from '../graphics/textures';
import { coverUrl } from '../online/providers';
import { IconButton } from '../ui/Button';
import { fillCover } from '../ui/coverFill';
import { onPointerDownOutside } from '../ui/outsideClick';
import { counterText, fitText, label } from '../ui/text';
import { Colors } from '../ui/theme';
import { UIComponent } from '../ui/UIComponent';

const WIDTH = 400;
const HEIGHT = 130;
const MARGIN = 10;
const RADIUS = 5;

let shade: FillGradient | null = null;
/** Bottom-weighted darkening so the controls stay readable on any cover. */
function shadeGradient(): FillGradient {
    shade ??= new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0.25)' },
            { offset: 1, color: 'rgba(0,0,0,0.75)' },
        ],
        textureSpace: 'local',
    });
    return shade;
}

/**
 * lazer's HoverableProgressBar: a thin bar along the panel's bottom that
 * thickens on hover; click or drag to seek (when the track allows it).
 */
class SeekBar extends UIComponent {
    private readonly g = new Graphics();
    private progress = 0;
    private thickness = 5;
    private readonly thicknessProxy = { t: 5 };
    private dragging = false;
    seekable = false;
    onSeek: ((fraction: number) => void) | null = null;

    constructor() {
        super();
        this.addChild(this.g);
        this.makeInteractive({ sounds: false });
        this.on('pointerdown', this.onDown, this);
        this.resize(WIDTH, 14);
    }

    set value(v: number) {
        if (this.dragging) return;
        v = clamp(Number.isFinite(v) ? v : 0, 0, 1);
        if (Math.abs(v - this.progress) * this._w < 0.25) return;
        this.progress = v;
        this.draw();
    }

    protected override onResize(): void {
        this.draw();
    }

    private draw(): void {
        const w = this._w, t = this.thickness, y = this._h - t;
        this.g.clear().rect(0, y, w, t).fill({ color: 0x000000, alpha: 0.5 });
        if (this.progress > 0) this.g.rect(0, y, w * this.progress, t).fill(Colors.yellow);
    }

    private fractionAt(e: FederatedPointerEvent): number {
        return clamp(this.toLocal(e.global).x / this._w, 0, 1);
    }

    private onDown(e: FederatedPointerEvent): void {
        if (!this.seekable || e.button > 0) return;
        this.dragging = true;
        this.progress = this.fractionAt(e);
        this.draw();
        const move = (ev: FederatedPointerEvent) => {
            this.progress = this.fractionAt(ev);
            this.draw();
        };
        const up = () => {
            this.off('globalpointermove', move);
            this.off('pointerup', up);
            this.off('pointerupoutside', up);
            this.dragging = false;
            this.onSeek?.(this.progress);
        };
        this.on('globalpointermove', move);
        this.on('pointerup', up);
        this.on('pointerupoutside', up);
    }

    protected override onHoverChange(hovered: boolean): void {
        this.cursor = this.seekable ? 'pointer' : 'default';
        const proxy = this.thicknessProxy;
        tween(proxy, { t: hovered ? 10 : 5 }, {
            owner: this,
            duration: 200,
            onUpdate: () => {
                this.thickness = proxy.t;
                this.draw();
            },
        });
    }
}

/**
 * osu!lazer's now playing overlay (music controller): a small player
 * under the toolbar's music button showing the current song over its
 * background, with previous / play-pause / next and a seekable progress
 * bar. Non-modal; F6 or the toolbar toggles it, Esc or a click elsewhere
 * closes it.
 */
export class NowPlayingOverlay extends Overlay {
    override readonly exclusive = false;
    protected override readonly modal = false;
    private readonly panel = new Container();
    private readonly shadow = new Graphics();
    private readonly bg = new Graphics();
    private readonly title: Text;
    private readonly artist: Text;
    private readonly prev: IconButton;
    private readonly play: IconButton;
    private readonly next: IconButton;
    private readonly elapsed: BitmapText;
    private readonly total: BitmapText;
    private readonly bar = new SeekBar();
    private texture: Texture | null = null;
    /** Decoded by us (library backgrounds) and so ours to destroy. */
    private ownsTexture = false;
    private bgKey: string | null = null;
    private bgSeq = 0;
    private shownPlaying: boolean | null = null;
    private lastElapsed = -1;
    private lastTotal = -1;
    private outsideOff: (() => void) | null = null;

    constructor(game: Game) {
        super(game);
        this.title = label('', { size: 24, weight: '600', italic: true, shadow: true });
        this.title.anchor.set(0.5, 1);
        this.artist = label('', { size: 14, weight: '700', italic: true, color: Colors.grayD, shadow: true });
        this.artist.anchor.set(0.5, 0);
        this.prev = new IconButton('prev', { size: 36, iconSize: 16, circle: true });
        this.play = new IconButton('play', { size: 46, iconSize: 22, circle: true });
        this.next = new IconButton('next', { size: 36, iconSize: 16, circle: true });
        this.prev.tooltip = 'previous track';
        this.next.tooltip = 'next track';
        this.elapsed = counterText('0:00', { size: 11 });
        this.total = counterText('0:00', { size: 11 });
        this.total.anchor.set(1, 0);
        this.panel.addChild(this.shadow, this.bg, this.title, this.artist, this.prev, this.play, this.next, this.elapsed, this.total, this.bar);
        this.panel.eventMode = 'static';
        this.panel.hitArea = new Rectangle(0, 0, WIDTH, HEIGHT);
        this.panel.pivot.set(WIDTH / 2, HEIGHT / 2);
        this.addChild(this.panel);
        this.layoutPanel();

        const music = game.music;
        this.prev.onActivate = () => void music.prev();
        this.next.onActivate = () => void music.next();
        this.play.onActivate = () => {
            if (music.current.value) music.togglePause();
            else void music.next();
        };
        this.bar.onSeek = f => {
            const d = music.duration;
            if (Number.isFinite(d) && d > 0) music.seek(f * d);
        };
        music.current.bind(n => this.onTrack(n), true);

        this.state.bind(open => {
            this.outsideOff?.();
            this.outsideOff = null;
            if (!open) return;
            this.loadBackground(music.current.value);
            this.outsideOff = onPointerDownOutside(
                game.app.canvas,
                () => [this.panel, game.toolbar.musicButton],
                () => this.hide(),
            );
        });
    }

    private onTrack(n: NowPlaying | null): void {
        fitText(this.title, WIDTH - 30, n ? n.title : 'nothing to play');
        fitText(this.artist, WIDTH - 30, n ? n.artist : 'import or download some beatmaps');
        this.lastTotal = this.lastElapsed = -1;
        if (this.isOpen) this.loadBackground(n);
    }

    private loadBackground(n: NowPlaying | null): void {
        const key = !n ? null : n.kind === 'library' ? `set:${n.set.key}` : `online:${n.sid}`;
        if (key === this.bgKey) return;
        this.bgKey = key;
        const seq = ++this.bgSeq;
        const load = async (): Promise<{ tex: Texture | null; owned: boolean }> => {
            if (!n) return { tex: null, owned: false };
            if (n.kind === 'online') return { tex: await this.game.covers.get(coverUrl(n.sid)), owned: false };
            const blob = await this.game.library.getBackground(n.set.key);
            if (blob) return { tex: await textureFromBlob(blob, 800), owned: true };
            const sid = n.set.onlineSetId;
            return { tex: sid ? await this.game.covers.get(coverUrl(sid)) : null, owned: false };
        };
        load().then(({ tex, owned }) => {
            if (seq !== this.bgSeq || this.destroyed) {
                if (owned) tex?.destroy(true);
                return;
            }
            this.setTexture(tex, owned);
        }).catch(() => {
            if (seq === this.bgSeq) this.setTexture(null, false);
        });
    }

    private setTexture(tex: Texture | null, owned: boolean): void {
        const old = this.texture;
        if (old && this.ownsTexture && old !== tex) old.destroy(true);
        this.texture = tex;
        this.ownsTexture = owned;
        this.drawBackground();
        this.bg.alpha = 0.4;
        tween(this.bg, { alpha: 1 }, { duration: 400 });
    }

    private drawBackground(): void {
        const g = this.bg.clear();
        g.roundRect(0, 0, WIDTH, HEIGHT, RADIUS).fill(0x26222c);
        if (this.texture) fillCover(g, this.texture, 0, 0, WIDTH, HEIGHT, RADIUS, { color: 0x999999 });
        g.roundRect(0, 0, WIDTH, HEIGHT, RADIUS).fill(shadeGradient());
    }

    private layoutPanel(): void {
        const s = this.shadow.clear();
        for (let i = 1; i <= 4; i++) s.roundRect(-i * 3, -i * 3 + 3, WIDTH + i * 6, HEIGHT + i * 6, RADIUS + i * 3).fill({ color: 0x000000, alpha: 0.06 });
        this.drawBackground();
        this.title.position.set(WIDTH / 2, 44);
        this.artist.position.set(WIDTH / 2, 48);
        const cy = 92;
        this.play.position.set(WIDTH / 2 - this.play.w / 2, cy - this.play.h / 2);
        this.prev.position.set(this.play.x - 6 - this.prev.w, cy - this.prev.h / 2);
        this.next.position.set(this.play.x + this.play.w + 6, cy - this.next.h / 2);
        this.elapsed.position.set(10, HEIGHT - 26);
        this.total.position.set(WIDTH - 10, HEIGHT - 26);
        this.bar.position.set(0, HEIGHT - this.bar.h);
    }

    override update(_dt: number): void {
        const music = this.game.music;
        const playing = music.isPlaying;
        if (playing !== this.shownPlaying) {
            this.shownPlaying = playing;
            this.play.setIcon(playing ? 'pause' : 'play');
            this.play.tooltip = playing ? 'pause' : 'play';
        }
        const library = this.game.music.current.value?.kind === 'library';
        const pos = music.position, dur = music.duration;
        const known = Number.isFinite(dur) && dur > 0;
        this.bar.seekable = library && !!music.currentTrack && known;
        this.bar.value = known ? pos / dur : 0;
        const e = Math.floor((known ? pos : 0) / 1000), t = known ? Math.floor(dur / 1000) : 0;
        if (e !== this.lastElapsed) {
            this.lastElapsed = e;
            this.elapsed.text = formatTime(e * 1000);
        }
        if (t !== this.lastTotal) {
            this.lastTotal = t;
            this.total.text = formatTime(t * 1000);
        }
    }

    protected popIn(): void {
        this.relayout();
        this.alpha = 0;
        this.panel.scale.set(0.9);
        tween(this, { alpha: 1 }, { duration: 400, ease: 'OutQuint' });
        tween(this.panel, { scale: 1 }, { duration: 800, ease: 'OutElastic' });
    }

    protected async popOut(): Promise<void> {
        tween(this.panel, { scale: 0.9 }, { duration: 400, ease: 'OutQuint' });
        await tween(this, { alpha: 0 }, { duration: 300, ease: 'OutQuint' }).finished;
    }

    protected layout(w: number, _h: number): void {
        const top = this.game.toolbarOffset;
        const x = Math.max(MARGIN, w - WIDTH - MARGIN);
        this.panel.position.set(x + WIDTH / 2, top + MARGIN + HEIGHT / 2);
    }
}
