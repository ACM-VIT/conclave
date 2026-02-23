import { createVideoEncodingHelpers } from "@conclave/meeting-core/video-encodings";
import {
  LOW_VIDEO_MAX_BITRATE,
  SCREEN_SHARE_MAX_BITRATE,
  SCREEN_SHARE_MAX_FRAMERATE,
  STANDARD_VIDEO_MAX_BITRATE,
} from "./constants";

const {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
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
          minBitrate: 90000,
          maxFramerate: 15,
        },
        {
          rid: "f",
          scaleResolutionDownBy: 1,
          bitrateRatio: 1,
          minBitrate: 0,
          maxFramerate: 24,
        },
      ],
      standard: [
        {
          rid: "h",
          scaleResolutionDownBy: 2,
          bitrateRatio: 0.35,
          minBitrate: 160000,
          maxFramerate: 15,
        },
        {
          rid: "f",
          scaleResolutionDownBy: 1,
          bitrateRatio: 1,
          minBitrate: 0,
          maxFramerate: 24,
        },
      ],
    },
    singleLayerMaxFramerate: {
      low: 20,
      standard: 24,
    },
  },
});

export {
  buildScreenShareEncoding,
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
};
