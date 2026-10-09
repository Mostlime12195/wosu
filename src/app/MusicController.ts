import { Bindable } from '../core/Bindable';
import { Signal } from '../core/Signal';
import type { AudioEngine } from '../audio/AudioEngine';
import { MusicTrack } from '../audio/MusicTrack';
import type { PreviewPlayer } from '../audio/PreviewPlayer';
import type { BeatmapLibrary, LibrarySet } from '../beatmap/Library';
import { buildControlPointTimeline } from '../beatmap/controlPoints';
import type { ControlPointTimeline } from '../beatmap/types';
import { coverUrl, previewUrl, type OnlineSet } from '../online/providers';

export type NowPlaying =
    | { kind: 'library'; set: LibrarySet; title: string; artist: string }
    | { kind: 'online'; sid: number; title: string; artist: string; cover: string };

export interface BeatState {
    /** ms per beat, or 0 when unknown (previews). */
    beatLength: number;
    /** 0..1 progress through the current beat. */
    phase: number;
    /** Index of the current beat. */
    beatIndex: number;
    kiai: boolean;
}

/**
 * Menu music, osu!-style: plays full songs from the library (random
 * order, with history for "previous"), falls back to online preview clips
 * when the library is empty, and lends its decoded track to gameplay so a
 * song is never decoded twice.
 */
export class MusicController {
    readonly current = new Bindable<NowPlaying | null>(null);
    readonly trackChanged = new Signal<[NowPlaying | null]>();
    readonly playingState = new Bindable(false);

    private track: MusicTrack | null = null;
    private trackSetKey: string | null = null;
    private timeline: ControlPointTimeline | null = null;
    private history: string[] = [];
    private historyPos = -1;
    private loadSeq = 0;
    private lent = false;
    /** In song select the selected song loops from its preview point. */
    loopFromPreview = false;
    /** Called to fetch a random online set when the library is empty. */
    onlineSource: (() => Promise<OnlineSet | null>) | null = null;
    enabled = true;

    constructor(
        private readonly engine: AudioEngine,
        private readonly preview: PreviewPlayer,
        private readonly library: BeatmapLibrary,
    ) {
        preview.ended.add(() => {
            if (this.current.value?.kind !== 'online') return;
            if (this.enabled && !this.loopFromPreview) void this.next();
            else this.playingState.value = false;
        });
        library.changed.add(() => {
            // The playing song's set was deleted: move on, like lazer.
            const now = this.current.value;
            if (now?.kind !== 'library' || this.lent || library.get(now.set.key)) return;
            // Song select moves its selection to a neighbour and plays that.
            if (this.loopFromPreview && library.sets.length > 0) return;
            if (this.enabled) {
                void this.next();
            } else {
                ++this.loadSeq;
                this.stopTrack(300);
                this.timeline = null;
                this.setNow(null);
                this.playingState.value = false;
            }
        });
    }

    get isPlaying(): boolean {
        if (this.track && !this.lent) return this.track.isPlaying;
        return this.preview.playing;
    }

    /** Current position in ms (library tracks only). */
    get position(): number {
        return this.track && !this.lent ? this.track.currentTime : this.preview.currentTime;
    }

    get duration(): number {
        return this.track && !this.lent ? this.track.duration : this.preview.duration;
    }

    get currentTrack(): MusicTrack | null {
        return this.lent ? null : this.track;
    }

    /** Play a library set. `fromPreview` starts at the map's preview point. */
    async playSet(set: LibrarySet, opts: { fromPreview?: boolean; restart?: boolean; fadeInMs?: number } = {}): Promise<void> {
        const now = this.current.value;
        if (!opts.restart && now?.kind === 'library' && now.set.key === set.key && this.track && this.trackSetKey === set.key && !this.lent) {
            if (!this.track.isPlaying) this.track.play();
            this.playingState.value = true;
            return;
        }
        const seq = ++this.loadSeq;
        this.preview.stop(300);
        this.pushHistory(set.key);
        this.setNow({ kind: 'library', set, title: set.title, artist: set.artist });
        try {
            const archive = await this.library.openArchive(set.key);
            const file = archive.findAudio(set.audioFile);
            if (!file) throw new Error('no audio file');
            const bytes = await archive.readBytes(file);
            if (seq !== this.loadSeq) return;
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            const track = await MusicTrack.decode(this.engine, buf, file);
            if (seq !== this.loadSeq) {
                track.dispose();
                return;
            }
            this.replaceTrack(track, set.key);
            this.loadTimeline(set, seq);
            const start = opts.fromPreview ? Math.max(0, set.previewTime > 0 ? set.previewTime : track.duration * 0.4) : 0;
            track.playFrom(start, opts.fadeInMs ?? (opts.fromPreview ? 600 : 0));
            this.playingState.value = true;
        } catch (e) {
            console.warn('music: failed to play set', set.key, e);
            if (seq === this.loadSeq) this.playingState.value = false;
        }
    }

    /** Play an online preview clip (beatmap listing, empty-library menu). */
    async playOnline(set: Pick<OnlineSet, 'sid' | 'title' | 'artist'>): Promise<void> {
        const seq = ++this.loadSeq;
        this.stopTrack(300);
        this.timeline = null;
        this.setNow({ kind: 'online', sid: set.sid, title: set.title, artist: set.artist, cover: coverUrl(set.sid) });
        try {
            await this.preview.play(previewUrl(set.sid), { fadeInMs: 300 });
            this.playingState.value = true;
        } catch {
            // Superseded (a newer request owns the state) or blocked.
            if (seq === this.loadSeq) this.playingState.value = false;
        }
    }

    stopPreview(): void {
        this.preview.stop(300);
        if (this.current.value?.kind === 'online') this.playingState.value = false;
    }

    async next(): Promise<void> {
        if (this.historyPos < this.history.length - 1) {
            this.historyPos++;
            const set = this.library.get(this.history[this.historyPos]);
            if (set) return this.playSet(set, { restart: true });
        }
        return this.playRandom();
    }

    async prev(): Promise<void> {
        // Like osu!: restart if we're a few seconds in, else go back.
        if (this.track && !this.lent && this.track.currentTime > 4000) {
            this.track.playFrom(0);
            return;
        }
        if (this.historyPos > 0) {
            this.historyPos--;
            const set = this.library.get(this.history[this.historyPos]);
            if (set) {
                this.historyPos--; // playSet pushes it back
                return this.playSet(set, { restart: true });
            }
        }
        if (this.track && !this.lent) this.track.playFrom(0);
    }

    async playRandom(): Promise<void> {
        const sets = this.library.sets;
        if (sets.length > 0) {
            const currentKey = this.current.value?.kind === 'library' ? this.current.value.set.key : null;
            let pick = sets[Math.floor(Math.random() * sets.length)];
            if (sets.length > 1 && pick.key === currentKey) pick = sets[(sets.indexOf(pick) + 1) % sets.length];
            return this.playSet(pick, { restart: true });
        }
        if (this.onlineSource) {
            const set = await this.onlineSource();
            if (set) return this.playOnline(set);
        }
    }

    togglePause(): void {
        if (this.track && !this.lent) {
            if (this.track.isPlaying) this.track.pause();
            else this.track.play();
            this.playingState.value = this.track.isPlaying;
            return;
        }
        if (this.current.value?.kind === 'online') {
            if (this.preview.playing) this.stopPreview();
            else void this.playOnline(this.current.value);
        }
    }

    seek(ms: number): void {
        if (this.track && !this.lent) this.track.seek(ms);
    }

    /** Pause, and drop any song still loading so it can't start later (gameplay is taking over). */
    pause(): void {
        ++this.loadSeq;
        if (this.track && !this.lent && this.track.isPlaying) this.track.pause();
        this.preview.stop(200);
        this.playingState.value = false;
    }

    /**
     * Hand the decoded track for `setKey` to gameplay. Returns null when a
     * different (or no) track is loaded. Call `reclaim` afterwards.
     */
    lend(setKey: string): MusicTrack | null {
        // A song still loading (quick re-selection) must not start over gameplay.
        ++this.loadSeq;
        if (!this.track || this.trackSetKey !== setKey) return null;
        this.lent = true;
        this.track.ended.clear();
        this.track.loop = false;
        return this.track;
    }

    /** Take the track back after gameplay (or accept the one it decoded). */
    reclaim(track: MusicTrack | null, setKey: string | null): void {
        this.lent = false;
        if (track && setKey) {
            if (track !== this.track) this.replaceTrack(track, setKey);
            else this.attachEnded(track);
            track.setRate(1, true).catch(() => {});
        }
    }

    /** Beat phase for visual sync (logo pulse, kiai flashes). */
    beat(): BeatState {
        const t = this.track;
        if (!t || this.lent || !this.timeline || !t.isPlaying) return { beatLength: 0, phase: 0, beatIndex: 0, kiai: false };
        const time = t.currentTime;
        const cp = this.timeline.at(time);
        const uninheritedStart = findTimingStart(this.timeline, time);
        const since = time - uninheritedStart;
        const beatLength = cp.beatLength > 0 ? cp.beatLength : 500;
        const idx = Math.floor(since / beatLength);
        return { beatLength, phase: (since - idx * beatLength) / beatLength, beatIndex: idx, kiai: cp.kiai };
    }

    private loadTimeline(set: LibrarySet, seq: number): void {
        const diff = set.difficulties[set.difficulties.length - 1];
        if (!diff) return;
        this.library.loadBeatmap(set.key, diff.file).then(data => {
            if (seq !== this.loadSeq) return;
            this.timeline = buildControlPointTimeline(data.timingPoints, data.general.sampleSet);
        }).catch(() => (this.timeline = null));
    }

    private setNow(n: NowPlaying | null): void {
        this.current.value = n;
        this.trackChanged.emit(n);
    }

    private pushHistory(key: string): void {
        if (this.history[this.historyPos] === key) return;
        this.history.splice(this.historyPos + 1);
        this.history.push(key);
        if (this.history.length > 100) this.history.shift();
        this.historyPos = this.history.length - 1;
    }

    private replaceTrack(track: MusicTrack, key: string): void {
        if (this.track && this.track !== track && !this.lent) {
            const old = this.track;
            old.fadeTo(0, 250).then(() => old.dispose());
        }
        this.track = track;
        this.trackSetKey = key;
        this.lent = false;
        this.attachEnded(track);
    }

    private attachEnded(track: MusicTrack): void {
        track.ended.clear();
        track.ended.add(() => {
            if (track !== this.track || this.lent) return;
            if (this.loopFromPreview && this.current.value?.kind === 'library') {
                const set = this.current.value.set;
                track.playFrom(Math.max(0, set.previewTime), 600);
            } else if (this.enabled) {
                void this.next();
            } else {
                this.playingState.value = false;
            }
        });
    }

    private stopTrack(fadeMs: number): void {
        if (!this.track || this.lent) return;
        const old = this.track;
        this.track = null;
        this.trackSetKey = null;
        old.fadeTo(0, fadeMs).then(() => old.dispose());
    }

    dispose(): void {
        this.stopTrack(0);
        this.preview.stop(0);
    }
}

function findTimingStart(timeline: ControlPointTimeline, time: number): number {
    // Start of the governing tempo section: walk back while beat length is
    // unchanged (inherited points keep the parent's beat length).
    const pts = timeline.points;
    let lo = 0, hi = pts.length - 1, idx = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].time <= time) {
            idx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const bl = pts[idx]?.beatLength;
    while (idx > 0 && pts[idx - 1].beatLength === bl) idx--;
    return pts[idx]?.time ?? 0;
}
