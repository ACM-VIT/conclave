import { describe, expect, it } from "vitest";
import type { TranscriptSpeaker } from "../types.js";
import {
  TranscriptAudioBatcher,
  type TranscriptAudioBatchSink,
} from "../server/transcript/audioBatcher.js";

type AudioEvent =
  | { type: "chunk"; speaker: TranscriptSpeaker; bytes: number }
  | { type: "commit"; speaker: TranscriptSpeaker }
  | { type: "clear"; speaker: TranscriptSpeaker };

const speaker = (userId: string, displayName: string): TranscriptSpeaker => ({
  userId,
  displayName,
  source: "remote",
});

const pcm = (sampleCount: number, amplitude: number): Buffer => {
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(amplitude, index * 2);
  }
  return buffer;
};

const createSink = (events: AudioEvent[]): TranscriptAudioBatchSink => ({
  sendAudioChunk(audio, speaker) {
    events.push({
      type: "chunk",
      speaker,
      bytes: Buffer.from(audio, "base64").length,
    });
    return true;
  },
  commitAudio(speaker) {
    events.push({ type: "commit", speaker });
    return true;
  },
  clearAudio(speaker) {
    events.push({ type: "clear", speaker });
    return true;
  },
});

describe("TranscriptAudioBatcher", () => {
  it("keeps overlapping speakers separated while both are talking", () => {
    const events: AudioEvent[] = [];
    let now = 1000;
    const sink = createSink(events);
    const ada = speaker("u1", "Ada");
    const grace = speaker("u2", "Grace");
    const adaBatcher = new TranscriptAudioBatcher({
      speaker: ada,
      sink,
      now: () => now,
      batchTargetSamples: 4,
    });
    const graceBatcher = new TranscriptAudioBatcher({
      speaker: grace,
      sink,
      now: () => now,
      batchTargetSamples: 4,
    });

    expect(adaBatcher.pushPcm(pcm(4, 2200))).toBe(true);
    expect(graceBatcher.pushPcm(pcm(4, 2600))).toBe(true);
    now += 1200;
    expect(graceBatcher.commitIfNeeded()).toBe(true);
    expect(adaBatcher.commitIfNeeded()).toBe(true);

    expect(events).toEqual([
      { type: "chunk", speaker: ada, bytes: 8 },
      { type: "chunk", speaker: grace, bytes: 8 },
      { type: "commit", speaker: grace },
      { type: "commit", speaker: ada },
    ]);
  });

  it("flushes short pending speech when a participant pauses", () => {
    const events: AudioEvent[] = [];
    const ada = speaker("u1", "Ada");
    const batcher = new TranscriptAudioBatcher({
      speaker: ada,
      sink: createSink(events),
      batchTargetSamples: 10,
    });

    expect(batcher.pushPcm(pcm(3, 2400))).toBe(true);
    expect(events).toEqual([]);
    batcher.flushAndCommit();

    expect(events).toEqual([
      { type: "chunk", speaker: ada, bytes: 6 },
      { type: "commit", speaker: ada },
      { type: "clear", speaker: ada },
    ]);
  });

  it("keeps brief pauses after speech but drops long silence", () => {
    const events: AudioEvent[] = [];
    let now = 0;
    const ada = speaker("u1", "Ada");
    const batcher = new TranscriptAudioBatcher({
      speaker: ada,
      sink: createSink(events),
      now: () => now,
      batchTargetSamples: 4,
    });

    expect(batcher.pushPcm(pcm(2, 2200))).toBe(true);
    now += 100;
    expect(batcher.pushPcm(pcm(2, 0))).toBe(true);
    now += 1000;
    expect(batcher.pushPcm(pcm(2, 0))).toBe(false);
    batcher.commitIfNeeded();

    expect(events).toEqual([
      { type: "chunk", speaker: ada, bytes: 8 },
      { type: "commit", speaker: ada },
    ]);
  });

  it("keeps quiet but non-silent mic input", () => {
    const events: AudioEvent[] = [];
    const ada = speaker("u1", "Ada");
    const batcher = new TranscriptAudioBatcher({
      speaker: ada,
      sink: createSink(events),
      batchTargetSamples: 4,
    });

    expect(batcher.pushPcm(pcm(4, 32))).toBe(true);
    batcher.commitIfNeeded();

    expect(events).toEqual([
      { type: "chunk", speaker: ada, bytes: 8 },
      { type: "commit", speaker: ada },
    ]);
  });

  it("does not emit quiet-only tracks", () => {
    const events: AudioEvent[] = [];
    const batcher = new TranscriptAudioBatcher({
      speaker: speaker("u1", "Ada"),
      sink: createSink(events),
      batchTargetSamples: 4,
    });

    expect(batcher.pushPcm(pcm(4, 0))).toBe(false);
    expect(batcher.commitIfNeeded()).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not clear the worker buffer when nothing was committed", () => {
    const events: AudioEvent[] = [];
    const batcher = new TranscriptAudioBatcher({
      speaker: speaker("u1", "Ada"),
      sink: createSink(events),
      batchTargetSamples: 4,
    });

    expect(batcher.flushAndCommit()).toBe(false);
    expect(events).toEqual([]);
  });
});
