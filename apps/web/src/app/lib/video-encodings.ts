import { createVideoEncodingHelpers } from "@conclave/meeting-core/video-encodings";
import {
  LOW_VIDEO_MAX_BITRATE,
  SCREEN_SHARE_MAX_BITRATE,
  SCREEN_SHARE_MAX_FRAMERATE,
  STANDARD_VIDEO_MAX_BITRATE,
} from "./constants";

const STANDARD_BASE_LAYER_MAX_BITRATE = 80_000;
const STANDARD_MIDDLE_LAYER_MAX_BITRATE = 250_000;

const {
  buildWebcamSimulcastEncodings: buildBaseWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding: buildBaseWebcamSingleLayerEncoding,
  buildScreenShareEncoding,
} = createVideoEncodingHelpers({
  bitrates: {
    maxBitrate: {
      low: LOW_VIDEO_MAX_BITRATE,
      standard: STANDARD_VIDEO_MAX_BITRATE,
    },
    screenShare: {
      maxBitrate: SCREEN_SHARE_MAX_BITRATE,
      maxFramerate: SCREEN_SHARE_MAX_FRAMERATE,
    },
  },
  profile: {
    simulcast: {
      low: [
        {
          rid: "q",
          scaleResolutionDownBy: 2,
          bitrateRatio: 0.35,
          minBitrate: 80000,
          maxFramerate: 12,
        },
        {
          rid: "f",
          scaleResolutionDownBy: 1,
          bitrateRatio: 1,
          minBitrate: 0,
          maxFramerate: 20,
        },
      ],
      standard: [
        {
          rid: "q",
          scaleResolutionDownBy: 4,
          bitrateRatio:
            STANDARD_BASE_LAYER_MAX_BITRATE / STANDARD_VIDEO_MAX_BITRATE,
          minBitrate: STANDARD_BASE_LAYER_MAX_BITRATE,
          maxFramerate: 15,
        },
        {
          rid: "h",
          scaleResolutionDownBy: 2,
          bitrateRatio:
            STANDARD_MIDDLE_LAYER_MAX_BITRATE / STANDARD_VIDEO_MAX_BITRATE,
          minBitrate: STANDARD_MIDDLE_LAYER_MAX_BITRATE,
          maxFramerate: 30,
        },
        {
          rid: "f",
          scaleResolutionDownBy: 1,
          bitrateRatio: 1,
          minBitrate: 0,
          maxFramerate: 30,
        },
      ],
    },
    singleLayerMaxFramerate: {
      low: 20,
      standard: 30,
    },
  },
});

const buildWebcamSimulcastEncodings = (quality: "low" | "standard") =>
  buildBaseWebcamSimulcastEncodings(quality).map((encoding) => ({
    ...encoding,
    scalabilityMode: "L1T1" as const,
  }));

const buildWebcamSingleLayerEncoding = (quality: "low" | "standard") => ({
  ...buildBaseWebcamSingleLayerEncoding(quality),
  scalabilityMode: "L1T1" as const,
});

export {
  buildScreenShareEncoding,
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
};
