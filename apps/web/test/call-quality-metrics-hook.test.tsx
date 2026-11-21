// @vitest-environment happy-dom
import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionState,
  Producer,
  ReconnectRecoveryStatus,
  Transport,
  VideoQuality,
} from "../src/app/lib/types";

const telemetryMock = vi.hoisted(() => ({ enabled: true, capture: vi.fn() }));
vi.mock("../src/app/lib/telemetry", () => ({
  get telemetryEnabled() {
    return telemetryMock.enabled;
  },
  telemetry: { capture: telemetryMock.capture, captureException: vi.fn() },
}));

const { useCallQualityMetrics } = await import(
  "../src/app/hooks/useCallQualityMetrics"
);

const report = (stats: object[]) =>
  new Map(stats.map((stat, index) => [String(index), stat]));

// Counters grow with the fake clock: 100 bytes/ms is 800 kbps.
const fakeConsumerTransport = () => ({
  id: "recv",
  closed: false,
  getStats: vi.fn(async () => {
    const now = performance.now();
    return report([
      { type: "inbound-rtp", id: "IA", kind: "audio", packetsReceived: Math.round(now / 20), totalSamplesReceived: Math.round(now * 48), concealedSamples: 0 },
      { type: "inbound-rtp", id: "IV", kind: "video", packetsReceived: Math.round(now / 10), bytesReceived: Math.round(now * 100), framesDecoded: Math.round(now / 33), freezeCount: 0, totalFreezesDuration: 0 },
    ]);
  }),
});

const fakeCameraProducer = () => ({
  id: "camera-1",
  closed: false,
  getStats: vi.fn(async () =>
    report([
      { type: "outbound-rtp", id: "OT2", kind: "video", bytesSent: Math.round(performance.now() * 100), frameHeight: 720, qualityLimitationDurations: { cpu: 0, bandwidth: 0, none: 0 } },
    ]),
  ),
});

type HarnessProps = {
  state: ConnectionState;
  reconnect?: ReconnectRecoveryStatus | null;
};

let root: Root | null = null;

const mount = () => {
  const consumer = fakeConsumerTransport();
  const camera = fakeCameraProducer();
  const consumerTransportRef = { current: consumer } as unknown as MutableRefObject<Transport | null>;
  const cameraProducerRef = { current: camera } as unknown as MutableRefObject<Producer | null>;
  const videoQualityRef: MutableRefObject<VideoQuality> = { current: "standard" };
  function Harness({ state, reconnect = null }: HarnessProps) {
    useCallQualityMetrics({
      connectionState: state,
      meetError: null,
      reconnectRecoveryStatus: reconnect,
      participantCount: 2,
      joinMode: "meeting",
      consumerTransportRef,
      cameraProducerRef,
      videoQualityRef,
    });
    return null;
  }
  root = createRoot(document.createElement("div"));
  const render = (props: HarnessProps) =>
    act(() => root?.render(<Harness {...props} />));
  return { consumer, camera, render };
};

const capturedSummary = () =>
  telemetryMock.capture.mock.calls.find(([name]) => name === "call_summary")?.[1];

const gaveUp: ReconnectRecoveryStatus = {
  phase: "failed",
  attempt: 8,
  maxAttempts: 8,
  message: "Could not reconnect after several attempts.",
  lastError: "Connection timed out",
  retryAt: null,
  updatedAt: 0,
};

beforeEach(() => {
  telemetryMock.enabled = true;
  telemetryMock.capture.mockClear();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("useCallQualityMetrics", () => {
  it("summarises the camera producer's sending", async () => {
    const { render, camera } = mount();
    await render({ state: "connecting" });
    await render({ state: "joined" });
    await vi.advanceTimersByTimeAsync(31_000);
    await render({ state: "disconnected" });

    expect(camera.getStats).toHaveBeenCalled();
    expect(capturedSummary()).toMatchObject({
      end_reason: "left",
      outbound_video_height: 720,
      outbound_video_kbps: 800,
    });
  });

  it("reads no stats while telemetry is off", async () => {
    telemetryMock.enabled = false;
    const { render, camera, consumer } = mount();
    await render({ state: "connecting" });
    await render({ state: "joined" });
    await vi.advanceTimersByTimeAsync(31_000);

    expect(camera.getStats).not.toHaveBeenCalled();
    expect(consumer.getStats).not.toHaveBeenCalled();
  });

  it("sends the summary as soon as reconnecting gives up", async () => {
    const { render } = mount();
    await render({ state: "connecting" });
    await render({ state: "joined" });
    await vi.advanceTimersByTimeAsync(10_000);
    await render({ state: "reconnecting" });
    await vi.advanceTimersByTimeAsync(20_000);
    await render({ state: "error", reconnect: gaveUp });

    expect(capturedSummary()).toMatchObject({
      end_reason: "reconnect_failed",
      reconnect_unrecovered: true,
    });
  });
});
