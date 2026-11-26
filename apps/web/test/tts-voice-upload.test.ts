import { afterEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  createInstantVoiceClone: vi.fn(async (_input: { audio: File; name: string }) => ({ voiceId: "voice-1", requiresVerification: false })),
}));

vi.mock("@/lib/sfu-user-auth", () => ({
  requireSfuSessionUser: vi.fn(async () => ({ ok: true, user: { id: "user-1", name: "Ada", email: "ada@example.com" } })),
}));
vi.mock("@/lib/tts-voice", async () => ({
  ...(await import("../src/lib/tts-voice")),
  createInstantVoiceClone: provider.createInstantVoiceClone,
  createVoiceToken: vi.fn(async () => "voice-token"),
  deleteInstantVoiceClone: vi.fn(async () => undefined),
}));
vi.mock("@/lib/voice-upload", () => import("../src/lib/voice-upload"));

const { POST } = await import("../src/app/api/tts/voices/route");
const { MAX_VOICE_SAMPLE_BYTES } = await import("../src/lib/tts-voice");

const WEBM_HEADER = [0x1a, 0x45, 0xdf, 0xa3];

const audioBytes = (size: number, header: number[] = WEBM_HEADER) => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set(header, 0);
  return bytes;
};

const multipart = async (audio: Uint8Array, type = "audio/webm") => {
  const form = new FormData();
  form.set("consent", "true");
  form.set("durationSeconds", "70");
  form.set("name", "Ada");
  form.set("audio", new File([audio], "voice.webm", { type }));
  const encoded = new Response(form);
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type") ?? "",
  };
};

/** A body stream that records how many bytes the route actually pulled. */
const countingStream = (bytes: Uint8Array, chunkSize = 64 * 1024) => {
  const stats = { pulled: 0 };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      const chunk = bytes.slice(offset, offset + chunkSize);
      offset += chunk.byteLength;
      stats.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { stream, stats };
};

const upload = (body: BodyInit, headers: Record<string, string>) =>
  POST(new Request("https://conclave.example/api/tts/voices", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit));

afterEach(() => provider.createInstantVoiceClone.mockClear());

describe("voice sample upload", () => {
  it("passes a valid recording to the voice provider unchanged", async () => {
    const audio = audioBytes(200_000);
    const { body, contentType } = await multipart(audio);
    const response = await upload(body, { "content-type": contentType, "content-length": String(body.byteLength) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "voice-token", name: "Ada · Conclave" });
    const sent = provider.createInstantVoiceClone.mock.calls[0][0].audio;
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(audio);
  });

  it("requires a Content-Length header", async () => {
    const { body, contentType } = await multipart(audioBytes(1_000));
    const { stream } = countingStream(body);
    const response = await upload(stream, { "content-type": contentType });
    expect(response.status).toBe(411);
    expect(provider.createInstantVoiceClone).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized upload without reading the body", async () => {
    const { body, contentType } = await multipart(audioBytes(1_000));
    const { stream, stats } = countingStream(body);
    const response = await upload(stream, { "content-type": contentType, "content-length": String(64 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(stats.pulled).toBe(0);
  });

  it("stops reading once a body outgrows its Content-Length claim", async () => {
    const huge = new Uint8Array(40 * 1024 * 1024);
    const { stream, stats } = countingStream(huge);
    const response = await upload(stream, {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": "1000",
    });
    expect(response.status).toBe(413);
    expect(stats.pulled).toBeLessThan(MAX_VOICE_SAMPLE_BYTES + 256 * 1024);
    expect(provider.createInstantVoiceClone).not.toHaveBeenCalled();
  });

  it("rejects a recording over 12 MB", async () => {
    const { body, contentType } = await multipart(audioBytes(MAX_VOICE_SAMPLE_BYTES + 1));
    const response = await upload(body, { "content-type": contentType, "content-length": String(body.byteLength) });
    expect(response.status).toBe(413);
    expect(provider.createInstantVoiceClone).not.toHaveBeenCalled();
  });

  it("rejects files labelled as audio that are not audio", async () => {
    const page = new TextEncoder().encode("<html><script>alert(1)</script></html>".padEnd(5_000, " "));
    const { body, contentType } = await multipart(page, "audio/webm");
    const response = await upload(body, { "content-type": contentType, "content-length": String(body.byteLength) });
    expect(response.status).toBe(400);
    expect(provider.createInstantVoiceClone).not.toHaveBeenCalled();
  });

  it.each([
    ["MP4", [0, 0, 0, 0x20, ...new TextEncoder().encode("ftypM4A ")]],
    ["Ogg", [...new TextEncoder().encode("OggS")]],
    ["WAV", [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]],
    ["MP3", [...new TextEncoder().encode("ID3")]],
  ])("accepts %s recordings", async (_label, header) => {
    const { body, contentType } = await multipart(audioBytes(5_000, header), "audio/mp4");
    const response = await upload(body, { "content-type": contentType, "content-length": String(body.byteLength) });
    expect(response.status).toBe(200);
  });
});
