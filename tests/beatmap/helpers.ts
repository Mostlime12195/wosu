// Shared fixtures for beatmap tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAP_BASIC = `osu file format v14
[General]
AudioFilename: song.ogg
Mode: 0
StackLeniency: 0.7
[Metadata]
Title:Test
Artist:A
Creator:C
Version:Normal
BeatmapID:1
BeatmapSetID:10
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:6
ApproachRate:7
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[Colours]
Combo1 : 96,159,159
[HitObjects]
100,100,1000,1,0,0:0:0:0:
150,150,2000,2,0,B|250:150,1,100
256,192,3000,12,0,3500,0:0:0:0:
`;

/** Minimal valid map around a custom [HitObjects] / [TimingPoints] body. */
export function makeMap(opts: {
    objects: string[];
    timing?: string[];
    version?: number;
    difficulty?: Partial<Record<'HPDrainRate' | 'CircleSize' | 'OverallDifficulty' | 'ApproachRate' | 'SliderMultiplier' | 'SliderTickRate', number>>;
    stackLeniency?: number;
}): string {
    const d = { HPDrainRate: 5, CircleSize: 4, OverallDifficulty: 6, ApproachRate: 7, SliderMultiplier: 1, SliderTickRate: 1, ...opts.difficulty };
    return [
        `osu file format v${opts.version ?? 14}`,
        '[General]',
        'AudioFilename: a.mp3',
        `StackLeniency: ${opts.stackLeniency ?? 0.7}`,
        'Mode: 0',
        '[Metadata]',
        'Title:T',
        'Version:V',
        '[Difficulty]',
        ...Object.entries(d).map(([k, v]) => `${k}:${v}`),
        '[TimingPoints]',
        ...(opts.timing ?? ['0,500,4,1,0,100,1,0']),
        '[HitObjects]',
        ...opts.objects,
        '',
    ].join('\n');
}

export const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'map1');

export function fixtureOsu(): string {
    const file = readdirSync(FIXTURE_DIR).find(f => f.endsWith('.osu'));
    if (!file) throw new Error('fixture .osu missing');
    return readFileSync(join(FIXTURE_DIR, file), 'utf8');
}
