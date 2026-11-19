import { afterEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => ({ context: null as null | { env: Record<string, unknown> } }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => {
    if (!cloudflare.context) throw new Error("not running on Cloudflare");
    return cloudflare.context;
  }),
}));

const { takeSpeechRateLimit } = await import("../src/app/api/tts/speech/rate-limit");

const requestFrom = (ip: string) => new Request("https://site.test/api/tts/speech", {
  method: "POST",
  headers: { "cf-connecting-ip": ip },
});

afterEach(() => {
  cloudflare.context = null;
  vi.restoreAllMocks();
});

describe("cloned speech rate limit", () => {
  it("uses an in-process window outside Cloudflare", async () => {
    const results = [];
    for (let index = 0; index < 21; index += 1) results.push(await takeSpeechRateLimit(requestFrom("10.0.0.1")));
    expect(results.slice(0, 20).every((result) => result === "allowed")).toBe(true);
    expect(results[20]).toBe("limited");
    expect(await takeSpeechRateLimit(requestFrom("10.0.0.2"))).toBe("allowed");
  });

  it("uses the shared limiter in a Cloudflare deployment", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    cloudflare.context = { env: { TTS_SPEECH_RATE_LIMITER: { limit } } };
    expect(await takeSpeechRateLimit(requestFrom("10.0.0.3"))).toBe("limited");
    expect(limit).toHaveBeenCalledWith({ key: "tts-speech:10.0.0.3" });
  });

  it("refuses requests when the deployed limiter is missing or failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cloudflare.context = { env: {} };
    expect(await takeSpeechRateLimit(requestFrom("10.0.0.4"))).toBe("unavailable");
    cloudflare.context = { env: { TTS_SPEECH_RATE_LIMITER: { limit: async () => { throw new Error("down"); } } } };
    expect(await takeSpeechRateLimit(requestFrom("10.0.0.4"))).toBe("unavailable");
  });
});
