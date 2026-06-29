import type {
  TranscriptMinutesEntry,
  TranscriptMinutesSnapshot,
  TranscriptSegment,
} from "@conclave/meeting-core/transcript-types";
import { DEFAULT_QA_MODEL } from "./constants";
import { hashCode, safeJsonParse, toStringValue, trimText } from "./utils";

export const createEmptyMinutes = (
  model = DEFAULT_QA_MODEL,
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

const entry = (text: string, index: number): TranscriptMinutesEntry => ({
  id: `m-${index}-${Math.abs(hashCode(text))}`,
  text,
});

export const fallbackMinutes = (
  segments: TranscriptSegment[],
  model: string,
): TranscriptMinutesSnapshot => {
  const finalText = segments
    .filter((segment) => segment.isFinal)
    .map(
      (segment) =>
        `${segment.speakerDisplayName}: ${trimText(segment.text, 500)}`,
    )
    .join("\n");
  const sentences = finalText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => trimText(sentence, 180))
    .filter(Boolean);
  const decisions = sentences.filter((sentence) =>
    /\b(decided|decision|agreed|approved|chosen|confirmed)\b/i.test(sentence),
  );
  const actionItems = sentences.filter((sentence) =>
    /\b(action|todo|follow up|follow-up|owner|will|needs to|next)\b/i.test(
      sentence,
    ),
  );
  const openQuestions = sentences.filter((sentence) => sentence.endsWith("?"));

  return {
    summary: trimText(sentences.slice(-4).join(" "), 900),
    topics: sentences.slice(-8, -3).map(entry),
    decisions: decisions.slice(-8).map(entry),
    actionItems: actionItems.slice(-10).map(entry),
    openQuestions: openQuestions.slice(-8).map(entry),
    followUps: actionItems.slice(-6).map(entry),
    updatedAt: Date.now(),
    model,
  };
};

export const parseMinutesFromText = (
  value: string,
  fallback: TranscriptMinutesSnapshot,
): TranscriptMinutesSnapshot => {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  const parsed = safeJsonParse(value.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object") return fallback;
  const data = parsed as Record<string, unknown>;
  const normalizeEntries = (key: string): TranscriptMinutesEntry[] =>
    (Array.isArray(data[key]) ? data[key] : [])
      .map((item, index) => {
        if (typeof item === "string") return entry(trimText(item, 240), index);
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const text = trimText(toStringValue(record.text), 280);
        if (!text) return null;
        return {
          id: toStringValue(record.id) || `${key}-${index}-${hashCode(text)}`,
          text,
          owner: toStringValue(record.owner) || undefined,
          due: toStringValue(record.due) || undefined,
        } satisfies TranscriptMinutesEntry;
      })
      .filter((item): item is TranscriptMinutesEntry => Boolean(item));

  return {
    summary: trimText(toStringValue(data.summary, fallback.summary), 1200),
    topics: normalizeEntries("topics"),
    decisions: normalizeEntries("decisions"),
    actionItems: normalizeEntries("actionItems"),
    openQuestions: normalizeEntries("openQuestions"),
    followUps: normalizeEntries("followUps"),
    updatedAt: Date.now(),
    model: fallback.model,
  };
};
