import type {
  TranscriptSegment,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import type { ReplayBatch } from "./transcription-recovery";

export type LinePlace = { sequence: number; startMs: number };

/**
 * Everything about one line a provider accepted: its place, the speaker of
 * the audio that created it, its words so far, its own replay audio, and
 * whether it is open or waiting for an ack to claim it.
 */
export type LineRecord = {
  readonly id: string;
  itemId: string;
  place: LinePlace;
  speaker: TranscriptSpeaker;
  shown: TranscriptSegment | null;
  /** Our voice check heard speech for it; one with no words that was not heard ends with nothing shown. */
  heard: boolean;
  audio: ReplayBatch[];
  /** Awaiting: its audio went to a provider that has not acknowledged it yet. */
  state: "open" | "awaiting";
  /** Its audio was replayed to a replacement, so a new utterance there may claim it. */
  replayed: boolean;
  deadlineAt: number;
};

type NewLine = Pick<LineRecord, "place" | "speaker" | "heard" | "deadlineAt">;

/** The lines one provider connection owes, each ending exactly once. */
export class TranscriptLines {
  private readonly records = new Map<string, LineRecord>();
  /** Sarvam: the line its committed audio belongs to, until the turn ends. */
  audioOwner: string | null = null;

  get size(): number {
    return this.records.size;
  }

  get(itemId: string): LineRecord | undefined {
    for (const record of this.records.values()) {
      if (record.itemId === itemId) return record;
    }
    return undefined;
  }

  byId(id: string): LineRecord | undefined {
    return this.records.get(id);
  }

  all(): LineRecord[] {
    return Array.from(this.records.values()).sort(
      (left, right) => left.place.sequence - right.place.sequence,
    );
  }

  /** Words of open lines; a line awaiting a replacement is re-transcribed there. */
  shown(): TranscriptSegment[] {
    return this.all().flatMap(({ shown, state }) => (shown && state === "open" ? [shown] : []));
  }

  accept(itemId: string, line: NewLine): LineRecord {
    const record: LineRecord = {
      id: crypto.randomUUID(),
      itemId,
      shown: null,
      audio: [],
      state: "open",
      replayed: false,
      ...line,
    };
    this.records.set(record.id, record);
    return record;
  }

  /** A line for audio sent but not yet acknowledged; its ack claims it by id. */
  hold(line: NewLine): LineRecord {
    const record = this.accept("", line);
    record.itemId = `held-${record.id}`;
    record.state = "awaiting";
    return record;
  }

  /** The ack of a line's own audio names it and opens it again. */
  claim(id: string, itemId: string, deadlineAt: number): LineRecord | null {
    const record = this.records.get(id);
    if (!record || record.state !== "awaiting") return null;
    return this.reopen(record, itemId, deadlineAt);
  }

  /** A new utterance on a replacement takes the oldest line whose audio was replayed to it. */
  claimReplayed(itemId: string, deadlineAt: number): LineRecord | null {
    const record = this.all().find(({ state, replayed }) => state === "awaiting" && replayed);
    return record ? this.reopen(record, itemId, deadlineAt) : null;
  }

  /** Every line now waits for a replacement provider's ack of its replayed audio. */
  awaitReplacement(replayedIds: ReadonlySet<string>): void {
    for (const record of this.records.values()) {
      record.state = "awaiting";
      record.replayed = replayedIds.has(record.id);
      record.audio = [];
      record.deadlineAt = Number.POSITIVE_INFINITY;
    }
    this.audioOwner = null;
  }

  /** Once the replacement has its audio, a line it never claims ends at a deadline. */
  limitAwaiting(deadlineAt: number): void {
    for (const record of this.records.values()) {
      if (record.state === "awaiting" && record.deadlineAt > deadlineAt) {
        record.deadlineAt = deadlineAt;
      }
    }
  }

  end(record: LineRecord): void {
    this.records.delete(record.id);
    if (this.audioOwner === record.id) this.audioOwner = null;
  }

  takeDue(now: number): LineRecord[] {
    const due = this.all().filter(({ deadlineAt }) => deadlineAt <= now);
    for (const record of due) this.end(record);
    return due;
  }

  takeAll(): LineRecord[] {
    const all = this.all();
    this.records.clear();
    this.audioOwner = null;
    return all;
  }

  nextDeadline(): number | null {
    let next: number | null = null;
    for (const { deadlineAt } of this.records.values()) {
      if (Number.isFinite(deadlineAt) && (next === null || deadlineAt < next)) next = deadlineAt;
    }
    return next;
  }

  private reopen(record: LineRecord, itemId: string, deadlineAt: number): LineRecord {
    record.itemId = itemId;
    record.state = "open";
    record.replayed = false;
    record.shown = null;
    record.deadlineAt = Math.min(record.deadlineAt, deadlineAt);
    return record;
  }
}
