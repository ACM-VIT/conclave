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
  it("uses current OpenAI defaults and exposes Claude alternatives", () => {
    expect(DEFAULT_TRANSCRIPT_QA_MODEL).toBe("gpt-6.1-sol");
    expect(TRANSCRIPT_QA_MODELS.map((model) => model.id)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]);
  });

  it("keeps unknown response models conservative", () => {
    expect(getTranscriptResponseModelConfig("custom-model")).toMatchObject({
      id: "custom-model",
      supportsReasoning: false,
      supportsTextVerbosity: false,
      supportsStructuredOutputs: false,
    });
  });

  it("does not prompt gpt-live-transcribe transcription sessions", () => {
    const realtimeWhisper = getTranscriptTranscriptionModelConfig(
      "gpt-live-transcribe",
    );
    expect(realtimeWhisper.supportsPrompt).toBe(false);
    expect(realtimeWhisper.supportsDelay).toBe(true);
    expect(
      getTranscriptTranscriptionModelConfig("gpt-4o-transcribe").supportsPrompt,
    ).toBe(true);
    expect(
      getTranscriptTranscriptionModelConfig("gpt-4o-transcribe").supportsDelay,
    ).toBe(false);
  });

  it("only exposes live-capable transcription models for room sessions", () => {
    expect(
      LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS.map((model) => model.id),
    ).toEqual(["gpt-live-transcribe", "saaras:v3"]);
    expect(getTranscriptTranscriptionProvider("saaras:v3")).toBe("sarvam");
    expect(getTranscriptTranscriptionProvider("gpt-live-transcribe")).toBe(
      "openai",
    );
  });
});
