import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { LiveTranscriptionSession } from "./transcription/types";
import type { VoiceReading } from "./transcription/voice-activity";

export type LinePlace = { sequence: number; startMs: number };

export type AudioChunk = {
  audio: string;
  sampleCount: number;
  createdAt: number;
  sequence: number;
  voice: VoiceReading;
  turn: number;
};

export type CaptionLineState = "pending_ack" | "open" | "replaying" | "gap" | "final" | "dropped";

export type CaptionLine = {
  readonly id: string;
  state: CaptionLineState;
  readonly place: LinePlace;
  speaker: TranscriptSpeaker;
  heard: boolean;
  text: string;
  freshText: boolean;
  replayed: boolean;
  audio: AudioChunk[];
  epoch: number | null;
  deadlineAt: number;
};

export type QueuedCommit = { lineId: string; committedAt: number };

const ACTIVE: ReadonlySet<CaptionLineState> = new Set(["pending_ack", "open", "replaying"]);

export const isActive = (line: CaptionLine): boolean => ACTIVE.has(line.state);

export class CaptionLedger {
  private readonly lines = new Map<string, CaptionLine>();

  get size(): number {
    return this.lines.size;
  }

  get(id: string): CaptionLine | undefined {
    return this.lines.get(id);
  }

  all(): CaptionLine[] {
    return Array.from(this.lines.values()).sort(
      (left, right) => left.place.sequence - right.place.sequence,
    );
  }

  active(): CaptionLine[] {
    return this.all().filter(isActive);
  }

  activeUnordered(): CaptionLine[] {
    return Array.from(this.lines.values()).filter(isActive);
  }

  add(line: Omit<CaptionLine, "id" | "text" | "freshText" | "replayed"> & { text?: string }): CaptionLine {
    const created: CaptionLine = { id: crypto.randomUUID(), text: "", freshText: false, replayed: false, ...line };
    this.lines.set(created.id, created);
    return created;
  }

  end(line: CaptionLine, state: "gap" | "final" | "dropped", text = line.text): void {
    line.state = state;
    line.text = text;
    line.audio = [];
    line.deadlineAt = Number.POSITIVE_INFINITY;
  }

  remove(id: string): void {
    this.lines.delete(id);
  }

  forgetEnded(epoch: number): void {
    for (const line of this.lines.values()) {
      if (!isActive(line) && line.epoch === epoch) this.lines.delete(line.id);
    }
  }

  forgetShownExcept(kept: ReadonlySet<string>): void {
    for (const line of this.lines.values()) {
      if (!isActive(line) && !kept.has(line.id)) this.lines.delete(line.id);
    }
  }

  clear(): void {
    this.lines.clear();
  }
}

export class ProviderConnection {
  role: "live" | "draining" = "live";
  readonly providerToLine = new Map<string, string>();
  readonly commitQueue: QueuedCommit[] = [];
  quietAt = 0;
  block: { next: number; end: number } | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly epoch: number,
    readonly session: LiveTranscriptionSession,
  ) {}

  bind(providerItemId: string, lineId: string): void {
    this.providerToLine.set(providerItemId, lineId);
  }

  providerIdsOf(lineId: string): string[] {
    return Array.from(this.providerToLine.entries()).flatMap(([providerItemId, id]) =>
      id === lineId ? [providerItemId] : [],
    );
  }

  forgetLinesExcept(kept: (lineId: string) => boolean): void {
    for (const [providerItemId, lineId] of this.providerToLine) {
      if (!kept(lineId)) this.providerToLine.delete(providerItemId);
    }
  }
}
