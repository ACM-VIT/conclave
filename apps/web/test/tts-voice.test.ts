import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVoiceToken,
  verifyVoiceToken,
} from "../src/lib/tts-voice";

describe("cloned TTS voice tokens", () => {
  const previousTokenSecret = process.env.TTS_VOICE_TOKEN_SECRET;
  const previousSfuSecret = process.env.SFU_SECRET;

  beforeEach(() => {
    process.env.TTS_VOICE_TOKEN_SECRET = "test-tts-token-secret-with-enough-entropy";
    delete process.env.SFU_SECRET;
  });

  afterEach(() => {
    if (previousTokenSecret === undefined) {
      delete process.env.TTS_VOICE_TOKEN_SECRET;
    } else {
      process.env.TTS_VOICE_TOKEN_SECRET = previousTokenSecret;
    }
    if (previousSfuSecret === undefined) {
      delete process.env.SFU_SECRET;
    } else {
      process.env.SFU_SECRET = previousSfuSecret;
    }
  });

  it("round-trips an encrypted provider identity", async () => {
    const token = await createVoiceToken({
      voiceId: "provider-voice-123",
      voiceName: "Alice · Conclave",
      ownerId: "user-123",
    });

    expect(token).not.toContain("provider-voice-123");
    expect(token.length).toBeLessThan(2048);
    expect(token).toMatch(/^[A-Za-z0-9._~-]+$/);
    await expect(verifyVoiceToken(token)).resolves.toEqual({
      voiceId: "provider-voice-123",
      voiceName: "Alice · Conclave",
      ownerId: "user-123",
    });
  });

  it("rejects a token after its ciphertext is changed", async () => {
    const token = await createVoiceToken({
      voiceId: "provider-voice-123",
      voiceName: "Alice · Conclave",
      ownerId: "user-123",
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifyVoiceToken(tampered)).rejects.toThrow();
  });
});
