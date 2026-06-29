import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyTranscriptRelayStartToken } from "../server/socket/handlers/transcriptHandlers.js";

const room = {
  id: "room-a",
  clientId: "client-a",
  channelId: "client-a:room-a",
};

const signRelayStartToken = (
  overrides: Record<string, unknown> = {},
): string =>
  jwt.sign(
    {
      iss: "conclave-transcript-worker",
      aud: "conclave-sfu",
      tokenUse: "transcript:sfuRelayStart",
      userId: "u1",
      roomId: room.id,
      clientId: room.clientId,
      channelId: room.channelId,
      sessionStatus: "live",
      transportMode: "sfu",
      ...overrides,
    },
    "relay-secret",
    {
      algorithm: "HS256",
      expiresIn: "30s",
    },
  );

describe("verifyTranscriptRelayStartToken", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSCRIPT_TOKEN_SECRET", "relay-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a live SFU controller token for the same room channel", () => {
    expect(
      verifyTranscriptRelayStartToken(signRelayStartToken(), room, "u1"),
    ).toEqual({ ok: true });
  });

  it("rejects direct relay starts without a worker token", () => {
    expect(verifyTranscriptRelayStartToken(undefined, room, "u1")).toEqual({
      ok: false,
      message: "Transcript worker relay authorization is required.",
    });
  });

  it("rejects tokens for another user, room channel, or transport mode", () => {
    expect(
      verifyTranscriptRelayStartToken(
        signRelayStartToken({ userId: "u2" }),
        room,
        "u1",
      ).ok,
    ).toBe(false);
    expect(
      verifyTranscriptRelayStartToken(
        signRelayStartToken({ channelId: "client-b:room-a" }),
        room,
        "u1",
      ).ok,
    ).toBe(false);
    expect(
      verifyTranscriptRelayStartToken(
        signRelayStartToken({ transportMode: "browser" }),
        room,
        "u1",
      ).ok,
    ).toBe(false);
  });
});
