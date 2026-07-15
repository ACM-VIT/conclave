import { createVideoEncodingHelpers } from "@conclave/meeting-core/video-encodings";
import {
  LOW_VIDEO_MAX_BITRATE,
  SCREEN_SHARE_MAX_BITRATE,
  SCREEN_SHARE_MAX_FRAMERATE,
  STANDARD_VIDEO_MAX_BITRATE,
} from "./constants";

// Keep the standard simulcast ladder aligned with the native Swift/Android
// clients. All active simulcast layers consume upload at the same time, so q/h
// must remain small enough to leave useful BWE headroom for the full 720p layer.
const STANDARD_BASE_LAYER_MAX_BITRATE = 80_000;
const STANDARD_MIDDLE_LAYER_MAX_BITRATE = 220_000;

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
          maxFramerate: 12,
        },
        {
          rid: "h",
          scaleResolutionDownBy: 2,
          bitrateRatio:
            STANDARD_MIDDLE_LAYER_MAX_BITRATE / STANDARD_VIDEO_MAX_BITRATE,
          minBitrate: STANDARD_MIDDLE_LAYER_MAX_BITRATE,
          maxFramerate: 20,
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

// Chrome otherwise promotes VP8 camera encodings to L1T3. On the measured SFU
// path, that correlated with the receiver's network-minimum jitter buffer
// climbing above 80 ms even on lossless local UDP and repeatable decoder
// starvation. Spatial simulcast already supplies the adaptive ladder; keeping
// every simulcast and true-single encoding at one temporal layer removes the
// temporal hierarchy as a controlled low-latency variable, without attributing
// the result to an unobserved codec mechanism.
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
