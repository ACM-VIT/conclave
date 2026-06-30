import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@conclave/meeting-core/transcript-types";
import type { Env } from "../transcript-worker/src/types";
import {
  QA_SYSTEM_PROMPT,
  buildQaTranscriptContext,
  buildRealtimeTranscriptionConfig,
  buildTranscriptionPrompt,
  realtimeEndpoint,
} from "../transcript-worker/src/openai";

const segment = (
  sequence: number,
  text: string,
  options: { final?: boolean } = {},
): TranscriptSegment => ({
  id: `item-${sequence}`,
  itemId: `item-${sequence}`,
  sequence,
  speakerUserId: sequence % 2 === 0 ? "u1" : "u2",
  speakerDisplayName: sequence % 2 === 0 ? "Ada" : "Grace",
  source: "remote",
  text,
  startMs: Date.UTC(2026, 0, 1, 10, 0, sequence),
  endMs: options.final === false ? null : Date.UTC(2026, 0, 1, 10, 0, sequence + 1),
  isFinal: options.final !== false,
  updatedAt: Date.UTC(2026, 0, 1, 10, 0, sequence + 1),
});

describe("transcript OpenAI request helpers", () => {
  it("builds realtime transcription endpoint with intent and model", () => {
    const endpoint = realtimeEndpoint(
      {
        OPENAI_REALTIME_URL: "wss://api.openai.com/v1/realtime",
      } as Partial<Env> as Env,
      "gpt-realtime-whisper",
    );
    const url = new URL(endpoint);

    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("intent")).toBe("transcription");
    expect(url.searchParams.get("model")).toBe("gpt-realtime-whisper");
  });

  it("sends delay only for gpt-realtime-whisper", () => {
    expect(
      buildRealtimeTranscriptionConfig({
        model: "gpt-realtime-whisper",
        language: "en",
        delay: "medium",
        locale: "en-IN",
      }),
    ).toEqual({
      model: "gpt-realtime-whisper",
      language: "en",
      delay: "medium",
    });
  });

  it("normalizes non-Realtime transcription models to the live default", () => {
    expect(
      buildRealtimeTranscriptionConfig({
        model: "gpt-4o-transcribe",
        language: "en",
        delay: "medium",
        locale: "en-IN",
      }),
    ).toEqual({
      model: "gpt-realtime-whisper",
      language: "en",
      delay: "medium",
    });
  });

  it("builds India-focused localization prompts for prompt-capable models", () => {
    const prompt = buildTranscriptionPrompt({
      locale: "en-IN",
      localizationPrompt: "Expect ACM VIT and Hinglish project names.",
    });

    expect(prompt).toContain("Preferred locale: en-IN.");
    expect(prompt).toContain("Hinglish");
    expect(prompt).toContain("ACM VIT");
  });

  it("builds Ask context from the full available transcript", () => {
    const segments = Array.from({ length: 150 }, (_, index) =>
      segment(
        index,
        index === 0
          ? "FIRST_CONTEXT_MARKER"
          : index === 149
            ? "LAST_CONTEXT_MARKER"
            : `Segment ${index}`,
      ),
    );

    const context = buildQaTranscriptContext(segments);

    expect(context).toContain("FIRST_CONTEXT_MARKER");
    expect(context).toContain("LAST_CONTEXT_MARKER");
    expect(context.split("\n")).toHaveLength(150);
  });

  it("keeps full segment text in Ask context", () => {
    const longText = "x".repeat(1200);
    const context = buildQaTranscriptContext([segment(1, longText)]);

    expect(context).toContain(longText);
  });

  it("keeps Ask grounded in transcript evidence and speaker attribution", () => {
    expect(QA_SYSTEM_PROMPT).toContain("source of truth");
    expect(QA_SYSTEM_PROMPT).toContain("Do not reassign a statement");
    expect(QA_SYSTEM_PROMPT).toContain("If the user asks what someone said");
    expect(QA_SYSTEM_PROMPT).toContain("owner not stated");
    expect(QA_SYSTEM_PROMPT).toContain("partial");
  });
});
