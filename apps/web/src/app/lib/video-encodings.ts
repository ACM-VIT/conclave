import {
  LOW_VIDEO_MAX_BITRATE,
  STANDARD_VIDEO_MAX_BITRATE,
} from "./constants";
import type { VideoQuality } from "./types";

const floorBitrate = (value: number, min: number) => Math.max(min, Math.floor(value));

export function buildWebcamSimulcastEncodings(quality: VideoQuality) {
  const maxBitrate =
    quality === "low" ? LOW_VIDEO_MAX_BITRATE : STANDARD_VIDEO_MAX_BITRATE;

  if (quality === "low") {
    return [
      {
        rid: "q",
        scaleResolutionDownBy: 2,
        maxBitrate: floorBitrate(maxBitrate * 0.35, 90000),
        maxFramerate: 15,
      },
      {
        rid: "f",
        scaleResolutionDownBy: 1,
        maxBitrate,
        maxFramerate: 24,
      },
    ];
  }

  return [
    {
      rid: "q",
      scaleResolutionDownBy: 4,
      maxBitrate: floorBitrate(maxBitrate * 0.15, 90000),
      maxFramerate: 15,
    },
    {
      rid: "h",
      scaleResolutionDownBy: 2,
      maxBitrate: floorBitrate(maxBitrate * 0.45, 220000),
      maxFramerate: 24,
    },
    {
      rid: "f",
      scaleResolutionDownBy: 1,
      maxBitrate,
      maxFramerate: 30,
    },
  ];
}

export function buildWebcamSingleLayerEncoding(quality: VideoQuality) {
  return {
    maxBitrate:
      quality === "low" ? LOW_VIDEO_MAX_BITRATE : STANDARD_VIDEO_MAX_BITRATE,
    maxFramerate: quality === "low" ? 24 : 30,
  };
}
