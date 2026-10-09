import { Bindable } from '../../core/Bindable';
import { Signal } from '../../core/Signal';
import type { IconName } from '../../ui/icons';

export type NotificationKind = 'info' | 'success' | 'warning' | 'error' | 'progress';
export type ProgressState = 'active' | 'completed' | 'failed' | 'cancelled';

export interface NotificationOptions {
    kind?: NotificationKind;
    text: string;
    title?: string;
    icon?: IconName;
    onClick?: () => void;
    onCancel?: () => void;
    /** Toast lifetime in ms (progress toasts stay until finished). */
    duration?: number;
    /** Post silently into the list without a toast. */
    silent?: boolean;
}

let nextId = 1;

export class Notification {
    readonly id = nextId++;
    readonly kind: NotificationKind;
    readonly createdAt = Date.now();
    readonly text: Bindable<string>;
    readonly title: string | null;
    readonly icon: IconName;
    readonly progress = new Bindable<number>(0);
    readonly state = new Bindable<ProgressState>('active');
    readonly dismissed = new Signal<[]>();
    read = false;
    onClick: (() => void) | null;
    onCancel: (() => void) | null;
    readonly duration: number;
    readonly silent: boolean;

    constructor(o: NotificationOptions) {
        this.kind = o.kind ?? 'info';
        this.text = new Bindable(o.text);
        this.title = o.title ?? null;
        this.icon = o.icon ?? defaultIcon(this.kind);
        this.onClick = o.onClick ?? null;
        this.onCancel = o.onCancel ?? null;
        this.duration = o.duration ?? (this.kind === 'error' ? 7000 : 4500);
        this.silent = !!o.silent;
        if (this.kind !== 'progress') this.state.value = 'completed';
    }

    complete(text?: string, onClick?: () => void): void {
        if (text) this.text.value = text;
        if (onClick) this.onClick = onClick;
        this.progress.value = 1;
        this.state.value = 'completed';
    }

    fail(text?: string): void {
        if (text) this.text.value = text;
        // A cancelled task reports its abort as a failure afterwards: stay cancelled.
        if (this.state.value === 'cancelled') return;
        this.state.value = 'failed';
    }

    cancel(): void {
        if (this.state.value !== 'active') return;
        this.state.value = 'cancelled';
        this.onCancel?.();
    }

    dismiss(): void {
        this.dismissed.emit();
    }
}

function defaultIcon(kind: NotificationKind): IconName {
    switch (kind) {
        case 'success': return 'check';
        case 'warning': return 'warning';
        case 'error': return 'error';
        case 'progress': return 'download';
        default: return 'info';
    }
}

/** Notification centre (data side); the toast tray and panel observe it. */
export class NotificationManager {
    readonly posted = new Signal<[Notification]>();
    readonly removed = new Signal<[Notification]>();
    readonly list: Notification[] = [];
    readonly unread = new Bindable(0);
    /** The notification panel is open: new posts arrive read, without toasts. */
    readonly panelOpen = new Bindable(false);

    post(o: NotificationOptions): Notification {
        const n = new Notification(o);
        this.list.unshift(n);
        if (this.list.length > 50) {
            // Drop the oldest finished entry; running tasks stay listed.
            const i = this.list.findLastIndex(x => x.state.value !== 'active');
            const old = this.list.splice(i === -1 ? this.list.length - 1 : i, 1)[0];
            if (!old.read) this.unread.value = Math.max(0, this.unread.value - 1);
            this.removed.emit(old);
        }
        if (this.panelOpen.value) n.read = true;
        else this.unread.value++;
        n.dismissed.add(() => this.remove(n));
        this.posted.emit(n);
        return n;
    }

    info(text: string, onClick?: () => void): Notification {
        return this.post({ kind: 'info', text, onClick });
    }

    success(text: string, onClick?: () => void): Notification {
        return this.post({ kind: 'success', text, onClick });
    }

    warning(text: string): Notification {
        return this.post({ kind: 'warning', text });
    }

    error(text: string): Notification {
        return this.post({ kind: 'error', text });
    }

    progress(text: string, title?: string): Notification {
        return this.post({ kind: 'progress', text, title });
    }

    remove(n: Notification): void {
        const i = this.list.indexOf(n);
        if (i === -1) return;
        this.list.splice(i, 1);
        if (!n.read) this.unread.value = Math.max(0, this.unread.value - 1);
        this.removed.emit(n);
    }

    markRead(n: Notification): void {
        if (n.read) return;
        n.read = true;
        if (this.list.includes(n)) this.unread.value = Math.max(0, this.unread.value - 1);
    }

    markAllRead(): void {
        for (const n of this.list) n.read = true;
        this.unread.value = 0;
    }

    clearCompleted(): void {
        for (const n of this.list.slice()) if (n.state.value !== 'active') this.remove(n);
    }

    cancelAll(): void {
        for (const n of this.list.slice()) if (n.state.value === 'active') n.cancel();
    }
}
