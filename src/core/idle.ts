/**
 * Background work that should never compete with a frame: each task runs
 * in its own idle period (requestIdleCallback, or a short timeout where
 * that doesn't exist), one after another, in the order queued. An async
 * task holds the queue until it settles, so downloads queued here also
 * go one at a time.
 */
type Task = () => void | Promise<unknown>;

const queue: Task[] = [];
let running = false;

const idle: (fn: () => void) => void = typeof requestIdleCallback === 'function'
    ? fn => requestIdleCallback(() => fn(), { timeout: 2000 })
    : fn => setTimeout(fn, 50);

function next(): void {
    const task = queue.shift();
    if (!task) {
        running = false;
        return;
    }
    idle(() => {
        let result: void | Promise<unknown> = undefined;
        try {
            result = task();
        } catch (e) {
            console.warn('[idle] task failed', e);
        }
        Promise.resolve(result).catch(e => console.warn('[idle] task failed', e)).finally(next);
    });
}

/** Queue background work for idle time. */
export function whenIdle(...tasks: Task[]): void {
    queue.push(...tasks);
    if (!running) {
        running = true;
        next();
    }
}

/** Run `fn` once the next frame has been presented (rAF, then a task after it). */
export function afterNextFrame(fn: () => void): void {
    if (typeof requestAnimationFrame !== 'function') {
        setTimeout(fn, 0);
        return;
    }
    requestAnimationFrame(() => setTimeout(fn, 0));
}
