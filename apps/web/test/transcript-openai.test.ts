import { describe, expect, it } from "vitest";
import {
  buildRealtimeTranscriptionConfig,
  buildTranscriptionPrompt,
} from "../transcript-worker/src/openai";

describe("transcript OpenAI request helpers", () => {
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
});
