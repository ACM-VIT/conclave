import { describe, expect, it } from "vitest";
import {
  participantReducer,
  type ParticipantAction,
} from "../src/participant-reducer";
import type { Participant } from "../src/types";

/**
 * A MediaStream stand-in. The reducer never calls methods on the stream — it
 * only stores/compares the reference — so an opaque object is faithful.
 */
const fakeStream = (id: string): MediaStream => ({ id }) as unknown as MediaStream;

const empty = () => new Map<string, Participant>();

const seed = (userId: string, overrides: Partial<Participant> = {}) => {
  const state = participantReducer(empty(), {
    type: "ADD_PARTICIPANT",
    userId,
  });
  const p = state.get(userId)!;
  state.set(userId, { ...p, ...overrides });
  return state;
};

const videoAction = (
  userId: string,
  stream: MediaStream | null,
  producerId = "vp1",
): ParticipantAction => ({
  type: "UPDATE_STREAM",
  userId,
  kind: "video",
  streamType: "webcam",
  stream,
  producerId,
});

describe("participantReducer — ADD_PARTICIPANT (join)", () => {
  it("adds a brand-new participant with default flags", () => {
    const next = participantReducer(empty(), {
      type: "ADD_PARTICIPANT",
      userId: "a",
    });
    const p = next.get("a")!;
    expect(p).toMatchObject({
      userId: "a",
      isMuted: false,
      isCameraOff: false,
      isVideoAdaptivelyPaused: false,
      isHandRaised: false,
      isGhost: false,
      videoStream: null,
      audioStream: null,
    });
    expect(p.isLeaving).toBeUndefined();
  });

  it("honors the isGhost flag on add", () => {
    const next = participantReducer(empty(), {
      type: "ADD_PARTICIPANT",
      userId: "g",
      isGhost: true,
    });
    expect(next.get("g")!.isGhost).toBe(true);
  });

  it("returns the SAME map reference for a no-op re-add (server re-sync)", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
    });
    expect(next).toBe(state); // identity preserved → memoized consumers skip
  });

  it("clears isLeaving when a leaving participant re-joins", () => {
    let state = seed("a");
    state = participantReducer(state, { type: "MARK_LEAVING", userId: "a" });
    expect(state.get("a")!.isLeaving).toBe(true);

    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
    });
    expect(next).not.toBe(state);
    expect(next.get("a")!.isLeaving).toBe(false);
  });

  it("does not add a missing participant when addIfMissing is false", () => {
    const state = empty();
    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "hidden",
      addIfMissing: false,
    });

    expect(next).toBe(state);
    expect(next.has("hidden")).toBe(false);
  });

  it("does not revive a leaving participant when addIfMissing is false", () => {
    let state = seed("a");
    state = participantReducer(state, { type: "MARK_LEAVING", userId: "a" });

    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
      addIfMissing: false,
    });

    expect(next).toBe(state);
    expect(next.get("a")!.isLeaving).toBe(true);
  });

  it("revives a leaving participant when explicitly restoring an existing one", () => {
    let state = seed("a");
    state = participantReducer(state, { type: "MARK_LEAVING", userId: "a" });

    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
      addIfMissing: false,
      reviveIfPresent: true,
    });

    expect(next).not.toBe(state);
    expect(next.get("a")!.isLeaving).toBe(false);
  });

  it("does not add a missing participant when reviveIfPresent is true", () => {
    const state = empty();

    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "hidden",
      addIfMissing: false,
      reviveIfPresent: true,
    });

    expect(next).toBe(state);
    expect(next.has("hidden")).toBe(false);
  });

  it("promotes a ghost to a real participant on re-add (ghost flag change)", () => {
    const state = seed("a", { isGhost: true });
    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
      isGhost: false,
    });
    expect(next).not.toBe(state);
    expect(next.get("a")!.isGhost).toBe(false);
  });

  it("keeps the existing ghost flag when re-add omits isGhost", () => {
    const state = seed("a", { isGhost: true });
    const next = participantReducer(state, {
      type: "ADD_PARTICIPANT",
      userId: "a",
    });
    // existing.isGhost (true) === nextGhost (true) and not leaving → no-op
    expect(next).toBe(state);
    expect(next.get("a")!.isGhost).toBe(true);
  });
});

describe("participantReducer — REMOVE_PARTICIPANT (leave)", () => {
  it("removes a present participant", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "REMOVE_PARTICIPANT",
      userId: "a",
    });
    expect(next.has("a")).toBe(false);
    expect(next).not.toBe(state);
  });

  it("is a no-op (same reference) when participant is absent", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "REMOVE_PARTICIPANT",
      userId: "missing",
    });
    expect(next).toBe(state);
  });

  it("does not mutate the input map", () => {
    const state = seed("a");
    participantReducer(state, { type: "REMOVE_PARTICIPANT", userId: "a" });
    expect(state.has("a")).toBe(true);
  });
});

describe("participantReducer — MARK_LEAVING", () => {
  it("sets isLeaving on a present participant", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "MARK_LEAVING",
      userId: "a",
    });
    expect(next.get("a")!.isLeaving).toBe(true);
    expect(next).not.toBe(state);
  });

  it("is a no-op when already leaving", () => {
    let state = seed("a");
    state = participantReducer(state, { type: "MARK_LEAVING", userId: "a" });
    const next = participantReducer(state, {
      type: "MARK_LEAVING",
      userId: "a",
    });
    expect(next).toBe(state);
  });

  it("is a no-op when participant is absent", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "MARK_LEAVING",
      userId: "ghost",
    });
    expect(next).toBe(state);
  });
});

describe("participantReducer — UPDATE_STREAM", () => {
  it("attaches a webcam video stream and clears isCameraOff", () => {
    const state = seed("a", {
      isCameraOff: true,
      isVideoAdaptivelyPaused: true,
    });
    const s = fakeStream("v");
    const next = participantReducer(state, videoAction("a", s));
    const p = next.get("a")!;
    expect(p.videoStream).toBe(s);
    expect(p.videoProducerId).toBe("vp1");
    expect(p.isCameraOff).toBe(false);
    expect(p.isVideoAdaptivelyPaused).toBe(false);
  });

  it("clears the producer id when the stream is removed", () => {
    let state = seed("a");
    state = participantReducer(state, videoAction("a", fakeStream("v")));
    const next = participantReducer(state, videoAction("a", null));
    const p = next.get("a")!;
    expect(p.videoStream).toBeNull();
    expect(p.videoProducerId).toBeNull();
  });

  it("attaches a webcam audio stream and clears isMuted", () => {
    const state = seed("a", { isMuted: true });
    const s = fakeStream("au");
    const next = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "audio",
      streamType: "webcam",
      stream: s,
      producerId: "ap1",
    });
    const p = next.get("a")!;
    expect(p.audioStream).toBe(s);
    expect(p.audioProducerId).toBe("ap1");
    expect(p.isMuted).toBe(false);
  });

  it("routes screen video to the screenShare slots (not the webcam slot)", () => {
    const state = seed("a");
    const s = fakeStream("scr");
    const next = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "video",
      streamType: "screen",
      stream: s,
      producerId: "sp1",
    });
    const p = next.get("a")!;
    expect(p.screenShareStream).toBe(s);
    expect(p.screenShareProducerId).toBe("sp1");
    expect(p.videoStream).toBeNull();
  });

  it("routes screen audio to the screenShareAudio slots", () => {
    const state = seed("a");
    const s = fakeStream("scra");
    const next = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "audio",
      streamType: "screen",
      stream: s,
      producerId: "sap1",
    });
    const p = next.get("a")!;
    expect(p.screenShareAudioStream).toBe(s);
    expect(p.screenShareAudioProducerId).toBe("sap1");
    expect(p.audioStream).toBeNull();
  });

  it("creates a participant on the fly when one does not exist yet", () => {
    const next = participantReducer(empty(), videoAction("new", fakeStream("v")));
    expect(next.has("new")).toBe(true);
    expect(next.get("new")!.videoStream).not.toBeNull();
  });

  it("is a no-op (same reference) when the re-emitted stream state is identical", () => {
    let state = seed("a");
    const s = fakeStream("v");
    state = participantReducer(state, videoAction("a", s, "vp1"));
    const next = participantReducer(state, videoAction("a", s, "vp1"));
    expect(next).toBe(state);
  });

  it("ignores stale webcam video closes after a replacement stream is attached", () => {
    let state = seed("a");
    const oldStream = fakeStream("old-video");
    const nextStream = fakeStream("next-video");
    state = participantReducer(state, videoAction("a", oldStream, "old-vp"));
    state = participantReducer(state, videoAction("a", nextStream, "next-vp"));

    const staleClose = participantReducer(
      state,
      videoAction("a", null, "old-vp"),
    );

    expect(staleClose).toBe(state);
    expect(staleClose.get("a")!.videoStream).toBe(nextStream);
    expect(staleClose.get("a")!.videoProducerId).toBe("next-vp");
    expect(staleClose.get("a")!.isCameraOff).toBe(false);
  });

  it("ignores stale screen-share video closes after a replacement stream is attached", () => {
    let state = seed("a");
    const oldStream = fakeStream("old-screen");
    const nextStream = fakeStream("next-screen");
    state = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "video",
      streamType: "screen",
      stream: oldStream,
      producerId: "old-screen-producer",
    });
    state = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "video",
      streamType: "screen",
      stream: nextStream,
      producerId: "next-screen-producer",
    });

    const staleClose = participantReducer(state, {
      type: "UPDATE_STREAM",
      userId: "a",
      kind: "video",
      streamType: "screen",
      stream: null,
      producerId: "old-screen-producer",
    });

    expect(staleClose).toBe(state);
    expect(staleClose.get("a")!.screenShareStream).toBe(nextStream);
    expect(staleClose.get("a")!.screenShareProducerId).toBe(
      "next-screen-producer",
    );
  });
});

describe("participantReducer — mute / camera / hand transitions", () => {
  it("UPDATE_MUTED toggles isMuted and is a no-op when unchanged", () => {
    const state = seed("a");
    const muted = participantReducer(state, {
      type: "UPDATE_MUTED",
      userId: "a",
      muted: true,
    });
    expect(muted.get("a")!.isMuted).toBe(true);
    const again = participantReducer(muted, {
      type: "UPDATE_MUTED",
      userId: "a",
      muted: true,
    });
    expect(again).toBe(muted);
  });

  it("UPDATE_MUTED materializes an absent participant", () => {
    const next = participantReducer(empty(), {
      type: "UPDATE_MUTED",
      userId: "x",
      muted: true,
    });
    expect(next.get("x")!.isMuted).toBe(true);
  });

  it("UPDATE_MUTED can skip materializing an absent participant", () => {
    const state = empty();
    const next = participantReducer(state, {
      type: "UPDATE_MUTED",
      userId: "x",
      muted: true,
      addIfMissing: false,
    });
    expect(next).toBe(state);
    expect(next.has("x")).toBe(false);
  });

  it("UPDATE_CAMERA_OFF toggles isCameraOff and is a no-op when unchanged", () => {
    const state = seed("a");
    const off = participantReducer(state, {
      type: "UPDATE_CAMERA_OFF",
      userId: "a",
      cameraOff: true,
    });
    expect(off.get("a")!.isCameraOff).toBe(true);
    const again = participantReducer(off, {
      type: "UPDATE_CAMERA_OFF",
      userId: "a",
      cameraOff: true,
    });
    expect(again).toBe(off);
  });

  it("UPDATE_CAMERA_OFF clears adaptive video pause when the camera is actually off", () => {
    const state = seed("a", {
      isCameraOff: false,
      isVideoAdaptivelyPaused: true,
    });
    const off = participantReducer(state, {
      type: "UPDATE_CAMERA_OFF",
      userId: "a",
      cameraOff: true,
    });
    expect(off.get("a")!.isCameraOff).toBe(true);
    expect(off.get("a")!.isVideoAdaptivelyPaused).toBe(false);
  });

  it("UPDATE_CAMERA_OFF can skip materializing an absent participant", () => {
    const state = empty();
    const next = participantReducer(state, {
      type: "UPDATE_CAMERA_OFF",
      userId: "x",
      cameraOff: true,
      addIfMissing: false,
    });
    expect(next).toBe(state);
    expect(next.has("x")).toBe(false);
  });

  it("UPDATE_VIDEO_ADAPTIVE_PAUSED toggles receiver-side video pause for the matching producer only", () => {
    const stream = fakeStream("v");
    const state = participantReducer(seed("a"), videoAction("a", stream, "vp1"));
    const paused = participantReducer(state, {
      type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
      userId: "a",
      producerId: "vp1",
      adaptivelyPaused: true,
    });
    expect(paused.get("a")!.isVideoAdaptivelyPaused).toBe(true);

    const staleClear = participantReducer(paused, {
      type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
      userId: "a",
      producerId: "old-producer",
      adaptivelyPaused: false,
    });
    expect(staleClear).toBe(paused);

    const resumed = participantReducer(paused, {
      type: "UPDATE_VIDEO_ADAPTIVE_PAUSED",
      userId: "a",
      producerId: "vp1",
      adaptivelyPaused: false,
    });
    expect(resumed.get("a")!.isVideoAdaptivelyPaused).toBe(false);
  });

  it("UPDATE_HAND_RAISED toggles isHandRaised and is a no-op when unchanged", () => {
    const state = seed("a");
    const raised = participantReducer(state, {
      type: "UPDATE_HAND_RAISED",
      userId: "a",
      raised: true,
    });
    expect(raised.get("a")!.isHandRaised).toBe(true);
    const again = participantReducer(raised, {
      type: "UPDATE_HAND_RAISED",
      userId: "a",
      raised: true,
    });
    expect(again).toBe(raised);
  });

  it("UPDATE_HAND_RAISED materializes an absent participant", () => {
    const next = participantReducer(empty(), {
      type: "UPDATE_HAND_RAISED",
      userId: "z",
      raised: true,
    });
    expect(next.get("z")!.isHandRaised).toBe(true);
  });
});

describe("participantReducer — connection status transitions", () => {
  it("UPDATE_CONNECTION_STATUS clear does not materialize an absent participant", () => {
    const state = seed("a");
    const next = participantReducer(state, {
      type: "UPDATE_CONNECTION_STATUS",
      userId: "missing",
      status: null,
    });

    expect(next).toBe(state);
    expect(next.has("missing")).toBe(false);
  });
});

describe("participantReducer — CLEAR_ALL & fallthrough", () => {
  it("clears a populated map", () => {
    let state = seed("a");
    state = participantReducer(state, { type: "ADD_PARTICIPANT", userId: "b" });
    const next = participantReducer(state, { type: "CLEAR_ALL" });
    expect(next.size).toBe(0);
    expect(next).not.toBe(state);
  });

  it("is a no-op (same reference) when clearing an empty map", () => {
    const state = empty();
    const next = participantReducer(state, { type: "CLEAR_ALL" });
    expect(next).toBe(state);
  });

  it("returns the same state for an unknown action type", () => {
    const state = seed("a");
    // @ts-expect-error — exercising the default branch with an invalid action
    const next = participantReducer(state, { type: "NOPE", userId: "a" });
    expect(next).toBe(state);
  });
});
