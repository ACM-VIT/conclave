// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublishRig,
  startFakeClock,
  type PublishRig,
} from "./adaptive-publish-rig";

const MIC_BITRATE = { good: 40_000, fair: 32_000, poor: 24_000 };
const VP8_FULL_LAYER_BITRATE = { good: 1_650_000, fair: 35_000, poor: 15_000 };

let rig: PublishRig | null = null;

const mount = async (config: Parameters<typeof createPublishRig>[0] = {}) => {
  rig = createPublishRig(config);
  await rig.mount();
  return rig;
};

const micBitrate = (target: PublishRig) =>
  target.lastSend("mic")?.encodings[0]?.maxBitrate ?? null;

const fullLayerBitrate = (target: PublishRig) =>
  target.lastSend("webcam")?.encodings.find((encoding) => encoding.rid === "f")
    ?.maxBitrate ?? null;

const captureRefreshes = (target: PublishRig) =>
  target
    .of("update-video-quality")
    .filter((effect) => effect.forceCaptureRefresh)
    .map(({ at, quality, profile }) => ({ at, quality, profile }));

const fullLayerProof = (producerId: string) => ({
  roomId: "room",
  producerId,
  revision: 1,
  basis: "simulcast-full-layer" as const,
  expiresAtMonotonicMs: 1e12,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  startFakeClock();
});

afterEach(async () => {
  await rig?.unmount();
  rig = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CPU limitation", () => {
  it("caps the camera and mic to fair after six seconds and restores good on the tick it clears", async () => {
    const target = await mount({ inputs: { publishCpuLimited: true } });

    await target.advance(5_999);
    expect(micBitrate(target)).toBe(MIC_BITRATE.good);
    expect(target.of("capture")).toEqual([]);

    await target.advance(1);
    expect(micBitrate(target)).toBe(MIC_BITRATE.fair);
    expect(fullLayerBitrate(target)).toBe(VP8_FULL_LAYER_BITRATE.fair);
    expect(target.of("capture")).toEqual([
      { at: 6_000, type: "capture", frameRate: 20 },
    ]);

    await target.advance(4_000);
    expect(micBitrate(target)).toBe(MIC_BITRATE.fair);
    await target.set({ publishCpuLimited: false });
    expect(micBitrate(target)).toBe(MIC_BITRATE.good);
    expect(fullLayerBitrate(target)).toBe(VP8_FULL_LAYER_BITRATE.good);
  });

  it("steps a screen-sharing sender down to poor after twenty limited seconds", async () => {
    const target = createPublishRig({ inputs: { publishCpuLimited: true } });
    rig = target;
    await target.startScreenShare();
    await target.mount();

    await target.advance(6_000);
    expect(micBitrate(target)).toBe(MIC_BITRATE.fair);
    await target.advance(13_999);
    expect(micBitrate(target)).toBe(MIC_BITRATE.fair);
    await target.advance(1);
    expect(micBitrate(target)).toBe(MIC_BITRATE.poor);
    expect(fullLayerBitrate(target)).toBe(VP8_FULL_LAYER_BITRATE.poor);
  });
});

describe("data saver", () => {
  it("applies the poor profile at once and returns to good on the tick it turns off", async () => {
    const target = await mount({ inputs: { dataSaverMode: true } });

    expect(micBitrate(target)).toBe(MIC_BITRATE.poor);
    expect(fullLayerBitrate(target)).toBe(VP8_FULL_LAYER_BITRATE.poor);
    expect(target.of("capture")).toEqual([
      { at: 0, type: "capture", frameRate: 12 },
    ]);

    await target.advance(10_000);
    expect(micBitrate(target)).toBe(MIC_BITRATE.poor);
    await target.set({ dataSaverMode: false });
    expect(micBitrate(target)).toBe(MIC_BITRATE.good);
    expect(fullLayerBitrate(target)).toBe(VP8_FULL_LAYER_BITRATE.good);
  });
});

describe("start-up window", () => {
  it("waits five seconds after joining before the first good profile when no camera publishes", async () => {
    const target = await mount({ withWebcam: false });

    await target.advance(4_999);
    expect(target.sends("mic")).toEqual([]);
    await target.advance(1);
    expect(micBitrate(target)).toBe(MIC_BITRATE.good);
  });

  it("returns a network-managed low start to standard two seconds after joining", async () => {
    const target = await mount({
      videoQuality: "low",
      networkManagedVideoQuality: true,
    });

    await target.advance(1_999);
    expect(target.of("set-video-quality")).toEqual([]);
    await target.advance(1);
    expect(target.of("update-video-quality")).toEqual([
      {
        at: 2_000,
        type: "update-video-quality",
        quality: "standard",
        profile: "good",
        forceCaptureRefresh: false,
      },
    ]);
    expect(target.of("set-video-quality")).toEqual([
      { at: 2_000, type: "set-video-quality", quality: "standard" },
    ]);
    expect(target.refs.networkManagedVideoQualityRef.current).toBe(false);
  });

  it("keeps a network-managed low start in rooms of more than four", async () => {
    const target = await mount({
      videoQuality: "low",
      networkManagedVideoQuality: true,
      inputs: { participantCount: 5 },
    });

    await target.advance(60_000);
    expect(target.of("set-video-quality")).toEqual([]);
    expect(target.refs.videoQualityRef.current).toBe("low");
    expect(target.refs.networkManagedVideoQualityRef.current).toBe(true);
  });
});

describe("configured capture restore", () => {
  it("restores a degraded capture at the good profile once the start-up window settles", async () => {
    const target = await mount({
      captureSettings: { width: 640, height: 360, frameRate: 15 },
    });

    await target.advance(4_999);
    expect(captureRefreshes(target)).toEqual([]);
    await target.advance(60_000);
    expect(captureRefreshes(target)).toEqual([
      { at: 5_000, quality: "standard", profile: "good" },
    ]);
  });

  it("retries a failed restore after fifteen seconds", async () => {
    const target = createPublishRig({
      captureSettings: { width: 640, height: 360, frameRate: 15 },
    });
    rig = target;
    target.failNextCaptureRefreshes(true);
    await target.mount();

    await target.advance(19_999);
    expect(captureRefreshes(target).map(({ at }) => at)).toEqual([5_000]);
    target.failNextCaptureRefreshes(false);
    await target.advance(60_000);
    expect(captureRefreshes(target).map(({ at }) => at)).toEqual([
      5_000, 20_000,
    ]);
  });
});

describe("single-receiver VP8 topology", () => {
  it("parks the lower layers for a proven sole receiver and reverts once a third person has stayed for the topology window", async () => {
    const target = createPublishRig();
    rig = target;
    const producerId = target.refs.videoProducerRef.current!.id;
    await target.set({ soleReceiverCapacityProof: fullLayerProof(producerId) });
    await target.mount();

    await target.advance(2_000);
    expect(target.lastSend("webcam")?.encodings[0]?.maxBitrate).toBe(35_000);

    await target.set({ participantCount: 3 });
    await target.advance(1_999);
    expect(target.lastSend("webcam")?.encodings[0]?.maxBitrate).toBe(35_000);
    await target.advance(1);
    expect(target.lastSend("webcam")).toMatchObject({ at: 4_000 });
    expect(target.lastSend("webcam")?.encodings[0]?.maxBitrate).toBe(80_000);
  });

  it("asks for a single-layer republish at the good profile when the server offers one", async () => {
    const target = createPublishRig();
    rig = target;
    const producerId = target.refs.videoProducerRef.current!.id;
    await target.set({
      soleReceiverCapacityProof: {
        ...fullLayerProof(producerId),
        replacementOffer: {
          nonce: "offer",
          target: "vp8-single-layer",
          expiresAtMonotonicMs: 1e12,
        },
      },
    });
    await target.mount();

    await target.advance(1_000);
    expect(target.of("replace-topology")).toEqual([]);
    await target.advance(1_000);
    expect(target.of("replace-topology")).toEqual([
      {
        at: 2_000,
        type: "replace-topology",
        target: "single-receiver",
        expectedProducerId: producerId,
        quality: "standard",
        networkProfile: "good",
      },
    ]);
  });
});

describe("screen share", () => {
  it("follows the available outgoing bitrate while sharing", async () => {
    const target = createPublishRig({
      inputs: { availableOutgoingBitrateBps: 400_000 },
    });
    rig = target;
    await target.startScreenShare();
    await target.mount();

    expect(micBitrate(target)).toBe(MIC_BITRATE.poor);
    expect(target.lastSend("screen")?.encodings[0]?.maxBitrate).toBe(650_000);

    await target.advance(1_000);
    await target.set({ availableOutgoingBitrateBps: 3_000_000 });
    expect(micBitrate(target)).toBe(MIC_BITRATE.good);
  });
});

describe("producer transport authority", () => {
  it("budgets the send transport instead of the senders, and requests a key frame when the budget relaxes", async () => {
    const target = await mount({
      transport: "supported",
      inputs: { dataSaverMode: true },
    });
    const producerId = target.refs.videoProducerRef.current!.id;

    expect(target.of("transport-profile")).toEqual([
      { at: 0, type: "transport-profile", profile: "poor" },
    ]);
    expect(target.sends("webcam")).toEqual([]);
    expect(target.sends("mic")).toEqual([]);

    await target.advance(10_000);
    await target.set({ dataSaverMode: false });
    expect(target.of("transport-profile").at(-1)).toEqual({
      at: 10_000,
      type: "transport-profile",
      profile: "good",
    });
    expect(target.of("key-frame")).toEqual([
      { at: 10_000, type: "key-frame", producerId },
    ]);
  });
});
