import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { POST as voice } from "../src/app/api/conclave/voice/route";
import { POST as speech } from "../src/app/api/tts/speech/route";
import { createVoiceToken } from "../src/lib/tts-voice";

vi.mock("@/lib/room-ai-access", () => import("../src/lib/room-ai-access"));
vi.mock("@/lib/tts-voice", () => import("../src/lib/tts-voice"));

const access = (purpose: string) =>
  jwt.sign(
    {
      tokenUse: "room-ai:access",
      purpose,
      sfuUrl: "https://sfu.example",
      userId: "user",
      roomId: "room",
      clientId: "client",
      channelId: "channel",
    },
    "fixture-secret",
    {
      algorithm: "HS256",
      audience: "conclave-web",
      issuer: "conclave-sfu",
      expiresIn: "2m",
    },
  );
const request = (body: unknown, token?: string) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("SFU_SECRET", "fixture-secret");
  vi.stubEnv(
    "TTS_VOICE_TOKEN_SECRET",
    "fixture-speech-secret-with-enough-entropy",
  );
  vi.stubEnv("ELEVENLABS_API_KEY", "eleven-fixture-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("room audio settings authorization", () => {
  it("preserves the deployment speech model when the room has no explicit model override", async () => {
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "eleven_turbo_v2_5");
    const voiceToken = await createVoiceToken({voiceId: "deployment-voice", voiceName: "Fixture", ownerId: "user"});
    const fetcher = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).includes("/internal/ai/credentials") ? Response.json({CONCLAVE_AI_SETTINGS: JSON.stringify({speech: {enabled: true}})}) : new Response(new Uint8Array([1,2,3])));
    vi.stubGlobal("fetch", fetcher);
    const response = await speech(request({token: voiceToken, text: "Deployment model fixture", roomAiToken: access("speech")}));
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).model_id).toBe("eleven_turbo_v2_5");
  });
  it("uses the live room model and key after a current-host check, returning only an ephemeral token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/internal/ai/credentials"))
          return Response.json({
            OPENAI_API_KEY: "sk-room-fixture",
            OPENAI_BASE_URL: "https://openai-room.example/v1",
            CONCLAVE_AI_SETTINGS: JSON.stringify({
              voice: {
                model: "gpt-realtime-1.5",
                instructions: "Speak softly.",
              },
            }),
          });
        return Response.json({ value: "ek_fixture", expires_at: 100 });
      }),
    );
    const response = await voice(
      request(
        { session: { model: "spoofed", instructions: "Meeting assistant" } },
        access("voice"),
      ),
    );
    expect(response.status).toBe(200);
    const result = await response.text();
    expect(result).toContain("ek_fixture");
    expect(result).not.toContain("sk-room-fixture");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      requireHost: true,
      userId: "user",
      providers: ["openai"],
    });
    expect(calls[1].url).toBe(
      "https://openai-room.example/v1/realtime/client_secrets",
    );
    expect(JSON.parse(String(calls[1].init?.body)).session).toMatchObject({
      model: "gpt-realtime-1.5",
      instructions: "Meeting assistant\n\nSpeak softly.",
    });
  });
  it.each(["demoted", "disabled", "wrong-purpose"])(
    "blocks voice when %s and never contacts the provider",
    async (condition) => {
      const fetcher = vi.fn(async () =>
        condition === "demoted"
          ? Response.json({}, { status: 403 })
          : Response.json({
              CONCLAVE_AI_SETTINGS: JSON.stringify({
                voice: { enabled: false },
              }),
            }),
      );
      vi.stubGlobal("fetch", fetcher);
      const response = await voice(
        request(
          { session: {} },
          access(condition === "wrong-purpose" ? "speech" : "voice"),
        ),
      );
      expect(response.status).toBe(403);
      expect(fetcher).toHaveBeenCalledTimes(
        condition === "wrong-purpose" ? 0 : 1,
      );
    },
  );
  it("applies the room speech model and validates membership before serving cached audio", async () => {
    const voiceToken = await createVoiceToken({
      voiceId: "voice-fixture",
      voiceName: "Fixture",
      ownerId: "user",
    });
    const calls: { url: string; init?: RequestInit }[] = [];
    let member = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/internal/ai/credentials"))
          return member
            ? Response.json({
                CONCLAVE_AI_SETTINGS: JSON.stringify({
                  speech: { model: "eleven_flash_v2_5", timeoutMs: 60000 },
                }),
              })
            : Response.json({}, { status: 403 });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        });
      }),
    );
    const body = {
      token: voiceToken,
      text: "Room speech fixture",
      roomAiToken: access("speech"),
    };
    const response = await speech(request(body));
    expect(response.status).toBe(200);
    expect(JSON.parse(String(calls[1].init?.body)).model_id).toBe(
      "eleven_flash_v2_5",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      userId: "user",
      providers: [],
    });
    member = false;
    const denied = await speech(request(body));
    expect(denied.status).toBe(400);
    expect(calls).toHaveLength(3);
  });
});
