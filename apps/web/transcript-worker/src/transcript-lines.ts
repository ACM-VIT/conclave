import type { TranscriptSegment } from "@conclave/meeting-core/transcript-types";

export type LinePlace = { sequence: number; startMs: number };

/** A line a provider accepted and has not finished yet. */
export type OpenLine = {
  itemId: string;
  place: LinePlace;
  /** The words on screen so far; null until the first of them. */
  shown: TranscriptSegment | null;
  deadlineAt: number;
};

/**
 * The lines one provider connection owes: each has its place from the
 * moment the provider accepted it and ends exactly once, as its final, or
 * as its words or a gap at its deadline.
 */
export class TranscriptLines {
  private readonly lines = new Map<string, OpenLine>();
  private readonly held: string[] = [];

  get size(): number {
    return this.lines.size;
  }

  get(itemId: string): OpenLine | undefined {
    return this.lines.get(itemId);
  }

  all(): OpenLine[] {
    return Array.from(this.lines.values());
  }

  shown(): TranscriptSegment[] {
    return this.all().flatMap(({ shown }) => (shown ? [shown] : []));
  }

  accept(itemId: string, place: LinePlace, deadlineAt: number): OpenLine {
    const existing = this.lines.get(itemId);
    if (existing) return existing;
    const line: OpenLine = { itemId, place, shown: null, deadlineAt };
    this.lines.set(itemId, line);
    return line;
  }

  /** Keeps a place under a unique key for audio sent but not yet acknowledged, in send order. */
  hold(key: string, place: LinePlace, deadlineAt: number): void {
    this.accept(key, place, deadlineAt);
    this.held.push(key);
  }

  /** Gives the oldest held place to the item just acknowledged. */
  claimHeld(itemId: string): OpenLine | null {
    for (let key = this.held.shift(); key; key = this.held.shift()) {
      const held = this.lines.get(key);
      if (!held) continue;
      this.lines.delete(key);
      const line: OpenLine = { ...held, itemId };
      this.lines.set(itemId, line);
      return line;
    }
    return null;
  }

  show(itemId: string, segment: TranscriptSegment): void {
    const line = this.lines.get(itemId);
    if (line) line.shown = segment;
  }

  end(itemId: string): OpenLine | null {
    const line = this.lines.get(itemId) ?? null;
    this.lines.delete(itemId);
    return line;
  }

  /** Removes and returns the lines whose deadline has passed. */
  takeDue(now: number): OpenLine[] {
    const due = this.all().filter(({ deadlineAt }) => deadlineAt <= now);
    for (const { itemId } of due) this.lines.delete(itemId);
    return due;
  }

  takeAll(): OpenLine[] {
    const all = this.all();
    this.lines.clear();
    this.held.length = 0;
    return all;
  }

  nextDeadline(): number | null {
    let next: number | null = null;
    for (const { deadlineAt } of this.lines.values()) {
      if (next === null || deadlineAt < next) next = deadlineAt;
    }
    return next;
  }
}
