import { describe, expect, it } from 'vitest';
import { GameplayLeaderboardModel, SORT_INTERVAL, type LeaderboardSource } from '../../src/gameplay/hud/leaderboard';
import { songProgressAt } from '../../src/gameplay/hud/LegacySongProgress';

function src(player: string, score: number, date = score): LeaderboardSource {
    return { player, score, accuracy: 0.95, maxCombo: 100, date };
}

const order = (m: GameplayLeaderboardModel) =>
    [...m.entries].sort((a, b) => a.displayOrder - b.displayOrder).map(e => `${e.name}:${e.position ?? '-'}`);

describe('gameplay leaderboard', () => {
    it('starts with the player last, ranked below every local score', () => {
        const m = new GameplayLeaderboardModel([src('a', 3000), src('b', 2000), src('c', 1000)], 'me');
        expect(order(m)).toEqual(['a:1', 'b:2', 'c:3', 'me:4']);
        expect(m.tracked.tracked).toBe(true);
    });

    it('moves the player up as they pass scores, re-sorting once a second', () => {
        const m = new GameplayLeaderboardModel([src('a', 3000), src('b', 2000), src('c', 1000)], 'me');
        m.setLive(2500, 0.99, 50);
        expect(m.update(SORT_INTERVAL - 1)).toBe(false);
        expect(order(m)).toEqual(['a:1', 'b:2', 'c:3', 'me:4']);
        expect(m.update(1)).toBe(true);
        expect(order(m)).toEqual(['a:1', 'me:2', 'b:3', 'c:4']);
        expect(m.tracked.combo).toBe(50);
        m.setLive(4000, 0.99, 80);
        m.update(SORT_INTERVAL);
        expect(order(m)).toEqual(['me:1', 'a:2', 'b:3', 'c:4']);
    });

    it('keeps the player below a score they only tie', () => {
        const m = new GameplayLeaderboardModel([src('a', 2000)], 'me');
        m.setLive(2000, 1, 10);
        m.sort();
        expect(order(m)).toEqual(['a:1', 'me:2']);
    });

    it('breaks ties between saved scores by date (older first)', () => {
        const m = new GameplayLeaderboardModel([src('new', 1000, 20), src('old', 1000, 10)], 'me');
        expect(order(m)).toEqual(['old:1', 'new:2', 'me:3']);
    });

    it('does nothing when the score has not changed', () => {
        const m = new GameplayLeaderboardModel([src('a', 1000)], 'me');
        const v = m.version;
        m.setLive(0, 1, 0);
        expect(m.update(SORT_INTERVAL * 3)).toBe(false);
        expect(m.version).toBe(v);
    });

    it('has the player alone at #1 without local scores', () => {
        const m = new GameplayLeaderboardModel([], '');
        expect(order(m)).toEqual(['Guest:1']);
    });

    it('leaves the player unranked below a partial list, and shifts scores they pass (lazer)', () => {
        const all = [src('a', 5000), src('b', 4000), src('c', 3000), src('d', 2000)];
        const m = new GameplayLeaderboardModel(all, 'me', 2);
        expect(m.partial).toBe(true);
        expect(order(m)).toEqual(['a:1', 'b:2', 'me:-']);
        m.setLive(4500, 1, 1);
        m.sort();
        expect(order(m)).toEqual(['a:1', 'me:2', 'b:3']);
        m.setLive(6000, 1, 1);
        m.sort();
        expect(order(m)).toEqual(['me:1', 'a:2', 'b:3']);
    });
});

describe('legacy song progress', () => {
    it('runs through the intro from the clock start to the first object', () => {
        expect(songProgressAt(-2000, -2000, 1000, 11000)).toEqual({ progress: 0, intro: true });
        expect(songProgressAt(-500, -2000, 1000, 11000)).toEqual({ progress: 0.5, intro: true });
    });

    it('runs from the first object to the end of the last', () => {
        expect(songProgressAt(1000, -2000, 1000, 11000)).toEqual({ progress: 0, intro: false });
        expect(songProgressAt(6000, -2000, 1000, 11000)).toEqual({ progress: 0.5, intro: false });
        expect(songProgressAt(20000, -2000, 1000, 11000)).toEqual({ progress: 1, intro: false });
    });

    it('handles a map whose objects all start at once', () => {
        expect(songProgressAt(5000, 0, 5000, 5000)).toEqual({ progress: 0, intro: false });
    });
});
