import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import {
  useAdaptivePublishQuality,
  type AdaptivePublishQualityDebugSnapshot,
  type ProducerTransportNetworkProfileApplication,
} from "../src/app/hooks/useAdaptivePublishQuality";
import type { WebcamProducerTopologyReplacementRequest } from "../src/app/hooks/useMeetMedia";
import {
  DEFAULT_MEDIA_QUALITY_SETTINGS,
  type MediaQualitySettings,
} from "../src/app/lib/media-quality-settings";
import type { Producer, VideoQuality } from "../src/app/lib/types";
import type { WebcamProducerNetworkProfile } from "../src/app/lib/webcam-codec";
import type { ActiveWebcamReceiverCapacityProof } from "../src/app/lib/webcam-receiver-capacity-proof";
import type { WebcamTopologyReplacementResult } from "../src/app/lib/webcam-topology-transition";

export type PublishSource = "mic" | "webcam" | "screen" | "screenAudio";

export type EncodingSummary = {
  rid: string | null;
  active: boolean | null;
  maxBitrate: number | null;
  maxFramerate: number | null;
  scaleResolutionDownBy: number | null;
};

export type PublishEffect =
  | {
      at: number;
      type: "sender";
      source: PublishSource;
      producerId: string;
      encodings: EncodingSummary[];
      degradationPreference: string | null;
    }
  | { at: number; type: "capture"; frameRate: number }
  | {
      at: number;
      type: "update-video-quality";
      quality: VideoQuality;
      profile: WebcamProducerNetworkProfile | null;
      forceCaptureRefresh: boolean;
    }
  | { at: number; type: "set-video-quality"; quality: VideoQuality }
  | { at: number; type: "transport-profile"; profile: WebcamProducerNetworkProfile }
  | {
      at: number;
      type: "replace-topology";
      target: string;
      expectedProducerId: string;
      quality: VideoQuality;
      networkProfile: WebcamProducerNetworkProfile;
    }
  | { at: number; type: "refresh-screen-audio"; profile: WebcamProducerNetworkProfile }
  | { at: number; type: "key-frame"; producerId: string };

export type RigInputs = {
  enabled: boolean;
  publishCpuLimited: boolean;
  dataSaverMode: boolean;
  isCameraOff: boolean;
  participantCount: number;
  availableOutgoingBitrateBps: number | null;
  soleReceiverCapacityProof: ActiveWebcamReceiverCapacityProof | null;
};

export type RigConfig = {
  inputs?: Partial<RigInputs>;
  transport?: "supported" | "absent";
  videoQuality?: VideoQuality;
  networkManagedVideoQuality?: boolean;
  captureSettings?: { width: number; height: number; frameRate: number };
  withWebcam?: boolean;
};

const TRANSPORT_ID = "send-transport";
const TRANSPORT_BITRATE: Record<WebcamProducerNetworkProfile, number> = {
  good: 6_000_000,
  fair: 1_200_000,
  poor: 400_000,
  emergency: 160_000,
};

export const startFakeClock = () => {
  vi.useFakeTimers({
    now: 1_000_000,
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
};

export function createPublishRig(config: RigConfig = {}) {
  const effects: PublishEffect[] = [];
  const startedAt = Date.now();
  const now = () => Date.now() - startedAt;
  let producerSequence = 0;
  let failCaptureRefresh = false;
  let captureSettings = config.captureSettings ?? {
    width: 1280,
    height: 720,
    frameRate: 30,
  };

  const cameraTrack = {
    id: "camera-track",
    kind: "video",
    readyState: "live" as MediaStreamTrackState,
    getSettings: () => ({ ...captureSettings }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      const frameRate = constraints.frameRate as { max: number };
      effects.push({ at: now(), type: "capture", frameRate: frameRate.max });
      captureSettings = { ...captureSettings, frameRate: frameRate.max };
    },
  } as unknown as MediaStreamTrack;

  const makeProducer = (
    source: PublishSource,
    kind: "audio" | "video",
    mimeType: string,
    rids: (string | null)[],
    track: MediaStreamTrack | null,
    appData: Record<string, unknown> = {},
  ): Producer => {
    const id = `${source}-${++producerSequence}`;
    let parameters: RTCRtpSendParameters = {
      transactionId: "tx",
      codecs: [],
      headerExtensions: [],
      rtcp: {},
      encodings: rids.map((rid) => (rid ? { rid } : {})),
    } as RTCRtpSendParameters;
    const sender = {
      getParameters: () => structuredClone(parameters),
      setParameters: async (next: RTCRtpSendParameters) => {
        parameters = structuredClone(next);
        effects.push({
          at: now(),
          type: "sender",
          source,
          producerId: id,
          encodings: next.encodings.map((encoding) => ({
            rid: encoding.rid ?? null,
            active: encoding.active ?? null,
            maxBitrate: encoding.maxBitrate ?? null,
            maxFramerate: encoding.maxFramerate ?? null,
            scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? null,
          })),
          degradationPreference: next.degradationPreference ?? null,
        });
      },
    };
    return {
      id,
      kind,
      closed: false,
      paused: false,
      track,
      appData,
      rtpSender: sender,
      rtpParameters: {
        codecs: [{ mimeType, clockRate: kind === "audio" ? 48_000 : 90_000 }],
        encodings: rids.map((rid) => (rid ? { rid } : {})),
      },
      setRtpEncodingParameters: async () => {},
    } as unknown as Producer;
  };

  const webcamRids = {
    standard: ["q", "h", "f"],
    low: ["q", "f"],
    single: [null],
  } as const;
  const makeWebcam = (layers: keyof typeof webcamRids) =>
    makeProducer("webcam", "video", "video/VP8", [...webcamRids[layers]], cameraTrack);

  const screenTrack = {
    id: "screen-track",
    kind: "video",
    readyState: "live",
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 15 }),
  } as unknown as MediaStreamTrack;

  const refs = {
    audioProducerRef: {
      current: makeProducer("mic", "audio", "audio/opus", [null], null),
    },
    videoProducerRef: {
      current:
        config.withWebcam === false
          ? null
          : makeWebcam(config.videoQuality ?? "standard"),
    },
    screenProducerRef: { current: null as Producer | null },
    screenAudioProducerRef: { current: null as Producer | null },
    videoQualityRef: { current: config.videoQuality ?? ("standard" as VideoQuality) },
    localStreamRef: { current: null as MediaStream | null },
    mediaQualitySettingsRef: {
      current: DEFAULT_MEDIA_QUALITY_SETTINGS as MediaQualitySettings,
    },
    networkManagedVideoQualityRef: {
      current: config.networkManagedVideoQuality ?? false,
    },
    debugStateRef: {
      current: null as AdaptivePublishQualityDebugSnapshot | null,
    },
    updateVideoQualityRef: {
      current: async (
        quality: VideoQuality,
        profile?: WebcamProducerNetworkProfile,
        forceCaptureRefresh?: boolean,
      ) => {
        effects.push({
          at: now(),
          type: "update-video-quality",
          quality,
          profile: profile ?? null,
          forceCaptureRefresh: forceCaptureRefresh === true,
        });
        const webcam = refs.videoProducerRef.current;
        if (
          webcam &&
          webcam.rtpParameters.encodings?.length !== webcamRids[quality].length
        ) {
          refs.videoProducerRef.current = makeWebcam(quality);
        }
        if (!forceCaptureRefresh) return;
        if (failCaptureRefresh) throw new Error("capture refresh failed");
        captureSettings = { width: 1280, height: 720, frameRate: 30 };
      },
    },
  };

  const setVideoQuality = (quality: VideoQuality) => {
    effects.push({ at: now(), type: "set-video-quality", quality });
  };

  const replaceWebcamProducerTopology = async (
    request: WebcamProducerTopologyReplacementRequest,
  ): Promise<WebcamTopologyReplacementResult> => {
    effects.push({
      at: now(),
      type: "replace-topology",
      target: request.target,
      expectedProducerId: request.expectedProducerId,
      quality: request.quality,
      networkProfile: request.networkProfile,
    });
    const next = makeWebcam(
      request.target === "single-receiver" ? "single" : request.quality,
    );
    refs.videoProducerRef.current = next;
    return {
      status: "applied",
      producerId: next.id,
      topology: request.target === "single-receiver" ? "vp8-single-layer" : "vp8-simulcast",
    };
  };

  const refreshScreenAudioProducerForNetworkProfile = async (
    profile: WebcamProducerNetworkProfile,
  ) => {
    effects.push({ at: now(), type: "refresh-screen-audio", profile });
    return false;
  };

  const transport = config.transport ?? "absent";
  const setProducerTransportNetworkProfile = async (
    profile: WebcamProducerNetworkProfile,
  ): Promise<ProducerTransportNetworkProfileApplication> => {
    effects.push({ at: now(), type: "transport-profile", profile });
    return {
      transportId: TRANSPORT_ID,
      profile,
      maxIncomingBitrate: TRANSPORT_BITRATE[profile],
    };
  };

  const requestWebcamProducerKeyFrame = async (producerId: string) => {
    effects.push({ at: now(), type: "key-frame", producerId });
  };

  let inputs: RigInputs = {
    enabled: true,
    publishCpuLimited: false,
    dataSaverMode: false,
    isCameraOff: false,
    participantCount: 2,
    availableOutgoingBitrateBps: null,
    soleReceiverCapacityProof: null,
    ...config.inputs,
  };

  function Harness({ current }: { current: RigInputs }) {
    useAdaptivePublishQuality({
      connectionQuality: "good",
      capRecoveryQuality: "good",
      emergencyMode: false,
      ...current,
      ...refs,
      setVideoQuality,
      replaceWebcamProducerTopology,
      refreshScreenAudioProducerForNetworkProfile,
      producerTransportId: transport === "absent" ? null : TRANSPORT_ID,
      setProducerTransportNetworkProfile:
        transport === "absent" ? undefined : setProducerTransportNetworkProfile,
      requestWebcamProducerKeyFrame,
    });
    return null;
  }

  let root: Root | null = null;
  const render = () => root?.render(<Harness current={inputs} />);

  return {
    effects,
    refs,
    async mount() {
      root = createRoot(document.createElement("div"));
      await act(async () => render());
    },
    async unmount() {
      await act(async () => root?.unmount());
      root = null;
    },
    async set(next: Partial<RigInputs>) {
      inputs = { ...inputs, ...next };
      await act(async () => render());
    },
    async advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    },
    async startScreenShare() {
      refs.screenProducerRef.current = makeProducer(
        "screen",
        "video",
        "video/VP8",
        [null],
        screenTrack,
      );
      refs.screenAudioProducerRef.current = makeProducer(
        "screenAudio",
        "audio",
        "audio/opus",
        [null],
        null,
        { type: "screen", networkProfile: "poor" },
      );
      await act(async () => render());
    },
    failNextCaptureRefreshes(fail: boolean) {
      failCaptureRefresh = fail;
    },
    of<T extends PublishEffect["type"]>(type: T) {
      return effects.filter(
        (effect): effect is Extract<PublishEffect, { type: T }> =>
          effect.type === type,
      );
    },
    sends(source: PublishSource) {
      return effects.filter(
        (effect): effect is Extract<PublishEffect, { type: "sender" }> =>
          effect.type === "sender" && effect.source === source,
      );
    },
    lastSend(source: PublishSource) {
      return this.sends(source).at(-1) ?? null;
    },
  };
}

export type PublishRig = ReturnType<typeof createPublishRig>;
