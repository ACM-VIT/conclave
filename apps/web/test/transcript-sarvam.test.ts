import { describe, expect, it } from "vitest";
import {
  Pcm24To16Downsampler,
  buildSarvamAudioMessage,
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
  it("builds a Saaras v3 websocket endpoint for Indian code-mixed speech", () => {
    const endpoint = sarvamEndpoint({
      model: "saaras:v3",
      language: "en",
      locale: "en-IN",
    });
    const url = new URL(endpoint);

    expect(url.origin).toBe("wss://api.sarvam.ai");
    expect(url.pathname).toBe("/speech-to-text/ws");
    expect(url.searchParams.get("model")).toBe("saaras:v3");
    expect(url.searchParams.get("language-code")).toBe("en-IN");
    expect(url.searchParams.get("mode")).toBe("codemix");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("input_audio_codec")).toBe("pcm_s16le");
    expect(url.searchParams.get("flush_signal")).toBe("true");
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
