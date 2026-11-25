import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { VoiceReading } from "./transcription/voice-activity";
import { speakerKey } from "./utils";

export type AudioOwner = { kind: "queued" } | { kind: "unowned" } | { kind: "line"; lineId: string };

export type HeldChunk = {
  readonly audio: string;
  readonly sampleCount: number;
  readonly speaker: TranscriptSpeaker;
  readonly sequence: number;
  readonly order: number;
  readonly createdAt: number;
  readonly voice: VoiceReading;
  readonly turn: number;
  sentAt: number | null;
  owner: AudioOwner;
};

export type QueuedMarker = { type: "commit" | "clear" | "pause"; speaker: TranscriptSpeaker; after: number };

export type QueuedEvent = { type: "chunk"; chunk: HeldChunk } | QueuedMarker;

export type AudioRun = { speaker: TranscriptSpeaker; turn: number; chunks: HeldChunk[] };

const isVoiced = (chunk: HeldChunk): boolean => chunk.voice !== "quiet";

export const runsOf = (chunks: readonly HeldChunk[], splitAtTurn: boolean): AudioRun[] => {
  const runs: AudioRun[] = [];
  for (const chunk of chunks) {
    const run = runs.at(-1);
    const last = run?.chunks.at(-1);
    if (
      run &&
      last &&
      last.sequence + 1 === chunk.sequence &&
      speakerKey(run.speaker) === speakerKey(chunk.speaker) &&
      (!splitAtTurn || run.turn === chunk.turn)
    ) {
      run.chunks.push(chunk);
    } else {
      runs.push({ speaker: chunk.speaker, turn: chunk.turn, chunks: [chunk] });
    }
  }
  return runs;
};

export const runHeard = (run: AudioRun): boolean => run.chunks.some(isVoiced);

export const lastHeardSentAt = (run: AudioRun): number =>
  run.chunks.reduce((latest, chunk) => (isVoiced(chunk) ? Math.max(latest, chunk.sentAt ?? chunk.createdAt) : latest), Number.NEGATIVE_INFINITY);

export class AudioStore {
  private chunks: HeldChunk[] = [];
  private markers: QueuedMarker[] = [];
  private total = 0;

  get bytes(): number {
    return this.total;
  }

  all(): readonly HeldChunk[] {
    return this.chunks;
  }

  add(chunk: HeldChunk): void {
    const last = this.chunks.at(-1);
    if (!last || last.sequence < chunk.sequence) {
      this.chunks.push(chunk);
    } else {
      const at = this.chunks.findIndex(({ sequence }) => sequence > chunk.sequence);
      this.chunks.splice(at, 0, chunk);
    }
    this.total += chunk.audio.length;
  }

  ownedBy(lineId: string): HeldChunk[] {
    return this.chunks.filter(({ owner }) => owner.kind === "line" && owner.lineId === lineId);
  }

  owns(lineId: string): boolean {
    return this.chunks.some(({ owner }) => owner.kind === "line" && owner.lineId === lineId);
  }

  unowned(): HeldChunk[] {
    return this.chunks.filter(({ owner }) => owner.kind === "unowned");
  }

  queued(): HeldChunk[] {
    return this.chunks.filter(({ owner }) => owner.kind === "queued");
  }

  hasQueued(): boolean {
    return this.markers.length > 0 || this.chunks.some(({ owner }) => owner.kind === "queued");
  }

  queueMarker(marker: QueuedMarker): void {
    this.markers.push(marker);
  }

  queuedEvents(): QueuedEvent[] {
    const events: { arrival: number; event: QueuedEvent }[] = [
      ...this.queued().map((chunk) => ({ arrival: chunk.sequence, event: { type: "chunk" as const, chunk } })),
      ...this.markers.map((marker) => ({ arrival: marker.after - 0.5, event: marker })),
    ];
    return events.sort((left, right) => left.arrival - right.arrival).map(({ event }) => event);
  }

  consumeMarker(marker: QueuedMarker): void {
    this.markers = this.markers.filter((queued) => queued !== marker);
  }

  setOwner(chunks: readonly HeldChunk[], owner: AudioOwner): void {
    for (const chunk of chunks) chunk.owner = owner;
  }

  releaseOwner(lineId: string): void {
    this.keep((chunk) => !(chunk.owner.kind === "line" && chunk.owner.lineId === lineId));
  }

  remove(chunks: readonly HeldChunk[]): void {
    const removed = new Set(chunks);
    this.keep((chunk) => !removed.has(chunk));
  }

  removeUnowned(): void {
    this.keep(({ owner }) => owner.kind !== "unowned");
  }

  enforceBudget(limit: number): HeldChunk[] {
    let excess = this.total - limit;
    if (excess <= 0) return [];
    const evicted: HeldChunk[] = [];
    for (const chunk of this.chunks) {
      if (excess <= 0) break;
      evicted.push(chunk);
      excess -= chunk.audio.length;
    }
    this.remove(evicted);
    return evicted;
  }

  clear(): void {
    this.chunks = [];
    this.markers = [];
    this.total = 0;
  }

  private keep(kept: (chunk: HeldChunk) => boolean): void {
    const next = this.chunks.filter(kept);
    if (next.length === this.chunks.length) return;
    this.chunks = next;
    this.total = next.reduce((sum, { audio }) => sum + audio.length, 0);
  }
}
