import { Logger } from "../../utilities/loggers.js";
import type { TranscriptChunk } from "./roomTranscriber.js";

const DEFAULT_MODEL_URL =
  process.env.HF_SUMMARY_URL ||
  // MODEL TO BE CHANGED, THIS IS TEMPORARY AND UNRELIABLE
  "https://api-inference.huggingface.co/models/facebook/bart-large-cnn";

const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN;

const FALLBACK_SENTENCE_LIMIT = 3;
const MAX_TEXT_LENGTH = 6000; // keep payload modest for free tier

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

const localFallbackSummary = (text: string): string => {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, FALLBACK_SENTENCE_LIMIT).join(" ") || "No content";
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
        body: JSON.stringify({ inputs: text, parameters: { max_length: 220, min_length: 60 } }),
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

  // No token, fallback to simple heuristic summary
  return localFallbackSummary(text);
}
