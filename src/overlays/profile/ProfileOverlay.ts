import { Container, FillGradient, Graphics, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { decodeImageFile, pickImageFile } from '../../app/Profile';
import { formatNumber, lerpColor } from '../../core/math';
import { track } from '../../core/analytics';
import { ApiError } from '../../online/Account';
import { offerLocalImport } from '../../online/importLocal';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { PLAYER_NAME_MAX, validatePlayerName } from '../../storage/profile';
import { Avatar } from '../../ui/Avatar';
import { Box } from '../../ui/Box';
import { Button, IconButton } from '../../ui/Button';
import { fillCover } from '../../ui/coverFill';
import { fitText, label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { ColorProvider, Colors, Metrics } from '../../ui/theme';
import { Triangles } from '../../ui/Triangles';
import { AvatarCropper } from './AvatarCropper';

const WIDTH = 560;
const COVER_H = 170;
const AVATAR = 112;
const PAD = 24;
const colours = new ColorProvider('pink');

let coverShade: FillGradient | null = null;
/** Darkens the banner's bottom so the name reads on any picture. */
function shade(): FillGradient {
    coverShade ??= new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0)' },
            { offset: 1, color: 'rgba(0,0,0,0.7)' },
        ],
        textureSpace: 'local',
    });
    return coverShade;
}

/** Global actions that still work over the profile (everything else stays here). */
const PASS_THROUGH: readonly Action[] = ['toggleSettings', 'toggleNotifications', 'volumeUp', 'volumeDown', 'toggleMute', 'screenshot', 'fullscreen', 'toggleFps'];

/**
 * The local player's profile (lazer's user profile header, offline): the
 * banner, profile picture and name, editable in place. A new picture goes
 * through a crop editor before it is downscaled and stored; the banner is
 * centre-cropped.
 */
export class ProfileOverlay extends Overlay {
    private readonly card = new Container();
    private readonly cover = new Graphics();
    private readonly coverTris: Triangles;
    private readonly coverShadeG = new Graphics();
    private readonly avatar: Avatar;
    private readonly nameText: Text;
    private readonly subtitle: Text;
    private readonly body = new Box({ color: colours.background4, radius: 10, corners: 'bottom' });
    private readonly closeButton = new IconButton('close', { size: 32, circle: true });
    // Profile editing
    private readonly editor = new Container();
    private readonly nameBox: TextBox;
    private readonly saveName: Button;
    private readonly nameHint: Text;
    private readonly uploadAvatar: Button;
    private readonly removeAvatar: Button;
    private readonly uploadCover: Button;
    private readonly removeCover: Button;
    // wosu! account (global leaderboards)
    private readonly signedOut = new Container();
    private readonly signedIn = new Container();
    private readonly userBox: TextBox;
    private readonly passBox: TextBox;
    private readonly signInButton: Button;
    private readonly registerButton: Button;
    private readonly accountHint: Text;
    private readonly accountText: Text;
    private readonly signOutButton: Button;
    private readonly pageButton: Button;
    private readonly rankingsButton: Button;
    private authBusy = false;
    // Crop step
    private readonly cropView = new Container();
    private readonly cropTitle: Text;
    private readonly cropSave: Button;
    private readonly cropCancel: Button;
    private cropper: AvatarCropper | null = null;
    private cropImage: ImageBitmap | null = null;
    private busy = false;
    private viewW = 0;
    private viewH = 0;
    private cardH = 0;
    /** The card's height while editing (the crop step changes it). */
    private readonly editorH: number;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.6;
        const p = game.profile;
        this.coverTris = new Triangles(game.skin.tex('triangle'), {
            colorLight: lerpColor(colours.dark2, 0xffffff, 0.08),
            colorDark: colours.dark4,
            maskRadius: 10,
            velocity: 0.4,
            density: 1,
        });
        this.avatar = new Avatar(AVATAR, p.avatar, { radius: 16 });
        this.nameText = label('', { size: 30, weight: '700', shadow: true });
        this.nameText.anchor.set(0, 1);
        this.subtitle = label('', { size: 14, weight: '600', color: Colors.grayD, shadow: true });
        this.subtitle.anchor.set(0, 1);
        this.closeButton.onActivate = () => this.hide();

        this.nameBox = new TextBox({ placeholder: 'Your name', maxLength: PLAYER_NAME_MAX * 2, accent: colours.highlight1 });
        this.saveName = new Button('Save', { color: colours.dark1, width: 96, height: 40 });
        this.saveName.onActivate = () => this.commitName();
        this.nameBox.committed.add(() => this.commitName());
        this.nameBox.changed.add(v => this.updateNameHint(v));
        this.nameHint = label('', { size: 13, weight: '600' });
        const btn = (text: string, icon: 'upload' | 'trash' | 'image', color: number) => new Button(text, { color, icon, width: 200, height: 36, fontSize: 14 });
        this.uploadAvatar = btn('Upload picture', 'upload', colours.dark1);
        this.removeAvatar = btn('Use default', 'trash', Colors.gray4);
        this.uploadCover = btn('Upload banner', 'image', colours.dark1);
        this.removeCover = btn('Use default', 'trash', Colors.gray4);
        this.uploadAvatar.onActivate = () => void this.chooseAvatar();
        this.removeAvatar.onActivate = () => void this.run(async () => {
            await p.removeAvatar();
            await this.sync('avatar', null);
        });
        this.uploadCover.onActivate = () => void this.chooseCover();
        this.removeCover.onActivate = () => void this.run(async () => {
            await p.removeCover();
            await this.sync('cover', null);
        });
        const heading = (t: string) => label(t, { size: 16, weight: '700' });
        const nameHead = heading('Display name');
        const avatarHead = heading('Profile picture');
        const coverHead = heading('Banner');
        const avatarNote = label('Cropped square, saved on this device.', { size: 12, weight: '500', color: Colors.grayA });
        const coverNote = label('Centre-cropped to a wide strip.', { size: 12, weight: '500', color: Colors.grayA });
        // Layout of the editor (card-local, below the banner).
        let y = COVER_H + 64;
        nameHead.position.set(PAD, y);
        y += 28;
        this.nameBox.resize(WIDTH - PAD * 2 - 96 - 10, 40);
        this.nameBox.position.set(PAD, y);
        this.saveName.position.set(WIDTH - PAD - 96, y);
        y += 46;
        this.nameHint.position.set(PAD, y);
        y += 32;
        const half = (WIDTH - PAD * 2 - 20) / 2;
        avatarHead.position.set(PAD, y);
        coverHead.position.set(PAD + half + 20, y);
        y += 28;
        for (const [b, x] of [[this.uploadAvatar, PAD], [this.uploadCover, PAD + half + 20]] as const) b.resize(half, 36).position.set(x, y);
        y += 44;
        for (const [b, x] of [[this.removeAvatar, PAD], [this.removeCover, PAD + half + 20]] as const) b.resize(half, 36).position.set(x, y);
        y += 44;
        avatarNote.position.set(PAD, y);
        coverNote.position.set(PAD + half + 20, y);
        fitText(avatarNote, half);
        fitText(coverNote, half);
        y += 34;
        // Account: sign in / register, or who is signed in.
        const accountHead = heading('wosu! account');
        accountHead.position.set(PAD, y);
        y += 28;
        this.userBox = new TextBox({ placeholder: 'Username', maxLength: PLAYER_NAME_MAX * 2, accent: colours.highlight1 });
        this.passBox = new TextBox({ placeholder: 'Password', password: true, maxLength: 200, accent: colours.highlight1 });
        this.userBox.resize(half, 40).position.set(PAD, 0);
        this.passBox.resize(half, 40).position.set(PAD + half + 20, 0);
        const third = (WIDTH - PAD * 2 - 20) / 3;
        this.signInButton = new Button('Sign in', { color: colours.dark1, width: third, height: 36, fontSize: 14 });
        this.registerButton = new Button('Create account', { color: Colors.gray4, width: third, height: 36, fontSize: 14 });
        this.rankingsButton = new Button('Rankings', { color: Colors.gray4, icon: 'trophy', width: third, height: 36, fontSize: 14 });
        this.signInButton.resize(third, 36).position.set(PAD, 48);
        this.registerButton.resize(third, 36).position.set(PAD + third + 10, 48);
        this.rankingsButton.resize(third, 36).position.set(PAD + (third + 10) * 2, 48);
        this.rankingsButton.onActivate = () => this.openPage('rankings');
        this.signInButton.onActivate = () => void this.auth('login');
        this.registerButton.onActivate = () => void this.auth('register');
        this.userBox.committed.add(() => this.passBox.focus());
        this.passBox.committed.add(() => void this.auth('login'));
        this.accountHint = label('', { size: 12, weight: '500', color: Colors.grayA });
        this.accountHint.position.set(PAD, 92);
        this.signedOut.addChild(this.userBox, this.passBox, this.signInButton, this.registerButton, this.rankingsButton, this.accountHint);
        this.accountText = label('', { size: 14, weight: '600' });
        this.accountText.position.set(PAD, 8);
        this.pageButton = new Button('Open profile page', { color: colours.dark1, icon: 'user', width: half, height: 36, fontSize: 14 });
        this.pageButton.resize(half, 36).position.set(PAD, 48);
        this.pageButton.onActivate = () => this.openPage('best');
        this.signOutButton = new Button('Sign out', { color: Colors.gray4, width: half, height: 36, fontSize: 14 });
        this.signOutButton.resize(half, 36).position.set(PAD + half + 20, 48);
        this.signOutButton.onActivate = () => void this.signOut();
        this.signedIn.addChild(this.accountText, this.pageButton, this.signOutButton);
        this.signedOut.position.set(0, y);
        this.signedIn.position.set(0, y);
        y += 112;
        this.cardH = this.editorH = y;
        this.editor.addChild(nameHead, this.nameBox, this.saveName, this.nameHint, avatarHead, coverHead,
            this.uploadAvatar, this.uploadCover, this.removeAvatar, this.removeCover, avatarNote, coverNote,
            accountHead, this.signedOut, this.signedIn);
        this.disposer.add(game.account.user.bind(() => this.updateAccount(), true));
        this.disposer.add(game.account.available.bind(() => this.updateAccount()));

        this.cropTitle = label('Crop your picture', { size: 18, weight: '700' });
        this.cropSave = new Button('Save picture', { color: colours.dark1, width: 160, height: 38 });
        this.cropCancel = new Button('Cancel', { color: Colors.gray4, width: 120, height: 38 });
        this.cropSave.onActivate = () => void this.saveCrop();
        this.cropCancel.onActivate = () => this.closeCrop();
        this.cropView.addChild(this.cropTitle, this.cropSave, this.cropCancel);
        this.cropView.visible = false;

        this.body.position.set(0, COVER_H);
        this.card.addChild(this.body, this.cover, this.coverTris, this.coverShadeG, this.avatar, this.nameText, this.subtitle, this.closeButton, this.editor, this.cropView);
        this.card.eventMode = 'static';
        this.addChild(this.card);
        this.disposer.add(p.name.bind(() => this.drawHeader(), true));
        this.disposer.add(p.cover.bind(() => this.drawHeader()));
        this.disposer.add(p.avatar.bind(() => this.updateButtons(), true));
        this.disposer.add(p.cover.bind(() => this.updateButtons(), true));
        this.disposer.add(this.state.bind(open => {
            if (open) this.onOpen();
            else this.closeCrop();
        }));
        this.drawCard();
    }

    private onOpen(): void {
        this.nameBox.setValue(this.game.profile.name.value, false);
        this.updateNameHint(this.nameBox.value);
        this.updateSubtitle();
        void this.game.account.refresh().catch(() => {});
    }

    private updateSubtitle(): void {
        const u = this.game.account.user.value;
        void this.game.scores.all().then(list => {
            const n = list.length;
            const local = `${n} score${n === 1 ? '' : 's'} on this device`;
            this.subtitle.text = u ? `${u.rank ? `Global #${formatNumber(u.rank)} · ` : ''}${formatNumber(Math.round(u.pp))}pp · ${local}` : `Local player · ${local}`;
        }).catch(() => (this.subtitle.text = u ? `${formatNumber(Math.round(u.pp))}pp` : 'Local player'));
    }

    private updateAccount(): void {
        const account = this.game.account;
        const u = account.user.value;
        this.signedIn.visible = !!u;
        this.signedOut.visible = !u;
        if (u) {
            const rank = u.rank ? ` · global #${formatNumber(u.rank)}` : '';
            this.accountText.text = `Signed in as ${u.name}${rank} · ${formatNumber(Math.round(u.pp))}pp · ${formatNumber(u.playCount)} play${u.playCount === 1 ? '' : 's'}`;
            fitText(this.accountText, WIDTH - PAD * 2, this.accountText.text);
        } else if (!this.authBusy) {
            this.accountHint.text = account.available.value
                ? 'Passed plays on downloaded beatmaps go to the global leaderboards. Names are 2–15 characters, passwords 8+.'
                : 'Global leaderboards need the wosu! server (not reachable from here).';
            this.accountHint.tint = Colors.grayA;
        }
        this.signInButton.enabled = this.registerButton.enabled = !this.authBusy;
        this.signOutButton.enabled = this.pageButton.enabled = !this.authBusy;
        if (this.isOpen) this.updateSubtitle();
    }

    private async auth(kind: 'login' | 'register'): Promise<void> {
        if (this.authBusy) return;
        const name = this.userBox.value.replace(/\s+/g, ' ').trim();
        const password = this.passBox.value;
        if (!name || !password) {
            this.accountHint.text = 'Enter your username and password.';
            this.accountHint.tint = Colors.redLight;
            this.game.uiSounds.play('UI/generic-error');
            return;
        }
        this.authBusy = true;
        this.updateAccount();
        try {
            const account = this.game.account;
            const user = kind === 'login' ? await account.login(name, password) : await account.register(name, password);
            track(kind === 'login' ? 'signin' : 'register');
            this.passBox.setValue('', false);
            this.passBox.blur();
            this.game.notifications.success(kind === 'login' ? `Welcome back, ${user.name}!` : `Welcome to wosu!, ${user.name}!`);
            // A new account on a device with plays: offer to bring them along.
            if (kind === 'register') void offerLocalImport(this.game);
        } catch (e) {
            console.warn('[profile] sign in failed', e);
            this.accountHint.text = e instanceof ApiError ? e.message : 'The wosu! server could not be reached.';
            this.accountHint.tint = Colors.redLight;
            this.game.uiSounds.play('UI/generic-error');
        } finally {
            this.authBusy = false;
            this.updateAccount();
        }
    }

    /** The full profile page (rankings when signed out). */
    private openPage(tab: 'best' | 'rankings'): void {
        this.hide();
        this.game.userProfile.use(o => o.open(tab === 'rankings' && !this.game.account.signedIn ? undefined : this.game.account.user.value?.name, tab));
    }

    /** Mirror a picture change to the account (the local copy is the source of truth on this device). */
    private async sync(kind: 'avatar' | 'cover', blob: Blob | null): Promise<void> {
        if (!this.game.account.signedIn) return;
        try {
            if (blob) await this.game.account.setImage(kind, blob);
            else await this.game.account.removeImage(kind);
        } catch (e) {
            console.warn('[profile] online picture update failed', e);
            this.game.notifications.warning(`Your ${kind === 'avatar' ? 'picture' : 'banner'} is saved on this device, but the wosu! server did not take it.`);
        }
    }

    private async signOut(): Promise<void> {
        if (this.authBusy) return;
        this.authBusy = true;
        this.updateAccount();
        try {
            await this.game.account.logout();
        } finally {
            this.authBusy = false;
            this.updateAccount();
        }
    }

    private drawHeader(): void {
        const tex: Texture | null = this.game.profile.cover.value;
        const g = this.cover.clear();
        if (tex) fillCover(g, tex, 0, 0, WIDTH, COVER_H, 10, { corners: 'top' });
        this.coverTris.visible = !tex;
        this.coverTris.resize(WIDTH, COVER_H);
        this.coverShadeG.clear().rect(0, COVER_H * 0.35, WIDTH, COVER_H * 0.65).fill(shade());
        const textX = PAD + AVATAR + 18;
        fitText(this.nameText, WIDTH - textX - PAD, this.game.profile.name.value);
        this.nameText.position.set(textX, COVER_H - 30);
        this.subtitle.position.set(textX, COVER_H - 10);
    }

    private drawCard(): void {
        // Banner backing (under the triangles / picture).
        this.body.resize(WIDTH, this.cardH - COVER_H);
        this.avatar.position.set(PAD, COVER_H - AVATAR / 2 - 10);
        this.closeButton.position.set(WIDTH - 40, 8);
        this.card.addChildAt(new Box({ color: colours.dark3, radius: 10, corners: 'top' }, WIDTH, COVER_H), 0);
        this.card.pivot.set(WIDTH / 2, this.cardH / 2);
        this.drawHeader();
        this.place();
    }

    private updateNameHint(v: string): void {
        const check = validatePlayerName(v);
        const same = check.ok && check.name === this.game.profile.name.value;
        this.nameHint.text = check.ok
            ? same ? `Shown on your scores and leaderboards (up to ${PLAYER_NAME_MAX} characters).` : 'Press Enter or Save to use this name.'
            : check.error;
        this.nameHint.tint = check.ok ? Colors.grayA : Colors.redLight;
        this.saveName.enabled = check.ok && !same;
    }

    private commitName(): void {
        const check = this.game.profile.rename(this.nameBox.value);
        if (!check.ok) {
            this.game.uiSounds.play('UI/generic-error');
            this.updateNameHint(this.nameBox.value);
            return;
        }
        this.nameBox.setValue(check.name, false);
        this.nameBox.blur();
        this.updateNameHint(check.name);
        this.game.notifications.success(`Your name is now ${check.name}.`);
    }

    private updateButtons(): void {
        this.removeAvatar.enabled = !this.busy && !!this.game.profile.avatar.value;
        this.removeCover.enabled = !this.busy && !!this.game.profile.cover.value;
        this.uploadAvatar.enabled = this.uploadCover.enabled = !this.busy;
    }

    private async run(fn: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.updateButtons();
        try {
            await fn();
        } catch (e) {
            console.warn('[profile] update failed', e);
            this.game.notifications.error('Your profile could not be saved.');
        } finally {
            this.busy = false;
            this.updateButtons();
        }
    }

    private async pickImage(): Promise<ImageBitmap | null> {
        const file = await pickImageFile();
        if (!file) return null;
        const r = await decodeImageFile(file);
        if ('error' in r) {
            this.game.notifications.error(r.error);
            return null;
        }
        return r.image;
    }

    private async chooseAvatar(): Promise<void> {
        const image = await this.pickImage();
        if (image) this.openCrop(image);
    }

    private async chooseCover(): Promise<void> {
        const image = await this.pickImage();
        if (!image) return;
        await this.run(async () => this.sync('cover', await this.game.profile.setCover(image)));
        image.close();
    }

    /** Switch the body to the crop editor for a freshly picked picture. */
    openCrop(image: ImageBitmap): void {
        this.closeCrop();
        if (!this.isOpen) this.show();
        this.cropImage = image;
        const cropper = (this.cropper = new AvatarCropper(image, 240));
        const left = (WIDTH - cropper.w) / 2;
        this.cropTitle.position.set(PAD, COVER_H + 64);
        cropper.position.set(left, COVER_H + 100);
        const by = cropper.y + cropper.h + 10;
        this.cropSave.position.set(WIDTH - PAD - 160, by);
        this.cropCancel.position.set(WIDTH - PAD - 160 - 10 - 120, by);
        this.cropView.addChild(cropper);
        this.cropView.visible = true;
        this.editor.visible = false;
        this.setCardHeight(by + 38 + PAD);
    }

    private closeCrop(): void {
        this.cropper?.destroy();
        this.cropper = null;
        this.cropImage?.close();
        this.cropImage = null;
        this.cropView.visible = false;
        this.editor.visible = true;
        this.setCardHeight(this.editorH);
    }

    private setCardHeight(h: number): void {
        if (h === this.cardH) return;
        this.cardH = h;
        this.body.resize(WIDTH, h - COVER_H);
        this.card.pivot.set(WIDTH / 2, h / 2);
        this.place();
    }

    private async saveCrop(): Promise<void> {
        const cropper = this.cropper, image = this.cropImage;
        if (!cropper || !image) return;
        const crop = cropper.crop;
        await this.run(async () => this.sync('avatar', await this.game.profile.setAvatar(image, crop)));
        this.closeCrop();
    }

    /** Centred below the toolbar, shrunk to fit short windows. */
    private place(): void {
        const top = Metrics.toolbarHeight;
        const scale = Math.min(1, (this.viewH - top - 20) / this.cardH, (this.viewW - 32) / WIDTH);
        this.card.scale.set(Math.max(0.5, scale));
        this.card.position.set(this.viewW / 2, this.centreY);
    }

    private get centreY(): number {
        return Metrics.toolbarHeight + (this.viewH - Metrics.toolbarHeight) / 2;
    }

    protected popIn(): void {
        this.card.alpha = 0;
        this.card.y = this.centreY + 40;
        tween(this.card, { alpha: 1, y: this.centreY }, { duration: 500, ease: 'OutQuint' });
    }

    protected async popOut(): Promise<void> {
        this.nameBox.blur();
        this.userBox.blur();
        this.passBox.blur();
        await tween(this.card, { alpha: 0, y: this.centreY + 40 }, { duration: 250, ease: 'OutQuint' }).finished;
    }

    protected layout(w: number, h: number): void {
        this.viewW = w;
        this.viewH = h;
        this.place();
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (action === 'back') {
            if (this.cropper) this.closeCrop();
            else this.hide();
            return true;
        }
        const is = (a: Action) => this.game.input.matches(e, a);
        return !PASS_THROUGH.some(is);
    }
}
