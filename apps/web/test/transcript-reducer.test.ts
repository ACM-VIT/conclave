import { describe, expect, it } from "vitest";
import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptSegmentDelta,
} from "../src/app/lib/types";
import {
  exportTranscriptMarkdown,
  mergeTranscriptDelta,
  mergeTranscriptFinal,
  orderTranscriptSegments,
} from "../src/app/lib/transcript-reducer";

const delta = (
  overrides: Partial<TranscriptSegmentDelta> = {},
): TranscriptSegmentDelta => ({
  id: "item-a",
  itemId: "item-a",
  sequence: 2,
  speaker: {
    userId: "u1",
    displayName: "Ada",
    source: "remote",
  },
  text: "hello",
  delta: "hello",
  startMs: 1_000,
  updatedAt: 1_100,
  ...overrides,
});

const segment = (
  itemId: string,
  sequence: number,
  text: string,
): TranscriptSegment => ({
  id: itemId,
  itemId,
  sequence,
  speakerUserId: "u1",
  speakerDisplayName: "Ada",
  source: "remote",
  text,
  startMs: 1_700_000_000_000 + sequence * 1_000,
  endMs: 1_700_000_000_500 + sequence * 1_000,
  isFinal: true,
  updatedAt: 1_700_000_000_500 + sequence * 1_000,
});

const minutes: TranscriptMinutesSnapshot = {
  summary: "Reviewed launch risks.",
  topics: [{ id: "topic-1", text: "Launch plan" }],
  decisions: [{ id: "decision-1", text: "Ship the transcript dock" }],
  actionItems: [{ id: "action-1", text: "Run QA", owner: "Ada" }],
  openQuestions: [{ id: "question-1", text: "Who owns follow-up?" }],
  followUps: [{ id: "follow-1", text: "Send notes" }],
  updatedAt: 1_700_000_010_000,
  model: "gpt-5.6-terra",
};

describe("transcript reducer", () => {
  it("merges partial deltas without replacing the original start time", () => {
    let partials = new Map<string, TranscriptSegment>();
    partials = mergeTranscriptDelta(partials, delta());
    partials = mergeTranscriptDelta(
      partials,
      delta({ text: "hello world", startMs: 2_000, updatedAt: 1_200 }),
    );

    expect(partials.get("item-a")).toMatchObject({
      text: "hello world",
      startMs: 1_000,
      updatedAt: 1_200,
      isFinal: false,
    });
  });

  it("replaces finals by item ID and keeps sequence ordering", () => {
    let segments: TranscriptSegment[] = [
      segment("later", 4, "later"),
      segment("early", 1, "early"),
    ];

    segments = mergeTranscriptFinal(segments, segment("middle", 3, "middle"));
    segments = mergeTranscriptFinal(
      segments,
      segment("early", 1, "early updated"),
    );

    expect(segments.map((item) => item.itemId)).toEqual([
      "early",
      "middle",
      "later",
    ]);
    expect(segments[0].text).toBe("early updated");
  });

  it("orders segments deterministically by sequence, start time, and item ID", () => {
    const ordered = orderTranscriptSegments([
      { ...segment("b", 2, "b"), startMs: 20 },
      { ...segment("a", 2, "a"), startMs: 20 },
      { ...segment("earliest", 1, "earliest"), startMs: 30 },
      { ...segment("middle", 2, "middle"), startMs: 10 },
    ]);

    expect(ordered.map((item) => item.itemId)).toEqual([
      "earliest",
      "middle",
      "a",
      "b",
    ]);
  });

  it("exports minutes and final segments as markdown", () => {
    const markdown = exportTranscriptMarkdown({
      roomId: "room-a",
      minutes,
      segments: [segment("one", 1, "We should launch this week.")],
    });

    expect(markdown).toContain("# Meeting Transcript - room-a");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Reviewed launch risks.");
    expect(markdown).toContain("- Ship the transcript dock");
    expect(markdown).toContain("- Run QA (Ada)");
    expect(markdown).toContain("Ada: We should launch this week.");
  });

  it("exports live partial segments in stable transcript order", () => {
    const partial = {
      ...segment("partial", 1, "still streaming"),
      isFinal: false,
      endMs: null,
    };
    const final = segment("final", 2, "already final");

    const markdown = exportTranscriptMarkdown({
      roomId: "room-a",
      minutes,
      segments: [final, partial],
    });

    expect(markdown.indexOf("Ada: still streaming")).toBeLessThan(
      markdown.indexOf("Ada: already final"),
    );
  });
});
