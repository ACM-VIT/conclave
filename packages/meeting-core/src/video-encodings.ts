import type { VideoQuality } from "./types";

export interface WebcamSimulcastLayerProfile {
  rid: string;
  scaleResolutionDownBy: number;
  bitrateRatio: number;
  minBitrate: number;
  maxFramerate: number;
}

export interface VideoEncodingProfile {
  simulcast: Record<VideoQuality, readonly WebcamSimulcastLayerProfile[]>;
  singleLayerMaxFramerate: Record<VideoQuality, number>;
}

export interface VideoBitrateProfile {
  maxBitrate: Record<VideoQuality, number>;
  screenShare: {
    maxBitrate: number;
    maxFramerate: number;
  };
}

export interface CreateVideoEncodingHelpersOptions {
  profile: VideoEncodingProfile;
  bitrates: VideoBitrateProfile;
}

const floorBitrate = (value: number, min: number) => Math.max(min, Math.floor(value));

export function createVideoEncodingHelpers(
  options: CreateVideoEncodingHelpersOptions
) {
  const { profile, bitrates } = options;

  const buildWebcamSimulcastEncodings = (quality: VideoQuality) => {
    const maxBitrate = bitrates.maxBitrate[quality];
    return profile.simulcast[quality].map((layer) => ({
      rid: layer.rid,
      scaleResolutionDownBy: layer.scaleResolutionDownBy,
      maxBitrate: floorBitrate(maxBitrate * layer.bitrateRatio, layer.minBitrate),
      maxFramerate: layer.maxFramerate,
    }));
  };

  const buildWebcamSingleLayerEncoding = (quality: VideoQuality) => ({
    maxBitrate: bitrates.maxBitrate[quality],
    maxFramerate: profile.singleLayerMaxFramerate[quality],
  });

  const buildScreenShareEncoding = () => ({
    maxBitrate: bitrates.screenShare.maxBitrate,
    maxFramerate: bitrates.screenShare.maxFramerate,
    scalabilityMode: "L1T2" as const,
  });

  return {
    buildWebcamSimulcastEncodings,
    buildWebcamSingleLayerEncoding,
    buildScreenShareEncoding,
  };
}
