import { Container, Graphics, type Text, type Texture } from 'pixi.js';
import type { Game } from '../../app/Game';
import { Overlay } from '../../app/Overlay';
import { lerpColor, formatNumber } from '../../core/math';
import { tween } from '../../core/Tweener';
import type { Action } from '../../input/bindings';
import { sanitizeMods } from '../../gameplay/mods';
import { ApiError, type ModLogEntry, type OnlineScore, type ProfileData, type RankingsPage } from '../../online/Account';
import { offerLocalImport } from '../../online/importLocal';
import { ModIconRow } from '../mods/ModIcon';
import { TabStrip } from '../listing/TabStrip';
import { Avatar } from '../../ui/Avatar';
import { Box } from '../../ui/Box';
import { Button } from '../../ui/Button';
import { fillCover } from '../../ui/coverFill';
import { LoadingSpinner } from '../../ui/LoadingSpinner';
import { ScrollContainer } from '../../ui/ScrollContainer';
import { fitText, label } from '../../ui/text';
import { TextBox } from '../../ui/TextBox';
import { ColorProvider, Colors, gradeColor, gradeLabel } from '../../ui/theme';
import { Triangles } from '../../ui/Triangles';
import { UIComponent } from '../../ui/UIComponent';
import { relativeDate } from '../../screens/select/visuals';
import { PLAYER_NAME_MAX } from '../../storage/profile';

type Tab = 'best' | 'recent' | 'rankings' | 'account' | 'moderation';

const COVER_H = 220;
const AVATAR = 110;
const MAX_W = 1000;
const ROW_H = 52;
const ROW_GAP = 4;
/** Keys that would otherwise reach the screen behind. */
const SWALLOWED: ReadonlySet<Action> = new Set<Action>(['select', 'up', 'down', 'left', 'right', 'toggleMods', 'random', 'randomRewind', 'skip', 'quickRetry', 'deleteItem']);

function joinedDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One play on a profile: position, grade, map, mods, accuracy, pp, score, when. */
class PlayRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly badge = new Graphics();
    private readonly position_: Text;
    private readonly grade: Text;
    private readonly title: Text;
    private readonly sub: Text;
    private readonly pp: Text;
    private readonly score: Text;
    private readonly mods = new ModIconRow(16, 2);
    private play: OnlineScore | null = null;
    private colorsRef: ColorProvider;

    constructor(colors: ColorProvider) {
        super();
        this.colorsRef = colors;
        this.position_ = label('', { size: 14, weight: '700', color: Colors.grayC });
        this.position_.anchor.set(0.5);
        this.grade = label('', { size: 14, weight: '800', italic: true });
        this.grade.anchor.set(0.5);
        this.title = label('', { size: 15, weight: '700' });
        this.sub = label('', { size: 12, weight: '600', color: Colors.grayC });
        this.pp = label('', { size: 18, weight: '700', color: Colors.yellow });
        this.pp.anchor.set(1, 0);
        this.score = label('', { size: 12, weight: '600', color: Colors.grayC });
        this.score.anchor.set(1, 0);
        this.addChild(this.bg, this.position_, this.badge, this.grade, this.title, this.sub, this.pp, this.score, this.mods);
        this.makeInteractive();
    }

    assign(s: OnlineScore, position: number): void {
        this.play = s;
        this.position_.text = String(position);
        this.grade.text = gradeLabel(s.grade);
        this.grade.tint = s.grade.endsWith('H') ? 0x222222 : 0x2a1a00;
        this.title.text = `${s.artist} - ${s.title} [${s.version}]`;
        this.sub.text = `${(s.accuracy * 100).toFixed(2)}%  ·  ${formatNumber(s.maxCombo)}x  ·  ${relativeDate(s.date)}${s.ranked ? '' : '  ·  unranked'}`;
        this.pp.text = s.pp != null ? `${Math.round(s.pp)}pp` : '';
        this.score.text = formatNumber(s.score);
        this.mods.setMods(s.mods, s.modSettings);
        this.relayout();
    }

    get current(): OnlineScore | null {
        return this.play;
    }

    protected override onHoverChange(): void {
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const s = this.play;
        if (!s) return;
        this.bg.clear().roundRect(0, 0, w, h, 6).fill({ color: this.hovered ? this.colorsRef.background3 : this.colorsRef.background5, alpha: 1 });
        this.position_.position.set(18, h / 2);
        this.badge.clear().roundRect(36, h / 2 - 11, 40, 22, 11).fill(gradeColor(s.grade));
        this.grade.position.set(56, h / 2);
        const textX = 88;
        const rightW = Math.max(this.pp.width, this.score.width, this.mods.rowWidth) + 24;
        fitText(this.title, Math.max(60, w - textX - rightW), this.title.text);
        this.title.position.set(textX, 7);
        this.sub.position.set(textX, 29);
        this.pp.position.set(w - 12, 6);
        this.score.position.set(w - 12, 30);
        this.mods.position.set(w - 12 - rightW - this.mods.rowWidth, h / 2 - 8);
    }
}

/** One player on the rankings list. */
class RankRow extends UIComponent {
    private readonly bg = new Graphics();
    private readonly rank: Text;
    private readonly avatar = new Avatar(32, null, { radius: 6 });
    private readonly nameLabel: Text;
    private readonly stats: Text;
    private readonly pp: Text;
    private token = 0;
    user: RankingsPage['users'][number] | null = null;

    constructor(private readonly game: Game, private readonly colors: ColorProvider, private readonly own: () => string | null) {
        super();
        this.rank = label('', { size: 15, weight: '700', color: Colors.grayC });
        this.rank.anchor.set(0.5);
        this.nameLabel = label('', { size: 16, weight: '700' });
        this.stats = label('', { size: 12, weight: '600', color: Colors.grayC });
        this.pp = label('', { size: 18, weight: '700', color: Colors.yellow });
        this.pp.anchor.set(1, 0.5);
        this.addChild(this.bg, this.rank, this.avatar, this.nameLabel, this.stats, this.pp);
        this.makeInteractive();
    }

    assign(u: RankingsPage['users'][number]): void {
        this.user = u;
        this.rank.text = `#${u.rank}`;
        this.nameLabel.text = u.name;
        this.stats.text = `${(u.accuracy * 100).toFixed(2)}%  ·  ${formatNumber(u.playCount)} plays  ·  ${formatNumber(u.rankedScore)}`;
        this.pp.text = `${formatNumber(Math.round(u.pp))}pp`;
        const token = ++this.token;
        this.avatar.setTexture(null);
        if (u.avatarUrl) {
            void this.game.covers.get(u.avatarUrl).then(tex => {
                if (token === this.token && !this.destroyed) this.avatar.setTexture(tex);
            });
        }
        this.relayout();
    }

    protected override onHoverChange(): void {
        this.relayout();
    }

    protected override onResize(w: number, h: number): void {
        const u = this.user;
        if (!u) return;
        const mine = u.name === this.own();
        this.bg.clear().roundRect(0, 0, w, h, 6).fill({ color: mine ? lerpColor(this.colors.background5, Colors.yellow, 0.18) : this.hovered ? this.colors.background3 : this.colors.background5 });
        this.rank.position.set(28, h / 2);
        this.avatar.position.set(56, (h - 32) / 2);
        fitText(this.nameLabel, Math.max(60, w - 100 - this.pp.width - 40), u.name);
        this.nameLabel.position.set(98, 7);
        this.stats.position.set(98, 29);
        this.pp.position.set(w - 12, h / 2);
    }
}

/** A heading + one-line value, for the stats grid in the header. */
function stat(title: string, value: string): Container {
    const c = new Container();
    const t = label(title.toUpperCase(), { size: 10, weight: '700', color: Colors.grayC, letterSpacing: 1, shadow: true });
    const v = label(value, { size: 18, weight: '700', shadow: true });
    v.y = 14;
    c.addChild(t, v);
    return c;
}

/**
 * The full profile page (lazer's UserProfileOverlay): banner, picture,
 * name and global stats, then tabs for the best plays, recent plays and
 * the global rankings. The player's own page adds account settings
 * (email, password, local score upload); moderators get a moderation tab
 * on other players' pages.
 */
export class UserProfileOverlay extends Overlay {
    protected override readonly popInSample = 'UI/overlay-big-pop-in';
    protected override readonly popOutSample = 'UI/overlay-big-pop-out';
    private readonly colors = new ColorProvider('pink');
    private readonly waves: Graphics[] = [];
    private readonly panel = new Container();
    private readonly panelBg = new Graphics();
    private readonly scroll = new ScrollContainer();
    private readonly content = new Container();
    // Header
    private readonly cover = new Graphics();
    private readonly coverTris: Triangles;
    private readonly coverShade = new Graphics();
    private readonly avatar = new Avatar(AVATAR, null, { radius: 16 });
    private readonly nameText: Text;
    private readonly roleText: Text;
    private readonly metaText: Text;
    private readonly restrictedText: Text;
    private readonly statsRow = new Container();
    private readonly gradesRow = new Container();
    private readonly headerBg = new Box({ color: 0x000000, alpha: 0.25 });
    private readonly tabs: TabStrip<Tab>;
    private readonly tabsBg = new Graphics();
    // Body
    private readonly body = new Container();
    private readonly spinner = new LoadingSpinner(16);
    private readonly message: Text;
    private readonly playRows: PlayRow[] = [];
    private readonly rankRows: RankRow[] = [];
    private readonly pager = new Container();
    private readonly pagePrev: Button;
    private readonly pageNext: Button;
    private readonly pageText: Text;
    private readonly account = new Container();
    private readonly moderation = new Container();
    private readonly closeButton: Button;
    // Account tab controls
    private readonly emailBox: TextBox;
    private readonly emailSave: Button;
    private readonly emailHint: Text;
    private readonly passCurrent: TextBox;
    private readonly passNew: TextBox;
    private readonly passSave: Button;
    private readonly passHint: Text;
    private readonly uploadButton: Button;
    private readonly signOutButton: Button;
    // Moderation tab controls
    private readonly modReason: TextBox;
    private readonly modRestrict: Button;
    private readonly modRename: TextBox;
    private readonly modRenameButton: Button;
    private readonly modHint: Text;
    private readonly modLogText: Text;
    // State
    private playerName: string | null = null;
    private data: ProfileData | null = null;
    private rankings: RankingsPage | null = null;
    private rankingsPage = 1;
    private tab: Tab = 'best';
    private token = 0;
    private abort: AbortController | null = null;
    private busy = false;
    private coverTex: Texture | null = null;
    private viewW = 0;
    private viewH = 0;
    private layoutDirty = true;

    constructor(game: Game) {
        super(game);
        this.backdropAlpha = 0.4;
        const c = this.colors;
        for (const color of [c.light4, c.light3, c.dark4, c.dark3]) {
            const wave = new Graphics();
            wave.tint = color;
            wave.visible = false;
            this.waves.push(wave);
        }
        this.coverTris = new Triangles(game.skin.tex('triangle'), { colorLight: lerpColor(c.dark2, 0xffffff, 0.08), colorDark: c.dark4, maskRadius: 0, velocity: 0.4, density: 1 });
        this.nameText = label('', { size: 34, weight: '700', shadow: true });
        this.roleText = label('', { size: 11, weight: '800', color: 0x222222, letterSpacing: 1 });
        this.metaText = label('', { size: 13, weight: '600', color: Colors.grayD, shadow: true });
        this.restrictedText = label('', { size: 13, weight: '700', color: Colors.redLight, shadow: true });
        this.tabs = new TabStrip<Tab>([], 'best', { size: 15, weight: '700', gap: 26, rowHeight: 40, idle: Colors.grayC, hover: Colors.white, active: Colors.white, bar: { color: c.highlight1, height: 3 } });
        this.tabs.changed.add(t => this.setTab(t));
        this.message = label('', { size: 15, weight: '600', color: Colors.grayC, align: 'center' });
        this.message.anchor.set(0.5, 0);
        this.spinner.visible = false;
        this.closeButton = new Button('Close', { color: Colors.gray4, width: 100, height: 34, fontSize: 14, icon: 'close' });
        this.closeButton.onActivate = () => this.hide();
        // Rankings pager
        this.pagePrev = new Button('Previous', { color: c.dark1, width: 120, height: 34, fontSize: 14, icon: 'chevronLeft' });
        this.pageNext = new Button('Next', { color: c.dark1, width: 120, height: 34, fontSize: 14, icon: 'chevronRight' });
        this.pageText = label('', { size: 13, weight: '600', color: Colors.grayC });
        this.pageText.anchor.set(0.5, 0.5);
        this.pagePrev.onActivate = () => this.loadRankings(this.rankingsPage - 1);
        this.pageNext.onActivate = () => this.loadRankings(this.rankingsPage + 1);
        this.pager.addChild(this.pagePrev, this.pageNext, this.pageText);
        // Account tab
        const heading = (t: string) => label(t, { size: 16, weight: '700' });
        const note = (t: string) => label(t, { size: 12, weight: '500', color: Colors.grayA, wrap: 600 });
        this.emailBox = new TextBox({ placeholder: 'you@example.com', maxLength: 200, accent: c.highlight1, icon: 'bell' });
        this.emailSave = new Button('Save email', { color: c.dark1, width: 150, height: 40, fontSize: 14 });
        this.emailSave.onActivate = () => void this.saveEmail();
        this.emailBox.committed.add(() => void this.saveEmail());
        this.emailHint = label('', { size: 12, weight: '500', color: Colors.grayA });
        this.passCurrent = new TextBox({ placeholder: 'Current password', password: true, maxLength: 200, accent: c.highlight1 });
        this.passNew = new TextBox({ placeholder: 'New password (8+ characters)', password: true, maxLength: 200, accent: c.highlight1 });
        this.passSave = new Button('Change password', { color: c.dark1, width: 180, height: 40, fontSize: 14 });
        this.passSave.onActivate = () => void this.savePassword();
        this.passNew.committed.add(() => void this.savePassword());
        this.passHint = label('', { size: 12, weight: '500', color: Colors.grayA });
        this.uploadButton = new Button('Upload local scores', { color: c.dark1, icon: 'upload', width: 220, height: 40, fontSize: 14 });
        this.uploadButton.onActivate = () => void this.run(() => offerLocalImport(game, { prompt: true }));
        this.signOutButton = new Button('Sign out', { color: Colors.gray4, icon: 'signOut', width: 150, height: 40, fontSize: 14 });
        this.signOutButton.onActivate = () => void this.run(async () => {
            await game.account.logout();
            this.hide();
        });
        const emailHead = heading('Email');
        const emailNote = note('Used for password resets. A verification link is mailed when the server can send mail.');
        const passHead = heading('Password');
        const scoresHead = heading('Local scores');
        const scoresNote = note('Passed plays on downloaded beatmaps saved on this device can join your account.');
        let y = 0;
        emailHead.position.set(0, y);
        y += 28;
        this.emailBox.resize(360, 40).position.set(0, y);
        this.emailSave.resize(150, 40).position.set(370, y);
        y += 46;
        this.emailHint.position.set(0, y);
        y += 20;
        emailNote.position.set(0, y);
        y += 40;
        passHead.position.set(0, y);
        y += 28;
        this.passCurrent.resize(250, 40).position.set(0, y);
        this.passNew.resize(250, 40).position.set(260, y);
        this.passSave.resize(180, 40).position.set(520, y);
        y += 46;
        this.passHint.position.set(0, y);
        y += 36;
        scoresHead.position.set(0, y);
        y += 28;
        this.uploadButton.resize(220, 40).position.set(0, y);
        this.signOutButton.resize(150, 40).position.set(230, y);
        y += 46;
        scoresNote.position.set(0, y);
        this.account.addChild(emailHead, this.emailBox, this.emailSave, this.emailHint, emailNote, passHead, this.passCurrent, this.passNew, this.passSave, this.passHint, scoresHead, this.uploadButton, this.signOutButton, scoresNote);
        this.account.visible = false;
        // Moderation tab
        const modHead = heading('Moderation');
        const modNote = note('Restricting hides every score and removes the player from the rankings; they keep playing and see why on their own profile. Every action is logged.');
        this.modReason = new TextBox({ placeholder: 'Reason (shown to the player)', maxLength: 500, accent: Colors.red });
        this.modRestrict = new Button('Restrict', { color: Colors.red, width: 150, height: 40, fontSize: 14, icon: 'skull' });
        this.modRestrict.onActivate = () => void this.toggleRestrict();
        this.modRename = new TextBox({ placeholder: 'New name', maxLength: PLAYER_NAME_MAX * 2, accent: c.highlight1 });
        this.modRenameButton = new Button('Rename', { color: c.dark1, width: 150, height: 40, fontSize: 14 });
        this.modRenameButton.onActivate = () => void this.renamePlayer();
        this.modHint = label('', { size: 12, weight: '500', color: Colors.grayA });
        this.modLogText = label('', { size: 12, weight: '500', color: Colors.grayC, wrap: 700, lineHeight: 18 });
        y = 0;
        modHead.position.set(0, y);
        y += 28;
        modNote.position.set(0, y);
        y += 44;
        this.modReason.resize(360, 40).position.set(0, y);
        this.modRestrict.resize(150, 40).position.set(370, y);
        y += 50;
        this.modRename.resize(360, 40).position.set(0, y);
        this.modRenameButton.resize(150, 40).position.set(370, y);
        y += 46;
        this.modHint.position.set(0, y);
        y += 30;
        const logHead = heading('Recent moderation log');
        logHead.position.set(0, y);
        y += 28;
        this.modLogText.position.set(0, y);
        this.moderation.addChild(modHead, modNote, this.modReason, this.modRestrict, this.modRename, this.modRenameButton, this.modHint, logHead, this.modLogText);
        this.moderation.visible = false;

        this.body.addChild(this.spinner, this.message, this.pager, this.account, this.moderation);
        this.content.addChild(this.cover, this.coverTris, this.coverShade, this.headerBg, this.avatar, this.nameText, this.roleText, this.metaText, this.restrictedText, this.statsRow, this.gradesRow, this.tabsBg, this.tabs, this.closeButton, this.body);
        this.scroll.padBottom = 30;
        this.scroll.content.addChild(this.content);
        this.panel.addChild(this.panelBg, this.scroll);
        this.panel.eventMode = 'static';
        this.addChild(...this.waves, this.panel);
        // Own stats change (a submission, sign-out) while open: keep the page honest.
        this.disposer.add(game.account.user.bind(u => {
            if (!this.isOpen || !this.playerName) return;
            if (!u && this.data?.user.name === this.playerName && this.tab === 'account') this.setTab('best');
            this.refreshTabs();
        }));
        this.disposer.add(game.account.submitted.add(() => {
            if (this.isOpen && this.data && this.data.user.name === game.account.user.value?.name) this.load();
        }));
    }

    /** Open on a player (default: the signed-in player; the rankings when nobody is). */
    open(name?: string, tab?: Tab): void {
        const target = name ?? this.game.account.user.value?.name ?? null;
        if (tab) this.tab = tab;
        else if (!target) this.tab = 'rankings';
        if (target !== this.playerName) {
            this.playerName = target;
            this.data = null;
        }
        this.show();
        this.refreshTabs();
        this.load();
    }

    private get isOwn(): boolean {
        return !!this.playerName && this.playerName === this.game.account.user.value?.name;
    }

    private refreshTabs(): void {
        const choices: { value: Tab; label: string }[] = [];
        if (this.playerName) choices.push({ value: 'best', label: 'Best performance' }, { value: 'recent', label: 'Recent plays' });
        choices.push({ value: 'rankings', label: 'Global rankings' });
        if (this.isOwn) choices.push({ value: 'account', label: 'Account' });
        else if (this.playerName && this.game.account.isMod) choices.push({ value: 'moderation', label: 'Moderation' });
        if (!choices.some(ch => ch.value === this.tab)) this.tab = choices[0].value;
        this.tabs.setChoices(choices, this.tab);
        this.layoutDirty = true;
    }

    private setTab(tab: Tab): void {
        this.tab = tab;
        if (tab === 'rankings' && !this.rankings) this.loadRankings(this.rankingsPage);
        if (tab === 'moderation') void this.loadModLog();
        if (tab === 'account') this.fillAccount();
        this.scroll.scrollTo(Math.min(this.scroll.scrollY, Math.max(0, COVER_H - 40)), true);
        this.layoutDirty = true;
    }

    private load(): void {
        const token = ++this.token;
        this.abort?.abort();
        this.abort = null;
        if (!this.playerName) {
            this.data = null;
            this.renderHeader();
            if (!this.rankings) this.loadRankings(this.rankingsPage);
            this.layoutDirty = true;
            return;
        }
        this.spinner.visible = true;
        this.message.text = '';
        const abort = (this.abort = new AbortController());
        this.game.account.profile(this.playerName, abort.signal).then(data => {
            if (token !== this.token || this.destroyed) return;
            this.spinner.visible = false;
            this.data = data;
            this.renderHeader();
            if (this.tab === 'rankings' && !this.rankings) this.loadRankings(this.rankingsPage);
            this.layoutDirty = true;
        }).catch(e => {
            if (token !== this.token || this.destroyed || abort.signal.aborted) return;
            this.spinner.visible = false;
            this.data = null;
            this.message.text = e instanceof ApiError ? (e.status === 404 ? `There is no player called ${this.playerName}.` : e.message) : 'The wosu! server could not be reached.';
            this.renderHeader();
            this.layoutDirty = true;
        });
    }

    private loadRankings(page: number): void {
        const p = Math.max(1, page);
        const token = ++this.token;
        this.spinner.visible = true;
        this.game.account.rankings(p).then(r => {
            if (token !== this.token || this.destroyed) return;
            this.spinner.visible = false;
            this.rankings = r;
            this.rankingsPage = r.page;
            this.layoutDirty = true;
        }).catch(e => {
            if (token !== this.token || this.destroyed) return;
            this.spinner.visible = false;
            this.message.text = e instanceof ApiError ? e.message : 'The wosu! server could not be reached.';
            this.layoutDirty = true;
        });
    }

    private async loadModLog(): Promise<void> {
        try {
            const entries = await this.game.account.modLog(1);
            this.modLogText.text = entries.length ? entries.slice(0, 15).map(e => this.logLine(e)).join('\n') : 'Nothing yet.';
        } catch {
            this.modLogText.text = 'The log could not be loaded.';
        }
        this.layoutDirty = true;
    }

    private logLine(e: ModLogEntry): string {
        const who = e.target ? ` ${e.target.name}` : '';
        return `${relativeDate(e.created)} · ${e.mod.name} ${e.action}${who}${e.detail ? ` (${e.detail})` : ''}${e.reason ? `: ${e.reason}` : ''}`;
    }

    // ------------------------------------------------------------------
    // Header

    private renderHeader(): void {
        const u = this.data?.user ?? null;
        this.nameText.text = u?.name ?? this.playerName ?? 'Global rankings';
        this.roleText.text = u && u.role !== 'user' ? u.role.toUpperCase() : '';
        this.roleText.visible = !!this.roleText.text;
        this.metaText.text = u ? `joined ${joinedDate(u.created)}  ·  last seen ${relativeDate(u.lastSeen)}` : '';
        const own = this.isOwn;
        this.restrictedText.text = u?.restricted ? (own ? `Your account is restricted${u.restrictedReason ? `: ${u.restrictedReason}` : ''}. Scores stay hidden until a moderator lifts it.` : 'This account is restricted.') : '';
        this.statsRow.removeChildren().forEach(ch => ch.destroy({ children: true }));
        this.gradesRow.removeChildren().forEach(ch => ch.destroy({ children: true }));
        if (u) {
            const items = [
                stat('Global rank', u.rank ? `#${formatNumber(u.rank)}` : '—'),
                stat('Performance', `${formatNumber(Math.round(u.pp))}pp`),
                stat('Accuracy', `${(u.accuracy * 100).toFixed(2)}%`),
                stat('Ranked score', formatNumber(u.rankedScore)),
                stat('Play count', formatNumber(u.playCount)),
            ];
            let x = 0;
            for (const it of items) {
                it.x = x;
                x += Math.max(110, it.width + 28);
                this.statsRow.addChild(it);
            }
            const grades = this.data!.grades;
            x = 0;
            for (const g of ['XH', 'X', 'SH', 'S', 'A'] as const) {
                const chip = new Container();
                const pill = new Graphics().roundRect(0, 0, 40, 20, 10).fill(gradeColor(g));
                const t = label(gradeLabel(g), { size: 12, weight: '800', italic: true, color: g.endsWith('H') ? 0x222222 : 0x2a1a00 });
                t.anchor.set(0.5);
                t.position.set(20, 10);
                const n = label(String(grades[g]), { size: 13, weight: '700', shadow: true });
                n.position.set(46, 2);
                chip.addChild(pill, t, n);
                chip.x = x;
                x += 46 + n.width + 18;
                this.gradesRow.addChild(chip);
            }
        }
        this.avatar.setTexture(null);
        this.coverTex = null;
        const token = this.token;
        if (u?.avatarUrl) {
            void this.game.covers.get(u.avatarUrl).then(tex => {
                if (token === this.token && !this.destroyed) this.avatar.setTexture(tex);
            });
        } else if (own) {
            this.avatar.setTexture(this.game.profile.avatar.value);
        }
        if (u?.coverUrl) {
            void this.game.covers.get(u.coverUrl).then(tex => {
                if (token !== this.token || this.destroyed) return;
                this.coverTex = tex;
                this.layoutDirty = true;
            });
        } else if (own) {
            this.coverTex = this.game.profile.cover.value;
        }
        this.layoutDirty = true;
    }

    // ------------------------------------------------------------------
    // Account / moderation actions

    private fillAccount(): void {
        const u = this.game.account.user.value;
        this.emailBox.setValue(u?.email ?? '', false);
        this.emailHint.text = u?.email ? (u.emailVerified ? 'Verified.' : this.game.account.mail.value ? 'Not verified yet: check your inbox for the link.' : 'Saved, unverified (this server cannot send mail yet).') : 'No email on this account.';
        this.emailHint.tint = Colors.grayA;
        this.passHint.text = '';
        this.passCurrent.setValue('', false);
        this.passNew.setValue('', false);
    }

    private async run(fn: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        for (const b of [this.emailSave, this.passSave, this.uploadButton, this.signOutButton, this.modRestrict, this.modRenameButton]) b.enabled = false;
        try {
            await fn();
        } finally {
            this.busy = false;
            for (const b of [this.emailSave, this.passSave, this.uploadButton, this.signOutButton, this.modRestrict, this.modRenameButton]) b.enabled = true;
        }
    }

    private fail(hint: Text, e: unknown, fallback: string): void {
        hint.text = e instanceof ApiError ? e.message : fallback;
        hint.tint = Colors.redLight;
        this.game.uiSounds.play('UI/generic-error');
    }

    private async saveEmail(): Promise<void> {
        await this.run(async () => {
            try {
                const r = await this.game.account.setEmail(this.emailBox.value.trim());
                this.emailBox.blur();
                this.fillAccount();
                if (r.user.email) this.emailHint.text = r.sent ? 'Saved. A verification link is on its way.' : 'Saved (unverified: this server cannot send mail yet).';
                this.game.notifications.success(r.user.email ? 'Email saved.' : 'Email removed.');
            } catch (e) {
                this.fail(this.emailHint, e, 'The wosu! server could not be reached.');
            }
        });
    }

    private async savePassword(): Promise<void> {
        await this.run(async () => {
            try {
                await this.game.account.changePassword(this.passCurrent.value, this.passNew.value);
                this.passCurrent.setValue('', false);
                this.passNew.setValue('', false);
                this.passNew.blur();
                this.passHint.text = 'Password changed. Other devices were signed out.';
                this.passHint.tint = Colors.grayA;
                this.game.notifications.success('Password changed.');
            } catch (e) {
                this.fail(this.passHint, e, 'The wosu! server could not be reached.');
            }
        });
    }

    private async toggleRestrict(): Promise<void> {
        const u = this.data?.user;
        if (!u) return;
        const restrict = !u.restricted;
        const reason = this.modReason.value.trim();
        if (restrict && !reason) {
            this.modHint.text = 'Give a reason first.';
            this.modHint.tint = Colors.redLight;
            return;
        }
        const ok = await this.game.dialog.confirm({
            title: restrict ? `Restrict ${u.name}?` : `Lift ${u.name}'s restriction?`,
            text: restrict ? `Their scores disappear from every leaderboard and the rankings. Reason: ${reason}` : 'Their scores return to the leaderboards.',
            confirmText: restrict ? 'Restrict' : 'Unrestrict',
            cancelText: 'Cancel',
            danger: restrict,
            icon: 'skull',
        });
        if (!ok) return;
        await this.run(async () => {
            try {
                await this.game.account.restrict(u.id, restrict, reason);
                this.modHint.text = restrict ? 'Restricted.' : 'Restriction lifted.';
                this.modHint.tint = Colors.grayA;
                this.modReason.setValue('', false);
                this.load();
                void this.loadModLog();
            } catch (e) {
                this.fail(this.modHint, e, 'The wosu! server could not be reached.');
            }
        });
    }

    private async renamePlayer(): Promise<void> {
        const u = this.data?.user;
        if (!u) return;
        await this.run(async () => {
            try {
                const next = await this.game.account.rename(u.id, this.modRename.value, this.modReason.value.trim());
                this.modRename.setValue('', false);
                this.modHint.text = `Renamed to ${next.name}.`;
                this.modHint.tint = Colors.grayA;
                this.playerName = next.name;
                this.load();
                void this.loadModLog();
            } catch (e) {
                this.fail(this.modHint, e, 'The wosu! server could not be reached.');
            }
        });
    }

    /** A moderator's context action on a play row. */
    private async deletePlay(s: OnlineScore): Promise<void> {
        const ok = await this.game.dialog.confirm({
            title: 'Delete this score?',
            text: `${s.player}'s ${(s.accuracy * 100).toFixed(2)}% on ${s.title} [${s.version}] is removed from the server, replay included.`,
            confirmText: 'Delete it',
            cancelText: 'Keep it',
            danger: true,
            icon: 'trash',
        });
        if (!ok) return;
        try {
            await this.game.account.deleteScore(s.id, this.modReason.value.trim());
            this.game.notifications.success('Score deleted.');
            this.load();
        } catch (e) {
            this.game.notifications.error(e instanceof ApiError ? e.message : 'The wosu! server could not be reached.');
        }
    }

    // ------------------------------------------------------------------
    // Layout

    protected layout(w: number, h: number): void {
        this.viewW = w;
        this.viewH = h;
        const top = this.game.toolbarOffset;
        const ph = Math.max(0, h - top);
        this.panel.y = top;
        this.panel.hitArea = { contains: (x: number, y: number) => x >= 0 && x <= w && y >= 0 && y <= ph };
        this.panelBg.clear().rect(0, 0, w, ph).fill(this.colors.background4);
        this.scroll.resize(w, ph);
        for (const [i, wave] of this.waves.entries()) {
            const angle = [0.12, -0.08, 0.05, -0.025][i];
            wave.clear().rect(-w * 0.8, 0, w * 1.6, h * 1.6).fill(0xffffff);
            wave.rotation = angle;
            wave.x = w / 2;
        }
        this.layoutDirty = true;
        this.layoutContent();
    }

    private layoutContent(): void {
        this.layoutDirty = false;
        const w = this.viewW;
        if (w <= 0) return;
        const pad = w >= 900 ? 40 : 16;
        const cw = Math.min(MAX_W, w - pad * 2);
        this.content.x = Math.round((w - cw) / 2);
        // Cover
        const g = this.cover.clear();
        if (this.coverTex && !this.coverTex.destroyed) fillCover(g, this.coverTex, 0, 0, cw, COVER_H, 12, { corners: 'top' });
        else g.roundRect(0, 0, cw, COVER_H, 12).fill(this.colors.dark3);
        this.coverTris.visible = !this.coverTex;
        this.coverTris.resize(cw, COVER_H);
        this.coverShade.clear().rect(0, COVER_H * 0.3, cw, COVER_H * 0.7).fill({ color: 0x000000, alpha: 0.55 });
        this.avatar.position.set(24, COVER_H - AVATAR - 20);
        const textX = 24 + AVATAR + 20;
        fitText(this.nameText, cw - textX - 130, this.nameText.text);
        this.nameText.position.set(textX, COVER_H - 86);
        this.roleText.position.set(textX + this.nameText.width + 12, COVER_H - 74);
        this.metaText.position.set(textX, COVER_H - 44);
        this.closeButton.position.set(cw - 112, 12);
        // Stats strip under the cover
        let y = COVER_H;
        const hasStats = this.statsRow.children.length > 0;
        const stripH = hasStats ? 92 : 0;
        this.headerBg.visible = hasStats;
        this.headerBg.resize(cw, stripH).position.set(0, y);
        this.statsRow.position.set(24, y + 14);
        this.gradesRow.position.set(24, y + 60);
        this.restrictedText.visible = !!this.restrictedText.text;
        y += stripH;
        if (this.restrictedText.visible) {
            this.restrictedText.position.set(24, y + 10);
            fitText(this.restrictedText, cw - 48, this.restrictedText.text);
            y += 36;
        }
        // Tabs
        this.tabs.position.set(24, y + 6);
        this.tabs.resize(cw - 48, this.tabs.measure(cw - 48));
        const tabsH = this.tabs.h + 12;
        this.tabsBg.clear().rect(0, y + tabsH - 1, cw, 1).fill({ color: 0xffffff, alpha: 0.12 });
        y += tabsH + 12;
        // Body
        this.body.position.set(0, y);
        const bodyH = this.layoutBody(cw);
        this.scroll.contentHeight = y + bodyH;
    }

    private layoutBody(cw: number): number {
        const tab = this.tab;
        const padX = 24;
        const innerW = cw - padX * 2;
        this.account.visible = tab === 'account';
        this.moderation.visible = tab === 'moderation';
        this.pager.visible = tab === 'rankings' && !!this.rankings && this.rankings.pages > 1;
        this.spinner.position.set(cw / 2 - 16, 20);
        this.message.position.set(cw / 2, 24);
        for (const r of this.playRows) r.visible = false;
        for (const r of this.rankRows) r.visible = false;
        let y = 0;
        if (this.message.text && (tab === 'best' || tab === 'recent' || tab === 'rankings')) y = 60;
        if (tab === 'best' || tab === 'recent') {
            const plays = this.data ? (tab === 'best' ? this.data.best : this.data.recent) : [];
            if (this.data && plays.length === 0 && !this.message.text) {
                this.message.text = tab === 'best' ? 'No ranked plays yet.' : 'No plays yet.';
                y = 60;
            }
            plays.forEach((s, i) => {
                let row = this.playRows[i];
                if (!row) {
                    row = new PlayRow(this.colors);
                    row.onActivate = () => {
                        const p = row.current;
                        if (p && p.mods.length) this.game.mods.value = sanitizeMods(p.mods, p.modSettings);
                    };
                    row.on('rightclick', () => {
                        const p = row.current;
                        if (p && this.game.account.isMod) void this.deletePlay(p);
                    });
                    this.playRows.push(row);
                    this.body.addChild(row);
                }
                row.visible = true;
                row.assign(s, i + 1);
                row.resize(innerW, ROW_H).position.set(padX, y);
                y += ROW_H + ROW_GAP;
            });
        } else if (tab === 'rankings') {
            const list = this.rankings?.users ?? [];
            if (this.rankings && list.length === 0 && !this.message.text) {
                this.message.text = 'Nobody has submitted a play yet. Be the first!';
                y = 60;
            }
            list.forEach((u, i) => {
                let row = this.rankRows[i];
                if (!row) {
                    row = new RankRow(this.game, this.colors, () => this.game.account.user.value?.name ?? null);
                    row.onActivate = () => {
                        if (row.user) this.open(row.user.name, 'best');
                    };
                    this.rankRows.push(row);
                    this.body.addChild(row as Container);
                }
                row.visible = true;
                row.assign(u);
                row.resize(innerW, 46).position.set(padX, y);
                y += 46 + ROW_GAP;
            });
            if (this.pager.visible && this.rankings) {
                y += 10;
                this.pagePrev.position.set(padX, 0);
                this.pageNext.position.set(cw - padX - 120, 0);
                this.pageText.position.set(cw / 2, 17);
                this.pageText.text = `page ${this.rankings.page} of ${this.rankings.pages}  ·  ${formatNumber(this.rankings.total)} players`;
                this.pagePrev.enabled = this.rankings.page > 1;
                this.pageNext.enabled = this.rankings.page < this.rankings.pages;
                this.pager.position.set(0, y);
                y += 44;
            }
        } else if (tab === 'account') {
            this.account.position.set(padX, 8);
            y = 8 + this.account.height + 10;
        } else if (tab === 'moderation') {
            this.modRestrict.caption = this.data?.user.restricted ? 'Unrestrict' : 'Restrict';
            this.moderation.position.set(padX, 8);
            y = 8 + this.moderation.height + 10;
        }
        return Math.max(y, 80);
    }

    override update(dt: number): void {
        if (this.layoutDirty) this.layoutContent();
        void dt;
    }

    // ------------------------------------------------------------------
    // Show / hide

    protected popIn(): void {
        this.relayout();
        const h = this.viewH;
        const top = this.game.toolbarOffset;
        this.waves.forEach((wave, i) => {
            wave.visible = true;
            wave.y = h + 40;
            tween(wave, { y: top - 30 + i * 8 }, { duration: 700, delay: i * 60, ease: 'OutQuint' });
        });
        this.panel.y = h;
        tween(this.panel, { y: top }, { duration: 800, delay: 180, ease: 'OutQuint' }).finished.then(() => {
            if (this.isOpen) for (const wave of this.waves) wave.visible = false;
        });
    }

    protected async popOut(): Promise<void> {
        for (const box of [this.emailBox, this.passCurrent, this.passNew, this.modReason, this.modRename]) box.blur();
        const h = this.viewH;
        tween(this.panel, { y: h + 40 }, { duration: 500, ease: 'InQuad' });
        let last: Promise<void> = Promise.resolve();
        this.waves.forEach((wave, i) => {
            wave.visible = true;
            last = tween(wave, { y: h + 40 }, { duration: 500, delay: (this.waves.length - i) * 50, ease: 'InQuad' }).finished;
        });
        await last;
        if (!this.isOpen) for (const wave of this.waves) wave.visible = false;
    }

    override onKey(e: KeyboardEvent, action: Action | null): boolean {
        if (super.onKey(e, action)) return true;
        switch (action) {
            case 'pageUp': this.scroll.scrollTo(this.scroll.scrollY - this.scroll.h * 0.8); return true;
            case 'pageDown': this.scroll.scrollTo(this.scroll.scrollY + this.scroll.h * 0.8); return true;
            case 'home': this.scroll.scrollTo(0); return true;
            case 'end': this.scroll.scrollTo(this.scroll.maxScroll); return true;
            default: return (action !== null && SWALLOWED.has(action)) || (!e.ctrlKey && !e.metaKey && e.key.length === 1);
        }
    }
}
