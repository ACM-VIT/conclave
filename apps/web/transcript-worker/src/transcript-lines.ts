import type {
  TranscriptSegment,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";

export type LinePlace = { sequence: number; startMs: number };

/**
 * Everything about one line a provider accepted: its place, the speaker of
 * the audio that created it, its words so far, and whether it is open or
 * waiting for an ack to claim it. Its audio is the replay journal's, owned
 * by its id. Its public itemId is fixed when it is accepted.
 */
export type LineRecord = {
  readonly id: string;
  readonly itemId: string;
  place: LinePlace;
  speaker: TranscriptSpeaker;
  shown: TranscriptSegment | null;
  /** Our voice check heard speech for it; one with no words that was not heard ends with nothing shown. */
  heard: boolean;
  /** Awaiting: its audio went to a provider that has not acknowledged it yet. */
  state: "open" | "awaiting";
  deadlineAt: number;
};

type NewLine = Pick<LineRecord, "place" | "speaker" | "heard" | "deadlineAt">;

/**
 * The lines one provider connection owes, each ending exactly once. Later
 * provider ids for a line are aliases of its public itemId, kept after it
 * ends so a late answer fills the same line; all of it goes with the book.
 */
export class TranscriptLines {
  private readonly records = new Map<string, LineRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly endedAliases = new Map<string, string>();
  private readonly endedAwaiting = new Map<string, string>();
  /** Sarvam: the line its new audio belongs to, until the turn ends. */
  audioOwner: string | null = null;

  get size(): number {
    return this.records.size;
  }

  /** How many records this book still holds, of any kind. */
  get retained(): number {
    return this.records.size + this.aliases.size + this.endedAliases.size + this.endedAwaiting.size;
  }

  get(providerItemId: string): LineRecord | undefined {
    const aliased = this.aliases.get(providerItemId);
    if (aliased) return this.records.get(aliased);
    for (const record of this.records.values()) {
      if (record.itemId === providerItemId) return record;
    }
    return undefined;
  }

  byId(id: string): LineRecord | undefined {
    return this.records.get(id);
  }

  /** The public itemId a provider id names, for a line of this book that already ended. */
  endedItemId(providerItemId: string): string | undefined {
    return this.endedAliases.get(providerItemId);
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
      state: "open",
      ...line,
    };
    this.records.set(record.id, record);
    return record;
  }

  /** A line for audio sent but not yet acknowledged; its ack claims it by id. */
  hold(line: NewLine): LineRecord {
    const id = crypto.randomUUID();
    const record: LineRecord = {
      id,
      itemId: `held-${id}`,
      shown: null,
      state: "awaiting",
      ...line,
    };
    this.records.set(id, record);
    return record;
  }

  /** The ack of a line's own audio, or an utterance heard in it on replay, opens it again under its own itemId. */
  claim(id: string, providerItemId: string, deadlineAt: number): LineRecord | null {
    const record = this.records.get(id);
    if (!record || record.state !== "awaiting") return null;
    return this.reopen(record, providerItemId, deadlineAt);
  }

  /** A late ack for a line that already ended names that line, so its final fills it. */
  reviveEnded(id: string, providerItemId: string): string | null {
    const itemId = this.endedAwaiting.get(id);
    if (itemId === undefined) return null;
    this.endedAwaiting.delete(id);
    this.endedAliases.set(providerItemId, itemId);
    return itemId;
  }

  /** Every line now waits for a replacement provider to claim it from its replayed audio. */
  awaitReplacement(): void {
    for (const record of this.records.values()) {
      record.state = "awaiting";
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
    if (!this.records.delete(record.id)) return;
    if (this.audioOwner === record.id) this.audioOwner = null;
    for (const [providerItemId, id] of this.aliases) {
      if (id !== record.id) continue;
      this.aliases.delete(providerItemId);
      this.endedAliases.set(providerItemId, record.itemId);
    }
    if (record.state === "awaiting") this.endedAwaiting.set(record.id, record.itemId);
  }

  takeDue(now: number): LineRecord[] {
    const due = this.all().filter(({ deadlineAt }) => deadlineAt <= now);
    for (const record of due) this.end(record);
    return due;
  }

  takeAll(): LineRecord[] {
    const all = this.all();
    for (const record of all) this.end(record);
    this.audioOwner = null;
    return all;
  }

  /** Forgets ended lines whose itemId is no longer in the transcript. */
  forgetEndedExcept(itemIds: ReadonlySet<string>): void {
    for (const ended of [this.endedAliases, this.endedAwaiting]) {
      for (const [key, itemId] of ended) {
        if (!itemIds.has(itemId)) ended.delete(key);
      }
    }
  }

  nextDeadline(): number | null {
    let next: number | null = null;
    for (const { deadlineAt } of this.records.values()) {
      if (Number.isFinite(deadlineAt) && (next === null || deadlineAt < next)) next = deadlineAt;
    }
    return next;
  }

  private reopen(record: LineRecord, providerItemId: string, deadlineAt: number): LineRecord {
    if (providerItemId !== record.itemId) this.aliases.set(providerItemId, record.id);
    record.state = "open";
    record.shown = null;
    record.deadlineAt = Math.min(record.deadlineAt, deadlineAt);
    return record;
  }
}
