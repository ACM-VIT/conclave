import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptSegmentDelta,
} from "./types";

export const createEmptyTranscriptMinutes = (
  model = "gpt-5.5",
): TranscriptMinutesSnapshot => ({
  summary: "",
  topics: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
  followUps: [],
  updatedAt: Date.now(),
  model,
});

export const mergeTranscriptDelta = (
  partials: Map<string, TranscriptSegment>,
  delta: TranscriptSegmentDelta,
): Map<string, TranscriptSegment> => {
  const next = new Map(partials);
  const existing = next.get(delta.itemId);
  next.set(delta.itemId, {
    id: delta.id,
    itemId: delta.itemId,
    sequence: delta.sequence,
    speakerUserId: delta.speaker.userId,
    speakerDisplayName: delta.speaker.displayName,
    source: delta.speaker.source,
    text: delta.text,
    startMs: existing?.startMs ?? delta.startMs,
    endMs: null,
    isFinal: false,
    updatedAt: delta.updatedAt,
  });
  return next;
};

export const mergeTranscriptFinal = (
  segments: TranscriptSegment[],
  segment: TranscriptSegment,
): TranscriptSegment[] => {
  const next = [...segments];
  const existingIndex = next.findIndex(
    (candidate) => candidate.itemId === segment.itemId,
  );
  if (existingIndex >= 0) {
    next[existingIndex] = segment;
  } else {
    next.push(segment);
  }
  return orderTranscriptSegments(next);
};

export const orderTranscriptSegments = (
  segments: TranscriptSegment[],
): TranscriptSegment[] =>
  [...segments].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.startMs - right.startMs ||
      left.itemId.localeCompare(right.itemId),
  );

export const formatTranscriptTimestamp = (value: number): string => {
  const date = new Date(value);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

export const exportTranscriptMarkdown = (options: {
  roomId: string;
  segments: TranscriptSegment[];
  minutes: TranscriptMinutesSnapshot;
}): string => {
  const lines: string[] = [
    `# Meeting Transcript - ${options.roomId}`,
    "",
    `Exported: ${new Date().toLocaleString()}`,
    "",
  ];

  if (options.minutes.summary.trim()) {
    lines.push("## Summary", "", options.minutes.summary.trim(), "");
  }

  const section = (
    title: string,
    items: { text: string; owner?: string; due?: string }[],
  ) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const item of items) {
      const meta = [item.owner, item.due].filter(Boolean).join(" - ");
      lines.push(`- ${item.text}${meta ? ` (${meta})` : ""}`);
    }
    lines.push("");
  };

  section("Topics", options.minutes.topics);
  section("Decisions", options.minutes.decisions);
  section("Action Items", options.minutes.actionItems);
  section("Open Questions", options.minutes.openQuestions);
  section("Follow-Ups", options.minutes.followUps);

  lines.push("## Transcript", "");
  for (const segment of orderTranscriptSegments(options.segments)) {
    lines.push(
      `- ${formatTranscriptTimestamp(segment.startMs)} ${segment.speakerDisplayName}: ${segment.text}`,
    );
  }

  return lines.join("\n");
};
