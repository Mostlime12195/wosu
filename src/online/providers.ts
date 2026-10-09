/**
 * Beatmap mirror registry (port of the old scripts/config.js).
 *
 * Browsing (list/search/info) and downloading each use SayoBot, Mino
 * (catboy.best) or NeriNyan. NeriNyan offers downloads only: its search
 * API is unreachable, so it is never used for browsing.
 *
 * Covers and audio previews ALWAYS come from SayoBot's CDN regardless of
 * provider: it is the only host that sends `Access-Control-Allow-Origin`,
 * and a WebGL/WebGPU texture (or an AnalyserNode-routed audio element)
 * cannot be built from a cross-origin resource without CORS.
 */

export type ProviderId = 'sayobot' | 'mino' | 'nerinyan';
export type ListKind = 'latest' | 'popular' | 'random' | 'search' | 'genre';

export interface OnlineDifficulty {
    bid: number;
    mode: number;
    stars: number;
    version: string;
    creator: string;
    /** Drain/total length in seconds. */
    length: number;
    bpm: number;
    cs?: number;
    ar?: number;
    od?: number;
    hp?: number;
    maxCombo?: number;
}

export interface OnlineSet {
    sid: number;
    title: string;
    titleUnicode?: string;
    artist: string;
    artistUnicode?: string;
    creator: string;
    /** Ranked status: 4 loved, 3 qualified, 2 approved, 1 ranked, 0 pending, -1 WIP, -2 graveyard. */
    approved: number;
    /** Bitmask of game modes present; bit 0 = osu!standard. */
    modes: number;
    video: boolean;
    playCount: number;
    favouriteCount?: number;
    genreId?: number;
    languageId?: number;
    bpm?: number;
    source?: string;
    tags?: string;
    difficulties?: OnlineDifficulty[];
}

export interface ListRequest {
    kind: ListKind;
    offset: number;
    limit: number;
    keyword: string;
    /** SayoBot-style genre bitmask sum (1 = all). */
    genre?: number | null;
    /** SayoBot-style language bitmask sum (1 = all). */
    lang?: number | null;
}

export interface ListUrl {
    url: string;
    /** Rows requested from the API (may exceed `limit`, e.g. Mino popular). */
    fetchSize: number;
}

export interface Provider {
    readonly id: ProviderId;
    readonly name: string;
    /** Usable for list/search/info. */
    readonly browse: boolean;
    downloadUrl(sid: number, withVideo: boolean): string;
    listUrl(req: ListRequest): ListUrl;
    /** Difficulty details for one set. */
    infoUrl(sid: number): string;
    /** Set metadata plus difficulties. */
    setInfoUrl(sid: number): string;
    /** Rows the API returned (before filtering) — short pages mean end of data. */
    rawCount(json: unknown): number;
    normalizeList(json: unknown, req: ListRequest & { fetchSize: number }): OnlineSet[];
    normalizeDifficulties(json: unknown): OnlineDifficulty[];
    normalizeSet(json: unknown): OnlineSet | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SAYO_CDN = 'https://cdn.sayobot.cn:25225';

/** CORS-enabled cover image (webp; jpg for engines without webp). */
export function coverUrl(sid: number, format: 'webp' | 'jpg' = 'webp'): string {
    return `${SAYO_CDN}/beatmaps/${sid}/covers/cover.${format}`;
}

/** CORS-enabled ~10 s audio preview. */
export function previewUrl(sid: number): string {
    return `${SAYO_CDN}/preview/${sid}.mp3`;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
function n(v: unknown, fallback = 0): number {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(x) ? x : fallback;
}
const optNum = (v: unknown): number | undefined => {
    const x = n(v, NaN);
    return Number.isFinite(x) ? x : undefined;
};
const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/**
 * Parse selector values like "2+64+256" into a bitmask sum (the old pages
 * eval()'d these). Returns null for empty/junk input.
 */
export function parseMaskSum(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let sum = 0;
    let any = false;
    for (const part of String(v).split('+')) {
        const p = part.trim();
        if (!p) continue;
        const x = Number(p);
        if (!Number.isFinite(x)) return null;
        sum += x;
        any = true;
    }
    return any ? sum : null;
}

/** SayoBot genre bitmask -> osu! genre_id list (null = no filter). */
export function minoGenreIds(mask: number | null | undefined): number[] | null {
    // 1=All, 4=Games, 8=Animation, 16=Rock, 128=Novelty, 1024=Electronic.
    // 32 (SayoBot "Popular") and the combined "Others" have no v2 equivalent.
    switch (mask) {
        case 4: return [2];
        case 8: return [3];
        case 16: return [4];
        case 128: return [7];
        case 1024: return [10];
        default: return null;
    }
}

/** SayoBot language bitmask -> osu! language_id list (null = no filter). */
export function minoLangIds(mask: number | null | undefined): number[] | null {
    // 1=All, 32=Instrumental, 4=English, 8=Japanese, 64=Korean,
    // 16=Chinese, 128=French, 256=German.
    switch (mask) {
        case 32: return [5];
        case 4: return [2];
        case 8: return [3];
        case 64: return [6];
        case 16: return [4];
        case 128: return [7];
        case 256: return [8];
        default: return null;
    }
}

export const isStandardSet = (s: OnlineSet): boolean => (s.modes & 1) !== 0;

/** Ranked-status predicate for list filters ('any' = no filter). */
export function statusFilter(code: string | number | null | undefined): ((s: OnlineSet) => boolean) | null {
    if (code === 'any' || code === '' || code === null || code === undefined) return null;
    const x = Number(code);
    if (!Number.isFinite(x)) return null;
    return s => s.approved === x;
}

export function approvedText(status: number): string {
    switch (status) {
        case 4: return 'LOVED';
        case 3: return 'QUALIFIED';
        case 2: return 'APPROVED';
        case 1: return 'RANKED';
        case 0: return 'PENDING';
        case -1: return 'WIP';
        case -2: return 'GRAVEYARD';
        default: return 'UNKNOWN';
    }
}

// ---------------------------------------------------------------------------
// SayoBot
// ---------------------------------------------------------------------------

function sayoDifficulty(d: Json, fallbackCreator = ''): OnlineDifficulty {
    return {
        bid: n(d.bid),
        mode: n(d.mode),
        stars: n(d.star),
        version: str(d.version),
        creator: str(d.creator) || fallbackCreator,
        length: n(d.length),
        bpm: n(d.BPM ?? d.bpm),
        cs: optNum(d.CS),
        ar: optNum(d.AR),
        od: optNum(d.OD),
        hp: optNum(d.HP),
        maxCombo: optNum(d.maxcombo),
    };
}

function sayoListRow(r: Json): OnlineSet {
    return {
        sid: n(r.sid),
        title: str(r.title),
        titleUnicode: str(r.titleU) || undefined,
        artist: str(r.artist),
        artistUnicode: str(r.artistU) || undefined,
        creator: str(r.creator),
        approved: n(r.approved),
        modes: n(r.modes),
        // SayoBot lists never flag videos (the known-video registry fills in).
        video: truthy(r.video),
        playCount: n(r.play_count),
        favouriteCount: optNum(r.favourite_count),
    };
}

const sayobot: Provider = {
    id: 'sayobot',
    name: 'SayoBot',
    browse: true,
    // "mini" builds exclude video; SayoBot has no verified full variant.
    downloadUrl: (sid) => `https://txy1.sayobot.cn/beatmaps/download/mini/${sid}`,
    listUrl(o) {
        const base = 'https://api.sayobot.cn/beatmaplist';
        switch (o.kind) {
            case 'latest':
                return { url: `${base}?0=${o.limit}&1=${o.offset}&2=2&5=1`, fetchSize: o.limit };
            case 'popular':
            case 'random':
                return { url: `${base}?0=${o.limit}&1=${o.offset}&2=1&5=1`, fetchSize: o.limit };
            case 'search':
                return { url: `${base}?0=${o.limit}&1=${o.offset}&2=4&3=${encodeURIComponent(o.keyword)}&5=1`, fetchSize: o.limit };
            case 'genre':
                return { url: `${base}?0=${o.limit}&1=${o.offset}&2=4&5=1&7=${o.genre ?? 1}&8=${o.lang ?? 1}`, fetchSize: o.limit };
        }
    },
    infoUrl: (sid) => `https://api.sayobot.cn/beatmapinfo?1=${sid}`,
    setInfoUrl: (sid) => `https://api.sayobot.cn/v2/beatmapinfo?0=${sid}`,
    rawCount: (json) => (isObj(json) && Array.isArray(json.data) ? json.data.length : 0),
    normalizeList(json, o) {
        const rows = isObj(json) && Array.isArray(json.data) ? json.data : [];
        return rows.filter(isObj).map(sayoListRow).filter(s => s.sid > 0).slice(0, o.limit);
    },
    normalizeDifficulties(json) {
        const rows = isObj(json) && Array.isArray(json.data) ? json.data : [];
        return rows.filter(isObj).map(d => sayoDifficulty(d));
    },
    normalizeSet(json) {
        if (!isObj(json) || n(json.status, -1) !== 0 || !isObj(json.data)) return null;
        const d = json.data;
        const creator = str(d.creator);
        const diffs = Array.isArray(d.bid_data) ? d.bid_data.filter(isObj).map(x => sayoDifficulty(x, creator)) : [];
        let modes = 0;
        for (const x of diffs) modes |= 1 << x.mode;
        const sid = n(d.sid);
        if (!(sid > 0)) return null;
        // v2 only reports play counts per difficulty.
        const playCount = Array.isArray(d.bid_data)
            ? d.bid_data.filter(isObj).reduce((sum, x) => sum + n(x.playcount), 0)
            : 0;
        return {
            sid,
            title: str(d.title),
            titleUnicode: str(d.titleU) || undefined,
            artist: str(d.artist),
            artistUnicode: str(d.artistU) || undefined,
            creator,
            approved: n(d.approved),
            modes,
            video: truthy(d.video),
            playCount,
            favouriteCount: optNum(d.favourite_count),
            genreId: optNum(d.genre),
            languageId: optNum(d.language),
            bpm: optNum(d.bpm),
            source: str(d.source) || undefined,
            tags: str(d.tags) || undefined,
            difficulties: diffs,
        };
    },
};

// ---------------------------------------------------------------------------
// Mino (catboy.best, osu!api-v2 shaped)
// ---------------------------------------------------------------------------

function minoModes(set: Json): number {
    let m = 0;
    for (const b of Array.isArray(set.beatmaps) ? set.beatmaps : []) {
        if (isObj(b)) m |= 1 << n(b.mode_int);
    }
    return m;
}

function minoDifficulties(set: Json): OnlineDifficulty[] {
    const creator = str(set.creator);
    return (Array.isArray(set.beatmaps) ? set.beatmaps : []).filter(isObj).map(b => ({
        bid: n(b.id),
        mode: n(b.mode_int),
        stars: n(b.difficulty_rating),
        version: str(b.version),
        creator,
        length: n(b.total_length),
        bpm: n(b.bpm),
        cs: optNum(b.cs),
        ar: optNum(b.ar),
        od: optNum(b.accuracy),
        hp: optNum(b.drain),
        maxCombo: optNum(b.max_combo),
    }));
}

function minoSet(set: Json, withDifficulties: boolean): OnlineSet {
    const out: OnlineSet = {
        sid: n(set.id),
        title: str(set.title),
        titleUnicode: str(set.title_unicode) || undefined,
        artist: str(set.artist),
        artistUnicode: str(set.artist_unicode) || undefined,
        creator: str(set.creator),
        approved: n(set.ranked),
        modes: minoModes(set),
        video: truthy(set.video),
        playCount: n(set.play_count),
        favouriteCount: optNum(set.favourite_count),
        genreId: optNum(set.genre_id),
        languageId: optNum(set.language_id),
        bpm: optNum(set.bpm),
        source: str(set.source) || undefined,
        tags: str(set.tags) || undefined,
    };
    if (withDifficulties) out.difficulties = minoDifficulties(set);
    return out;
}

function minoRows(json: unknown): Json[] {
    if (Array.isArray(json)) return json.filter(isObj);
    if (isObj(json) && Array.isArray(json.beatmapsets)) return json.beatmapsets.filter(isObj);
    return [];
}

function minoSingle(json: unknown): Json | null {
    const set = Array.isArray(json) ? json[0] : json;
    return isObj(set) && n(set.id) > 0 ? set : null;
}

const mino: Provider = {
    id: 'mino',
    name: 'Mino',
    browse: true,
    // "n" suffix strips the video (verified: 18MB -> 4MB on a video map).
    downloadUrl: (sid, withVideo) => (withVideo ? `https://catboy.best/d/${sid}` : `https://catboy.best/d/${sid}n`),
    listUrl(o) {
        // Popular is sorted client-side from 100-row batches (no play-count
        // order in the API); random jumps to a random page.
        const fetchSize = o.kind === 'popular' ? 100 : o.limit;
        const page = o.kind === 'random' ? Math.floor(Math.random() * 50) : Math.floor(o.offset / fetchSize);
        let url = `https://catboy.best/api/v2/search?limit=${fetchSize}&p=${page}&mode=0`;
        if (o.kind === 'search') url += '&query=' + encodeURIComponent(o.keyword);
        return { url, fetchSize };
    },
    infoUrl: (sid) => `https://catboy.best/api/v2/s/${sid}`,
    setInfoUrl: (sid) => `https://catboy.best/api/v2/s/${sid}`,
    rawCount: (json) => minoRows(json).length,
    normalizeList(json, o) {
        let rows = minoRows(json).slice();
        if (o.kind === 'genre') {
            const g = minoGenreIds(o.genre), l = minoLangIds(o.lang);
            if (g) rows = rows.filter(s => g.includes(n(s.genre_id)));
            if (l) rows = rows.filter(s => l.includes(n(s.language_id)));
        }
        if (o.kind === 'popular') rows.sort((a, b) => n(b.play_count) - n(a.play_count));
        const start = o.kind === 'random' ? 0 : o.offset % o.fetchSize;
        // Search results already include difficulties: keep them (saves a lookup).
        return rows.slice(start, start + o.limit).map(s => minoSet(s, true));
    },
    normalizeDifficulties(json) {
        const set = minoSingle(json);
        return set ? minoDifficulties(set) : [];
    },
    normalizeSet(json) {
        const set = minoSingle(json);
        return set ? minoSet(set, true) : null;
    },
};

// ---------------------------------------------------------------------------
// NeriNyan (downloads only)
// ---------------------------------------------------------------------------

const nerinyan: Provider = {
    id: 'nerinyan',
    name: 'NeriNyan',
    browse: false,
    downloadUrl: (sid, withVideo) =>
        withVideo ? `https://api.nerinyan.moe/d/${sid}` : `https://api.nerinyan.moe/d/${sid}?noVideo=1`,
    listUrl() {
        throw new Error('NeriNyan offers no browse API');
    },
    infoUrl() {
        throw new Error('NeriNyan offers no info API');
    },
    setInfoUrl() {
        throw new Error('NeriNyan offers no info API');
    },
    rawCount: () => 0,
    normalizeList: () => [],
    normalizeDifficulties: () => [],
    normalizeSet: () => null,
};

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = { sayobot, mino, nerinyan };

export const DEFAULT_BROWSE: ProviderId = 'sayobot';
export const DEFAULT_DOWNLOAD: ProviderId = 'mino';

export interface ResolvedProviders {
    browse: Provider;
    download: Provider;
    browseId: ProviderId;
    downloadId: ProviderId;
}

function isProviderId(id: unknown): id is ProviderId {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * Sanitize stored choices exactly like the old `currentProviders`:
 * missing values take the defaults, a browse choice that can't browse
 * falls back to SayoBot, and an unknown download id falls back to SayoBot.
 */
export function resolveProviders(browseId?: string | null, downloadId?: string | null): ResolvedProviders {
    let b: string = browseId || DEFAULT_BROWSE;
    let d: string = downloadId || DEFAULT_DOWNLOAD;
    if (!isProviderId(b) || !PROVIDERS[b].browse) b = 'sayobot';
    if (!isProviderId(d)) d = 'sayobot';
    const bid = b as ProviderId, did = d as ProviderId;
    return { browse: PROVIDERS[bid], download: PROVIDERS[did], browseId: bid, downloadId: did };
}

export function downloadUrl(provider: Provider, sid: number, withVideo: boolean): string {
    return provider.downloadUrl(sid, withVideo);
}

/** Providers selectable for browsing / downloading (settings dropdowns). */
export const browseProviders = (): Provider[] => Object.values(PROVIDERS).filter(p => p.browse);
export const downloadProviders = (): Provider[] => Object.values(PROVIDERS);
