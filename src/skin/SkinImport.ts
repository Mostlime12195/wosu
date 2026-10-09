/**
 * Recognising and naming imported skins (lazer's SkinImporter), kept free
 * of Pixi and IndexedDB so it runs headlessly.
 */
import { OszArchive } from '../beatmap/archive';
import { parseSkinIni, type SkinConfig } from './SkinIni';

/** What an archive holds: a skin, a beatmap set, or neither. */
export type ArchiveKind = 'skin' | 'beatmap' | 'unknown';

/** Name and author shown in the skin dropdown. */
export interface SkinMetadata {
    name: string;
    author: string;
}

/** lazer's creator placeholder when skin.ini has no Author. */
export const UNKNOWN_AUTHOR = 'Unknown';

export function isSkinFilename(name: string): boolean {
    return /\.osk$/i.test(name);
}

/** Files the importer accepts at all (.osz beatmaps, .osk skins, zips of either). */
export function isImportableFilename(name: string): boolean {
    return /\.(osz|osk|zip)$/i.test(name);
}

const norm = (f: string): string => f.replace(/\\/g, '/').replace(/^\.?\//, '');

/** skin.ini at the archive root, or inside the single folder an export was zipped in. */
export function findSkinIni(files: readonly string[]): string | null {
    const paths = files.map(norm).filter(f => !f.endsWith('/') && !f.startsWith('__MACOSX/'));
    const root = paths.find(f => /^skin\.ini$/i.test(f));
    if (root) return root;
    const tops = new Set(paths.filter(f => f.includes('/')).map(f => f.split('/')[0]));
    if (tops.size !== 1 || paths.some(f => !f.includes('/'))) return null;
    return paths.find(f => /^[^/]+\/skin\.ini$/i.test(f)) ?? null;
}

/**
 * Classify by contents: any .osu file makes a beatmap set; otherwise a
 * skin.ini makes a skin. An .osk is a skin whatever it contains.
 */
export function classifyArchive(files: readonly string[], filename = ''): ArchiveKind {
    if (isSkinFilename(filename)) return 'skin';
    if (files.some(f => /\.osu$/i.test(f))) return 'beatmap';
    if (findSkinIni(files)) return 'skin';
    return 'unknown';
}

/** "folder/My Skin.osk" → "My Skin". */
export function archiveName(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? filename;
    return base.replace(/\.(osk|zip)$/i, '').trim();
}

/**
 * lazer's import naming: skin.ini's Name (else the file name) and Author
 * (else "Unknown"). When the file name differs from the ini name it is
 * appended in brackets, since people rename skins without editing skin.ini.
 */
export function skinMetadata(ini: SkinConfig, filename: string): SkinMetadata {
    const fromFile = archiveName(filename);
    const iniName = ini.name?.trim() ?? '';
    let name = iniName || fromFile || 'No name';
    if (iniName && fromFile && fromFile !== iniName && fromFile !== `${iniName} (${ini.author?.trim() || UNKNOWN_AUTHOR})`) {
        name = `${iniName} [${fromFile}]`;
    }
    return { name, author: ini.author?.trim() || UNKNOWN_AUTHOR };
}

/**
 * Stable id for a skin: the same skin (name and author) imported again
 * replaces the stored copy instead of adding a duplicate.
 */
export function skinId(meta: SkinMetadata): string {
    const key = `${meta.name.toLowerCase()}\u0000${meta.author.toLowerCase()}`;
    let h1 = 0x811c9dc5, h2 = 0x5bd1e995;
    for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 13);
    }
    return `skin-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** A file name for exporting: the skin's display name without characters file systems reject. */
export function exportFilename(meta: SkinMetadata): string {
    const safe = meta.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim() || 'skin';
    return `${safe}.osk`;
}

/** An opened skin archive with its metadata. */
export interface ReadSkin {
    archive: OszArchive;
    meta: SkinMetadata;
    config: SkinConfig;
}

/** Open an archive as a skin, or throw a user-facing error. */
export async function readSkinArchive(data: Blob | Uint8Array, filename: string): Promise<ReadSkin> {
    let archive: OszArchive;
    try {
        archive = await OszArchive.open(data);
    } catch {
        throw new Error('Not a valid skin archive');
    }
    if (classifyArchive(archive.files, filename) !== 'skin') {
        throw new Error(archive.osuFiles().length ? 'This is a beatmap, not a skin' : 'No skin.ini in archive');
    }
    if (!archive.files.length) throw new Error('The skin archive is empty');
    let config: SkinConfig = {};
    const ini = findSkinIni(archive.files);
    if (ini) {
        try {
            config = parseSkinIni(await archive.readText(ini));
        } catch {
            config = {};
        }
    }
    return { archive, meta: skinMetadata(config, filename), config };
}
