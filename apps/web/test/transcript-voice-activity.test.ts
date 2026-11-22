import { describe, expect, it } from "vitest";
import { VoiceActivity } from "../transcript-worker/src/transcription/voice-activity";
import { clicksPcm, noisePcm, silencePcm, voicedPcm } from "./transcript-audio-fixtures";

const feed = (chunks: Int16Array[], stepMs = 200) => {
  const voice = new VoiceActivity();
  return chunks.map((chunk, index) => voice.push(chunk, index * stepMs));
};

describe("the voice check a Sarvam place needs", () => {
  it.each([-20, -30, -40])("hears a voiced sound at %i dBFS as speech", (dbfs) => {
    expect(feed([voicedPcm(dbfs)])).toEqual(["onset"]);
  });

  it.each([
    ["silence", silencePcm()],
    ["a -60 dBFS noise floor", noisePcm(-60)],
    ["-44 dBFS broadband noise", noisePcm(-44)],
    ["-20 dBFS broadband noise", noisePcm(-20)],
    ["key clicks peaking at -6 dBFS", clicksPcm(-6)],
    ["a -50 dBFS voiced murmur", voicedPcm(-50)],
  ])("hears %s as quiet", (_label, chunk) => {
    expect(feed([chunk, chunk, chunk])).toEqual(["quiet", "quiet", "quiet"]);
  });

  it("needs 60 ms of voiced frames, so a 40 ms blip is not speech", () => {
    const blip = new Int16Array(4_800);
    blip.set(voicedPcm(-26, 40));
    expect(feed([blip])).toEqual(["quiet"]);
    const word = new Int16Array(4_800);
    word.set(voicedPcm(-26, 60));
    expect(feed([word])).toEqual(["onset"]);
  });

  it("bridges a pause shorter than its hangover and starts again after a longer one", () => {
    const speech = voicedPcm(-26);
    const voice = new VoiceActivity();
    expect(voice.push(speech, 0)).toBe("onset");
    expect(voice.push(speech, 250)).toBe("speech");
    expect(voice.speakingAt(750)).toBe(true);
    expect(voice.speakingAt(751)).toBe(false);
    expect(voice.push(speech, 900)).toBe("onset");
  });

  it("starts afresh after a gap with no audio, so speech's tail never makes the next turn's noise speech", () => {
    const voice = new VoiceActivity();
    expect(voice.push(voicedPcm(-26), 0)).toBe("onset");
    expect(voice.push(noisePcm(-60), 600)).toBe("quiet");
    expect(voice.push(silencePcm(), 1_300)).toBe("quiet");
  });

  it("starts a new run after a turn ends, even with no gap in time", () => {
    const voice = new VoiceActivity();
    expect(voice.push(voicedPcm(-26), 0)).toBe("onset");
    voice.restart();
    expect(voice.push(noisePcm(-60), 0)).toBe("quiet");
    expect(voice.speakingAt(400)).toBe(true);
  });

  it("keeps a run of voiced frames across chunk boundaries", () => {
    const voice = new VoiceActivity();
    const first = new Int16Array(4_800);
    first.set(voicedPcm(-26, 40), 4_800 - 960);
    const second = voicedPcm(-26, 40);
    expect(voice.push(first, 0)).toBe("quiet");
    expect(voice.push(second, 200)).toBe("onset");
  });
});
