import { describe, expect, it } from "vitest";
import {
  applyWebcamReceiverCapacityProof,
  createWebcamReceiverCapacityProofCache,
  isWebcamReceiverCapacityProofActive,
  parseWebcamReceiverCapacityProof,
  reduceWebcamReceiverCapacityProofCache,
  selectActiveWebcamReceiverCapacityProof,
  selectStagedWebcamReceiverCapacitySuccessor,
  selectWebcamReceiverCapacityRevocation,
  shouldAcceptWebcamReceiverCapacityProofRevision,
} from "../src/app/lib/webcam-receiver-capacity-proof";

const qualified = {
  roomId: "room-a",
  producerId: "producer-a",
  revision: 7,
  eligible: true,
  validForMs: 5_000,
  reason: "qualified",
  basis: "simulcast-full-layer",
  maxSpatialLayer: 2,
  maxTemporalLayer: 2,
  currentSpatialLayer: 2,
  currentTemporalLayer: 2,
  score: 10,
};

describe("webcam receiver-capacity proof", () => {
  it("accepts only producer-bound, room-bound, short-lived proof", () => {
    const proof = applyWebcamReceiverCapacityProof(
      null,
      qualified,
      { roomId: "room-a", producerId: "producer-a" },
      1_000,
    );
    expect(proof).toEqual({
      roomId: "room-a",
      producerId: "producer-a",
      revision: 7,
      basis: "simulcast-full-layer",
      expiresAtMonotonicMs: 6_000,
    });
    expect(
      isWebcamReceiverCapacityProofActive(
        proof,
        { roomId: "room-a", producerId: "producer-a" },
        5_999,
      ),
    ).toBe(true);
    expect(
      isWebcamReceiverCapacityProofActive(
        proof,
        { roomId: "room-a", producerId: "producer-a" },
        6_000,
      ),
    ).toBe(false);
  });

  it.each([
    [{ ...qualified, roomId: "wrong" }],
    [{ ...qualified, producerId: "wrong" }],
    [{ ...qualified, validForMs: 5_001 }],
    [{ ...qualified, validForMs: 0 }],
    [{ ...qualified, currentSpatialLayer: 1 }],
    [{ ...qualified, revision: 1.5 }],
  ])("rejects malformed or unbound grants", (payload) => {
    expect(
      applyWebcamReceiverCapacityProof(
        null,
        payload,
        { roomId: "room-a", producerId: "producer-a" },
        1_000,
      ),
    ).toBeNull();
  });

  it("ignores stale revisions and applies a newer revoke", () => {
    const current = applyWebcamReceiverCapacityProof(
      null,
      qualified,
      { roomId: "room-a", producerId: "producer-a" },
      1_000,
    );
    expect(
      applyWebcamReceiverCapacityProof(
        current,
        { ...qualified, revision: 6 },
        { roomId: "room-a", producerId: "producer-a" },
        2_000,
      ),
    ).toBe(current);
    expect(
      applyWebcamReceiverCapacityProof(
        current,
        {
          ...qualified,
          revision: 8,
          eligible: false,
          validForMs: 0,
          reason: "receiver_count",
        },
        { roomId: "room-a", producerId: "producer-a" },
        2_000,
      ),
    ).toBeNull();
  });

  it("rejects oversized identifiers and inconsistent eligibility", () => {
    expect(
      parseWebcamReceiverCapacityProof({
        ...qualified,
        roomId: "x".repeat(257),
      }),
    ).toBeNull();
    expect(
      parseWebcamReceiverCapacityProof({
        ...qualified,
        eligible: false,
      }),
    ).toBeNull();
  });

  it("retains revision monotonicity after a revoke or expiry", () => {
    const latest = { producerId: "producer-a", revision: 8 };
    expect(
      shouldAcceptWebcamReceiverCapacityProofRevision(latest, {
        producerId: "producer-a",
        revision: 7,
      }),
    ).toBe(false);
    expect(
      shouldAcceptWebcamReceiverCapacityProofRevision(latest, {
        producerId: "producer-a",
        revision: 9,
      }),
    ).toBe(true);
    expect(
      shouldAcceptWebcamReceiverCapacityProofRevision(latest, {
        producerId: "producer-b",
        revision: 1,
      }),
    ).toBe(true);
  });

  it("accepts a server offer and stages its successor before the producer ref changes", () => {
    const offered = {
      ...qualified,
      replacementOffer: {
        nonce: "server-nonce",
        validForMs: 4_000,
        target: "vp8-single-layer",
      },
    };
    let cache = reduceWebcamReceiverCapacityProofCache(
      createWebcamReceiverCapacityProofCache("room-a"),
      offered,
      "room-a",
      1_000,
    );
    const source = selectActiveWebcamReceiverCapacityProof(
      cache,
      { roomId: "room-a", producerId: "producer-a" },
      1_100,
    );
    expect(source?.replacementOffer).toEqual({
      nonce: "server-nonce",
      target: "vp8-single-layer",
      expiresAtMonotonicMs: 5_000,
    });

    cache = reduceWebcamReceiverCapacityProofCache(
      cache,
      {
        roomId: "room-a",
        producerId: "producer-b",
        revision: 1,
        eligible: true,
        validForMs: 5_000,
        reason: "qualified",
        basis: "single-layer-transition",
        replacesProducerId: "producer-a",
        transitionNonce: "server-nonce",
      },
      "room-a",
      1_200,
    );

    expect(
      selectStagedWebcamReceiverCapacitySuccessor(cache, {
        roomId: "room-a",
        replacesProducerId: "producer-a",
        transitionNonce: "server-nonce",
        nowMonotonicMs: 1_300,
      }),
    ).toEqual(
      expect.objectContaining({
        producerId: "producer-b",
        basis: "single-layer-transition",
      }),
    );
  });

  it("does not treat a revoke or a malformed client-shaped offer as authority", () => {
    let cache = reduceWebcamReceiverCapacityProofCache(
      createWebcamReceiverCapacityProofCache("room-a"),
      qualified,
      "room-a",
      1_000,
    );
    cache = reduceWebcamReceiverCapacityProofCache(
      cache,
      {
        ...qualified,
        revision: 8,
        eligible: false,
        validForMs: 0,
        reason: "receiver_count",
      },
      "room-a",
      1_100,
    );
    expect(
      selectActiveWebcamReceiverCapacityProof(
        cache,
        { roomId: "room-a", producerId: "producer-a" },
        1_200,
      ),
    ).toBeNull();
    expect(
      selectWebcamReceiverCapacityRevocation(
        cache,
        "room-a",
        "producer-a",
      )?.reason,
    ).toBe("receiver_count");
    expect(
      parseWebcamReceiverCapacityProof({
        ...qualified,
        replacementOffer: {
          nonce: "client-nonce",
          validForMs: 5_001,
          target: "vp8-single-layer",
        },
      }),
    ).toBeNull();
  });
});
