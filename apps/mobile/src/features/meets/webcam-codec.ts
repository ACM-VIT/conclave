import type { Device, RtpCodecCapability } from "mediasoup-client/types";
import type { Producer, ProducerType, Transport, VideoQuality } from "./types";
import {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
} from "./video-encodings";

// Prefer VP8 when the device/router intersection supports it. This avoids the
// H264 multi-decoder path that can surface as black remote webcam tiles on some
// mobile devices in denser calls.
const PREFERRED_WEBCAM_CODEC_MIME_TYPES = ["video/VP8"] as const;

const isPreferredVideoCodec = (
  codec: RtpCodecCapability,
  mimeType: string,
): boolean => {
  return (
    codec.kind === "video" &&
    codec.mimeType.toLowerCase() === mimeType.toLowerCase()
  );
};

export const getPreferredWebcamCodec = (
  device: Pick<Device, "rtpCapabilities"> | null | undefined,
): RtpCodecCapability | undefined => {
  const codecs = device?.rtpCapabilities?.codecs ?? [];

  for (const mimeType of PREFERRED_WEBCAM_CODEC_MIME_TYPES) {
    const codec = codecs.find((candidate) =>
      isPreferredVideoCodec(candidate, mimeType),
    );
    if (codec) {
      return codec;
    }
  }

  return undefined;
};

type ProduceWebcamTrackOptions = {
  transport: Transport;
  track: MediaStreamTrack;
  quality: VideoQuality;
  paused: boolean;
  preferredCodec?: RtpCodecCapability;
};

export async function produceWebcamTrack({
  transport,
  track,
  quality,
  paused,
  preferredCodec,
}: ProduceWebcamTrackOptions): Promise<Producer> {
  const buildOptions = (
    encodings: ReturnType<typeof buildWebcamSimulcastEncodings> | [
      ReturnType<typeof buildWebcamSingleLayerEncoding>,
    ],
    codec = preferredCodec,
  ) => ({
    track,
    encodings,
    ...(codec ? { codec } : {}),
    appData: { type: "webcam" as ProducerType, paused },
  });

  try {
    return await transport.produce(
      buildOptions(buildWebcamSimulcastEncodings(quality)),
    );
  } catch (simulcastError) {
    console.warn(
      "[Meets] Webcam simulcast produce failed, retrying single-layer:",
      simulcastError,
    );
  }

  try {
    return await transport.produce(
      buildOptions([buildWebcamSingleLayerEncoding(quality)]),
    );
  } catch (codecError) {
    if (!preferredCodec) {
      throw codecError;
    }

    console.warn(
      "[Meets] Preferred VP8 webcam codec failed, retrying router default codec:",
      codecError,
    );
  }

  return transport.produce(
    buildOptions([buildWebcamSingleLayerEncoding(quality)], undefined),
  );
}
