import { describe, expect, it } from "vitest";
import {
  isSpeakerOutsideVisibleWindow,
  placeParticipantAtVisibleBoundary,
} from "../src/app/lib/participant-order-policy";

const participants = ["a", "b", "c", "d", "e"].map((userId) => ({
  userId,
}));

describe("participant order policy", () => {
  it("does not promote speakers who already have a visible seat", () => {
    expect(
      isSpeakerOutsideVisibleWindow({
        speakerId: "b",
        participants,
        previousOrder: new Map(),
        visibleParticipantLimit: 4,
      }),
    ).toBe(false);
  });

  it("identifies a speaker beyond the visible grid boundary", () => {
    expect(
      isSpeakerOutsideVisibleWindow({
        speakerId: "e",
        participants,
        previousOrder: new Map(),
        visibleParticipantLimit: 4,
      }),
    ).toBe(true);
  });

  it("swaps only the final visible seat when an overflow speaker is promoted", () => {
    const reordered = placeParticipantAtVisibleBoundary(participants, "e", 4);

    expect(reordered.map((participant) => participant.userId)).toEqual([
      "a",
      "b",
      "c",
      "e",
      "d",
    ]);
  });

  it("leaves an already-visible featured speaker in place", () => {
    const reordered = placeParticipantAtVisibleBoundary(participants, "b", 4);

    expect(reordered.map((participant) => participant.userId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});
