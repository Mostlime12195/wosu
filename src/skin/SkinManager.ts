import { resolveAssetUrl } from '../audio/base';
import { OszArchive } from '../beatmap/archive';
import { Bindable } from '../core/Bindable';
import type { NotificationManager } from '../overlays/notifications/Notifications';
import { SkinStore, type StoredSkin } from '../storage/SkinStore';
import { LegacySkin, type SkinFiles } from './LegacySkin';
import { SkinChain, type SkinLayer } from './SkinChain';
import { classifyArchive, exportFilename, isSkinFilename, readSkinArchive, skinId } from './SkinImport';

/** wosu!'s default skin: an ordinary osu!-format skin served from public/assets/skins/default. */
export const DEFAULT_SKIN_URL = 'assets/skins/default/';

/** Files fetched from a folder that has a manifest.json listing them. */
export async function fetchedSkinFiles(baseUrl: string): Promise<SkinFiles> {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const res = await fetch(`${base}manifest.json`);
    if (!res.ok) throw new Error(`skin manifest missing at ${base}`);
    const { files } = (await res.json()) as { files: string[] };
    return {
        files,
        async readBytes(path: string) {
            const r = await fetch(`${base}${encodeURI(path)}`);
            if (!r.ok) throw new Error(`skin file ${path}: ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        },
    };
}

/** What the skin manager needs from the game (Game satisfies it). */
export interface SkinHost {
    readonly settings: { readonly skin: Bindable<string> };
    readonly notifications: Pick<NotificationManager, 'progress' | 'error'>;
    readonly audio: { readonly context: BaseAudioContext };
    readonly screens: {
        readonly screens: readonly { readonly showMenuCursor: boolean }[];
        readonly changed: { add(fn: () => void): () => void };
    };
}

/** Files sorted by what the importer should do with them. */
export interface ImportPartition {
    skins: File[];
    beatmaps: File[];
    rejected: File[];
}

/** ms a retired skin outlives the screen that used it (exit transitions still draw it). */
const DISPOSE_DELAY = 1500;

/**
 * The skins the game knows (lazer's SkinManager): the built-in default
 * (always the last layer), the imported skins stored in IndexedDB, and
 * the selected one (null = the default only). Gameplay asks for a chain,
 * optionally topped by the current beatmap's skin, when a play starts, so
 * a switch applies from the next play on.
 */
export class SkinManager {
    private defaultSkin: LegacySkin | null = null;
    /** The selected skin (imported .osk), or null for wosu!'s default. */
    readonly current = new Bindable<LegacySkin | null>(null);
    /** Stored metadata of the selected skin (null = default). */
    readonly currentInfo = new Bindable<StoredSkin | null>(null);
    /** A selected skin is being read and decoded. */
    readonly loading = new Bindable(false);

    private host: SkinHost | null = null;
    private loadToken = 0;
    /** Skins no longer selected, waiting until nothing draws them. */
    private readonly retired = new Set<LegacySkin>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly store: SkinStore = new SkinStore()) {}

    get default(): LegacySkin {
        if (!this.defaultSkin) throw new Error('default skin not loaded');
        return this.defaultSkin;
    }

    get loaded(): boolean {
        return !!this.defaultSkin;
    }

    /** Imported skins, sorted by name. */
    get imported(): readonly StoredSkin[] {
        return this.store.list;
    }

    /**
     * Load the default skin. Its hitsounds stay with the SampleBank (same
     * files), so only images and skin.ini are read here.
     */
    async loadDefault(): Promise<void> {
        const files = await fetchedSkinFiles(resolveAssetUrl(DEFAULT_SKIN_URL));
        this.defaultSkin = await LegacySkin.load(files, null, { samples: false });
    }

    /** The chain for gameplay (and the cursor/HUD): [beatmap?] → selected → default. */
    chain(beatmap: SkinLayer | null = null): SkinChain {
        const layers: SkinLayer[] = [];
        if (beatmap) layers.push(beatmap);
        const user = this.current.value;
        if (user) layers.push({ skin: user });
        layers.push({ skin: this.default, samples: false });
        return new SkinChain(layers);
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------

    /**
     * Wire up to the game: read the stored skins, then follow the
     * persisted selection (lazer's OsuSetting.Skin), loading it now.
     */
    async attach(host: SkinHost): Promise<void> {
        this.host = host;
        try {
            await this.store.init();
        } catch (e) {
            console.warn('[skins] store unavailable', e);
        }
        host.screens.changed.add(() => this.scheduleFlush());
        // A deleted skin can't stay selected.
        this.store.changed.add(() => {
            const id = host.settings.skin.value;
            if (id && !this.store.get(id)) host.settings.skin.value = '';
            else if (id && this.currentInfo.value?.id === id) this.currentInfo.value = this.store.get(id) ?? null;
        });
        host.settings.skin.bind(id => void this.select(id), true);
    }

    /** Select a stored skin by id ('' = default). Persists through settings. */
    selectId(id: string): void {
        if (this.host) this.host.settings.skin.value = id;
    }

    /** lazer's SelectRandomSkin: any other skin, the default included. */
    selectRandom(): void {
        const cur = this.host?.settings.skin.value ?? '';
        const options = ['', ...this.store.list.map(s => s.id)].filter(id => id !== cur);
        if (options.length) this.selectId(options[Math.floor(Math.random() * options.length)]);
    }

    private async select(id: string, force = false): Promise<void> {
        const host = this.host;
        if (!host) return;
        const token = ++this.loadToken;
        if (!id) {
            this.loading.value = false;
            this.setCurrent(null, null);
            return;
        }
        if (!force && this.currentInfo.value?.id === id && this.current.value) {
            this.loading.value = false;
            return;
        }
        const info = this.store.get(id);
        if (!info) {
            console.warn(`[skins] selected skin ${id} is not stored; using the default`);
            host.settings.skin.value = '';
            return;
        }
        this.loading.value = true;
        try {
            const blob = await this.store.blob(id);
            if (!blob) throw new Error('its files are missing');
            const archive = await OszArchive.open(blob);
            const skin = await LegacySkin.load(archive, host.audio.context);
            if (token !== this.loadToken) {
                skin.destroy();
                return;
            }
            this.setCurrent(skin, info);
        } catch (e) {
            if (token !== this.loadToken) return;
            console.warn(`[skins] loading "${info.name}" failed`, e);
            host.notifications.error(`Couldn't load the skin "${info.name}", so the default skin is used instead.`);
            host.settings.skin.value = '';
        } finally {
            if (token === this.loadToken) this.loading.value = false;
        }
    }

    private setCurrent(skin: LegacySkin | null, info: StoredSkin | null): void {
        const previous = this.current.value;
        this.currentInfo.value = info;
        this.current.value = skin;
        if (previous && previous !== skin) {
            this.retired.add(previous);
            this.scheduleFlush();
        }
    }

    // ------------------------------------------------------------------
    // Texture lifetime
    // ------------------------------------------------------------------

    /** A gameplay screen (draws its own cursor) is anywhere in the stack, e.g. paused under settings. */
    private get gameplayActive(): boolean {
        return this.host?.screens.screens.some(s => !s.showMenuCursor) ?? false;
    }

    private scheduleFlush(): void {
        if (this.flushTimer || !this.retired.size) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushRetired();
        }, DISPOSE_DELAY);
    }

    /**
     * Destroy retired skins once nothing can draw them: a play started
     * with a skin keeps it until it ends, even when the skin is switched
     * while paused (the switch applies from the next play).
     */
    private flushRetired(): void {
        if (this.gameplayActive) return;
        for (const skin of [...this.retired]) {
            this.retired.delete(skin);
            if (skin !== this.current.value) skin.destroy();
        }
    }

    // ------------------------------------------------------------------
    // Import / export / delete
    // ------------------------------------------------------------------

    /** Sort dropped or picked files: .osk → skin, .osz → beatmap, .zip by its contents. */
    async partition(files: readonly File[]): Promise<ImportPartition> {
        const out: ImportPartition = { skins: [], beatmaps: [], rejected: [] };
        for (const f of files) {
            if (isSkinFilename(f.name)) out.skins.push(f);
            else if (/\.osz$/i.test(f.name)) out.beatmaps.push(f);
            else if (/\.zip$/i.test(f.name)) {
                let skin = false;
                try {
                    skin = classifyArchive((await OszArchive.open(f)).files, f.name) === 'skin';
                } catch {
                    /* the beatmap importer reports broken zips */
                }
                (skin ? out.skins : out.beatmaps).push(f);
            } else out.rejected.push(f);
        }
        return out;
    }

    /** Store one skin archive; the same skin imported again replaces the stored copy. */
    async importSkin(data: Blob, filename: string): Promise<StoredSkin> {
        const { meta } = await readSkinArchive(data, filename);
        const info = await this.store.put({
            id: skinId(meta),
            name: meta.name,
            author: meta.author,
            filename,
            addedAt: Date.now(),
            sizeBytes: data.size,
        }, data);
        // Re-imported over the selected skin: load the new files.
        if (this.host?.settings.skin.value === info.id) void this.select(info.id, true);
        return info;
    }

    /** Import with notifications (lazer's "Imported X! Click to view.", which selects it). */
    async importFiles(files: readonly File[]): Promise<StoredSkin[]> {
        const notes = this.host?.notifications;
        const n = notes?.progress(`Importing ${files.length} skin${files.length > 1 ? 's' : ''}…`);
        if (n) n.progress.value = NaN;
        const ok: StoredSkin[] = [];
        const failed: { name: string; error: string }[] = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            try {
                ok.push(await this.importSkin(f, f.name));
            } catch (e) {
                failed.push({ name: f.name, error: e instanceof Error ? e.message : String(e) });
            }
            if (n && files.length > 1) n.progress.value = (i + 1) / files.length;
        }
        if (n) {
            if (ok.length) {
                const text = failed.length
                    ? `Imported ${ok.length} of ${files.length} skins.`
                    : ok.length > 1 ? `Imported ${ok.length} skins!` : `Imported ${ok[0].name}!`;
                n.complete(`${text} Click to view.`, () => this.selectId(ok[0].id));
            } else {
                n.fail('Skin import failed.');
            }
        }
        for (const f of failed) notes?.error(`${f.name}: ${f.error}`);
        return ok;
    }

    /** Download a stored skin as .osk. */
    async exportSkin(id: string): Promise<void> {
        const info = this.store.get(id);
        const blob = info ? await this.store.blob(id) : null;
        if (!info || !blob) throw new Error('The skin files are missing');
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/x-osu-skin' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = exportFilename(info);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    /** Delete a stored skin; the selected one switches to the default first (as lazer does). */
    async deleteSkin(id: string): Promise<void> {
        if (this.host?.settings.skin.value === id) this.selectId('');
        await this.store.delete(id);
    }
}
