import { resolveAssetUrl } from '../audio/base';
import { Bindable } from '../core/Bindable';
import { LegacySkin, type SkinFiles } from './LegacySkin';
import { SkinChain, type SkinLayer } from './SkinChain';

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

/**
 * The skins the game knows: the built-in default (always the last layer)
 * and the user's selected skin (null = the default only). Gameplay asks
 * for a chain, optionally topped by the current beatmap's skin.
 */
export class SkinManager {
    private defaultSkin: LegacySkin | null = null;
    /** The selected skin (imported .osk), or null for wosu!'s default. */
    readonly current = new Bindable<LegacySkin | null>(null);

    get default(): LegacySkin {
        if (!this.defaultSkin) throw new Error('default skin not loaded');
        return this.defaultSkin;
    }

    get loaded(): boolean {
        return !!this.defaultSkin;
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
}
