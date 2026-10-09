import { describe, expect, it } from 'vitest';
import { animationFramePaths, CommandTrack, parseStoryboard, STORYBOARD_EASINGS } from '../../src/beatmap/storyboard';

const osb = (events: string, vars = '') => `[Variables]\n${vars}\n[Events]\n${events}\n`;

describe('storyboard parser', () => {
    it('reads sprites, animations and samples in both syntaxes', () => {
        const sb = parseStoryboard(osb([
            'Sprite,Foreground,TopLeft,"sb/a.png",100,200',
            ' F,0,1000,2000,0,1',
            '4,0,1,"bg.jpg",320,264',
            ' S,0,0,500,1',
            'Animation,Overlay,Centre,"sb/anim.png",320,240,3,50,LoopOnce',
            ' M,0,0,100,0,0,10,20',
            'Sample,1500,0,"sb/boom.wav",60',
        ].join('\n')))!;
        expect(sb.sprites).toHaveLength(3);
        const [a, bg, anim] = sb.sprites;
        expect(a).toMatchObject({ kind: 'sprite', layer: 'Foreground', path: 'sb/a.png', x: 100, y: 200, start: 1000, end: 2000 });
        expect(a.origin).toEqual({ x: 0, y: 0 });
        expect(bg).toMatchObject({ layer: 'Background', path: 'bg.jpg' });
        expect(bg.origin).toEqual({ x: 0.5, y: 0.5 });
        expect(anim).toMatchObject({ kind: 'animation', layer: 'Overlay', frameCount: 3, frameDelay: 50, loopForever: false });
        expect(animationFramePaths(anim)).toEqual(['sb/anim0.png', 'sb/anim1.png', 'sb/anim2.png']);
        expect(sb.samples).toEqual([{ time: 1500, layer: 'Background', path: 'sb/boom.wav', volume: 0.6 }]);
    });

    it('expands loops and chains multi-value commands', () => {
        const sb = parseStoryboard(osb([
            'Sprite,Background,Centre,"x.png",0,0',
            ' L,1000,3',
            '  F,0,0,100,0,1',
            '  F,0,100,200,1,0',
            ' S,0,5000,5100,1,2,3',
        ].join('\n')))!;
        const cmds = sb.sprites[0].commands;
        const fades = cmds.filter(c => c.type === 'F');
        expect(fades.map(c => c.start)).toEqual([1000, 1100, 1200, 1300, 1400, 1500]);
        const scales = cmds.filter(c => c.type === 'S');
        expect(scales.map(c => [c.start, c.end, c.from[0], c.to[0]])).toEqual([[5000, 5100, 1, 2], [5100, 5200, 2, 3]]);
        expect(sb.sprites[0].end).toBe(5200);
    });

    it('substitutes variables and skips trigger groups', () => {
        const sb = parseStoryboard(osb([
            'Sprite,Pass,Centre,"$img",$x,240',
            ' T,HitSoundClap,0,1000',
            '  F,0,0,100,1,0',
            ' F,0,10,20,1',
        ].join('\n'), '$img="sb/v.png"\n$x=111'))!;
        const s = sb.sprites[0];
        expect(s.path).toBe('sb/v.png');
        expect(s.x).toBe(111);
        expect(s.commands).toHaveLength(1);
        expect(s.commands[0]).toMatchObject({ type: 'F', start: 10, end: 20 });
    });

    it('returns null without anything to show', () => {
        expect(parseStoryboard(osb('//nothing\n0,0,"bg.jpg",0,0'))).toBeNull();
    });
});

describe('command tracks', () => {
    it('holds the first start value before, eases inside and holds the end value after', () => {
        const t = new CommandTrack([
            { type: 'F', easing: 0, start: 100, end: 200, from: [0], to: [1] },
            { type: 'F', easing: 0, start: 300, end: 400, from: [1], to: [0.5] },
        ]);
        const v = [0];
        const at = (time: number) => (t.valueAt(time, v), v[0]);
        expect(at(0)).toBe(0);
        expect(at(150)).toBeCloseTo(0.5);
        expect(at(250)).toBe(1);
        expect(at(350)).toBeCloseTo(0.75);
        expect(at(1000)).toBe(0.5);
        expect(at(150)).toBeCloseTo(0.5); // seeking back works too
    });

    it('has all 35 osu! easings, each running 0 → 1', () => {
        expect(STORYBOARD_EASINGS).toHaveLength(35);
        for (const e of STORYBOARD_EASINGS) {
            expect(e(0)).toBeCloseTo(0, 2);
            expect(e(1)).toBeCloseTo(1, 2);
        }
    });
});
