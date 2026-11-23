import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { LiveTranscriptionSession } from "./transcription/types";
import type { VoiceReading } from "./transcription/voice-activity";

export type LinePlace = { sequence: number; startMs: number };

/** Audio sent to a provider, kept by the line it belongs to so a replacement can hear it again. */
export type AudioChunk = {
  audio: string;
  sampleCount: number;
  createdAt: number;
  voice: VoiceReading;
  turn: number;
};

/**
 * pending_ack: OpenAI has its audio and has not acknowledged it.
 * open: its provider owes its final.
 * replaying: its connection failed; it waits for a replacement to take its audio.
 * gap, final, dropped: it ended as a marker, with words, or with nothing to show.
 * A gap or a dropped line still takes a late answer in its place.
 */
export type CaptionLineState = "pending_ack" | "open" | "replaying" | "gap" | "final" | "dropped";

export type CaptionLine = {
  /** The public itemId viewers and snapshots know it by, for its whole life. */
  readonly id: string;
  state: CaptionLineState;
  readonly place: LinePlace;
  speaker: TranscriptSpeaker;
  /** Our voice check heard speech in it; one that ends with no words and was not heard shows nothing. */
  heard: boolean;
  text: string;
  /** A replacement re-transcribes this line's audio, so its next words replace the old ones. */
  freshText: boolean;
  /** Viewers already see this owed line as a final, its words or a gap; its later words and its answer update that final in place. */
  shownAsFinal: boolean;
  audio: AudioChunk[];
  /** The connection that owes it, or null while it waits for a replacement. */
  epoch: number | null;
  deadlineAt: number;
};

/** A commit OpenAI has not acknowledged: its line, and when it was sent, kept even if the line is trimmed. */
export type QueuedCommit = { lineId: string; committedAt: number };

const ACTIVE: ReadonlySet<CaptionLineState> = new Set(["pending_ack", "open", "replaying"]);

export const isActive = (line: CaptionLine): boolean => ACTIVE.has(line.state);

/**
 * Every caption line of a session, with one immutable id each. Active lines
 * own their audio; an ended line keeps only its place and words, and stays
 * until its connection closes or its segment is trimmed, so a late answer
 * fills it in place.
 */
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

  /** Active lines in no particular order, for checks that run on every chunk. */
  activeUnordered(): CaptionLine[] {
    return Array.from(this.lines.values()).filter(isActive);
  }

  add(line: Omit<CaptionLine, "id" | "text" | "freshText" | "shownAsFinal"> & { text?: string }): CaptionLine {
    const created: CaptionLine = { id: crypto.randomUUID(), text: "", freshText: false, shownAsFinal: false, ...line };
    this.lines.set(created.id, created);
    return created;
  }

  /** Ends a line: its audio goes now, its place and words stay for a late answer. */
  end(line: CaptionLine, state: "gap" | "final" | "dropped", text = line.text): void {
    line.state = state;
    line.text = text;
    line.audio = [];
    line.deadlineAt = Number.POSITIVE_INFINITY;
  }

  /** Forgets a line: one that never reached a provider, one ended with nothing to show, or one whose place was trimmed. */
  remove(id: string): void {
    this.lines.delete(id);
  }

  /** Forgets the ended lines a closed connection owed. */
  forgetEnded(epoch: number): void {
    for (const line of this.lines.values()) {
      if (!isActive(line) && line.epoch === epoch) this.lines.delete(line.id);
    }
  }

  /** Forgets lines whose segment was trimmed, or ended lines that never showed anything; an owed line not yet shown stays. */
  forgetShownExcept(kept: ReadonlySet<string>): void {
    for (const line of this.lines.values()) {
      if ((!isActive(line) || line.shownAsFinal) && !kept.has(line.id)) this.lines.delete(line.id);
    }
  }

  clear(): void {
    this.lines.clear();
  }
}

/**
 * One provider connection, live or draining, and the provider ids it has
 * named lines by. OpenAI acknowledges commits in order, so its queue holds
 * the lines whose audio it was sent and has not acknowledged.
 */
export class ProviderConnection {
  role: "live" | "draining" = "live";
  readonly providerToLine = new Map<string, string>();
  readonly commitQueue: QueuedCommit[] = [];
  /** Sarvam may report speech from its last audio until this time. */
  quietAt = 0;
  /** Places for lines a draining connection accepts after the switch, ahead of the new provider's. */
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
