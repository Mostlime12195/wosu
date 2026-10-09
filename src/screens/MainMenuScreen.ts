import { Container, Graphics, Sprite, Texture, type Text } from 'pixi.js';
import { Screen } from '../app/Screen';
import type { NowPlaying } from '../app/MusicController';
import { tween, delay } from '../core/Tweener';
import type { Action } from '../input/bindings';
import { label, fitText } from '../ui/text';
import { Colors } from '../ui/theme';
import { MenuButton, MENU_BUTTON_HEIGHT, MENU_WEDGE, type MenuButtonState } from './menu/MenuButton';
import { OsuLogo } from './menu/OsuLogo';

type MenuState = 'initial' | 'top' | 'play' | 'exit';

const IDLE_RETURN_MS = 12000;

/** Ordering for lazer's visible-state ranges (ButtonSystemState). */
const STATE_ORDER: Record<MenuState, number> = { exit: 0, initial: 1, top: 2, play: 3 };

/** lazer's logo sprite is 512 units; the disc is 0.94 of it (SCALE_ADJUST). */
const LOGO_SPRITE = 512;
const LOGO_DISC = LOGO_SPRITE * 0.94;
/** Logo scale in the button states (lazer ScaleTo(0.5)). */
const LOGO_TOP_SCALE = 0.5;
/** The flow's logo facade is drawn at 0.74 of the logo's size. */
const FACADE_SCALE = 0.74;

interface FlowButton {
    button: MenuButton;
    min: MenuState;
    max: MenuState;
}

/**
 * osu!lazer's main menu (ButtonSystem): the big logo alone at first;
 * clicking it shrinks the logo into the button bar, and the sheared
 * buttons grow out from under it (top level → Play submenu).
 *
 * Layout is one horizontal flow around the logo, like lazer's
 * FlowContainerWithOrigin centred on the logo facade: every frame the
 * buttons are placed from their current animated widths (spacing
 * −WEDGE so neighbours tuck under each other) outwards from the logo's
 * current size and position. Hovering a button pushes everything beyond
 * it; hovering or pressing the logo pushes both sides away. Since all
 * positions come from the same animated values in one pass, elastic
 * overshoot can never open a gap.
 *
 * Everything in the button system is in lazer's 1024×768 units, scaled by
 * `menuScale` (lazer's DrawSizePreservingFillContainer).
 */
export class MainMenuScreen extends Screen {
    private logo!: OsuLogo;
    /** lazer ButtonArea: band background + buttons, faded together. */
    private readonly area = new Container();
    private readonly band = new Graphics();
    private readonly buttonLayer = new Container();
    private topButtons: MenuButton[] = [];
    private playButtons: MenuButton[] = [];
    private settingsButton!: MenuButton;
    private backButton!: MenuButton;
    /** Flow order left of the logo (left → right). */
    private leftFlow: FlowButton[] = [];
    /** Flow order right of the logo (left → right). */
    private rightFlow: FlowButton[] = [];
    private state: MenuState = 'initial';
    private menuScale = 1;
    private leftFlash!: Sprite;
    private rightFlash!: Sprite;
    private tickerTitle!: Text;
    private tickerArtist!: Text;
    private readonly ticker = new Container();
    private versionText!: Text;
    private idle = 0;
    private lastBeat = -1;
    private sinceBeatFlash = 0;

    override load(): void {
        const g = this.game;
        this.logo = new OsuLogo(
            { triangle: g.skin.tex('triangle'), glow: g.skin.tex('glow'), white: Texture.WHITE },
            {
                beat: () => g.music.beat(),
                levels: () => g.audio.getLevels(),
                fft: out => g.audio.getFrequencyData(out),
                fftDb: out => g.audio.analyser.getFloatFrequencyData(out),
                sampleRate: g.audio.context.sampleRate,
            },
        );
        this.logo.onClickLogo = () => this.onLogo();

        const solo = new MenuButton('solo', 'user', 0x6644cc, ['KeyS', 'KeyP'], { left: MENU_WEDGE });
        solo.onActivate = () => this.game.openSongSelect();
        const imp = new MenuButton('import', 'fileImport', 0xee9900, ['KeyI']);
        imp.onActivate = () => this.game.pickFiles();
        this.playButtons = [solo, imp];

        const play = new MenuButton('play', 'play', 0x6644cc, ['KeyP'], { left: MENU_WEDGE });
        play.onActivate = () => this.setState('play');
        const browse = new MenuButton('browse', 'download', 0xa5cc00, ['KeyB', 'KeyD']);
        browse.onActivate = () => this.game.listing.show();
        const exit = new MenuButton('exit', 'signOut', 0xee3399, ['KeyQ', 'KeyX']);
        exit.onActivate = () => this.doExit();
        this.topButtons = [play, browse, exit];

        this.settingsButton = new MenuButton('settings', 'gear', 0x555555, ['KeyO'], { right: MENU_WEDGE });
        this.settingsButton.onActivate = () => this.game.settingsOverlay.toggle();
        this.backButton = new MenuButton('back', 'chevronLeft', 0x333a5e, [], { right: MENU_WEDGE });
        this.backButton.onActivate = () => this.setState('top');

        // lazer's flow order: settings, back, [logo], play-submenu, top level.
        this.leftFlow = [
            { button: this.settingsButton, min: 'top', max: 'top' },
            { button: this.backButton, min: 'play', max: 'play' },
        ];
        this.rightFlow = [
            ...this.playButtons.map(button => ({ button, min: 'play' as const, max: 'play' as const })),
            ...this.topButtons.map(button => ({ button, min: 'top' as const, max: 'top' as const })),
        ];
        for (const { button } of [...this.leftFlow, ...this.rightFlow]) {
            button.beatSource = () => g.music.beat();
            this.buttonLayer.addChild(button);
        }
        this.area.alpha = 0;
        this.band.scale.y = 0;
        this.area.addChild(this.band, this.buttonLayer);

        const flashTex = g.skin.tex('fadeRight');
        this.leftFlash = new Sprite(flashTex);
        this.rightFlash = new Sprite(flashTex);
        this.rightFlash.scale.x = -1;
        for (const f of [this.leftFlash, this.rightFlash]) {
            f.alpha = 0;
            f.blendMode = 'add';
        }

        this.tickerTitle = label('', { size: 22, weight: '700', italic: true, shadow: true });
        this.tickerArtist = label('', { size: 15, weight: '600', italic: true, color: Colors.grayD, shadow: true });
        this.tickerTitle.anchor.set(1, 0);
        this.tickerArtist.anchor.set(1, 0);
        this.ticker.addChild(this.tickerTitle, this.tickerArtist);
        this.ticker.alpha = 0;

        this.versionText = label(`wosu! · ${__BUILD_INFO__}`, { size: 12, weight: '600', color: 0xffffff });
        this.versionText.alpha = 0.4;
        this.versionText.anchor.set(1, 1);

        // The logo renders above the button area, so the buttons come out from under it.
        this.addChild(this.leftFlash, this.rightFlash, this.area, this.logo, this.ticker, this.versionText);
        this.eventMode = 'passive';

        this.disposer.add(g.music.current.bind(n => this.onTrack(n), true));
        this.disposer.add(g.input.pointerMoved.add(() => (this.idle = 0)));
    }

    // ------------------------------------------------------------------

    private onTrack(n: NowPlaying | null): void {
        if (!this.isCurrent && this.stack) return;
        if (!n) return;
        // Online covers are small (900×250), so blur them like osu! does.
        if (n.kind === 'library') {
            void this.game.setBackgroundForSet(n.set);
            this.game.background.setBlur(0, 800);
        } else {
            void this.game.setBackgroundForOnline(n.sid);
            this.game.background.setBlur(0.35, 800);
        }
        this.tickerTitle.text = n.title;
        this.tickerArtist.text = n.artist;
        fitText(this.tickerTitle, this._w * 0.5, n.title);
        fitText(this.tickerArtist, this._w * 0.5, n.artist);
        this.ticker.alpha = 0;
        this.ticker.x = this._w - 10 + 30;
        tween(this.ticker, { alpha: 1, x: this._w - 10 }, { duration: 1000, ease: 'OutQuint' });
        tween(this.ticker, { alpha: 0 }, { duration: 1000, delay: 5000 });
    }

    private onLogo(): void {
        this.idle = 0;
        if (this.state === 'initial') this.setState('top');
        else if (this.state === 'top') this.setState('play');
        else if (this.state === 'play') this.game.openSongSelect();
    }

    private setState(s: MenuState): void {
        if (s === this.state) return;
        const prev = this.state;
        this.state = s;
        this.idle = 0;
        const buttonsOn = s === 'top' || s === 'play';
        // lazer delays the button area by 150ms when leaving the lone logo,
        // so the logo has started shrinking into place first.
        const delay = prev === 'initial' ? 150 : 0;
        for (const f of [...this.leftFlow, ...this.rightFlow]) f.button.setState(this.buttonStateFor(f, s), { delay });
        tween(this.area, { alpha: buttonsOn ? 1 : 0 }, { duration: 300, ease: 'None', delay });
        if (buttonsOn) tween(this.band, { scaleY: 1 }, { duration: 400, ease: 'OutQuint', delay });
        else tween(this.band, { scaleY: 0 }, { duration: 300, ease: 'InSine' });
        this.moveLogo(prev, true);
    }

    /** lazer MainMenuButton.UpdateState. */
    private buttonStateFor(f: FlowButton, s: MenuState): MenuButtonState {
        if (s === 'initial' || s === 'exit') return 'contracted';
        const v = STATE_ORDER[s];
        if (v >= STATE_ORDER[f.min] && v <= STATE_ORDER[f.max]) return 'expanded';
        return v < STATE_ORDER[f.min] ? 'contracted' : 'exploded';
    }

    private get bigLogoDiameter(): number {
        return Math.min(LOGO_DISC * this.menuScale, this._w * 0.5);
    }

    /**
     * Logo centre x in the button states. lazer offsets the flow by a
     * constant tuned for its four buttons; with ours, centre the top-level
     * group (settings | logo | play browse exit) instead.
     */
    private get logoButtonsX(): number {
        const facadeHalf = (LOGO_SPRITE * LOGO_TOP_SCALE * FACADE_SCALE) / 2;
        const left = facadeHalf - MENU_WEDGE + this.settingsButton.baseWidth;
        let right = facadeHalf - MENU_WEDGE;
        for (const b of this.topButtons) right += b.baseWidth - MENU_WEDGE;
        right += MENU_WEDGE;
        return this._w / 2 - ((right - left) / 2) * this.menuScale;
    }

    /** lazer ButtonSystem.updateLogoState. */
    private moveLogo(prev: MenuState, animate: boolean): void {
        const cy = this._h / 2;
        const centred = this.state === 'initial' || this.state === 'exit';
        const x = centred ? this._w / 2 : this.logoButtonsX;
        const scale = centred ? 1 : LOGO_TOP_SCALE;
        if (!animate) {
            tween(this.logo, { x, y: cy, scale }, { duration: 0 });
            return;
        }
        if (centred) {
            delay(this.area.alpha * 150, () => {
                if (this.state !== 'initial' && this.state !== 'exit') return;
                // Exiting runs its own shrink-and-fade on the scale.
                const to: Record<string, number> = { x: this._w / 2, y: this._h / 2 };
                if (this.state !== 'exit') to.scale = 1;
                tween(this.logo, to, { duration: 800, ease: 'OutExpo' });
            }, this.logo);
        } else if (prev === 'initial') {
            const impact = this.logo.scale.x > 0.6;
            tween(this.logo, { x, y: cy, scale }, { duration: 200, ease: 'In' });
            delay(200, () => {
                if (impact && (this.state === 'top' || this.state === 'play')) this.logo.impact(2);
            }, this.logo);
        } else {
            tween(this.logo, { x, y: cy }, { duration: 0 });
            tween(this.logo, { scale }, { duration: 200, ease: 'OutQuint' });
        }
    }

    protected override onResize(): void {
        this.layout();
    }

    /** Size-dependent layout (on resize). Button positions are per-frame, see layoutFlow. */
    private layout(): void {
        if (!this.logo) return;
        const w = this._w, h = this._h;
        // lazer's DrawSizePreservingFillContainer: 1024×768 target, minimum strategy.
        this.menuScale = Math.min(w / 1024, h / 768);
        this.logo.setDiameter(this.bigLogoDiameter);
        this.moveLogo(this.state, false);
        this.buttonLayer.scale.set(this.menuScale);
        const bandH = MENU_BUTTON_HEIGHT * this.menuScale;
        this.band.clear().rect(-20, -bandH / 2, w + 40, bandH).fill(0x323232);
        this.band.position.set(0, h / 2);
        const flashW = Math.min(300, w * 0.2);
        this.leftFlash.position.set(0, 0);
        this.leftFlash.width = flashW;
        this.leftFlash.height = h;
        this.rightFlash.position.set(w, 0);
        this.rightFlash.width = -flashW;
        this.rightFlash.height = h;
        this.ticker.position.set(w - 10, this.game.toolbarOffset + 10);
        this.tickerArtist.position.set(0, 28);
        this.versionText.position.set(w - 10, h - 8);
        this.layoutFlow();
    }

    /**
     * lazer's flow, recomputed from the current animated values: the logo
     * facade (0.74 × logo size, including its hover/press bounce) sits at
     * the logo's centre, buttons follow it at −WEDGE spacing on each side.
     */
    private layoutFlow(): void {
        const k = this.menuScale;
        this.buttonLayer.position.set(this.logo.x, this.logo.y);
        const logoSize = (this.logo.diameter / 0.94) * this.logo.scale.x / k;
        const facadeHalf = (logoSize * FACADE_SCALE * this.logo.flowScale) / 2;
        const top = -MENU_BUTTON_HEIGHT / 2;
        let x = facadeHalf - MENU_WEDGE;
        for (const { button } of this.rightFlow) {
            button.sync();
            if (!button.present) continue;
            button.position.set(x, top);
            x += button.slotWidth - MENU_WEDGE;
        }
        x = -facadeHalf + MENU_WEDGE;
        for (let i = this.leftFlow.length - 1; i >= 0; i--) {
            const button = this.leftFlow[i].button;
            button.sync();
            if (!button.present) continue;
            x -= button.slotWidth;
            button.position.set(x, top);
            x += MENU_WEDGE;
        }
    }

    // ------------------------------------------------------------------

    override onEntering(): void {
        this.game.background.setDim(0.15, 1000);
        this.alpha = 0;
        this.fadeIn(600);
        this.layout();
        this.logo.scale.set(0.85);
        tween(this.logo, { scale: 1 }, { duration: 1500, ease: 'OutElastic' });
        this.game.music.loopFromPreview = false;
        if (!this.game.music.current.value) {
            if (this.game.settings.menuMusic.value) void this.game.music.playRandom();
        }
        else this.onTrack(this.game.music.current.value);
        if (this.game.pendingListingQuery) {
            const q = this.game.pendingListingQuery;
            this.game.pendingListingQuery = null;
            this.game.listing.search(q);
        }
    }

    override onSuspending(): void {
        tween(this, { alpha: 0 }, { duration: 300 }).finished.then(() => {
            if (!this.isCurrent) this.visible = false;
        });
    }

    override onResuming(): void {
        this.visible = true;
        tween(this, { alpha: 1 }, { duration: 500 });
        this.game.background.setDim(0.15, 600);
        this.game.music.loopFromPreview = false;
        const now = this.game.music.current.value;
        if (now) this.onTrack(now);
        if (!this.game.music.isPlaying && this.game.settings.menuMusic.value) {
            if (now?.kind === 'library') void this.game.music.playSet(now.set);
            else void this.game.music.playRandom();
        }
        if (this.state === 'initial') this.setState('top');
    }

    override onExiting(): number {
        tween(this, { alpha: 0 }, { duration: 400 });
        return 400;
    }

    private doExit(): void {
        this.state = 'exit';
        this.setState('initial');
        this.state = 'exit';
        tween(this.logo, { scale: this.logo.scale.x * 0.8, alpha: 0 }, { duration: 600, ease: 'InQuad' });
        delay(300, () => this.exit(), this);
    }

    override update(dt: number): void {
        const beat = this.game.music.beat();
        this.sinceBeatFlash += dt;
        let isBeat = false;
        if (beat.beatLength > 0 && beat.beatIndex !== this.lastBeat) {
            this.lastBeat = beat.beatIndex;
            isBeat = true;
        } else if (beat.beatLength === 0) {
            const lv = this.game.audio.getLevels();
            if (lv.bass > 0.45 && this.sinceBeatFlash > 400) isBeat = true;
        }
        if (isBeat) {
            this.sinceBeatFlash = 0;
            const lv = this.game.audio.getLevels();
            const amp = Math.min(1, 0.4 + lv.overall);
            // Side flashes: alternate sides each beat, both in kiai (lazer MenuSideFlashes).
            const strength = (beat.kiai ? 0.35 : 0.15) * amp;
            const targets = beat.kiai ? [this.leftFlash, this.rightFlash] : [beat.beatIndex % 2 === 0 ? this.leftFlash : this.rightFlash];
            for (const f of targets) {
                f.alpha = strength;
                tween(f, { alpha: 0 }, { duration: Math.max(300, (beat.beatLength || 500) * 1.5), ease: 'OutQuint' });
            }
            for (const f of this.rightFlow) f.button.onBeat(beat.beatLength);
            for (const f of this.leftFlow) f.button.onBeat(beat.beatLength);
        }
        // Runs after this frame's tweens: one pass from the current animated
        // widths/logo scale, so connected elements always move together.
        this.layoutFlow();
        if (this.state === 'top' || this.state === 'play') {
            this.idle += dt;
            if (this.idle > IDLE_RETURN_MS && !this.game.overlays.anyOpen) this.setState('initial');
        }
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        this.idle = 0;
        if (action === 'back') {
            if (this.state === 'play') this.setState('top');
            else if (this.state === 'top') this.setState('initial');
            else this.doExit();
            return true;
        }
        if (action === 'select') {
            this.onLogo();
            return true;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (this.state === 'initial' && (e.code === 'Space' || e.code === 'KeyP')) {
            this.setState('top');
            return true;
        }
        const pool = this.state === 'play' ? [...this.playButtons, this.backButton] : [...this.topButtons, this.settingsButton];
        const hit = pool.find(b => b.hotkeys.includes(e.code));
        if (hit) {
            hit.activate();
            return true;
        }
        return false;
    }
}
