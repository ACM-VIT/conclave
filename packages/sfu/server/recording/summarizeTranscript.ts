import { Logger } from "../../utilities/loggers.js";
import type { TranscriptChunk } from "./roomTranscriber.js";

const DEFAULT_MODEL_URL =
  process.env.HF_SUMMARY_URL ||
  "https://api-inference.huggingface.co/models/sshleifer/distilbart-cnn-12-6";

const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN;

const MAX_TEXT_LENGTH = 6000;
const FALLBACK_SENTENCE_LIMIT = 4;
const TOPIC_LIMIT = 6;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
  "your",
]);
const ACTION_TERMS = /\b(action|owner|deadline|due|follow[- ]?up|next step|todo|decide|decision|approve|ship|deliver)\b/i;

const buildPrompt = (chunks: TranscriptChunk[]): string => {
  const lines = chunks.map((c) => {
    const start = new Date(c.startMs).toISOString();
    const speaker = c.speaker || "unknown";
    return `[${start}] ${speaker}: ${c.text}`;
  });
  const text = lines.join("\n");
  return text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH)
    : text;
};

const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter(
    (token) => !STOPWORDS.has(token),
  );

const stripMetadata = (sentence: string): string =>
  sentence.replace(/\[[^\]]+\]\s*/g, "").replace(/^\w+:\s*/, "").trim();

const localFallbackSummary = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const rawSentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => stripMetadata(sentence))
    .filter(Boolean);

  if (!rawSentences.length) return "No content";

  const frequency = new Map<string, number>();
  for (const token of tokenize(normalized)) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }

  const scored = rawSentences.map((sentence, index) => {
    const tokens = tokenize(sentence);
    const tokenScore = tokens.reduce(
      (sum, token) => sum + (frequency.get(token) || 0),
      0,
    );
    const density = tokens.length ? tokenScore / tokens.length : 0;
    const actionBoost = ACTION_TERMS.test(sentence) ? 1.4 : 1;
    return { index, sentence, score: density * actionBoost };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(FALLBACK_SENTENCE_LIMIT, rawSentences.length))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);

  const topTopics = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_LIMIT)
    .map(([topic]) => topic);

  const actionItems = rawSentences.filter((sentence) => ACTION_TERMS.test(sentence));

  const sections = [
    `Key discussion points: ${selected.join(" ")}`,
    topTopics.length ? `Top themes: ${topTopics.join(", ")}.` : "",
    actionItems.length
      ? `Action items noted: ${actionItems.slice(0, 3).join(" ")}`
      : "Action items noted: none captured explicitly.",
  ].filter(Boolean);

  return sections.join("\n\n");
};

export async function summarizeTranscript(
  chunks: TranscriptChunk[],
): Promise<string> {
  if (!chunks.length) return "No transcript available.";
  const text = buildPrompt(chunks);

  if (HUGGINGFACE_TOKEN) {
    try {
      const res = await fetch(DEFAULT_MODEL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${HUGGINGFACE_TOKEN}`,
        },
        body: JSON.stringify({
          inputs: text,
          parameters: { max_length: 220, min_length: 60 },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        Logger.warn("HF summary request failed", { status: res.status, body });
        return localFallbackSummary(text);
      }

      const data = (await res.json()) as any;
      const summary = Array.isArray(data)
        ? data[0]?.summary_text
        : (data as any)?.summary_text;
      return summary || localFallbackSummary(text);
    } catch (err) {
      Logger.warn("HF summary request errored", err);
      return localFallbackSummary(text);
    }
  }

  return localFallbackSummary(text);
}
