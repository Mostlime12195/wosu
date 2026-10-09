/**
 * .osz download queue with streaming progress.
 *
 * Downloads run at most `maxConcurrent` at a time, are deduplicated by
 * set id while active, report progress even without a Content-Length
 * (progress is NaN then; `loaded` still grows), can be cancelled, and
 * retry once on transient (network / 5xx) failures.
 */
import { Signal } from '../core/Signal';
import { abortError, isAbortError, type FetchFn, type ProviderSource } from './BeatmapApi';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface DownloadMeta {
    title: string;
    artist: string;
}

export interface DownloadOptions {
    withVideo?: boolean;
}

/** Finished tasks kept for the downloads UI (each may pin its blob). */
const FINISHED_HISTORY = 10;

class HttpError extends Error {
    constructor(readonly status: number) {
        super(status === 404 ? 'Beatmap not found on this mirror' : `HTTP ${status}`);
    }
}

export class DownloadTask {
    state: DownloadState = 'queued';
    loaded = 0;
    total: number | null = null;
    error: string | null = null;
    readonly changed = new Signal<[]>();
    readonly result: Promise<Blob>;

    /** @internal */ controller: AbortController | null = null;
    private resolveFn!: (b: Blob) => void;
    private rejectFn!: (e: Error) => void;
    private onCancelQueued: (() => void) | null = null;

    constructor(
        readonly sid: number,
        readonly title: string,
        readonly artist: string,
        readonly withVideo: boolean,
    ) {
        this.result = new Promise<Blob>((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;
        });
        // Consumers may ignore failures; avoid unhandled-rejection noise.
        this.result.catch(() => undefined);
    }

    /** 0..1, or NaN while the total size is unknown. */
    get progress(): number {
        if (this.state === 'done') return 1;
        if (!this.total) return NaN;
        return Math.min(1, this.loaded / this.total);
    }

    get active(): boolean {
        return this.state === 'queued' || this.state === 'downloading';
    }

    cancel(): void {
        if (!this.active) return;
        if (this.state === 'queued') {
            this.onCancelQueued?.();
            this.finishCancelled();
            return;
        }
        this.controller?.abort();
    }

    /** @internal */ setQueuedCancel(fn: () => void): void {
        this.onCancelQueued = fn;
    }

    /** @internal */ update(patch: Partial<Pick<DownloadTask, 'state' | 'loaded' | 'total' | 'error'>>): void {
        Object.assign(this, patch);
        this.changed.emit();
    }

    /** @internal */ succeed(blob: Blob): void {
        this.update({ state: 'done', loaded: blob.size, total: this.total ?? blob.size });
        this.resolveFn(blob);
    }

    /** @internal */ fail(e: unknown): void {
        if (isAbortError(e)) {
            this.finishCancelled();
            return;
        }
        const message = e instanceof Error ? e.message : String(e);
        this.update({ state: 'failed', error: message });
        this.rejectFn(e instanceof Error ? e : new Error(message));
    }

    private finishCancelled(): void {
        this.update({ state: 'cancelled', error: null });
        this.rejectFn(abortError());
    }
}

export class DownloadManager {
    readonly added = new Signal<[task: DownloadTask]>();
    private readonly all: DownloadTask[] = [];
    private readonly queue: DownloadTask[] = [];
    private running = 0;

    constructor(
        private readonly getProviders: ProviderSource,
        private readonly maxConcurrent = 2,
        private readonly fetchImpl: FetchFn = (i, init) => fetch(i, init),
    ) {}

    /** Active tasks plus a few recently finished ones, oldest first. */
    get tasks(): readonly DownloadTask[] {
        return this.all;
    }

    /** The active task for a set, if any. */
    get(sid: number): DownloadTask | undefined {
        return this.all.find(t => t.sid === sid && t.active);
    }

    download(sid: number, meta: DownloadMeta, opts: DownloadOptions = {}): DownloadTask {
        const existing = this.get(sid);
        if (existing) return existing;
        const task = new DownloadTask(sid, meta.title, meta.artist, !!opts.withVideo);
        task.setQueuedCancel(() => {
            const i = this.queue.indexOf(task);
            if (i !== -1) this.queue.splice(i, 1);
        });
        this.all.push(task);
        this.queue.push(task);
        task.changed.add(() => {
            if (!task.active) this.prune();
        });
        this.added.emit(task);
        this.pump();
        return task;
    }

    private pump(): void {
        while (this.running < this.maxConcurrent && this.queue.length) {
            const task = this.queue.shift()!;
            if (!task.active) continue;
            this.running++;
            void this.run(task).finally(() => {
                this.running--;
                this.pump();
            });
        }
    }

    private async run(task: DownloadTask): Promise<void> {
        const url = this.getProviders().download.downloadUrl(task.sid, task.withVideo);
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController();
            task.controller = controller;
            task.update({ state: 'downloading', loaded: 0, total: null, error: null });
            try {
                const blob = await this.fetchOnce(url, task, controller.signal);
                task.controller = null;
                task.succeed(blob);
                return;
            } catch (e) {
                task.controller = null;
                const transient = !isAbortError(e) &&
                    (e instanceof TypeError || (e instanceof HttpError && e.status >= 500));
                if (attempt === 0 && transient) continue;
                task.fail(e);
                return;
            }
        }
    }

    private async fetchOnce(url: string, task: DownloadTask, signal: AbortSignal): Promise<Blob> {
        const res = await this.fetchImpl(url, { signal });
        if (!res.ok) throw new HttpError(res.status);
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (type.includes('json') || type.includes('text/html')) {
            // Mirrors answer missing/blocked maps with an error document.
            throw new Error('Mirror returned an error instead of the beatmap');
        }
        const lengthHeader = Number(res.headers.get('content-length'));
        const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
        task.update({ total });

        const chunks: Uint8Array[] = [];
        let loaded = 0;
        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value) continue;
                    chunks.push(value);
                    loaded += value.byteLength;
                    // Content-Length counts compressed bytes when the server
                    // gzips: drop the total rather than show >100%.
                    task.update({ loaded, total: task.total !== null && loaded > task.total ? null : task.total });
                }
            } finally {
                reader.releaseLock();
            }
        } else {
            const buf = new Uint8Array(await res.arrayBuffer());
            chunks.push(buf);
            loaded = buf.byteLength;
            task.update({ loaded });
        }
        if (signal.aborted) throw abortError();
        const head = chunks.find(c => c.byteLength >= 2) ?? new Uint8Array(0);
        if (loaded < 22 || head[0] !== 0x50 || head[1] !== 0x4b) {
            // Every zip starts with "PK"; anything else is an error page.
            throw new Error('Download is not a valid .osz archive');
        }
        return new Blob(chunks as BlobPart[], { type: 'application/x-osu-beatmap-archive' });
    }

    private prune(): void {
        let finished = this.all.filter(t => !t.active).length;
        for (let i = 0; i < this.all.length && finished > FINISHED_HISTORY; ) {
            if (!this.all[i].active) {
                this.all.splice(i, 1);
                finished--;
            } else {
                i++;
            }
        }
    }
}
