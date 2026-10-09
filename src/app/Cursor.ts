import { Assets, Container, type Texture } from 'pixi.js';
import { GameplayCursor } from './cursor/GameplayCursor';
import { MenuCursor } from './cursor/MenuCursor';

const BASE = import.meta.env.BASE_URL;

/** GameIdleTracker(6000): the menu cursor hides after this long without input. */
const IDLE_MS = 6000;

export interface CursorTextures {
    menu: Texture;
    menuAdditive: Texture;
    trail: Texture;
}

/**
 * Every cursor the game draws (osu!lazer's GlobalCursorDisplay plus the
 * ruleset's gameplay cursor):
 *
 * - `menu`: lazer's arrow MenuCursor, shown everywhere except active
 *   gameplay (also over the pause / fail menus, and over autoplay, where
 *   lazer keeps the user's own cursor visible).
 * - `gameplay`: the osu! cursor with its trail. The player owns it
 *   (`external`), positions it with `moveTo` and reports held buttons with
 *   `setDownCount`.
 *
 * Game decides which one the current screen wants (`menuStateVisible`,
 * `gameplayShown`); this class adds lazer's own rules on top: idle and
 * keyboard-only hiding, and hiding while the pointer is outside the page.
 */
export class Cursor extends Container {
    readonly menu: MenuCursor;
    readonly gameplay: GameplayCursor;

    /** Gameplay is still in control of the gameplay cursor (not paused / failed menu). */
    gameplayActive = true;
    /** Autoplay: gameplay moves its own cursor, so the user's menu cursor stays up too. */
    replayLoaded = false;

    // Set by Game.updateCursorVisibility.
    /** The menu cursor is the cursor the current screen provides. */
    menuStateVisible = false;
    /** The gameplay cursor is popped in (otherwise faded to lazer's 0.05). */
    gameplayShown = true;
    /** lazer's HideMenuCursorOnNonMouseInput for the current screen. */
    hideMenuOnNonMouseInput = false;
    /** IdleTracker.AllowIdle: no focused text box. */
    idleAllowed = true;

    private _external = false;
    private pointerInside = true;
    private windowActive = typeof document === 'undefined' ? true : document.hasFocus();
    private lastInputWasMouse = true;
    private lastInteraction = performance.now();
    /** Primary-pointer samples (logical px) since the last frame, for a smooth trail. */
    private readonly samples: number[] = [];

    static async loadTextures(): Promise<CursorTextures> {
        const load = (name: string) =>
            Assets.load<Texture>({ src: `${BASE}assets/skin/cursor/${name}.png`, data: { autoGenerateMipmaps: true } });
        const [menu, menuAdditive, trail] = await Promise.all([
            load('menu-cursor'),
            load('menu-cursor-additive'),
            load('cursortrail'),
        ]);
        return { menu, menuAdditive, trail };
    }

    constructor(
        textures: CursorTextures,
        gameplayTexture: Texture,
        private readonly toLogical: (clientX: number, clientY: number) => { x: number; y: number },
    ) {
        super();
        this.eventMode = 'none';
        this.gameplay = new GameplayCursor(gameplayTexture, textures.trail);
        this.gameplay.visible = false;
        this.menu = new MenuCursor(textures.menu, textures.menuAdditive);
        this.addChild(this.gameplay, this.menu);
        this.listen();
    }

    /** The player owns the gameplay cursor while this is set. */
    get external(): boolean {
        return this._external;
    }

    set external(v: boolean) {
        if (v === this._external) return;
        this._external = v;
        this.gameplay.visible = v;
        this.samples.length = 0;
        if (v) {
            this.gameplay.reset();
            this.gameplay.setShown(true, true);
            this.gameplayActive = true;
            this.replayLoaded = false;
        } else {
            this.gameplay.setDownCount(0);
        }
    }

    /** Logical px per playfield unit (gameplay cursor and trail sizes are in playfield units). */
    set playfieldScale(v: number) {
        this.gameplay.playfieldScale = v;
    }

    set circleSize(v: number) {
        this.gameplay.circleSize = v;
    }

    /**
     * Position the gameplay cursor. With `fromPointer`, the pointer's
     * coalesced samples since the last frame feed the trail first, like
     * lazer's high-frequency mouse input.
     */
    moveTo(x: number, y: number, fromPointer = false): void {
        const g = this.gameplay;
        g.prepareTrail();
        if (fromPointer) {
            const s = this.samples;
            for (let i = 0; i < s.length; i += 2) g.moveTo(s[i], s[i + 1]);
        }
        this.samples.length = 0;
        g.moveTo(x, y);
    }

    /** Gameplay buttons held (keys + mouse); each new press expands the cursor. */
    setDownCount(count: number): void {
        this.gameplay.setDownCount(count);
    }

    update(dt: number, pointerX: number, pointerY: number): void {
        const now = performance.now();
        const idle = this.idleAllowed && now - this.lastInteraction > IDLE_MS;
        let shown = this.menuStateVisible && this.pointerInside;
        // lazer only applies idle / keyboard hiding while the game has focus.
        if (shown && this.windowActive) shown = !(this.hideMenuOnNonMouseInput && !this.lastInputWasMouse) && !idle;
        this.menu.stateVisible = this.menuStateVisible;
        this.menu.setShown(shown);
        this.menu.position.set(pointerX, pointerY);
        this.menu.update(dt);

        if (this._external) {
            this.gameplay.setShown(this.gameplayShown);
            this.gameplay.update(dt);
        }
        this.samples.length = 0;
    }

    private listen(): void {
        if (typeof window === 'undefined') return;
        const opts = { passive: true } as const;
        const interact = () => {
            if (this.windowActive) this.lastInteraction = performance.now();
        };
        window.addEventListener('pointermove', e => {
            this.pointerInside = true;
            if (e.pointerType !== 'touch') this.lastInputWasMouse = true;
            interact();
            if (!e.isPrimary) return;
            const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
            for (const ev of events.length ? events : [e]) {
                const p = this.toLogical(ev.clientX, ev.clientY);
                if (this._external && this.samples.length < 512) this.samples.push(p.x, p.y);
                if (e.pointerType !== 'touch') this.menu.pointerMove(p.x, p.y);
            }
        }, opts);
        // Mouse events fire for every button (pointer events only for the first one held).
        window.addEventListener('mousedown', e => {
            this.lastInputWasMouse = true;
            interact();
            const p = this.toLogical(e.clientX, e.clientY);
            this.menu.pointerDown(p.x, p.y);
        }, opts);
        window.addEventListener('mouseup', e => {
            interact();
            this.menu.pointerUp(e.buttons !== 0);
        }, opts);
        window.addEventListener('pointerdown', e => {
            this.pointerInside = true;
            if (e.pointerType === 'touch') this.lastInputWasMouse = false;
            interact();
        }, opts);
        window.addEventListener('keydown', e => {
            if (!e.repeat) this.lastInputWasMouse = false;
            interact();
        }, opts);
        window.addEventListener('keyup', interact, opts);
        // Pointer left the page: hide the drawn cursor instead of leaving it stuck at the edge.
        window.addEventListener('pointerout', e => {
            if (!e.relatedTarget && e.pointerType !== 'touch') this.pointerInside = false;
        }, opts);
        document.documentElement.addEventListener('mouseleave', () => (this.pointerInside = false), opts);
        window.addEventListener('pointerover', () => (this.pointerInside = true), opts);
        window.addEventListener('blur', () => {
            this.windowActive = false;
            this.menu.pointerUp(false);
        });
        window.addEventListener('focus', () => {
            this.windowActive = true;
            this.lastInteraction = performance.now();
        });
    }
}

const NO_OS_CURSOR_CLASS = 'wosu-no-os-cursor';
let osCursorShown: boolean | null = null;

/**
 * Show or hide the operating system cursor over the whole page. A
 * `!important` class beats the inline `cursor` Pixi's EventSystem writes
 * on the canvas whenever the hovered object changes (which used to bring
 * the OS cursor back over buttons), and it also covers anything outside
 * the canvas (the hidden text input, the page around a resizing canvas).
 */
export function setOsCursorVisible(visible: boolean): void {
    if (osCursorShown === visible || typeof document === 'undefined') return;
    osCursorShown = visible;
    if (!document.getElementById(NO_OS_CURSOR_CLASS)) {
        const style = document.createElement('style');
        style.id = NO_OS_CURSOR_CLASS;
        style.textContent = `html.${NO_OS_CURSOR_CLASS}, html.${NO_OS_CURSOR_CLASS} * { cursor: none !important; }`;
        document.head.appendChild(style);
    }
    document.documentElement.classList.toggle(NO_OS_CURSOR_CLASS, !visible);
}
