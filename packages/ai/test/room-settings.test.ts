import { describe, expect, it } from "vitest";
import { AI_RESPONSE_MODELS } from "../src/models.js";
import {
  AI_FEATURES,
  AI_GENERATION_LIMITS,
  resolveAiFeatureSettings,
  validateFeaturePatch,
  parseRoomAiFeatureSettings,
} from "../src/room-settings.js";

describe("room feature configuration", () => {
  it("gives every text feature more than ten thousand research and output tokens", () => {
    for (const feature of [
      "assistant",
      "games",
      "minutes",
      "questions",
    ] as const) {
      const settings = resolveAiFeatureSettings({}, feature);
      expect(settings.maxOutputTokens).toBe(32768);
      expect(settings.researchTokens).toBe(16384);
    }
    for (const model of AI_RESPONSE_MODELS) {
      expect(model.minutesMaxOutputTokens).toBeGreaterThan(10_000);
      expect(model.qaMaxOutputTokens).toBeGreaterThan(10_000);
    }
    expect(AI_GENERATION_LIMITS.gameAckTimeoutMs).toBeGreaterThan(
      AI_GENERATION_LIMITS.maxTimeoutMs,
    );
    expect(AI_GENERATION_LIMITS.relayContentChars).toBeGreaterThan(
      AI_GENERATION_LIMITS.outputTokens * 8,
    );
  });
  it("keeps models and budgets independent and preserves the room's initial provider choice", () => {
    const env = {
      CONCLAVE_ASSISTANT_MODEL: "claude-haiku-5-5",
      CONCLAVE_AI_SETTINGS: JSON.stringify({
        assistant: { model: "gpt-6.1-sol", maxOutputTokens: 65536 },
        games: { model: "claude-sonnet-5-5", researchTokens: 24000 },
        minutes: { model: "claude-opus-5-5" },
      }),
    };
    expect(resolveAiFeatureSettings(env, "assistant")).toMatchObject({
      model: "gpt-6.1-sol",
      maxOutputTokens: 65536,
    });
    expect(resolveAiFeatureSettings(env, "games")).toMatchObject({
      model: "claude-sonnet-5-5",
      researchTokens: 24000,
      maxOutputTokens: 32768,
    });
    expect(resolveAiFeatureSettings(env, "questions").model).toBe(
      "claude-haiku-5-5",
    );
    expect(resolveAiFeatureSettings(env, "minutes").model).toBe(
      "claude-opus-5-5",
    );
    expect(resolveAiFeatureSettings(env, "transcription").model).toBe(
      AI_FEATURES.transcription.model,
    );
  });
  it.each([
    { apiKey: "sk-secret" },
    { maxOutputTokens: -1 },
    { researchTokens: "16000" },
    { timeoutMs: Infinity },
    { searchEnabled: "true" },
    { instructions: "x".repeat(32001) },
    { model: "saaras:v3" },
  ])("rejects unsupported settings: %j", (patch) => {
    expect(() => validateFeaturePatch("assistant", patch)).toThrow();
  });
  it("validates non-text model capabilities and refuses unknown features", () => {
    expect(
      validateFeaturePatch("transcription", { model: "saaras:v3" }),
    ).toEqual({ model: "saaras:v3" });
    expect(() =>
      validateFeaturePatch("transcription", { model: "claude-haiku-5-5" }),
    ).toThrow();
    expect(() =>
      validateFeaturePatch("images", { model: "gpt-6.1-sol" }),
    ).toThrow();
    expect(() =>
      parseRoomAiFeatureSettings({ unknown: { enabled: true } }),
    ).toThrow();
  });
});
