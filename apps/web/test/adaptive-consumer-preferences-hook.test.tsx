// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useAdaptiveConsumerPreferences } from "../src/app/hooks/useAdaptiveConsumerPreferences";
import type { Consumer } from "../src/app/lib/types";

type Options = Parameters<typeof useAdaptiveConsumerPreferences>[0];
type Refs = Options["refs"];
type Socket = NonNullable<Refs["socketRef"]["current"]>;
type Preference = { consumerId: string; preferredLayers?: { spatialLayer: number } };
type Ack = (result: { success: true; paused: boolean; producerPaused: boolean }) => void;

it("sends the latest tile size when an older request settles before the next poll", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const requests: { preference: Preference; ack: Ack }[] = [];
  const socket = {
    connected: true,
    emit: (event: string, preference: Preference, ack: Ack) => {
      if (event === "setConsumerPreferences") requests.push({ preference, ack });
    },
  } as unknown as Socket;
  const refs: Refs = {
    socketRef: { current: socket },
    consumersRef: {
      current: new Map([["camera", {
        id: "consumer",
        closed: false,
        rtpParameters: { encodings: [{ scalabilityMode: "L3T3" }] },
      } as Consumer]]),
    },
    producerMapRef: {
      current: new Map([["camera", { userId: "peer", kind: "video", type: "webcam" }]]),
    },
    consumerTelemetryRef: { current: new Map() },
    adaptivelyPausedConsumerProducerIdsRef: { current: new Set() },
    adaptiveVideoReceiverLifecycleRef: { current: null },
  };
  const root = createRoot(document.createElement("div"));
  const tile = document.createElement("div");
  tile.dataset.userid = "peer";
  let height = 120;
  Object.defineProperties(tile, {
    offsetHeight: { get: () => height },
    offsetWidth: { get: () => height * 16 / 9 },
  });
  document.body.append(tile);
  vi.stubGlobal("__conclaveMeetRoomTilingDebug", {
    current: { visibleRemoteIds: ["peer"], orderedRemoteIds: ["peer"], signature: "120" },
  });

  function Harness() {
    useAdaptiveConsumerPreferences({
      refs,
      enabled: true,
      connectionQuality: "good",
      emergencyMode: false,
      receiveContinuityRisk: false,
      availableIncomingBitrateBps: 10_000_000,
      activeSpeakerId: null,
    });
    return null;
  }

  const resize = (size: number) => {
    height = size;
    window.dispatchEvent(new CustomEvent("conclave:meet-room-tiling", {
      detail: { signature: String(size) },
    }));
  };
  const acknowledge = (index: number) =>
    requests[index].ack({ success: true, paused: false, producerPaused: false });

  try {
    await act(async () => root.render(<Harness />));
    await vi.advanceTimersByTimeAsync(10);
    expect(requests[0].preference.preferredLayers?.spatialLayer).toBe(0);
    acknowledge(0);

    resize(360);
    await vi.advanceTimersByTimeAsync(10);
    expect(requests[1].preference.preferredLayers?.spatialLayer).toBe(1);
    resize(720);
    resize(120);
    expect(requests).toHaveLength(2);

    acknowledge(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(requests).toHaveLength(3);
    expect(requests[2].preference.preferredLayers?.spatialLayer).toBe(0);
  } finally {
    await act(async () => root.unmount());
    tile.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
