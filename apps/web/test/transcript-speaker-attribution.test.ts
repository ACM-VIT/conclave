import { describe, expect, it } from "vitest";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import { TranscriptSpeakerAttribution } from "../transcript-worker/src/speaker-attribution";

const speaker = (
  userId: string,
  displayName: string,
): TranscriptSpeaker => ({
  userId,
  displayName,
  source: "remote",
});

describe("TranscriptSpeakerAttribution", () => {
  it("binds committed OpenAI item IDs to the committed speaker", () => {
    const attribution = new TranscriptSpeakerAttribution();
    const ada = speaker("u1", "Ada");
    const grace = speaker("u2", "Grace");

    attribution.enqueueCommit(ada);
    attribution.enqueueCommit(grace);

    expect(attribution.bindCommittedItem("item-a")).toEqual(ada);
    expect(attribution.bindCommittedItem("item-b")).toEqual(grace);
    expect(attribution.getItemSpeaker("item-a")).toEqual(ada);
    expect(attribution.getItemSpeaker("item-b")).toEqual(grace);
  });

  it("keeps item lookup stable when transcription finals arrive out of order", () => {
    const attribution = new TranscriptSpeakerAttribution();
    const ada = speaker("u1", "Ada");
    const grace = speaker("u2", "Grace");

    attribution.enqueueCommit(ada);
    attribution.enqueueCommit(grace);
    attribution.bindCommittedItem("item-a");
    attribution.bindCommittedItem("item-b");

    expect(attribution.getItemSpeaker("item-b")).toEqual(grace);
    expect(attribution.getItemSpeaker("item-a")).toEqual(ada);
  });

  it("clears pending and committed speaker state between sessions", () => {
    const attribution = new TranscriptSpeakerAttribution();

    attribution.enqueueCommit(speaker("u1", "Ada"));
    attribution.bindCommittedItem("item-a");
    attribution.reset();

    expect(attribution.peekPendingSpeaker()).toBeNull();
    expect(attribution.getItemSpeaker("item-a")).toBeNull();
    expect(attribution.bindCommittedItem("item-b")).toBeNull();
  });
});
