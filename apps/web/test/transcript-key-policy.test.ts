import { describe, expect, it } from "vitest";
import {
  getGlobalTranscriptProviderKeyAvailability,
  hasGlobalOpenAiApiKey,
  hasGlobalTranscriptProviderApiKey,
  resolveTranscriptProviderApiKey,
  resolveTranscriptResponseApiKey,
  resolveTranscriptOpenAiApiKey,
} from "../transcript-worker/src/key-policy";

describe("hasGlobalOpenAiApiKey", () => {
  it("only reports configured non-empty keys", () => {
    expect(hasGlobalOpenAiApiKey({})).toBe(false);
    expect(hasGlobalOpenAiApiKey({ OPENAI_API_KEY: "   " })).toBe(false);
    expect(hasGlobalOpenAiApiKey({ OPENAI_API_KEY: "sk-global" })).toBe(true);
  });
});

describe("transcript provider key policy", () => {
  it("reports global keys by provider", () => {
    expect(getGlobalTranscriptProviderKeyAvailability({})).toEqual({
      openai: false,
      sarvam: false,
      anthropic: false,
    });
    expect(
      getGlobalTranscriptProviderKeyAvailability({
        OPENAI_API_KEY: "sk-global",
        SARVAM_API_KEY: "sarvam-global",
      }),
    ).toEqual({
      openai: true,
      sarvam: true,
      anthropic: false,
    });
    expect(
      hasGlobalTranscriptProviderApiKey(
        { SARVAM_API_KEY: " sarvam-global " },
        "sarvam",
      ),
    ).toBe(true);
  });

  it("does not apply OpenAI key shape rules to Sarvam keys", () => {
    expect(
      resolveTranscriptProviderApiKey({
        provider: "sarvam",
        providedApiKey: " sarvam-user ",
        globalApiKey: "sarvam-global",
      }),
    ).toEqual({
      ok: true,
      apiKey: "sarvam-user",
      source: "controller",
    });
  });
});

describe("resolveTranscriptOpenAiApiKey", () => {
  it("uses a participant key when provided", () => {
    expect(
      resolveTranscriptOpenAiApiKey({
        providedApiKey: " sk-user ",
        globalApiKey: "sk-global",
      }),
    ).toEqual({
      ok: true,
      apiKey: "sk-user",
      source: "controller",
    });
  });

  it("falls back to the global key when the participant does not provide one", () => {
    expect(
      resolveTranscriptOpenAiApiKey({
        globalApiKey: " sk-global ",
      }),
    ).toEqual({
      ok: true,
      apiKey: "sk-global",
      source: "global",
    });
  });

  it("rejects missing or malformed keys without leaking values", () => {
    expect(resolveTranscriptOpenAiApiKey({})).toEqual({
      ok: false,
      message: "A valid OpenAI API key is required.",
    });
    expect(
      resolveTranscriptOpenAiApiKey({
        globalApiKey: "not-a-key",
      }),
    ).toEqual({
      ok: false,
      message: "The shared OpenAI API key is misconfigured.",
    });
  });
});

describe("transcript response provider credentials", () => {
  it("never sends an OpenAI transcription key to Claude", () => {
    const result = resolveTranscriptResponseApiKey({
      env: { OPENAI_API_KEY: "sk-global" },
      model: "claude-sonnet-5-5",
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-user",
    });
    expect(result).toEqual({
      ok: false,
      message: "A valid Anthropic API key is required for Ask and Minutes.",
    });
  });

  it("uses the selected provider's shared key and supports separate BYOK", () => {
    const options = {
      env: { ANTHROPIC_API_KEY: "sk-ant-global" },
      model: "claude-sonnet-5-5",
      transcriptionProvider: "sarvam" as const,
      transcriptionApiKey: "sarvam-user",
    };
    expect(resolveTranscriptResponseApiKey(options)).toEqual({
      ok: true,
      apiKey: "sk-ant-global",
      source: "global",
    });
    expect(
      resolveTranscriptResponseApiKey({
        ...options,
        assistantApiKey: "sk-ant-user",
      }),
    ).toEqual({ ok: true, apiKey: "sk-ant-user", source: "controller" });
    expect(
      resolveTranscriptResponseApiKey({
        ...options,
        assistantApiKey: "sk-openai-user",
      }),
    ).toMatchObject({ ok: false });
  });

  it("reuses an OpenAI transcription key only for OpenAI responses", () => {
    expect(
      resolveTranscriptResponseApiKey({
        env: {},
        model: "gpt-5.6-terra",
        transcriptionProvider: "openai",
        transcriptionApiKey: "sk-user",
      }),
    ).toEqual({ ok: true, apiKey: "sk-user", source: "controller" });
    expect(
      resolveTranscriptProviderApiKey({
        provider: "openai",
        providedApiKey: "sk-ant-user",
        globalApiKey: "sk-server",
      }),
    ).toMatchObject({ ok: false });
  });
});
