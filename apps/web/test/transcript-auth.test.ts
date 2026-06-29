import { describe, expect, it } from "vitest";
import {
  verifyTranscriptRoomToken,
  verifyTranscriptToken,
} from "../transcript-worker/src/auth";
import type { TranscriptTokenPayload } from "../transcript-worker/src/types";

const base64Url = (bytes: Uint8Array | string): string => {
  const binary =
    typeof bytes === "string"
      ? bytes
      : String.fromCharCode(...Array.from(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const signToken = async (
  payload: TranscriptTokenPayload,
  secret = "secret",
): Promise<string> => {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
};

const validPayload = (
  overrides: Partial<TranscriptTokenPayload> = {},
): TranscriptTokenPayload => ({
  aud: "conclave-transcript-worker",
  exp: Math.floor(Date.now() / 1000) + 60,
  userId: "user-a",
  displayName: "Ada",
  roomId: "room-a",
  capabilities: {
    start: true,
    takeover: true,
    stop: false,
    ask: true,
  },
  ...overrides,
});

describe("verifyTranscriptToken", () => {
  it("accepts a valid signed token and preserves capabilities", async () => {
    const token = await signToken(validPayload());

    await expect(verifyTranscriptToken(token, "secret")).resolves.toMatchObject({
      userId: "user-a",
      displayName: "Ada",
      roomId: "room-a",
      capabilities: {
        start: true,
        takeover: true,
        stop: false,
        ask: true,
      },
    });
  });

  it("strips unsupported identity fields from accepted tokens", async () => {
    const token = await signToken({
      ...validPayload(),
      userKey: "sensitive-room-identity",
    } as unknown as TranscriptTokenPayload);

    await expect(verifyTranscriptToken(token, "secret")).resolves.not.toHaveProperty(
      "userKey",
    );
  });

  it("rejects tokens signed with a different secret", async () => {
    const token = await signToken(validPayload(), "other-secret");

    await expect(verifyTranscriptToken(token, "secret")).resolves.toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await signToken(
      validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }),
    );

    await expect(verifyTranscriptToken(token, "secret")).resolves.toBeNull();
  });

  it("rejects wrong audiences and missing room/user identity", async () => {
    await expect(
      verifyTranscriptToken(
        await signToken(validPayload({ aud: "somewhere-else" })),
        "secret",
      ),
    ).resolves.toBeNull();

    await expect(
      verifyTranscriptToken(
        await signToken(validPayload({ userId: undefined })),
        "secret",
      ),
    ).resolves.toBeNull();

    await expect(
      verifyTranscriptToken(
        await signToken(validPayload({ roomId: undefined })),
        "secret",
      ),
    ).resolves.toBeNull();
  });
});

describe("verifyTranscriptRoomToken", () => {
  it("rejects tokens for a different room", async () => {
    const token = await signToken(validPayload({ roomId: "room-a" }));

    await expect(
      verifyTranscriptRoomToken(token, "secret", "room-b"),
    ).resolves.toBeNull();
  });
});
