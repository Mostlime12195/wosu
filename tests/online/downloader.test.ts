import { describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../../src/online/BeatmapApi';
import { DownloadManager, type DownloadTask } from '../../src/online/Downloader';
import { resolveProviders } from '../../src/online/providers';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(7)]);

interface StreamControl {
    push(bytes: Uint8Array): void;
    close(): void;
}

/** Response whose body is fed manually (lets tests observe progress). */
function controlledResponse(headers: Record<string, string>, signal?: AbortSignal | null): { res: Response; ctl: StreamControl } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: c => { controller = c; } });
    signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        try {
            controller.error(e);
        } catch {
            /* already closed */
        }
    });
    return {
        res: new Response(stream, { status: 200, headers }),
        ctl: { push: b => controller.enqueue(b), close: () => controller.close() },
    };
}

function staticResponse(body: Uint8Array | string, headers: Record<string, string> = {}, status = 200): Response {
    return new Response(body as BodyInit, { status, headers: { 'content-type': 'application/octet-stream', ...headers } });
}

const tick = () => new Promise(r => setTimeout(r, 0));
const providers = () => resolveProviders('sayobot', 'mino');

describe('DownloadManager', () => {
    it('streams with progress when Content-Length is known', async () => {
        let ctl!: StreamControl;
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const r = controlledResponse({ 'content-length': String(ZIP.length), 'content-type': 'application/octet-stream' }, init?.signal);
            ctl = r.ctl;
            return r.res;
        });
        const dm = new DownloadManager(providers, 2, fetchFn);
        const task = dm.download(42, { title: 'T', artist: 'A' });
        expect(fetchFn.mock.calls[0][0]).toBe('https://catboy.best/d/42n');
        await tick();
        expect(task.state).toBe('downloading');
        expect(task.total).toBe(ZIP.length);
        ctl.push(ZIP.slice(0, 32));
        await tick();
        expect(task.progress).toBeCloseTo(32 / ZIP.length, 5);
        ctl.push(ZIP.slice(32));
        ctl.close();
        const blob = await task.result;
        expect(blob.size).toBe(ZIP.length);
        expect(task.state).toBe('done');
        expect(task.progress).toBe(1);
    });

    it('works without Content-Length (progress NaN, loaded grows)', async () => {
        const dm = new DownloadManager(providers, 2, async () => staticResponse(ZIP));
        const task = dm.download(1, { title: 'T', artist: 'A' }, { withVideo: true });
        const seen: number[] = [];
        task.changed.add(() => {
            if (task.state === 'downloading') seen.push(task.progress);
        });
        await task.result;
        expect(seen.some(Number.isNaN)).toBe(true);
        expect(task.loaded).toBe(ZIP.length);
    });

    it('requests the video variant when asked', async () => {
        const fetchFn = vi.fn(async (_url: string) => staticResponse(ZIP));
        const dm = new DownloadManager(providers, 2, fetchFn);
        await dm.download(9, { title: 'T', artist: 'A' }, { withVideo: true }).result;
        expect(fetchFn.mock.calls[0][0]).toBe('https://catboy.best/d/9');
    });

    it('rejects error documents and non-zip bodies', async () => {
        const json = new DownloadManager(providers, 2, async () => staticResponse('{"error":"x"}', { 'content-type': 'application/json' }));
        const t1 = json.download(1, { title: 'T', artist: 'A' });
        await expect(t1.result).rejects.toThrow(/error instead/);
        expect(t1.state).toBe('failed');
        expect(t1.error).toMatch(/error instead/);

        const html = new DownloadManager(providers, 2, async () => staticResponse(new Uint8Array(100).fill(60)));
        await expect(html.download(2, { title: 'T', artist: 'A' }).result).rejects.toThrow(/not a valid/);

        const missing = new DownloadManager(providers, 2, async () => staticResponse('', {}, 404));
        await expect(missing.download(3, { title: 'T', artist: 'A' }).result).rejects.toThrow(/not found/);
    });

    it('dedupes active downloads by set id but allows retry after failure', async () => {
        let fail = true;
        const fetchFn = vi.fn(async () => (fail ? staticResponse('', {}, 404) : staticResponse(ZIP)));
        const dm = new DownloadManager(providers, 2, fetchFn);
        const a = dm.download(5, { title: 'T', artist: 'A' });
        const b = dm.download(5, { title: 'T', artist: 'A' });
        expect(a).toBe(b);
        await expect(a.result).rejects.toThrow();
        fail = false;
        const c = dm.download(5, { title: 'T', artist: 'A' });
        expect(c).not.toBe(a);
        await c.result;
        expect(dm.get(5)).toBeUndefined(); // finished tasks are no longer "active"
        expect(dm.tasks).toContain(c);
    });

    it('cancels in-flight and queued downloads', async () => {
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) =>
            controlledResponse({ 'content-type': 'application/octet-stream' }, init?.signal).res);
        const dm = new DownloadManager(providers, 1, fetchFn);
        const added: DownloadTask[] = [];
        dm.added.add(t => added.push(t));
        const running = dm.download(1, { title: 'A', artist: 'A' });
        const queued = dm.download(2, { title: 'B', artist: 'B' });
        expect(added).toHaveLength(2);
        await tick();
        expect(running.state).toBe('downloading');
        expect(queued.state).toBe('queued');
        queued.cancel();
        await expect(queued.result).rejects.toSatisfy(isAbortError);
        expect(queued.state).toBe('cancelled');
        running.cancel();
        await expect(running.result).rejects.toSatisfy(isAbortError);
        expect(running.state).toBe('cancelled');
        // the cancelled queued task never hit the network
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('limits concurrency', async () => {
        const controls: StreamControl[] = [];
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const r = controlledResponse({ 'content-type': 'application/octet-stream' }, init?.signal);
            controls.push(r.ctl);
            return r.res;
        });
        const dm = new DownloadManager(providers, 1, fetchFn);
        const first = dm.download(1, { title: 'A', artist: 'A' });
        const second = dm.download(2, { title: 'B', artist: 'B' });
        await tick();
        expect(fetchFn).toHaveBeenCalledTimes(1);
        controls[0].push(ZIP);
        controls[0].close();
        await first.result;
        await tick();
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(second.state).toBe('downloading');
        second.cancel();
        await expect(second.result).rejects.toSatisfy(isAbortError);
    });

    it('retries once on network errors and 5xx, not on 4xx', async () => {
        let n = 0;
        const flaky = vi.fn(async () => {
            if (n++ === 0) throw new TypeError('network down');
            return staticResponse(ZIP);
        });
        await new DownloadManager(providers, 2, flaky).download(1, { title: 'T', artist: 'A' }).result;
        expect(flaky).toHaveBeenCalledTimes(2);

        const fivexx = vi.fn(async () => staticResponse('', {}, 503));
        await expect(new DownloadManager(providers, 2, fivexx).download(1, { title: 'T', artist: 'A' }).result).rejects.toThrow('HTTP 503');
        expect(fivexx).toHaveBeenCalledTimes(2);

        const fourxx = vi.fn(async () => staticResponse('', {}, 403));
        await expect(new DownloadManager(providers, 2, fourxx).download(1, { title: 'T', artist: 'A' }).result).rejects.toThrow('HTTP 403');
        expect(fourxx).toHaveBeenCalledTimes(1);
    });
});
