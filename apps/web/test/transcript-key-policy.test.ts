import { describe, expect, it } from "vitest";
import {
  getGlobalTranscriptProviderKeyAvailability,
  hasGlobalOpenAiApiKey,
  hasGlobalTranscriptProviderApiKey,
  resolveTranscriptProviderApiKey,
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
    });
    expect(
      getGlobalTranscriptProviderKeyAvailability({
        OPENAI_API_KEY: "sk-global",
        SARVAM_API_KEY: "sarvam-global",
      }),
    ).toEqual({
      openai: true,
      sarvam: true,
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
