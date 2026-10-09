import { Rectangle, Texture, type Text } from 'pixi.js';
import { Screen } from '../app/Screen';
import { tween, delay } from '../core/Tweener';
import type { Action } from '../input/bindings';
import { label } from '../ui/text';
import { Colors } from '../ui/theme';
import { MainMenuScreen } from './MainMenuScreen';
import { OsuLogo } from './menu/OsuLogo';

const TIPS = [
    'Press Ctrl+O anywhere to open settings.',
    'Press Ctrl+D to browse and download beatmaps.',
    'Drag and drop .osz files anywhere to import them.',
    'Press F1 in song select to choose mods, F2 for a random beatmap.',
    'Alt + mouse wheel adjusts the volume from anywhere.',
    'Hold ` (backquote) during gameplay to quickly retry.',
    'Try the WebGPU renderer in Settings → Graphics.',
    'Space skips long intros during gameplay.',
    'Type anywhere in song select to search your beatmaps.',
];

/**
 * First screen (and the one the main menu exits back to). Browsers only
 * allow audio after a user gesture, so this doubles as osu!'s disclaimer /
 * "welcome" intro: click to unlock audio, then play the welcome sequence.
 */
export class IntroScreen extends Screen {
    override readonly catchesClicks = true;
    override readonly hideToolbar = true;
    override readonly allowOverlays = false;
    private logo!: OsuLogo;
    private hint!: Text;
    private welcome!: Text;
    private disclaimer!: Text;
    private tip!: Text;
    private waiting = true;

    override load(): void {
        const g = this.game;
        this.logo = new OsuLogo(
            { triangle: g.skin.tex('triangle'), glow: g.skin.tex('glow'), white: Texture.WHITE },
            { beat: () => g.music.beat(), levels: () => g.audio.getLevels(), fft: out => g.audio.getFrequencyData(out) },
        );
        this.logo.onClickLogo = () => this.begin();
        this.logo.visualiser.visible = false;
        this.hint = label(this.isTouch() ? 'tap to start' : 'click anywhere to start', { size: 20, weight: '600', color: 0xffffff, letterSpacing: 2 });
        this.hint.anchor.set(0.5);
        this.welcome = label('welcome', { size: 64, weight: '300', letterSpacing: 18 });
        this.welcome.anchor.set(0.5);
        this.welcome.alpha = 0;
        this.disclaimer = label(
            'wosu! is an unofficial, open-source osu!standard client that runs entirely in your browser.\nosu! is a trademark of ppy Pty Ltd. Beatmaps are provided by community mirrors.',
            { size: 13, weight: '500', color: Colors.grayA, align: 'center', lineHeight: 19 },
        );
        this.disclaimer.anchor.set(0.5, 1);
        this.tip = label(`Tip: ${TIPS[Math.floor(Math.random() * TIPS.length)]}`, { size: 15, weight: '600', color: Colors.pinkLight });
        this.tip.anchor.set(0.5, 1);
        this.addChild(this.logo, this.hint, this.welcome, this.disclaimer, this.tip);
        this.hitArea = new Rectangle(0, 0, 1, 1);
        this.on('pointertap', () => this.begin());
    }

    private isTouch(): boolean {
        return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    }

    protected override onResize(w: number, h: number): void {
        (this.hitArea as Rectangle).width = w;
        (this.hitArea as Rectangle).height = h;
        if (!this.logo) return;
        this.logo.position.set(w / 2, h / 2 - 20);
        this.logo.setDiameter(Math.min(h * 0.42, w * 0.4, 360));
        this.hint.position.set(w / 2, h / 2 + this.logo.diameter / 2 + 50);
        this.welcome.position.set(w / 2, h / 2 + this.logo.diameter / 2 + 50);
        this.disclaimer.position.set(w / 2, h - 24);
        this.tip.position.set(w / 2, h - 72);
    }

    override onEntering(): void {
        this.game.background.setDim(1, 0);
        this.alpha = 0;
        this.fadeIn(800);
        this.showWaiting();
    }

    private showWaiting(): void {
        this.waiting = true;
        this.logo.scale.set(0.9);
        tween(this.logo, { scale: 1, alpha: 1 }, { duration: 1200, ease: 'OutElastic' });
        this.hint.alpha = 0;
        tween(this.hint, { alpha: 1 }, { duration: 600, delay: 400 });
        tween(this.disclaimer, { alpha: 1 }, { duration: 600 });
        tween(this.tip, { alpha: 1 }, { duration: 600 });
    }

    override update(dt: number): void {
        if (this.waiting) {
            // Gentle breathing while waiting for the click.
            const t = performance.now() / 1000;
            this.hint.alpha = Math.min(this.hint.alpha + dt / 600, 0.55 + 0.45 * Math.sin(t * 2.5));
        }
    }

    override onKey(_e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back') return true;
        this.begin();
        return true;
    }

    private begin(): void {
        if (!this.waiting || !this.isCurrent) return;
        this.waiting = false;
        void this.game.audio.unlock();
        this.game.uiSounds.select();
        tween(this.hint, { alpha: 0 }, { duration: 200 });
        tween(this.disclaimer, { alpha: 0 }, { duration: 400 });
        tween(this.tip, { alpha: 0 }, { duration: 400 });
        this.logo.impact(3);
        this.welcome.alpha = 0;
        this.welcome.scale.set(0.9);
        tween(this.welcome, { alpha: 1, scale: 1 }, { duration: 1000, ease: 'OutQuint' });
        tween(this.logo, { scale: 1.12 }, { duration: 1400, ease: 'OutQuint' });
        if (this.game.settings.menuMusic.value) void this.game.music.playRandom();
        delay(1100, () => {
            if (!this.isCurrent) return;
            tween(this.welcome, { alpha: 0 }, { duration: 300 });
            this.push(new MainMenuScreen());
        }, this);
    }

    override onSuspending(): void {
        this.fadeOut(400);
    }

    /** Returning from the main menu's Exit: lazer's "see you next time". */
    override onResuming(): void {
        this.visible = true;
        this.game.background.setDim(1, 600);
        this.game.music.pause();
        this.alpha = 1;
        this.welcome.text = 'see you next time!';
        this.welcome.alpha = 0;
        tween(this.welcome, { alpha: 1 }, { duration: 600 });
        this.logo.alpha = 0;
        delay(1800, () => {
            tween(this.welcome, { alpha: 0 }, { duration: 500 });
            this.welcome.text = 'welcome';
            this.showWaiting();
        }, this);
    }
}
