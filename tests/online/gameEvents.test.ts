import { describe, expect, it } from 'vitest';
import { anonId, pingBody, sendPlayPing } from '../../src/online/gameEvents';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('game events (client)', () => {
    it('keeps one random anonymous id per browser', () => {
        const s = memoryStorage();
        const id = anonId(s);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(anonId(s)).toBe(id);
        expect(s.data.get('wosu:anon-id')).toBe(id);
    });

    it('still has an id when storage throws', () => {
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(anonId(broken)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rounds the play time and carries the anonymous id', () => {
        expect(pingBody({ phase: 'quit', beatmapId: 3, ms: 1234.7 }, 'id')).toMatchObject({ phase: 'quit', beatmapId: 3, ms: 1235, anonId: 'id' });
    });

    it('never throws, even when the request fails', async () => {
        let calls = 0;
        sendPlayPing({ phase: 'open' }, '/api', async () => {
            calls++;
            throw new Error('offline');
        });
        sendPlayPing({ phase: 'open' }, '/api', () => {
            throw new Error('no fetch');
        });
        await new Promise(r => setTimeout(r, 0));
        expect(calls).toBe(1);
    });
});
