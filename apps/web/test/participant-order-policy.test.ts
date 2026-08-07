import { describe, expect, it } from "vitest";
import {
  getVisibleRemoteParticipantLimit,
  isSpeakerOutsideVisibleWindow,
  placeParticipantAtVisibleBoundary,
} from "../src/app/lib/participant-order-policy";

const participants = ["a", "b", "c", "d", "e"].map((userId) => ({
  userId,
}));

describe("participant order policy", () => {
  it("uses the collapsed grid capacity for overflow speaker promotion", () => {
    const visibleParticipantLimit = getVisibleRemoteParticipantLimit({
      remoteParticipantCount: 5,
      maxRemoteWithoutOverflow: 4,
      isOverflowOpen: false,
    });
    const reordered = placeParticipantAtVisibleBoundary(
      participants,
      "e",
      visibleParticipantLimit,
    );

    expect(visibleParticipantLimit).toBe(3);
    expect(
      reordered
        .slice(0, visibleParticipantLimit)
        .map((participant) => participant.userId),
    ).toEqual(["a", "b", "e"]);
  });

  it("restores the reserved overflow seat when overflow is open", () => {
    expect(
      getVisibleRemoteParticipantLimit({
        remoteParticipantCount: 5,
        maxRemoteWithoutOverflow: 4,
        isOverflowOpen: true,
      }),
    ).toBe(4);
  });

  it("does not reserve an overflow seat when every remote fits", () => {
    expect(
      getVisibleRemoteParticipantLimit({
        remoteParticipantCount: 4,
        maxRemoteWithoutOverflow: 4,
        isOverflowOpen: false,
      }),
    ).toBe(4);
  });

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
