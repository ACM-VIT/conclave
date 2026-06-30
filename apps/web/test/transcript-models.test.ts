import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  getTranscriptResponseModelConfig,
  getTranscriptTranscriptionModelConfig,
  getTranscriptTranscriptionProvider,
  LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS,
  TRANSCRIPT_QA_MODELS,
} from "@conclave/meeting-core/transcript-models";

describe("transcript model registry", () => {
  it("uses documented OpenAI response model ids", () => {
    expect(DEFAULT_TRANSCRIPT_QA_MODEL).toBe("gpt-5.5");
    expect(TRANSCRIPT_QA_MODELS.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
    ]);
    expect(
      TRANSCRIPT_QA_MODELS.some((model) => model.id === "gpt-5.5-mini"),
    ).toBe(false);
  });

  it("keeps unknown response models conservative", () => {
    expect(getTranscriptResponseModelConfig("custom-model")).toMatchObject({
      id: "custom-model",
      supportsReasoning: false,
      supportsTextVerbosity: false,
      supportsStructuredOutputs: false,
    });
  });

  it("does not prompt gpt-realtime-whisper transcription sessions", () => {
    const realtimeWhisper =
      getTranscriptTranscriptionModelConfig("gpt-realtime-whisper");
    expect(realtimeWhisper.supportsPrompt).toBe(false);
    expect(realtimeWhisper.supportsDelay).toBe(true);
    expect(
      getTranscriptTranscriptionModelConfig("gpt-4o-transcribe")
        .supportsPrompt,
    ).toBe(true);
    expect(
      getTranscriptTranscriptionModelConfig("gpt-4o-transcribe")
        .supportsDelay,
    ).toBe(false);
  });

  it("only exposes live-capable transcription models for room sessions", () => {
    expect(LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS.map((model) => model.id)).toEqual(
      ["gpt-realtime-whisper", "saaras:v3"],
    );
    expect(getTranscriptTranscriptionProvider("saaras:v3")).toBe("sarvam");
    expect(getTranscriptTranscriptionProvider("gpt-realtime-whisper")).toBe(
      "openai",
    );
  });
});
