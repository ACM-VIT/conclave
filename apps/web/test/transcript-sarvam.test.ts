import { describe, expect, it } from "vitest";
import {
  Pcm24To16Downsampler,
  buildSarvamAudioMessage,
  createSarvamSegmentItemId,
  parseSarvamEvent,
  sarvamEndpoint,
} from "../transcript-worker/src/transcription/sarvam";

const pcm16Base64 = (samples: number[]): string => {
  let binary = "";
  for (const sample of samples) {
    const unsigned = sample < 0 ? sample + 0x10000 : sample;
    binary += String.fromCharCode(unsigned & 0xff, (unsigned >> 8) & 0xff);
  }
  return btoa(binary);
};

const decodePcm16Base64 = (base64: string): number[] => {
  const binary = atob(base64);
  const samples: number[] = [];
  for (let offset = 0; offset + 1 < binary.length; offset += 2) {
    const value =
      (binary.charCodeAt(offset) & 0xff) |
      ((binary.charCodeAt(offset + 1) & 0xff) << 8);
    samples.push(value >= 0x8000 ? value - 0x10000 : value);
  }
  return samples;
};

describe("Sarvam transcription provider helpers", () => {
  it("builds a Saaras v3 fetch endpoint for Indian code-mixed speech", () => {
    const endpoint = sarvamEndpoint({
      model: "saaras:v3",
      language: "en",
      locale: "en-IN",
    });
    const url = new URL(endpoint);

    expect(url.origin).toBe("https://api.sarvam.ai");
    expect(url.pathname).toBe("/speech-to-text/ws");
    expect(url.searchParams.get("model")).toBe("saaras:v3");
    expect(url.searchParams.get("language-code")).toBe("en-IN");
    expect(url.searchParams.get("mode")).toBe("codemix");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("input_audio_codec")).toBe("pcm_s16le");
    expect(url.searchParams.get("flush_signal")).toBe("true");
    expect(url.searchParams.get("high_vad_sensitivity")).toBe("true");
    expect(url.searchParams.get("vad_signals")).toBe("true");
  });

  it("normalizes websocket schemes for Cloudflare Worker fetch", () => {
    expect(
      sarvamEndpoint({
        baseUrl: "wss://example.com/speech-to-text/ws",
        model: "saaras:v3",
        language: "unknown",
      }).startsWith("https://example.com/speech-to-text/ws?"),
    ).toBe(true);
    expect(
      sarvamEndpoint({
        baseUrl: "ws://example.com/speech-to-text/ws",
        model: "saaras:v3",
        language: "unknown",
      }).startsWith("http://example.com/speech-to-text/ws?"),
    ).toBe(true);
  });

  it("downsamples 24k PCM into 16k PCM across chunk boundaries", () => {
    const downsampler = new Pcm24To16Downsampler();

    const first = downsampler.downsample(pcm16Base64([0, 3000]));
    const second = downsampler.downsample(
      pcm16Base64([6000, 9000, 12000, 15000]),
    );

    expect(first).toBe("");
    expect(decodePcm16Base64(second)).toEqual([0, 4500, 9000, 13500]);
  });

  it("formats Sarvam audio messages and parses transcript responses", () => {
    expect(JSON.parse(buildSarvamAudioMessage("abc"))).toEqual({
      audio: {
        data: "abc",
        sample_rate: "16000",
        encoding: "audio/wav",
      },
    });

    expect(
      parseSarvamEvent(
        JSON.stringify({
          type: "data",
          data: {
            request_id: "req-1",
            transcript: "hello everyone",
            metrics: {
              audio_duration: 1,
              processing_latency: 0.2,
            },
          },
        }),
      ),
    ).toEqual({
      type: "final",
      itemId: "sarvam-req-1",
      transcript: "hello everyone",
    });
  });

  it("parses Sarvam streaming guide transcript response shapes", () => {
    expect(
      parseSarvamEvent(
        JSON.stringify({
          type: "transcript",
          request_id: "req-2",
          text: "top level text",
        }),
      ),
    ).toEqual({
      type: "final",
      itemId: "sarvam-req-2",
      transcript: "top level text",
    });
    expect(
      parseSarvamEvent(
        JSON.stringify({
          type: "data",
          data: {
            request_id: "req-3",
            text: "nested text",
          },
        }),
      ),
    ).toEqual({
      type: "final",
      itemId: "sarvam-req-3",
      transcript: "nested text",
    });
  });

  it("creates unique segment item ids when Sarvam reuses request ids", () => {
    expect(createSarvamSegmentItemId("sarvam-req-1", 1)).toBe(
      "sarvam-req-1-1",
    );
    expect(createSarvamSegmentItemId("sarvam-req-1", 2)).toBe(
      "sarvam-req-1-2",
    );
  });

  it("surfaces Sarvam errors without leaking raw response payloads", () => {
    expect(
      parseSarvamEvent(
        JSON.stringify({
          type: "error",
          data: {
            error: "quota exceeded",
            code: "rate_limit",
          },
        }),
      ),
    ).toEqual({
      type: "error",
      message: "quota exceeded",
    });
  });
});
