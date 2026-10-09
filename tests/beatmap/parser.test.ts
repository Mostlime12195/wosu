import { describe, expect, it } from 'vitest';
import { parseOsu } from '../../src/beatmap/parser';
import { MAP_BASIC } from './helpers';

describe('parseOsu', () => {
    it('decodes circle, slider and spinner rows', () => {
        const map = parseOsu(MAP_BASIC);
        expect(map.formatVersion).toBe(14);
        expect(map.hitObjects.map(h => h.kind)).toEqual(['circle', 'slider', 'spinner']);
        const s = map.hitObjects[1];
        expect(s.curveType).toBe('B');
        expect(s.controlPoints).toEqual([{ x: 250, y: 150 }]);
        expect(s.slides).toBe(1);
        expect(s.pixelLength).toBe(100);
        // edge defaults: object hitsound, sets from the hit sample
        expect(s.edgeSounds).toEqual([0, 0]);
        expect(s.edgeSets).toHaveLength(2);
        const sp = map.hitObjects[2];
        expect(sp.endTime).toBe(3500);
        expect(sp.newCombo).toBe(true);
        expect(map.metadata).toMatchObject({ title: 'Test', artist: 'A', creator: 'C', version: 'Normal', beatmapId: 1, beatmapSetId: 10 });
        expect(map.metadata.titleUnicode).toBe('Test');
        expect(map.comboColors).toEqual([(96 << 16) | (159 << 8) | 159]);
    });

    it('applies osu! defaults for missing general/difficulty fields', () => {
        const text = MAP_BASIC
            .replace('StackLeniency: 0.7\n', '')
            .replace('Mode: 0\n', '')
            .replace('ApproachRate:7\n', '')
            .replace('SliderMultiplier:1.4\n', '')
            .replace('SliderTickRate:1\n', '');
        const map = parseOsu(text);
        expect(map.general.stackLeniency).toBe(0.7);
        expect(map.general.mode).toBe(0);
        expect(map.general.previewTime).toBe(-1);
        expect(map.general.sampleSet).toBe(1);
        expect(map.difficulty.approachRate).toBe(6); // falls back to OD
        expect(map.difficulty.sliderMultiplier).toBe(1.4);
        expect(map.difficulty.sliderTickRate).toBe(1);
    });

    it('keeps PreviewTime in milliseconds and reads the sample set', () => {
        const map = parseOsu(MAP_BASIC.replace('Mode: 0', 'Mode: 0\nPreviewTime: 56222\nSampleSet: Soft'));
        expect(map.general.previewTime).toBe(56222);
        expect(map.general.sampleSet).toBe(2);
    });

    it('tolerates BOM, CRLF, comments and unknown sections', () => {
        const text = '﻿' + MAP_BASIC.replace(/\n/g, '\r\n').replace('[HitObjects]', '[Mystery]\r\nfoo:bar\r\n// comment\r\n[HitObjects]');
        const map = parseOsu(text);
        expect(map.formatVersion).toBe(14);
        expect(map.hitObjects).toHaveLength(3);
    });

    it('decodes timing points with effects and old two-column rows', () => {
        const map = parseOsu(MAP_BASIC.replace('0,500,4,1,0,100,1,0', '0,500\n100,-50,4,2,1,60,0,1\n200,400,3,9,0,50,1,8'));
        expect(map.timingPoints).toHaveLength(3);
        expect(map.timingPoints[0]).toMatchObject({ uninherited: true, meter: 4, volume: 100, kiai: false });
        expect(map.timingPoints[1]).toMatchObject({ uninherited: false, beatLength: -50, sampleSet: 2, kiai: true });
        expect(map.timingPoints[2]).toMatchObject({ meter: 3, sampleSet: 0, omitFirstBarLine: true });
    });

    it('reads background, video and break events', () => {
        const text = MAP_BASIC.replace('[HitObjects]', '[Events]\nVideo,-200,"bg.avi"\n0,0,"bg, with comma.jpg",0,0\n2,1500,1900\n[HitObjects]');
        const map = parseOsu(text);
        expect(map.events.backgroundFile).toBe('bg, with comma.jpg');
        expect(map.events.video).toEqual({ filename: 'bg.avi', offset: -200 });
        expect(map.events.breaks).toEqual([{ startTime: 1500, endTime: 1900 }]);
        const numeric = parseOsu(MAP_BASIC.replace('[HitObjects]', '[Events]\n1,1500,"vid.mp4"\n[HitObjects]'));
        expect(numeric.events.video).toEqual({ filename: 'vid.mp4', offset: 1500 });
        expect(parseOsu(MAP_BASIC).events.video).toBeNull();
    });

    it('sorts combo colours and reads slider overrides', () => {
        const text = MAP_BASIC.replace('Combo1 : 96,159,159', 'Combo2 : 0,0,255\nCombo1 : 255,0,0\nSliderBorder : 1,2,3\nSliderTrackOverride: 4,5,6');
        const map = parseOsu(text);
        expect(map.comboColors).toEqual([0xff0000, 0x0000ff]);
        expect(map.sliderBorder).toBe(0x010203);
        expect(map.sliderTrackOverride).toBe(0x040506);
    });

    it('decodes combo skips, edge sounds/sets and hit samples', () => {
        const text = MAP_BASIC.replace('150,150,2000,2,0,B|250:150,1,100', '150,150,2000,38,2,L|250:150,2,100,2|8|4,1:2|0:0|3:1,2:3:1:70:x.wav');
        const s = parseOsu(text).hitObjects[1];
        expect(s.newCombo).toBe(true);
        expect(s.comboSkip).toBe(2);
        expect(s.curveType).toBe('L');
        expect(s.edgeSounds).toEqual([2, 8, 4]);
        expect(s.edgeSets).toEqual([{ normalSet: 1, additionSet: 2 }, { normalSet: 0, additionSet: 0 }, { normalSet: 3, additionSet: 1 }]);
        expect(s.hitSample).toEqual({ normalSet: 2, additionSet: 3, index: 1, volume: 70, filename: 'x.wav' });
    });

    it('drops non-finite objects and clamps bad sliders', () => {
        const text = MAP_BASIC.replace('[HitObjects]\n', '[HitObjects]\nNaN,1,500,1,0\n1,1,600,2,0,B|5:5,0,-20\n1,1,700,8,0,abc\n');
        const map = parseOsu(text);
        expect(map.hitObjects).toHaveLength(4);
        const bad = map.hitObjects[0];
        expect(bad.kind).toBe('slider');
        expect(bad.slides).toBe(1);
        expect(bad.pixelLength).toBe(0);
    });

    it('fixes spinner end before start and ignores mania holds', () => {
        const text = MAP_BASIC.replace('256,192,3000,12,0,3500', '256,192,3000,12,0,2000') + '64,192,4000,128,0,4500:0:0:0:0:\n';
        const map = parseOsu(text);
        expect(map.hitObjects).toHaveLength(3);
        expect(map.hitObjects[2].endTime).toBe(3001);
    });

    it('survives an empty object list and missing timing points', () => {
        const empty = MAP_BASIC.replace(/\[HitObjects\][\s\S]*$/, '[HitObjects]\n').replace('0,500,4,1,0,100,1,0\n', '');
        const map = parseOsu(empty);
        expect(map.hitObjects).toEqual([]);
        expect(map.timingPoints).toEqual([]);
    });

    it('sorts out-of-order hit objects', () => {
        const text = MAP_BASIC.replace('100,100,1000,1,0,0:0:0:0:', '100,100,5000,1,0,0:0:0:0:');
        const map = parseOsu(text);
        expect(map.hitObjects.map(h => h.time)).toEqual([2000, 3000, 5000]);
    });
});
