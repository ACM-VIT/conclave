"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FaceMesh,
  NormalizedLandmark,
  NormalizedLandmarkList,
  Results as FaceMeshResults,
} from "@mediapipe/face_mesh";
import type {
  Results as SelfieSegmentationResults,
  SelfieSegmentation,
} from "@mediapipe/selfie_segmentation";
import type {
  FaceLandmarker as TasksFaceLandmarker,
  ImageSegmenter as TasksImageSegmenter,
  ImageSegmenterResult,
  Matrix as TasksMatrix,
} from "@mediapipe/tasks-vision";
import {
  BACKGROUND_ASSET_PATHS,
  DEFAULT_VIDEO_EFFECTS,
  getFaceFilterEffectGraph,
  hasActiveVideoEffects,
  isMeetVideoPipeRuntimeEnabled,
  isAnimatedBackgroundEffect,
  requiresMeetVideoPipeFaceFilter,
  type AppearanceStyleId,
  type BackgroundEffectId,
  type FaceFilterEffectGraph,
  type FaceFilterId,
  type VideoEffectsState,
} from "../lib/video-effects";
import {
  prewarmMeetVideoPipeRuntime,
  startMeetVideoPipeEffect,
} from "../lib/meet-videopipe-runtime";

const SELFIE_SEGMENTATION_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747";
const FACE_MESH_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619";
const TASKS_VISION_VERSION = "0.10.35";
const TASKS_VISION_WASM_LOCAL_PATH = `/mediapipe/tasks-vision/${TASKS_VISION_VERSION}/wasm`;
const TASKS_VISION_WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const TASKS_SELFIE_SEGMENTER_MODEL_LOCAL_PATH =
  "/mediapipe/models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";
const TASKS_SELFIE_SEGMENTER_MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";
const TASKS_FACE_LANDMARKER_MODEL_LOCAL_PATH =
  "/mediapipe/models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const TASKS_FACE_LANDMARKER_MODEL_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const TASKS_SELFIE_SEGMENTER_MODELS = [
  { source: "same-origin", url: TASKS_SELFIE_SEGMENTER_MODEL_LOCAL_PATH },
  { source: "google-storage", url: TASKS_SELFIE_SEGMENTER_MODEL_CDN },
] as const;
const TASKS_FACE_LANDMARKER_MODELS = [
  { source: "same-origin", url: TASKS_FACE_LANDMARKER_MODEL_LOCAL_PATH },
  { source: "google-storage", url: TASKS_FACE_LANDMARKER_MODEL_CDN },
] as const;

const TARGET_FPS = 30;
const MAX_EFFECTS_OUTPUT_WIDTH = 1280;
const MAX_EFFECTS_OUTPUT_HEIGHT = 720;
const MAX_SEGMENTATION_MODEL_INPUT_WIDTH = 640;
const MAX_SEGMENTATION_MODEL_INPUT_HEIGHT = 360;
const MAX_FACE_MODEL_INPUT_WIDTH = 640;
const MAX_FACE_MODEL_INPUT_HEIGHT = 360;
const INITIAL_SEGMENTATION_INTERVAL_MS = 66;
const MIN_SEGMENTATION_INTERVAL_MS = 66;
const MIN_FACE_INTERVAL_MS = 84;
const MIN_FACE_FILTER_INTERVAL_MS = 50;
const MAX_ACTIVE_FACE_FILTER_INTERVAL_MS = 70;
const MAX_SEGMENTATION_INTERVAL_MS = 180;
const MAX_FACE_INTERVAL_MS = 260;
const FACE_NO_RESULT_BACKOFF_AFTER_RESULTS = 6;
const FACE_NO_RESULT_BACKOFF_INTERVAL_MS = 220;
const SEGMENTATION_RESULT_STALE_MS = 240;
const FACE_RESULT_STALE_MS = 520;
const VIDEO_EFFECTS_ADAPTATION_TIERS = [1400, 1200, 1100, 1000] as const;
const VIDEO_EFFECTS_ADAPTATION_PROCESSING_TARGET_MS = 30;
const VIDEO_EFFECTS_ADAPTATION_FULL_TARGET_MS = 200;
const VIDEO_EFFECTS_ADAPTATION_RUNTIME_PRESSURE_TARGET_MS = 55;
const VIDEO_EFFECTS_ADAPTATION_RECENT_SPIKE_MS = 60;
const VIDEO_EFFECTS_ADAPTATION_RUNTIME_PRESSURE_SPIKE_MS = 85;
const VIDEO_EFFECTS_ADAPTATION_FRAME_INTERVAL_TARGET_MS = 1000 / 14;
const VIDEO_EFFECTS_ADAPTATION_CONSECUTIVE_SLOW_FRAMES = 2;
const VIDEO_EFFECTS_ADAPTATION_HARD_PROCESSING_SPIKE_MS = 90;
const VIDEO_EFFECTS_ADAPTATION_HARD_FULL_SPIKE_MS = 320;
const VIDEO_EFFECTS_ADAPTATION_HARD_RUNTIME_PRESSURE_SPIKE_MS = 140;
const VIDEO_EFFECTS_ADAPTATION_FRAME_INTERVAL_SPIKE_MS = 140;
const VIDEO_EFFECTS_ADAPTATION_RECOVERY_COOLDOWNS_MS = [
  30_000,
  300_000,
  600_000,
  1_200_000,
] as const;
const VIDEO_EFFECTS_ADAPTATION_COOLDOWN_RESET_MS = 300_000;
const VIDEO_EFFECTS_ADAPTATION_WARMUP_HOLD_MS = 1200;
const VIDEO_EFFECTS_PROCESSING_ALPHA = 0.92;
const VIDEO_EFFECTS_FULL_ALPHA = 0.9;
const VIDEO_EFFECTS_RUNTIME_PRESSURE_ALPHA = 0.82;
const VIDEO_EFFECTS_FRAME_INTERVAL_ALPHA = 0.84;
const VIDEO_EFFECTS_ADAPTATION_WARMUP_RESULTS = 2;
const VIDEO_EFFECTS_POLICY_HD_PIXELS = 900_000;
const VIDEO_EFFECTS_POLICY_FULL_HD_PIXELS = 1_500_000;
const VIDEO_EFFECTS_POLICY_DOWNSHIFT_TRANSITION_HOLD_MS = 260;
const VIDEO_EFFECTS_POLICY_UPSHIFT_HOLD_MS = 1800;
const EFFECT_SWITCH_MODEL_CADENCE_WARMUP_MS = 900;
const LOW_LIGHT_SAMPLE_INTERVAL_MS = 180;
const LOW_LIGHT_TRANSITION_MS = 1000;
const LOW_LIGHT_TARGET_CHANGE_THRESHOLD = 1.5;
const VISUAL_EFFECT_BACKGROUND_TRANSITION_MS = 180;
const VISUAL_EFFECT_FILTER_TRANSITION_MS = 90;
const VISUAL_EFFECT_STYLE_TRANSITION_MS = 90;
const VISUAL_EFFECT_APPEARANCE_TRANSITION_MS = 90;
const VISUAL_EFFECT_FRAMING_TRANSITION_MS = 100;
const VISUAL_EFFECT_MIXED_TRANSITION_MS = 140;
const CROP_SMOOTHING_ALPHA = 0.22;
const STATIC_CROP_STABLE_FRAME_THRESHOLD = 8;
const STATIC_CROP_ENTER_DRIFT_PX = 2.5;
const STATIC_CROP_EXIT_DRIFT_PX = 10;
const STATIC_CROP_FACE_REVALIDATION_INTERVAL_MS = 360;
const FACE_LANDMARK_SMOOTHING_ALPHA = 0.42;
const FACE_LANDMARK_FAST_SMOOTHING_ALPHA = 0.84;
const FACE_LANDMARK_ADAPTIVE_MOTION_START = 0.004;
const FACE_LANDMARK_ADAPTIVE_MOTION_END = 0.03;
const FACE_FILTER_LANDMARK_SMOOTHING_ALPHA = 0.72;
const FACE_FILTER_LANDMARK_FAST_SMOOTHING_ALPHA = 0.94;
const FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_START = 0.0015;
const FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_END = 0.012;
const MASK_TEMPORAL_ALPHA = 0.72;
const MASK_CONFIDENCE_FLOOR = 0.18;
const MASK_CONFIDENCE_CEILING = 0.74;
const MASK_CONFIDENCE_GAMMA = 0.82;
const MASK_EDGE_FEATHER_PX = 1.35;
const MASK_EDGE_REINFORCE_ALPHA = 0.72;
const OUTPUT_PROBE_WIDTH = 16;
const OUTPUT_PROBE_HEIGHT = 9;
const LOW_LIGHT_SAMPLE_WIDTH = 48;
const LOW_LIGHT_SAMPLE_HEIGHT = 27;
const AUTO_FRAME_MASK_SAMPLE_WIDTH = 80;
const AUTO_FRAME_MASK_SAMPLE_HEIGHT = 45;
const AUTO_FRAME_FOREGROUND_THRESHOLD = 0.18;
const AUTO_FRAME_MIN_WEIGHT_RATIO = 0.015;
const AUTO_FRAME_MAX_ZOOM = 1.32;
const OUTPUT_READY_FRAMES = 6;
const DEBUG_RENDER_PROBE_READY_FRAMES = 2;
const DEBUG_RENDER_PROBE_INTERVAL_FRAMES = 90;
const DARK_OUTPUT_HOLD_WARNING_FRAMES = 12;
const VIDEO_FRAME_CALLBACK_WATCHDOG_MS = 450;
const VIDEO_FRAME_CALLBACK_TRANSITION_WATCHDOG_MS = 48;
const VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_PUMP_MS = 320;
const VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_DRAIN_FRAMES = 4;
const OUTPUT_WRITER_STEADY_MAX_PENDING_FRAMES = 1;
const OUTPUT_WRITER_TRANSITION_MAX_PENDING_FRAMES = 1;
const OUTPUT_WRITER_TRANSITION_BURST_MS = 900;
const OUTPUT_WRITER_BACKPRESSURE_DRAIN_TIMEOUT_MS = 36;
const OUTPUT_WRITER_PENDING_PRESSURE_MS = 75;
const OUTPUT_WRITER_FRAME_TIMEOUT_MS = 3000;
const OUTPUT_WRITER_FAILURE_RELEASE_THRESHOLD = 3;
const SEGMENTATION_PROCESSOR_FRAME_TIMEOUT_MS = 6000;
const FACE_PROCESSOR_FRAME_TIMEOUT_MS = 6000;
const SEGMENTATION_PROCESSOR_TIMEOUT_MESSAGE =
  "Timed out waiting for segmentation worker result.";
const FACE_PROCESSOR_TIMEOUT_MESSAGE =
  "Timed out waiting for face worker result.";
const VIDEO_EFFECTS_PROCESSOR_CLEANUP_MESSAGE =
  "Video effects processor cleaned up.";
const TRACK_PROCESSOR_PRIMARY_MAX_AGE_MS = 900;
const TRACK_PROCESSOR_SCHEDULER_MAX_AGE_MS = 1200;
const TRACK_PROCESSOR_RETIRE_AFTER_VIDEO_VISIBLE_MS = 1800;
const SOURCE_VIDEO_REARM_MISS_THRESHOLD = 8;
const TRACK_PROCESSOR_RESTART_MISS_THRESHOLD = 18;
const TRACK_PROCESSOR_RESTART_COOLDOWN_MS = 1200;
const LAST_VISIBLE_OUTPUT_HOLD_MS = 5000;
const LAST_VISIBLE_OUTPUT_SNAPSHOT_INTERVAL_MS = 450;
const OUTPUT_VISIBILITY_PROBE_INTERVAL_FRAMES = 12;
const SOURCE_VISIBILITY_PROBE_INTERVAL_FRAMES = 8;
const SOURCE_VISIBILITY_PROBE_RECOVERY_INTERVAL_FRAMES = 2;
const FRAME_METADATA_DISPATCH_INTERVAL_MS = 200;
const WORKER_CLOSE_GRACE_MS = 6500;
const PROCESSOR_PREWARM_TIMEOUT_MS = 12_000;
const PROCESSOR_PREWARM_CLOSE_GRACE_MS = 6500;
const PROCESSOR_PREWARM_IDLE_TIMEOUT_MS = 45_000;
const PROCESSOR_PREWARM_FRAME_WIDTH = 256;
const PROCESSOR_PREWARM_FRAME_HEIGHT = 144;
const PROCESSOR_PREWARM_CONFIG_ID = -1;
const ACTIVE_PIPELINE_PREWARM_SUPPRESSION_HOLD_MS = 1600;
const BACKGROUND_PREWARM_ACTIVE_PIPELINE_DELAY_MS = 160;
const BACKGROUND_PREWARM_IDLE_DELAY_MS = 24;
const BACKGROUND_PREWARM_ACTIVE_PIPELINE_CONCURRENCY = 1;
const BACKGROUND_PREWARM_IDLE_CONCURRENCY = 2;
const MIN_VISIBLE_AVERAGE_LUMA = 3;
const MIN_VISIBLE_PEAK_LUMA = 18;
const PROCESSED_TRACK_STOP_GRACE_MS = 1800;
const DEBUG_VIDEO_EFFECTS_STORAGE_KEY = "conclave:debug-video-effects";
const DEBUG_VIDEO_EFFECTS_VERBOSE_STORAGE_KEY =
  "conclave:debug-video-effects-verbose";
const HOT_DEBUG_EVENTS = new Set([
  "legacy_face_results",
  "legacy_segmentation_mask",
  "face_processor_worker_results",
  "segmentation_processor_worker_results",
  "tasks_face_results",
  "tasks_face_send",
  "tasks_segmenter_send",
  "tasks_segmentation_mask",
  "using_track_processor_frame_source",
  "frame_stats",
]);

export type VideoEffectsRuntimeStatus =
  | "off"
  | "loading"
  | "running"
  | "degraded";
export type VideoEffectsDebugStats = Record<string, unknown>;

type MeetVideoPipeFailureSnapshot = {
  requestKey: string;
  graphId: string;
  effectIdNumber: number | null;
  timestampMs: number;
  error: unknown;
};

type CropRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};
type LandmarkBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
};
type ForegroundBounds = LandmarkBounds & {
  width: number;
  height: number;
  confidenceWeight: number;
  coverage: number;
  samplePixelCount: number;
  maskSampleMode: string;
};
type AutoFrameSource = "off" | "face" | "foreground" | "center";
type AutoFrameStats = {
  enabled: boolean;
  source: AutoFrameSource;
  zoom: number;
  targetCrop: CropRect;
  crop: CropRect;
  foregroundBounds: ForegroundBounds | null;
  faceBounds: LandmarkBounds | null;
  recenterCount: number;
  recentered: boolean;
  lastRecenterAgeMs: number | null;
  staticCrop?: StaticCropStats;
};
type StaticCropExitReason =
  | "effect-change"
  | "not-framing-only"
  | "recenter"
  | "crop-drift"
  | "source-lost"
  | "source-not-face"
  | null;
type StaticCropStats = {
  eligible: boolean;
  active: boolean;
  stableFrameCount: number;
  activationCount: number;
  exitCount: number;
  modelSkipCount: number;
  enterThresholdFrames: number;
  enterDriftPx: number;
  exitDriftPx: number;
  faceRevalidationIntervalMs: number;
  latestDriftPx: number | null;
  enteredAgeMs: number | null;
  lastExitReason: StaticCropExitReason;
  crop: CropRect | null;
};
type AutoFrameTarget = Omit<
  AutoFrameStats,
  "crop" | "recenterCount" | "recentered" | "lastRecenterAgeMs"
>;
type VideoEffectsHumanTrack = {
  trackId: string;
  source: "face" | "foreground";
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  coverage: number;
};
type VideoEffectsFrameMetadata = {
  type: "FRAME_METADATA";
  source: "client-video-effects";
  sequence: number;
  processingConfigId: number;
  approximateTimestampMs: number;
  exactTimestampMs: number | null;
  frame: {
    width: number;
    height: number;
    frameSequence: number;
    outputFrameSequence: number;
  };
  roomTilingMetadata: {
    tileCount: number;
    tilesStable: boolean;
    enabledFramesCount: number;
    stableFramesCount: number;
    fallbackLevel: number;
  };
  humanTrackingMetadata: {
    lifetimeTrackCount: number;
    activeTrackCount: number;
    trackedHumans: VideoEffectsHumanTrack[];
  };
  continuousAutozoomMetadata: {
    enabled: boolean;
    source: AutoFrameSource;
    zoomFactor: number;
    crop: CropRect;
    targetCrop: CropRect;
    recentered: boolean;
    recenterCount: number;
  };
};
type VideoEffectsFrameMetadataDebugSnapshot = {
  current: VideoEffectsFrameMetadata | null;
  history: VideoEffectsFrameMetadata[];
  sequence: number;
};

declare global {
  interface Window {
    __conclaveGetVideoEffectsFrameMetadataDebug?: () => VideoEffectsFrameMetadataDebugSnapshot;
    __conclaveVideoEffectsFrameMetadataDebug?: VideoEffectsFrameMetadataDebugSnapshot;
  }
}

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (
      now: DOMHighResTimeStamp,
      metadata?: VideoFrameCallbackMetadataLike,
    ) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};
type VideoFrameCallbackMetadataLike = {
  presentationTime?: number;
  expectedDisplayTime?: number;
  width?: number;
  height?: number;
  mediaTime?: number;
  presentedFrames?: number;
  processingDuration?: number;
  captureTime?: number;
  receiveTime?: number;
  rtpTimestamp?: number;
};

type TasksVisionModule = typeof import("@mediapipe/tasks-vision");
type TasksVisionFileset = Awaited<
  ReturnType<TasksVisionModule["FilesetResolver"]["forVisionTasks"]>
>;
type MediaPipeDelegate = "GPU" | "CPU";
type ModelDispatchKind = "segmentation" | "face";
type VideoEffectsAdaptationTier =
  (typeof VIDEO_EFFECTS_ADAPTATION_TIERS)[number];
type VideoEffectsRoomTilingPolicyContext = {
  sequence: number;
  renderedMode: string;
  presenting: boolean;
  dynamicCrop: boolean;
  totalGridCount: number;
  visibleCount: number;
  hiddenCount: number;
  stageRailCount: number;
  fallbackLevel: number;
  maxTiles: number;
  tileWidth: number;
  tileHeight: number;
  selfViewPlacement: string;
  localIsPrimary: boolean;
  receivedAt: number;
};
type VideoEffectsAdaptationPolicy =
  | {
      tier: VideoEffectsAdaptationTier;
      reason: string;
      score: number;
      sourcePixels: number;
    }
  | {
      tier: null;
      reason: null;
      score: number;
      sourcePixels: number;
    };
type ModelAssetCandidate = {
  source: "same-origin" | "google-storage";
  url: string;
};
type CanvasVisibilityProbe = {
  averageLuma: number;
  peakLuma: number;
  visible: boolean;
};
type TemporalMaskSource =
  | "none"
  | "tasks-confidence"
  | "tasks-category"
  | "legacy";
type TemporalMaskStats = {
  enabled: boolean;
  alpha: number;
  confidenceFloor: number;
  confidenceCeiling: number;
  confidenceGamma: number;
  frameCount: number;
  shapeFrameCount: number;
  smoothedFrameCount: number;
  resetCount: number;
  source: TemporalMaskSource;
  pixelCount: number;
  canvas: {
    width: number;
    height: number;
    scratchWidth: number;
    scratchHeight: number;
  };
  latestAgeMs: number | null;
  hasHistory: boolean;
};
type VideoFramePollerStats = {
  mode: "requestVideoFrameCallback" | "timer" | "track-processor";
  callbackCount: number;
  timerPollCount: number;
  duplicateFrameSkipCount: number;
  watchdogFallbackCount: number;
  scheduleFailureCount: number;
  lastMetadata: {
    presentationTime: number | null;
    expectedDisplayTime: number | null;
    width: number | null;
    height: number | null;
    mediaTime: number | null;
    presentedFrames: number | null;
    processingDuration: number | null;
  } | null;
  lastFrameKey: string | null;
  lastProcessedFrameKey: string | null;
  lastDuplicateFrameKey: string | null;
  currentTime: number | null;
};
type OutputWriterMode = "worker" | "main-thread" | "canvas-capture";
type OutputWriterInputMode = "video-frame" | "bitmap";
type OutputWriterRenderer =
  | "direct-video-frame"
  | "offscreen-canvas"
  | "bitmap-video-frame";
type OutputWriterStats = {
  mode: OutputWriterMode;
  workerSupported: boolean;
  workerReady: boolean;
  workerHasVideoFrame: boolean | null;
  workerHasWritableStream: boolean | null;
  workerHasOffscreenCanvas: boolean | null;
  workerRenderer: OutputWriterRenderer | null;
  workerInputMode: OutputWriterInputMode | null;
  workerVideoFrameUnsupported: boolean;
  workerPendingFrameCount: number;
  workerPendingFrameLimit: number;
  workerOldestPendingFrameAgeMs: number | null;
  workerFramesSent: number;
  workerFramesWritten: number;
  workerFramesDropped: number;
  workerFrameMetadataCount: number;
  workerFirstFrameSeen: boolean;
  workerSkipCount: number;
  workerBackpressureSkipCount: number;
  workerCadenceSkipCount: number;
  workerUnavailableSkipCount: number;
  workerWriteFailures: number;
  workerPostFailures: number;
  latestSkipReason: string | null;
  latestWorkerWriteMs: number | null;
  latestWorkerBackpressureMs: number | null;
  latestWorkerRoundTripMs: number | null;
  latestWorkerFrameBuildMs: number | null;
  averageWorkerFrameBuildMs: number | null;
  maxWorkerFrameBuildMs: number | null;
  workerFrameBuildSampleCount: number;
  latestWorkerSequence: number;
  latestWorkerAckSequence: number;
  latestWorkerFrameMetadata: {
    sequence: number;
    width: number;
    height: number;
    timestamp: number | null;
    duration: number | null;
    renderer: OutputWriterRenderer;
    inputMode?: OutputWriterInputMode;
    writeMs: number;
    backpressureMs: number;
  } | null;
  fallbackReason: string | null;
  lastError: unknown;
};
type FaceProcessorMode = "worker" | "main-thread" | "legacy" | "none";
type ModelWorkerInputSource = "video-frame" | "image-bitmap";
type FaceProcessorStats = {
  mode: FaceProcessorMode;
  workerSupported: boolean;
  workerReady: boolean;
  workerDelegate: MediaPipeDelegate | null;
  workerPendingFrameCount: number;
  workerFramesSent: number;
  workerResults: number;
  workerStaleResults: number;
  workerFailures: number;
  workerFirstResultSeen: boolean;
  latestWorkerSequence: number;
  latestWorkerAckSequence: number;
  latestWorkerProcessingMs: number | null;
  latestWorkerRoundTripMs: number | null;
  latestWorkerResult: {
    sequence: number;
    processingConfigId: number;
    faceCount: number;
    landmarkCount: number;
    blendshapeCount: number;
    matrixCount: number;
    width: number;
    height: number;
    timestamp: number;
    delegate: MediaPipeDelegate;
    inputSource: ModelWorkerInputSource;
  } | null;
  fallbackReason: string | null;
  lastError: unknown;
};
type SegmentationProcessorMode = "worker" | "main-thread" | "legacy" | "none";
type SegmentationProcessorStats = {
  mode: SegmentationProcessorMode;
  workerSupported: boolean;
  workerReady: boolean;
  workerDelegate: MediaPipeDelegate | null;
  workerPendingFrameCount: number;
  workerFramesSent: number;
  workerResults: number;
  workerStaleResults: number;
  workerFailures: number;
  workerFirstResultSeen: boolean;
  latestWorkerSequence: number;
  latestWorkerAckSequence: number;
  latestWorkerProcessingMs: number | null;
  latestWorkerRoundTripMs: number | null;
  latestWorkerResult: {
    sequence: number;
    processingConfigId: number;
    width: number;
    height: number;
    timestamp: number;
    delegate: MediaPipeDelegate;
    inputSource: ModelWorkerInputSource;
    source: TemporalMaskSource;
    qualityScores: number[];
    confidenceMaskCount: number;
    hasCategoryMask: boolean;
  } | null;
  fallbackReason: string | null;
  lastError: unknown;
};
type VisualEffectTransitionReason =
  | "none"
  | "background"
  | "custom-background"
  | "filter"
  | "style"
  | "appearance"
  | "framing"
  | "mixed";
type VisualEffectTransitionSnapshot = {
  background: BackgroundEffectId;
  customBackground: boolean;
  customBackgroundId?: string | null;
  customBackgroundName?: string | null;
  filter: FaceFilterId;
  style: AppearanceStyleId;
  studioLighting: boolean;
  studioLook: boolean;
  framing: boolean;
  active: boolean;
};
type VisualEffectTransitionStats = {
  enabled: boolean;
  active: boolean;
  transitionMs: number;
  progress: number;
  easedProgress: number;
  previousOpacity: number;
  runCount: number;
  completedCount: number;
  skippedCount: number;
  reason: VisualEffectTransitionReason;
  lastReason: VisualEffectTransitionReason;
  startedAt: number;
  lastStartedAgeMs: number | null;
  lastCompletedAgeMs: number | null;
  timeLeftMs: number;
  from: VisualEffectTransitionSnapshot | null;
  to: VisualEffectTransitionSnapshot | null;
  lastSkippedReason: string | null;
  canvas: {
    width: number;
    height: number;
  } | null;
};
type EffectSwitchLatencyStats = {
  sequence: number;
  pending: boolean;
  reason: VisualEffectTransitionReason;
  sinceMs: number | null;
  firstDeliveredLatencyMs: number | null;
  firstVisibleLatencyMs: number | null;
};
type VisualEffectTransitionState = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  active: boolean;
  startedAt: number;
  lastStartedAt: number;
  lastCompletedAt: number;
  transitionMs: number;
  progress: number;
  easedProgress: number;
  runCount: number;
  completedCount: number;
  skippedCount: number;
  reason: VisualEffectTransitionReason;
  lastReason: VisualEffectTransitionReason;
  from: VisualEffectTransitionSnapshot | null;
  to: VisualEffectTransitionSnapshot | null;
  lastSkippedReason: string | null;
};
type FramePipelineStats = {
  processor: "main-thread" | "main-thread-worker-renderer";
  targetFps: number;
  processingConfigId: number;
  modelProcessingConfigId: number;
  schedulerMode: "timer" | "video-frame" | "track-processor";
  framePoller: VideoFramePollerStats;
  outputWriter: OutputWriterStats;
  segmentationProcessor: SegmentationProcessorStats;
  faceProcessor: FaceProcessorStats;
  outputMode: ProcessedOutput["mode"] | null;
  frameSequence: number;
  outputFrameSequence: number;
  outputFramesWritten: number;
  outputReady: boolean;
  outputTrackPublished: boolean;
  lastVisibleOutputFrameAgeMs: number | null;
  lastVisibleOutputRecoveryCount: number;
  latestLastVisibleOutputRecoveryReason: string | null;
  firstSourceFrameAgeMs: number | null;
  firstOutputFrameAgeMs: number | null;
  firstVisibleOutputFrameAgeMs: number | null;
  firstPublishedTrackAgeMs: number | null;
  sourceFrame: SourceFrameStats;
  lastFrame: {
    id: number;
    processingConfigId: number;
    source: FrameSource["source"] | "raw" | "none";
    width: number;
    height: number;
    outputWidth: number;
    outputHeight: number;
    outputScale: number;
    sourceVisible: boolean;
    outputVisible: boolean;
    outputDelivered: boolean;
    renderLatencyMs: number;
    segmentationMaskAgeMs: number | null;
    faceLandmarksAgeMs: number | null;
    firstFrame: boolean;
  } | null;
};
type SourceFrameStats = {
  selection: FrameSource["source"] | "none";
  fallbackReason: "dark-video" | "missing-video" | "none";
  blackSourceVideoFrameCount: number;
  fallbackCount: number;
  latestVideoProbe: CanvasVisibilityProbe | null;
  trackProcessor: {
    started: boolean;
    unavailable: boolean;
    frameCount: number;
    restartCount: number;
    latestFrameAgeMs: number | null;
  };
};
type CanvasBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
type FacePoseCandidate = {
  basis: "row-major" | "column-major";
  roll: number;
  yaw: number;
  pitch: number;
  scale: number;
};
type FacePoseTransform = {
  rows: number;
  columns: number;
  candidates: FacePoseCandidate[];
};
type ClosableMediaPipeResource = {
  close?: () => void;
};
type FaceFilterRenderStats = {
  filter: FaceFilterId;
  effectGraph: FaceFilterEffectGraphStats | null;
  drawn: boolean;
  reason?: string;
  landmarkCount: number;
  changedPixels: number;
  changedPixelRatio: number;
  samplePixelCount: number;
  anchor: {
    centerX: number;
    centerY: number;
    faceAngle: number;
    faceWidth: number;
    faceHeight?: number;
    headTopY?: number;
    headCenterX?: number;
    chinY?: number;
    noseY?: number;
    mouthCenterX?: number;
    mouthCenterY?: number;
    mouthWidth?: number;
    eyeAnchorBasis?: "iris" | "contour";
    eyeCenterDistance?: number;
    outerEyeDistance?: number;
    poseBasis?: FacePoseCandidate["basis"];
    poseRoll?: number;
    poseYaw?: number;
    poseBlend?: number;
  } | null;
  bounds: CanvasBounds | null;
};
type FaceFilterEffectGraphStats = {
  meetGraphId: string;
  meetEffectIdNumber?: number;
  renderMode: FaceFilterEffectGraph["renderMode"];
  assetProfile: FaceFilterEffectGraph["assetProfile"];
  dependencies: FaceFilterEffectGraph["dependencies"];
  requiresFaceLandmarks: boolean;
  requiresSegmentation: boolean;
  requiresMeetVideoPipe?: boolean;
  bundleAssets?: FaceFilterEffectGraph["bundleAssets"];
  thumbnailAsset?: string;
  modelIntervalMs: number;
  liveBundleVersion: FaceFilterEffectGraph["liveBundleVersion"];
};
type BackgroundRenderStats = {
  background: BackgroundEffectId;
  active: boolean;
  reason?: string;
  changedPixels: number;
  changedPixelRatio: number;
  samplePixelCount: number;
  sampleRegions: CanvasBounds[];
  hasSegmentationMask: boolean;
  hasBackgroundImage: boolean;
};
type ProceduralBackgroundLayerCache = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  key: string;
};
type LowLightRenderStats = {
  enabled: boolean;
  foregroundBrightness: number;
  backgroundBrightness: number;
  brighteningStrength: number;
  targetBrighteningStrength: number;
  transitionProgress: number;
  transitionActive: boolean;
  transitionMs: number;
  sourceAverageLuma: number;
  sourcePeakLuma: number;
  foregroundAverageLuma: number;
  backgroundAverageLuma: number;
  hasSegmentationMask: boolean;
  foregroundSampleWeight: number;
  backgroundSampleWeight: number;
  maskAverageConfidence: number;
  maskMinConfidence: number;
  maskMaxConfidence: number;
  maskSampleMode: string;
  samplePixelCount: number;
  sampleReason: string;
};
type LowLightSourceStats = {
  foregroundAverageLuma: number;
  backgroundAverageLuma: number;
  hasSegmentationMask: boolean;
  foregroundSampleWeight: number;
  backgroundSampleWeight: number;
  maskAverageConfidence: number;
  maskMinConfidence: number;
  maskMaxConfidence: number;
  maskSampleMode: string;
  samplePixelCount: number;
  sampleReason: string;
};
type FrameRenderStats = {
  faceFilter: FaceFilterRenderStats;
  background: BackgroundRenderStats;
  lowLight: LowLightRenderStats;
};
type LowLightTransitionState = {
  renderedStrength: number;
  startStrength: number;
  targetStrength: number;
  startedAt: number;
  lastUpdatedAt: number;
  targetEnabled: boolean;
};
type SmoothedMetric = {
  value: number;
  initialValue: number;
  alpha: number;
  initialized: boolean;
};
type FaceLandmarkSmoothingStats = {
  alpha: number;
  motionScore: number;
  centerDrift: number;
  sizeDrift: number;
  reset: boolean;
  reason:
    | "adaptive"
    | "first-result"
    | "large-jump"
    | "landmark-count-change"
    | "missing-result";
  previousCount: number;
  nextCount: number;
};
type FaceLandmarkSmoothingResult = {
  landmarks: NormalizedLandmarkList | null;
  stats: FaceLandmarkSmoothingStats;
};
type VideoEffectsAdaptationState = {
  adaptiveEffect: boolean;
  availableTiers: VideoEffectsAdaptationTier[];
  tierIndex: number;
  policyTierIndex: number;
  policyReason: string | null;
  processingDelayMs: SmoothedMetric;
  fullProcessingDelayMs: SmoothedMetric;
  asyncProcessingDelayMs: SmoothedMetric;
  runtimePressureMs: SmoothedMetric;
  frameIntervalMs: SmoothedMetric;
  lastProcessingDelayMs: number;
  lastFullProcessingDelayMs: number;
  lastAsyncProcessingDelayMs: number;
  lastRuntimePressureMs: number;
  lastRuntimePressureReason: string | null;
  lastFrameIntervalMs: number;
  downshiftCount: number;
  upshiftCount: number;
  slowFrameCount: number;
  consecutiveSlowFrameCount: number;
  lastTransitionAt: number;
  lastTransitionReason: string;
  recoveryCooldownUntilByTier: Record<VideoEffectsAdaptationTier, number>;
  recoveryCooldownStageByTier: Record<VideoEffectsAdaptationTier, number>;
};
type ImageCaptureWithGrabFrame = {
  grabFrame: () => Promise<ImageBitmap>;
};
type ImageCaptureConstructor = new (
  track: MediaStreamTrack,
) => ImageCaptureWithGrabFrame;
type VideoFrameLike = CanvasImageSource & {
  displayWidth?: number;
  displayHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
  timestamp?: number | null;
  close?: () => void;
};
type GeneratedVideoFrame = VideoFrameLike;
type VideoFrameConstructor = new (
  source: CanvasImageSource,
  init?: { duration?: number; timestamp?: number },
) => GeneratedVideoFrame;
type MediaStreamTrackProcessorConstructor = new (init: {
  track: MediaStreamTrack;
}) => {
  readable: ReadableStream<VideoFrameLike>;
};
type MediaStreamTrackGeneratorInstance = MediaStreamTrack & {
  writable: WritableStream<GeneratedVideoFrame>;
};
type MediaStreamTrackGeneratorConstructor = new (init: {
  kind: "video";
}) => MediaStreamTrackGeneratorInstance;
type CanvasCaptureMediaStreamTrack = MediaStreamTrack & {
  requestFrame?: () => void;
};
type ProcessedOutput = {
  mode: "track-generator" | "canvas-capture";
  writerMode: OutputWriterMode;
  stream: MediaStream;
  track: MediaStreamTrack;
};
type FinalProcessedTrackOwner = "none" | "local" | "meet-videopipe";
type OutputWriterWorkerReadyMessage = {
  type: "READY";
  hasVideoFrame: boolean;
  hasWritableStream: boolean;
  hasOffscreenCanvas: boolean;
  renderer: OutputWriterRenderer;
};
type OutputWriterWorkerWrittenMessage = {
  type: "WRITTEN";
  sequence: number;
  writeMs: number;
  backpressureMs: number;
  renderer?: OutputWriterRenderer;
  inputMode?: OutputWriterInputMode;
};
type OutputWriterWorkerDroppedMessage = {
  type: "DROPPED";
  sequence: number;
  reason: "superseded" | "closing";
};
type OutputWriterWorkerCompletionMessage =
  | OutputWriterWorkerWrittenMessage
  | OutputWriterWorkerDroppedMessage;
type OutputWriterWorkerFirstFrameMessage = {
  type: "FIRST_FRAME";
  sequence: number;
  renderer: OutputWriterRenderer;
  inputMode?: OutputWriterInputMode;
};
type OutputWriterWorkerFrameMetadataMessage = {
  type: "FRAME_METADATA";
  sequence: number;
  width: number;
  height: number;
  timestamp: number | null;
  duration: number | null;
  renderer: OutputWriterRenderer;
  inputMode?: OutputWriterInputMode;
  writeMs: number;
  backpressureMs: number;
};
type OutputWriterWorkerErrorMessage = {
  type: "ERROR";
  sequence?: number;
  error: unknown;
};
type OutputWriterWorkerMessage =
  | OutputWriterWorkerReadyMessage
  | OutputWriterWorkerWrittenMessage
  | OutputWriterWorkerDroppedMessage
  | OutputWriterWorkerFirstFrameMessage
  | OutputWriterWorkerFrameMetadataMessage
  | OutputWriterWorkerErrorMessage
  | { type: "CLOSED" };
type OutputWriterPendingFrame = {
  resolve: (message: OutputWriterWorkerCompletionMessage) => void;
  reject: (err: unknown) => void;
  completion: Promise<OutputWriterWorkerCompletionMessage>;
  timeoutId: number;
  sentAt: number;
};
type FaceProcessorWorkerReadyMessage = {
  type: "READY";
  delegate: MediaPipeDelegate;
};
type FaceProcessorWorkerResultMessage = {
  type: "FACE_RESULT";
  sequence: number;
  processingConfigId: number;
  landmarks: NormalizedLandmarkList | null;
  faceCount: number;
  blendshapeCount: number;
  matrixCount: number;
  pose: FacePoseTransform | null;
  width: number;
  height: number;
  timestamp: number;
  delegate: MediaPipeDelegate;
  inputSource: ModelWorkerInputSource;
  processingMs: number;
};
type FaceProcessorWorkerErrorMessage = {
  type: "ERROR";
  sequence?: number;
  error: unknown;
};
type FaceProcessorWorkerMessage =
  | FaceProcessorWorkerReadyMessage
  | FaceProcessorWorkerResultMessage
  | FaceProcessorWorkerErrorMessage
  | { type: "CLOSED" };
type FaceProcessorPendingFrame = {
  resolve: (message: FaceProcessorWorkerResultMessage) => void;
  reject: (err: unknown) => void;
  timeoutId: number;
  sentAt: number;
  processingConfigId: number;
};
type SegmentationProcessorWorkerReadyMessage = {
  type: "READY";
  delegate: MediaPipeDelegate;
};
type SegmentationProcessorWorkerResultMessage = {
  type: "SEGMENTATION_RESULT";
  sequence: number;
  processingConfigId: number;
  width: number;
  height: number;
  timestamp: number;
  delegate: MediaPipeDelegate;
  inputSource: ModelWorkerInputSource;
  processingMs: number;
  confidence?: Float32Array;
  category?: Uint8Array;
  qualityScores: number[];
  confidenceMaskCount: number;
  hasCategoryMask: boolean;
};
type SegmentationProcessorWorkerErrorMessage = {
  type: "ERROR";
  sequence?: number;
  error: unknown;
};
type SegmentationProcessorWorkerMessage =
  | SegmentationProcessorWorkerReadyMessage
  | SegmentationProcessorWorkerResultMessage
  | SegmentationProcessorWorkerErrorMessage
  | { type: "CLOSED" };
type SegmentationProcessorPendingFrame = {
  resolve: (message: SegmentationProcessorWorkerResultMessage) => void;
  reject: (err: unknown) => void;
  timeoutId: number;
  sentAt: number;
  processingConfigId: number;
};
type SegmentationMaskPixels = {
  width: number;
  height: number;
  confidence?: Float32Array | null;
  category?: Uint8Array | null;
  qualityScores?: number[] | null;
  confidenceMaskCount?: number;
  hasCategoryMask?: boolean;
  processor: "worker" | "main-thread";
};
type ModelWorkerFrameSource = {
  source: VideoFrameLike | ImageBitmap;
  kind: ModelWorkerInputSource;
  transfer: Transferable;
  width: number;
  height: number;
  scale: number;
};
type FrameSource = {
  image: HTMLVideoElement | HTMLCanvasElement;
  width: number;
  height: number;
  source: "video" | "image-capture" | "track-processor";
};

interface UseVideoEffectsOptions {
  sourceStream: MediaStream | null;
  effects: VideoEffectsState;
  processedVideoTrackRef: React.MutableRefObject<MediaStreamTrack | null>;
  framingRecenterToken?: number;
}

interface UseVideoEffectsResult {
  effectiveStream: MediaStream | null;
  processedTrackVersion: number;
  processedTrackReady: boolean;
  status: VideoEffectsRuntimeStatus;
  error: string | null;
  debugStats: VideoEffectsDebugStats | null;
}

type ProcessorPrewarmKind = "segmentation" | "face";
type PrewarmedProcessorWorker = {
  worker: Worker;
  delegate: MediaPipeDelegate;
  warmupRan: boolean;
  storedAt: number;
  instanceId: number;
  idleTimerId: number | null;
};
type PrewarmedOutputWriterWorker = {
  worker: Worker;
  track: MediaStreamTrackGeneratorInstance;
  hasVideoFrame: boolean;
  hasWritableStream: boolean;
  hasOffscreenCanvas: boolean;
  renderer: OutputWriterRenderer;
  storedAt: number;
  instanceId: number;
  idleTimerId: number | null;
};

let videoEffectsInstanceCounter = 0;
let sharedTasksVisionModule: TasksVisionModule | null = null;
let sharedTasksVisionModulePromise: Promise<TasksVisionModule> | null = null;
let sharedTasksVisionFileset: TasksVisionFileset | null = null;
let sharedTasksVisionFilesetPromise: Promise<TasksVisionFileset> | null = null;
let segmentationModelPrewarmPromise: Promise<void> | null = null;
let faceModelPrewarmPromise: Promise<void> | null = null;
let outputWriterWorkerPrewarmPromise: Promise<void> | null = null;
let segmentationProcessorWorkerPrewarmPromise: Promise<void> | null = null;
let faceProcessorWorkerPrewarmPromise: Promise<void> | null = null;
let videoEffectsRuntimePrewarmPromise: Promise<void> | null = null;
let videoEffectsRuntimePrewarmDone = false;
let prewarmedOutputWriterWorker: PrewarmedOutputWriterWorker | null = null;
let prewarmedSegmentationProcessorWorker: PrewarmedProcessorWorker | null = null;
let prewarmedFaceProcessorWorker: PrewarmedProcessorWorker | null = null;
let activeVideoEffectsPipelineCount = 0;
let activeVideoEffectsPipelineBusyUntil = 0;
let lowLightSourceSampleCanvas: HTMLCanvasElement | null = null;
let lowLightMaskSampleCanvas: HTMLCanvasElement | null = null;
let lowLightSourceSampleCtx: CanvasRenderingContext2D | null = null;
let lowLightMaskSampleCtx: CanvasRenderingContext2D | null = null;
let autoFrameMaskSampleCanvas: HTMLCanvasElement | null = null;
let autoFrameMaskSampleCtx: CanvasRenderingContext2D | null = null;
const backgroundImageCache = new Map<
  string,
  {
    image: HTMLImageElement | null;
    promise: Promise<HTMLImageElement | null> | null;
  }
>();
const backgroundPrewarmQueuePromises = new Map<string, Promise<void>>();
const videoEffectsAssetPrewarmPromises = new Map<string, Promise<void>>();

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const smoothStep = (value: number) => value * value * (3 - 2 * value);

const shapeSegmentationConfidence = (confidence: number) => {
  const normalized = clamp(
    (confidence - MASK_CONFIDENCE_FLOOR) /
      (MASK_CONFIDENCE_CEILING - MASK_CONFIDENCE_FLOOR),
    0,
    1,
  );
  return Math.pow(smoothStep(normalized), MASK_CONFIDENCE_GAMMA);
};

const getEvenDimension = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

const lerp = (from: number, to: number, alpha: number) =>
  from + (to - from) * alpha;

const normalizeAngleDelta = (angle: number) =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

const lerpAngle = (from: number, to: number, alpha: number) =>
  from + normalizeAngleDelta(to - from) * alpha;

const roundPoseNumber = (value: number) => Number(value.toFixed(4));

const getMatrixValue = (data: number[], columns: number, row: number, col: number) =>
  data[row * columns + col] ?? 0;

const createFacePoseCandidate = (
  basis: FacePoseCandidate["basis"],
  xAxis: { x: number; y: number; z: number },
  yAxis: { x: number; y: number; z: number },
): FacePoseCandidate | null => {
  const xScale = Math.hypot(xAxis.x, xAxis.y, xAxis.z);
  const yScale = Math.hypot(yAxis.x, yAxis.y, yAxis.z);
  const scale = (xScale + yScale) / 2;
  if (!Number.isFinite(scale) || scale <= 0.0001) return null;

  return {
    basis,
    roll: roundPoseNumber(Math.atan2(xAxis.y, xAxis.x)),
    yaw: roundPoseNumber(Math.asin(clamp(-xAxis.z / xScale, -1, 1))),
    pitch: roundPoseNumber(Math.asin(clamp(yAxis.z / yScale, -1, 1))),
    scale: roundPoseNumber(scale),
  };
};

const extractFacePoseTransform = (
  matrix: TasksMatrix | null | undefined,
): FacePoseTransform | null => {
  if (!matrix || matrix.rows < 3 || matrix.columns < 3) return null;
  const data = Array.isArray(matrix.data) ? matrix.data : [];
  if (data.length < matrix.rows * matrix.columns) return null;

  const rowMajor = createFacePoseCandidate(
    "row-major",
    {
      x: getMatrixValue(data, matrix.columns, 0, 0),
      y: getMatrixValue(data, matrix.columns, 0, 1),
      z: getMatrixValue(data, matrix.columns, 0, 2),
    },
    {
      x: getMatrixValue(data, matrix.columns, 1, 0),
      y: getMatrixValue(data, matrix.columns, 1, 1),
      z: getMatrixValue(data, matrix.columns, 1, 2),
    },
  );
  const columnMajor = createFacePoseCandidate(
    "column-major",
    {
      x: getMatrixValue(data, matrix.columns, 0, 0),
      y: getMatrixValue(data, matrix.columns, 1, 0),
      z: getMatrixValue(data, matrix.columns, 2, 0),
    },
    {
      x: getMatrixValue(data, matrix.columns, 0, 1),
      y: getMatrixValue(data, matrix.columns, 1, 1),
      z: getMatrixValue(data, matrix.columns, 2, 1),
    },
  );
  const candidates = [rowMajor, columnMajor].filter(
    (candidate): candidate is FacePoseCandidate => Boolean(candidate),
  );
  if (candidates.length <= 0) return null;

  return {
    rows: matrix.rows,
    columns: matrix.columns,
    candidates,
  };
};

const smoothFacePoseTransform = (
  previous: FacePoseTransform | null,
  next: FacePoseTransform | null,
  alpha: number,
): FacePoseTransform | null => {
  if (!next?.candidates.length) return null;
  if (!previous?.candidates.length) return next;

  return {
    ...next,
    candidates: next.candidates.map((candidate) => {
      const previousCandidate = previous.candidates.find(
        (item) => item.basis === candidate.basis,
      );
      if (!previousCandidate) return candidate;
      return {
        ...candidate,
        roll: roundPoseNumber(
          lerpAngle(previousCandidate.roll, candidate.roll, alpha),
        ),
        yaw: roundPoseNumber(lerp(previousCandidate.yaw, candidate.yaw, alpha)),
        pitch: roundPoseNumber(
          lerp(previousCandidate.pitch, candidate.pitch, alpha),
        ),
        scale: roundPoseNumber(
          lerp(previousCandidate.scale, candidate.scale, alpha),
        ),
      };
    }),
  };
};

const VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG: Record<
  VideoEffectsAdaptationTier,
  {
    modelIntervalScale: number;
    modelInputScale: number;
    outputScale: number;
    label: string;
  }
> = {
  1400: {
    modelIntervalScale: 1,
    modelInputScale: 1,
    outputScale: 1,
    label: "high",
  },
  1200: {
    modelIntervalScale: 1.15,
    modelInputScale: 0.9,
    outputScale: 1,
    label: "balanced",
  },
  1100: {
    modelIntervalScale: 1.35,
    modelInputScale: 0.8,
    outputScale: 1,
    label: "conservative",
  },
  1000: {
    modelIntervalScale: 1.6,
    modelInputScale: 0.7,
    outputScale: 1,
    label: "lite",
  },
};

const getVideoEffectsComplexityScore = (effects: VideoEffectsState) => {
  let score = 0;
  if (
    effects.background !== "none" &&
    effects.background !== "gradient"
  ) {
    const imageBackedBackground = Boolean(
      BACKGROUND_ASSET_PATHS[
        effects.background as keyof typeof BACKGROUND_ASSET_PATHS
      ],
    );
    if (effects.background === "custom") {
      score += 4;
    } else if (
      isAnimatedBackgroundEffect(effects.background) ||
      imageBackedBackground
    ) {
      score += 2;
    } else {
      score += 3;
    }
  }
  if (effects.filter !== "none") score += 2;
  if (effects.style !== "none") score += 1;
  if (effects.studioLighting) score += 1;
  if (effects.studioLook) score += 2;
  if (effects.framing) score += 0.5;
  return score;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readFiniteNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const readString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const readRoomTilingPolicyContext = (
  value: unknown,
): VideoEffectsRoomTilingPolicyContext | null => {
  if (!isPlainRecord(value)) return null;
  const counts = isPlainRecord(value.counts) ? value.counts : {};
  const layout = isPlainRecord(value.layout) ? value.layout : {};
  const selfView = isPlainRecord(value.selfView) ? value.selfView : {};
  const primaryIds = Array.isArray(value.primaryIds) ? value.primaryIds : [];
  const totalGridCount = readFiniteNumber(counts.totalGrid);
  const visibleCount = readFiniteNumber(counts.visible);
  const stageRailCount = readFiniteNumber(counts.stageRail);
  const maxTiles = readFiniteNumber(counts.maxTiles);
  const tileWidth = readFiniteNumber(layout.tileWidth);
  const tileHeight = readFiniteNumber(layout.tileHeight);
  if (
    totalGridCount <= 0 &&
    visibleCount <= 0 &&
    stageRailCount <= 0 &&
    tileWidth <= 0 &&
    tileHeight <= 0
  ) {
    return null;
  }

  return {
    sequence: readFiniteNumber(value.sequence),
    renderedMode: readString(value.renderedMode),
    presenting: value.presenting === true,
    dynamicCrop: value.dynamicCrop === true,
    totalGridCount,
    visibleCount,
    hiddenCount: readFiniteNumber(counts.hidden),
    stageRailCount,
    fallbackLevel: readFiniteNumber(value.fallbackLevel),
    maxTiles,
    tileWidth,
    tileHeight,
    selfViewPlacement: readString(selfView.placement),
    localIsPrimary: primaryIds.includes("local"),
    receivedAt: performance.now(),
  };
};

const readElementNumberAttribute = (
  element: Element,
  name: string,
  fallback = 0,
) => {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
};

const readElementStringAttribute = (
  element: Element,
  name: string,
  fallback = "",
) => element.getAttribute(name) ?? fallback;

const readElementBooleanAttribute = (element: Element, name: string) =>
  element.getAttribute(name) === "true";

const readCsvAttribute = (element: Element, name: string) =>
  readElementStringAttribute(element, name)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const normalizeRoomTilingMode = (value: string) =>
  value === "stage-rail" ? "stageRail" : value;

const readRoomTilingPolicyContextFromDom =
  (): VideoEffectsRoomTilingPolicyContext | null => {
    const mobileRoot = document.querySelector(
      "[data-mobile-room-tiling-source='client']",
    );
    if (mobileRoot) {
      const totalGridCount = readElementNumberAttribute(
        mobileRoot,
        "data-mobile-total-people",
        1,
      );
      const hiddenCount = readElementNumberAttribute(
        mobileRoot,
        "data-mobile-hidden-count",
      );
      const visibleCount = readElementNumberAttribute(
        mobileRoot,
        "data-mobile-visible-count",
        Math.max(1, totalGridCount - hiddenCount),
      );
      const stageRailCount = readElementNumberAttribute(
        mobileRoot,
        "data-mobile-rail-count",
      );
      const [mobileTileWidth = 0, mobileTileHeight = 0] =
        readElementStringAttribute(
          mobileRoot,
          "data-mobile-grid-tile-size",
          "0x0",
        )
          .split("x")
          .map((value) => Number(value));
      const localTileRect = document
        .querySelector("[data-mobile-grid-tile='local']")
        ?.getBoundingClientRect();
      const mainRect = document
        .querySelector(".mobile-stage-main")
        ?.getBoundingClientRect();
      const railRect = document
        .querySelector(".mobile-stage-rail")
        ?.getBoundingClientRect();
      const rootRect = mobileRoot.getBoundingClientRect();
      const localIsPrimary =
        readElementStringAttribute(mobileRoot, "data-mobile-primary") ===
        "local";
      const tileRect = localIsPrimary ? mainRect : railRect ?? mainRect;

      return {
        sequence: 0,
        renderedMode: normalizeRoomTilingMode(
          readElementStringAttribute(
            mobileRoot,
            "data-mobile-meet-layout",
            "solo",
          ),
        ),
        presenting: false,
        dynamicCrop: false,
        totalGridCount,
        visibleCount,
        hiddenCount,
        stageRailCount,
        fallbackLevel: hiddenCount > 0 ? 1 : 0,
        maxTiles: readElementNumberAttribute(
          mobileRoot,
          "data-mobile-max-tiles",
          stageRailCount + 1,
        ),
        tileWidth: Math.round(
          mobileTileWidth ||
            localTileRect?.width ||
            tileRect?.width ||
            rootRect.width,
        ),
        tileHeight: Math.round(
          mobileTileHeight ||
            localTileRect?.height ||
            tileRect?.height ||
            rootRect.height,
        ),
        selfViewPlacement: "tile",
        localIsPrimary,
        receivedAt: performance.now(),
      };
    }

    const desktopRoot = document.querySelector(
      "[data-meet-room-tiling-source='client']",
    );
    if (!desktopRoot) return null;

    const visibleCount = readElementNumberAttribute(
      desktopRoot,
      "data-meet-view-visible-count",
    );
    const stageRailCount = readElementNumberAttribute(
      desktopRoot,
      "data-meet-view-stage-rail-count",
    );
    const totalGridCount = readElementNumberAttribute(
      desktopRoot,
      "data-meet-view-grid-count",
      Math.max(1, visibleCount + stageRailCount),
    );
    const rootRect = desktopRoot.getBoundingClientRect();
    const estimatedCols =
      visibleCount > 1 ? Math.ceil(Math.sqrt(visibleCount)) : 1;
    const estimatedRows = Math.max(1, Math.ceil(visibleCount / estimatedCols));
    const primaryIds = readCsvAttribute(
      desktopRoot,
      "data-meet-room-tiling-primary-ids",
    );

    return {
      sequence: 0,
      renderedMode: normalizeRoomTilingMode(
        readElementStringAttribute(
          desktopRoot,
          "data-meet-view-effective",
          readElementStringAttribute(desktopRoot, "data-meet-view-layout"),
        ),
      ),
      presenting: readElementBooleanAttribute(
        desktopRoot,
        "data-meet-view-presenting",
      ),
      dynamicCrop: readElementBooleanAttribute(
        desktopRoot,
        "data-meet-view-dynamic-crop",
      ),
      totalGridCount,
      visibleCount,
      hiddenCount: readElementNumberAttribute(
        desktopRoot,
        "data-meet-view-hidden-count",
      ),
      stageRailCount,
      fallbackLevel: readElementNumberAttribute(
        desktopRoot,
        "data-meet-room-tiling-fallback-level",
      ),
      maxTiles: readElementNumberAttribute(
        desktopRoot,
        "data-meet-view-max-tiles",
        visibleCount,
      ),
      tileWidth: Math.round(rootRect.width / estimatedCols),
      tileHeight: Math.round(rootRect.height / estimatedRows),
      selfViewPlacement: readElementStringAttribute(
        desktopRoot,
        "data-meet-view-self-view-placement",
      ),
      localIsPrimary: primaryIds.includes("local"),
      receivedAt: performance.now(),
    };
  };

const getRoomTilingPolicyTier = (
  effects: VideoEffectsState,
  roomTiling: VideoEffectsRoomTilingPolicyContext | null,
): { tier: VideoEffectsAdaptationTier; reason: string } | null => {
  const score = getVideoEffectsComplexityScore(effects);
  if (!roomTiling || score <= 0) return null;
  const tilePixels =
    roomTiling.tileWidth > 0 && roomTiling.tileHeight > 0
      ? roomTiling.tileWidth * roomTiling.tileHeight
      : 0;
  const smallTile =
    tilePixels > 0 &&
    (roomTiling.tileWidth <= 360 ||
      roomTiling.tileHeight <= 210 ||
      tilePixels <= 130_000);
  const mediumTile =
    tilePixels > 0 &&
    (roomTiling.tileWidth <= 640 ||
      roomTiling.tileHeight <= 360 ||
      tilePixels <= 260_000);
  const visiblePressure =
    roomTiling.totalGridCount >= 6 ||
    roomTiling.visibleCount >= 5 ||
    roomTiling.hiddenCount > 0 ||
    roomTiling.stageRailCount >= 4;
  const moderatePressure =
    roomTiling.totalGridCount >= 4 ||
    roomTiling.visibleCount >= 4 ||
    roomTiling.stageRailCount >= 3 ||
    roomTiling.maxTiles >= 9;
  const heavyStackGridPressure = score >= 6 && moderatePressure;
  const auxiliarySelfView =
    roomTiling.selfViewPlacement === "floating" ||
    roomTiling.selfViewPlacement === "minimized" ||
    (roomTiling.presenting && !roomTiling.localIsPrimary);

  if (visiblePressure || smallTile || heavyStackGridPressure || auxiliarySelfView) {
    return {
      tier: 1000,
      reason: visiblePressure
        ? "room-tiling-visible-pressure"
        : smallTile
          ? "room-tiling-small-local-tile"
          : heavyStackGridPressure
            ? "room-tiling-heavy-stack-grid-pressure"
            : "room-tiling-auxiliary-self-view",
    };
  }
  if (moderatePressure || mediumTile) {
    return {
      tier: 1100,
      reason: moderatePressure
        ? "room-tiling-moderate-pressure"
        : "room-tiling-medium-local-tile",
    };
  }
  return null;
};

const applyRoomTilingAdaptationPolicy = (
  policy: VideoEffectsAdaptationPolicy,
  effects: VideoEffectsState,
  roomTiling: VideoEffectsRoomTilingPolicyContext | null,
): VideoEffectsAdaptationPolicy => {
  const roomPolicy = getRoomTilingPolicyTier(effects, roomTiling);
  if (!roomPolicy) return policy;
  if (!policy.tier) {
    return {
      ...policy,
      tier: roomPolicy.tier,
      reason: roomPolicy.reason,
    };
  }
  const currentIndex = VIDEO_EFFECTS_ADAPTATION_TIERS.indexOf(policy.tier);
  const roomIndex = VIDEO_EFFECTS_ADAPTATION_TIERS.indexOf(roomPolicy.tier);
  if (roomIndex < currentIndex) return policy;
  if (roomIndex === currentIndex) {
    return {
      ...policy,
      reason: policy.reason.includes(roomPolicy.reason)
        ? policy.reason
        : `${policy.reason}+${roomPolicy.reason}`,
    };
  }
  return {
    ...policy,
    tier: roomPolicy.tier,
    reason: `${policy.reason}+${roomPolicy.reason}`,
  };
};

const getVideoEffectsAdaptationPolicy = (
  effects: VideoEffectsState,
  sourceWidth: number,
  sourceHeight: number,
  roomTiling: VideoEffectsRoomTilingPolicyContext | null = null,
): VideoEffectsAdaptationPolicy => {
  const score = getVideoEffectsComplexityScore(effects);
  const sourcePixels = Math.max(1, sourceWidth * sourceHeight);
  if (score <= 0) {
    return { tier: null, reason: null, score, sourcePixels };
  }

  const applyRoomPolicy = (policy: VideoEffectsAdaptationPolicy) =>
    applyRoomTilingAdaptationPolicy(policy, effects, roomTiling);

  if (sourcePixels >= VIDEO_EFFECTS_POLICY_FULL_HD_PIXELS) {
    if (score >= 6) {
      return applyRoomPolicy({
        tier: 1000,
        reason: "full-hd-heavy-effect-stack",
        score,
        sourcePixels,
      });
    }
    if (score >= 3) {
      return applyRoomPolicy({
        tier: 1100,
        reason: "full-hd-multi-effect-stack",
        score,
        sourcePixels,
      });
    }
    return applyRoomPolicy({
      tier: 1200,
      reason: "full-hd-effect",
      score,
      sourcePixels,
    });
  }

  if (sourcePixels >= VIDEO_EFFECTS_POLICY_HD_PIXELS) {
    if (score >= 6) {
      return applyRoomPolicy({
        tier: 1100,
        reason: "hd-heavy-effect-stack",
        score,
        sourcePixels,
      });
    }
    if (score >= 3) {
      return applyRoomPolicy({
        tier: 1200,
        reason: "hd-multi-effect-stack",
        score,
        sourcePixels,
      });
    }
  }

  return applyRoomPolicy({ tier: null, reason: null, score, sourcePixels });
};

const createSmoothedMetric = (
  initialValue: number,
  alpha: number,
): SmoothedMetric => ({
  value: initialValue,
  initialValue,
  alpha,
  initialized: false,
});

const resetSmoothedMetric = (metric: SmoothedMetric) => {
  metric.value = metric.initialValue;
  metric.initialized = false;
};

const updateSmoothedMetric = (metric: SmoothedMetric, sample: number) => {
  if (!Number.isFinite(sample)) return metric.value;
  if (!metric.initialized) {
    metric.value = sample;
    metric.initialized = true;
    return metric.value;
  }
  metric.value = metric.value * metric.alpha + sample * (1 - metric.alpha);
  return metric.value;
};

const createAdaptationCooldownRecord = (): Record<
  VideoEffectsAdaptationTier,
  number
> => ({
  1400: 0,
  1200: 0,
  1100: 0,
  1000: 0,
});

const getAvailableAdaptationTiers = (adaptiveEffect: boolean) =>
  adaptiveEffect
    ? [...VIDEO_EFFECTS_ADAPTATION_TIERS]
    : VIDEO_EFFECTS_ADAPTATION_TIERS.filter((tier) => tier !== 1000);

const createVideoEffectsAdaptationState =
  (): VideoEffectsAdaptationState => ({
    adaptiveEffect: false,
    availableTiers: getAvailableAdaptationTiers(false),
    tierIndex: 0,
    policyTierIndex: 0,
    policyReason: null,
    processingDelayMs: createSmoothedMetric(
      24,
      VIDEO_EFFECTS_PROCESSING_ALPHA,
    ),
    fullProcessingDelayMs: createSmoothedMetric(
      160,
      VIDEO_EFFECTS_FULL_ALPHA,
    ),
    asyncProcessingDelayMs: createSmoothedMetric(
      24,
      VIDEO_EFFECTS_PROCESSING_ALPHA,
    ),
    runtimePressureMs: createSmoothedMetric(
      0,
      VIDEO_EFFECTS_RUNTIME_PRESSURE_ALPHA,
    ),
    frameIntervalMs: createSmoothedMetric(
      1000 / TARGET_FPS,
      VIDEO_EFFECTS_FRAME_INTERVAL_ALPHA,
    ),
    lastProcessingDelayMs: 0,
    lastFullProcessingDelayMs: 0,
    lastAsyncProcessingDelayMs: 0,
    lastRuntimePressureMs: 0,
    lastRuntimePressureReason: null,
    lastFrameIntervalMs: 0,
    downshiftCount: 0,
    upshiftCount: 0,
    slowFrameCount: 0,
    consecutiveSlowFrameCount: 0,
    lastTransitionAt: 0,
    lastTransitionReason: "initial",
    recoveryCooldownUntilByTier: createAdaptationCooldownRecord(),
    recoveryCooldownStageByTier: createAdaptationCooldownRecord(),
  });

const getAdaptationTierIndex = (
  state: VideoEffectsAdaptationState,
  tier: VideoEffectsAdaptationTier,
) => {
  const exactIndex = state.availableTiers.indexOf(tier);
  if (exactIndex >= 0) return exactIndex;
  return state.availableTiers.length - 1;
};

const getEffectiveAdaptationTierIndex = (
  state: VideoEffectsAdaptationState,
) =>
  clamp(
    Math.max(state.tierIndex, state.policyTierIndex),
    0,
    Math.max(0, state.availableTiers.length - 1),
  );

const getCurrentAdaptationTier = (state: VideoEffectsAdaptationState) =>
  state.availableTiers[getEffectiveAdaptationTierIndex(state)] ??
  state.availableTiers[0] ??
  1400;

const getStableAdaptationQualityTier = (state: VideoEffectsAdaptationState) =>
  state.availableTiers[state.policyTierIndex] ??
  state.availableTiers[0] ??
  getCurrentAdaptationTier(state);

const resetAdaptationProcessingMetrics = (
  state: VideoEffectsAdaptationState,
) => {
  resetSmoothedMetric(state.processingDelayMs);
  resetSmoothedMetric(state.fullProcessingDelayMs);
};

const resetAdaptationWarmupMetrics = (
  state: VideoEffectsAdaptationState,
) => {
  resetAdaptationProcessingMetrics(state);
  resetSmoothedMetric(state.asyncProcessingDelayMs);
  resetSmoothedMetric(state.runtimePressureMs);
  state.lastRuntimePressureMs = 0;
  state.lastRuntimePressureReason = null;
  resetSmoothedMetric(state.frameIntervalMs);
  state.consecutiveSlowFrameCount = 0;
};

const setAdaptationEffectMode = (
  state: VideoEffectsAdaptationState,
  adaptiveEffect: boolean,
) => {
  if (state.adaptiveEffect === adaptiveEffect) return;
  const previousTier = getCurrentAdaptationTier(state);
  state.adaptiveEffect = adaptiveEffect;
  state.availableTiers = getAvailableAdaptationTiers(adaptiveEffect);
  const preservedIndex = state.availableTiers.indexOf(previousTier);
  state.tierIndex =
    preservedIndex >= 0 ? preservedIndex : state.availableTiers.length - 1;
  state.policyTierIndex = clamp(
    state.policyTierIndex,
    0,
    Math.max(0, state.availableTiers.length - 1),
  );
};

const setAdaptationPolicyTier = (
  state: VideoEffectsAdaptationState,
  policy: VideoEffectsAdaptationPolicy,
) => {
  const nextPolicyTierIndex = policy.tier
    ? getAdaptationTierIndex(state, policy.tier)
    : 0;
  state.policyTierIndex = clamp(
    nextPolicyTierIndex,
    0,
    Math.max(0, state.availableTiers.length - 1),
  );
  state.policyReason = policy.reason;
};

const maybeResetExpiredAdaptationCooldowns = (
  state: VideoEffectsAdaptationState,
  now: number,
) => {
  for (const tier of VIDEO_EFFECTS_ADAPTATION_TIERS) {
    const cooldownUntil = state.recoveryCooldownUntilByTier[tier];
    if (
      cooldownUntil > 0 &&
      now - cooldownUntil > VIDEO_EFFECTS_ADAPTATION_COOLDOWN_RESET_MS
    ) {
      state.recoveryCooldownUntilByTier[tier] = 0;
      state.recoveryCooldownStageByTier[tier] = 0;
    }
  }
};

const evaluateVideoEffectsAdaptation = (
  state: VideoEffectsAdaptationState,
  now: number,
) => {
  if (state.availableTiers.length <= 1) return;
  maybeResetExpiredAdaptationCooldowns(state, now);

  const processingOverBudget =
    state.processingDelayMs.value >
      VIDEO_EFFECTS_ADAPTATION_PROCESSING_TARGET_MS ||
    state.fullProcessingDelayMs.value > VIDEO_EFFECTS_ADAPTATION_FULL_TARGET_MS;
  const runtimePressureOverBudget =
    state.runtimePressureMs.value >
    VIDEO_EFFECTS_ADAPTATION_RUNTIME_PRESSURE_TARGET_MS;
  const recentProcessingSpike =
    state.lastProcessingDelayMs > VIDEO_EFFECTS_ADAPTATION_RECENT_SPIKE_MS;
  const recentRuntimePressureSpike =
    state.lastRuntimePressureMs >
    VIDEO_EFFECTS_ADAPTATION_RUNTIME_PRESSURE_SPIKE_MS;
  const hardProcessingSpike =
    state.lastProcessingDelayMs >
      VIDEO_EFFECTS_ADAPTATION_HARD_PROCESSING_SPIKE_MS ||
    state.lastFullProcessingDelayMs >
      VIDEO_EFFECTS_ADAPTATION_HARD_FULL_SPIKE_MS;
  const hardRuntimePressureSpike =
    state.lastRuntimePressureMs >
    VIDEO_EFFECTS_ADAPTATION_HARD_RUNTIME_PRESSURE_SPIKE_MS;
  const frameCadenceSlow =
    state.frameIntervalMs.value >
      VIDEO_EFFECTS_ADAPTATION_FRAME_INTERVAL_TARGET_MS &&
    state.lastFrameIntervalMs >
      VIDEO_EFFECTS_ADAPTATION_FRAME_INTERVAL_TARGET_MS;
  const hardFrameCadenceSpike =
    state.lastFrameIntervalMs >
    VIDEO_EFFECTS_ADAPTATION_FRAME_INTERVAL_SPIKE_MS;
  const processingSlow =
    processingOverBudget ||
    runtimePressureOverBudget ||
    recentProcessingSpike ||
    recentRuntimePressureSpike ||
    frameCadenceSlow ||
    hardProcessingSpike ||
    hardRuntimePressureSpike ||
    hardFrameCadenceSpike;

  if (processingSlow) {
    state.slowFrameCount += 1;
    state.consecutiveSlowFrameCount += 1;
    const shouldDownshift =
      state.consecutiveSlowFrameCount >=
        VIDEO_EFFECTS_ADAPTATION_CONSECUTIVE_SLOW_FRAMES ||
      hardProcessingSpike ||
      hardFrameCadenceSpike;
    const effectiveTierIndex = getEffectiveAdaptationTierIndex(state);
    if (shouldDownshift && effectiveTierIndex < state.availableTiers.length - 1) {
      const previousTier = getCurrentAdaptationTier(state);
      state.tierIndex = effectiveTierIndex + 1;
      const nextTier = getCurrentAdaptationTier(state);
      const cooldownStage = clamp(
        state.recoveryCooldownStageByTier[previousTier],
        0,
        VIDEO_EFFECTS_ADAPTATION_RECOVERY_COOLDOWNS_MS.length - 1,
      );
      const cooldownMs =
        VIDEO_EFFECTS_ADAPTATION_RECOVERY_COOLDOWNS_MS[cooldownStage];
      state.recoveryCooldownUntilByTier[previousTier] = now + cooldownMs;
      state.recoveryCooldownStageByTier[previousTier] = Math.min(
        cooldownStage + 1,
        VIDEO_EFFECTS_ADAPTATION_RECOVERY_COOLDOWNS_MS.length - 1,
      );
      state.downshiftCount += 1;
      state.lastTransitionAt = now;
      state.lastTransitionReason =
        hardRuntimePressureSpike || runtimePressureOverBudget
          ? `runtime-pressure:${state.lastRuntimePressureReason ?? "unknown"}:${previousTier}->${nextTier}`
          : `slow-processing:${previousTier}->${nextTier}`;
      state.consecutiveSlowFrameCount = 0;
      resetAdaptationProcessingMetrics(state);
    }
    return;
  }

  state.consecutiveSlowFrameCount = 0;
  const effectiveTierIndex = getEffectiveAdaptationTierIndex(state);
  if (effectiveTierIndex <= state.policyTierIndex) return;
  const higherTier = state.availableTiers[effectiveTierIndex - 1];
  if (!higherTier) return;
  const cooldownUntil = state.recoveryCooldownUntilByTier[higherTier] ?? 0;
  if (cooldownUntil > now) return;

  const previousTier = getCurrentAdaptationTier(state);
  state.tierIndex = effectiveTierIndex - 1;
  const nextTier = getCurrentAdaptationTier(state);
  state.upshiftCount += 1;
  state.lastTransitionAt = now;
  state.lastTransitionReason = `recovered:${previousTier}->${nextTier}`;
  resetAdaptationProcessingMetrics(state);
};

const recordVideoEffectsFrameProcessing = (
  state: VideoEffectsAdaptationState,
  {
    processingDelayMs,
    fullProcessingDelayMs = processingDelayMs,
    frameIntervalMs,
  }: {
    processingDelayMs: number;
    fullProcessingDelayMs?: number;
    frameIntervalMs?: number;
  },
  now: number,
  {
    evaluate = true,
    updateSmoothedMetrics = true,
  }: {
    evaluate?: boolean;
    updateSmoothedMetrics?: boolean;
  } = {},
) => {
  const clampedProcessingDelayMs = clamp(processingDelayMs, 0, 90);
  const clampedFullProcessingDelayMs = clamp(fullProcessingDelayMs, 0, 600);
  state.lastProcessingDelayMs = clampedProcessingDelayMs;
  state.lastFullProcessingDelayMs = clampedFullProcessingDelayMs;
  if (updateSmoothedMetrics) {
    updateSmoothedMetric(state.processingDelayMs, clampedProcessingDelayMs);
    updateSmoothedMetric(
      state.fullProcessingDelayMs,
      clampedFullProcessingDelayMs,
    );
  }
  if (typeof frameIntervalMs === "number" && Number.isFinite(frameIntervalMs)) {
    const clampedFrameIntervalMs = clamp(frameIntervalMs, 0, 1000);
    state.lastFrameIntervalMs = clampedFrameIntervalMs;
    if (updateSmoothedMetrics) {
      updateSmoothedMetric(state.frameIntervalMs, clampedFrameIntervalMs);
    }
  }
  if (evaluate) {
    evaluateVideoEffectsAdaptation(state, now);
  } else {
    state.consecutiveSlowFrameCount = 0;
  }
};

const recordVideoEffectsAsyncProcessing = (
  state: VideoEffectsAdaptationState,
  processingDelayMs: number,
  now: number,
  {
    evaluate = true,
    updateSmoothedMetrics = true,
  }: {
    evaluate?: boolean;
    updateSmoothedMetrics?: boolean;
  } = {},
) => {
  const clampedProcessingDelayMs = clamp(processingDelayMs, 0, 600);
  state.lastAsyncProcessingDelayMs = clampedProcessingDelayMs;
  if (updateSmoothedMetrics) {
    updateSmoothedMetric(state.asyncProcessingDelayMs, clampedProcessingDelayMs);
    updateSmoothedMetric(
      state.processingDelayMs,
      clamp(clampedProcessingDelayMs, 0, 90),
    );
  }
  if (evaluate) {
    evaluateVideoEffectsAdaptation(state, now);
  } else {
    state.consecutiveSlowFrameCount = 0;
  }
};

const recordVideoEffectsRuntimePressure = (
  state: VideoEffectsAdaptationState,
  pressureMs: number,
  reason: string | null,
  now: number,
  {
    evaluate = false,
    updateSmoothedMetrics = true,
  }: {
    evaluate?: boolean;
    updateSmoothedMetrics?: boolean;
  } = {},
) => {
  const clampedPressureMs = clamp(pressureMs, 0, 240);
  state.lastRuntimePressureMs = clampedPressureMs;
  state.lastRuntimePressureReason = clampedPressureMs > 0 ? reason : null;
  if (updateSmoothedMetrics) {
    updateSmoothedMetric(state.runtimePressureMs, clampedPressureMs);
  }
  if (evaluate) {
    evaluateVideoEffectsAdaptation(state, now);
  }
};

const getAdaptedModelInterval = (
  state: VideoEffectsAdaptationState,
  kind: ModelDispatchKind,
  baseIntervalMs: number,
  minIntervalOverrideMs?: number,
) => {
  const tier = getCurrentAdaptationTier(state);
  const { modelIntervalScale } = VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier];
  const minIntervalMs =
    minIntervalOverrideMs ??
    (kind === "segmentation"
      ? MIN_SEGMENTATION_INTERVAL_MS
      : MIN_FACE_INTERVAL_MS);
  const maxIntervalMs =
    kind === "segmentation"
      ? MAX_SEGMENTATION_INTERVAL_MS
      : MAX_FACE_INTERVAL_MS;
  const staleCap =
    kind === "segmentation"
      ? SEGMENTATION_RESULT_STALE_MS - 30
      : FACE_RESULT_STALE_MS - 60;
  return clamp(
    baseIntervalMs * modelIntervalScale,
    minIntervalMs * modelIntervalScale,
    Math.min(staleCap, maxIntervalMs * modelIntervalScale),
  );
};

const getVideoEffectsAdaptationStats = (
  state: VideoEffectsAdaptationState,
  {
    targetSegmentationIntervalMs,
    targetFaceIntervalMs,
    lastSegmentationProcessingMs,
    lastFaceProcessingMs,
    roomTilingPolicyContext,
    now,
  }: {
    targetSegmentationIntervalMs: number;
    targetFaceIntervalMs: number;
    lastSegmentationProcessingMs: number;
    lastFaceProcessingMs: number;
    roomTilingPolicyContext: VideoEffectsRoomTilingPolicyContext | null;
    now: number;
  },
) => {
  const tier = getCurrentAdaptationTier(state);
  const higherTier =
    state.tierIndex > 0 ? state.availableTiers[state.tierIndex - 1] : null;
  const higherTierCooldownUntil = higherTier
    ? state.recoveryCooldownUntilByTier[higherTier]
    : 0;
  return {
    adaptationTier: tier,
    label: VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].label,
    availableTiers: state.availableTiers,
    tierIndex: state.tierIndex,
    effectiveTierIndex: getEffectiveAdaptationTierIndex(state),
    policyTier:
      state.availableTiers[state.policyTierIndex] ?? state.availableTiers[0],
    policyTierIndex: state.policyTierIndex,
    policyReason: state.policyReason,
    qualityTier: getStableAdaptationQualityTier(state),
    adaptiveEffect: state.adaptiveEffect,
    modelIntervalScale:
      VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].modelIntervalScale,
    modelInputScale: VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].modelInputScale,
    outputScale: VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].outputScale,
    roomTiling: roomTilingPolicyContext
      ? {
          sequence: roomTilingPolicyContext.sequence,
          ageMs: Math.round(
            Math.max(0, now - roomTilingPolicyContext.receivedAt),
          ),
          renderedMode: roomTilingPolicyContext.renderedMode,
          presenting: roomTilingPolicyContext.presenting,
          dynamicCrop: roomTilingPolicyContext.dynamicCrop,
          totalGridCount: roomTilingPolicyContext.totalGridCount,
          visibleCount: roomTilingPolicyContext.visibleCount,
          hiddenCount: roomTilingPolicyContext.hiddenCount,
          stageRailCount: roomTilingPolicyContext.stageRailCount,
          fallbackLevel: roomTilingPolicyContext.fallbackLevel,
          maxTiles: roomTilingPolicyContext.maxTiles,
          tileWidth: roomTilingPolicyContext.tileWidth,
          tileHeight: roomTilingPolicyContext.tileHeight,
          selfViewPlacement: roomTilingPolicyContext.selfViewPlacement,
          localIsPrimary: roomTilingPolicyContext.localIsPrimary,
        }
      : null,
    processingDelayMs: Number(state.processingDelayMs.value.toFixed(2)),
    fullProcessingDelayMs: Number(state.fullProcessingDelayMs.value.toFixed(2)),
    asyncProcessingDelayMs: Number(
      state.asyncProcessingDelayMs.value.toFixed(2),
    ),
    runtimePressureMs: Number(state.runtimePressureMs.value.toFixed(2)),
    frameIntervalMs: Number(state.frameIntervalMs.value.toFixed(2)),
    lastProcessingDelayMs: Number(state.lastProcessingDelayMs.toFixed(2)),
    lastFullProcessingDelayMs: Number(state.lastFullProcessingDelayMs.toFixed(2)),
    lastAsyncProcessingDelayMs: Number(
      state.lastAsyncProcessingDelayMs.toFixed(2),
    ),
    lastRuntimePressureMs: Number(state.lastRuntimePressureMs.toFixed(2)),
    lastRuntimePressureReason: state.lastRuntimePressureReason,
    lastFrameIntervalMs: Number(state.lastFrameIntervalMs.toFixed(2)),
    targetSegmentationIntervalMs: Number(
      targetSegmentationIntervalMs.toFixed(2),
    ),
    targetFaceIntervalMs: Number(targetFaceIntervalMs.toFixed(2)),
    lastSegmentationProcessingMs: Number(
      lastSegmentationProcessingMs.toFixed(2),
    ),
    lastFaceProcessingMs: Number(lastFaceProcessingMs.toFixed(2)),
    downshiftCount: state.downshiftCount,
    upshiftCount: state.upshiftCount,
    slowFrameCount: state.slowFrameCount,
    consecutiveSlowFrameCount: state.consecutiveSlowFrameCount,
    higherTierCooldownMs: Math.max(
      0,
      Math.round((higherTierCooldownUntil ?? 0) - now),
    ),
    lastTransitionAt:
      state.lastTransitionAt > 0
        ? Number(state.lastTransitionAt.toFixed(2))
        : 0,
    lastTransitionReason: state.lastTransitionReason,
  };
};

const smoothCrop = (
  previous: CropRect | null,
  next: CropRect,
  alpha: number,
): CropRect => {
  if (!previous) return next;
  return {
    sx: lerp(previous.sx, next.sx, alpha),
    sy: lerp(previous.sy, next.sy, alpha),
    sw: lerp(previous.sw, next.sw, alpha),
    sh: lerp(previous.sh, next.sh, alpha),
  };
};

const getCropDriftPx = (a: CropRect | null, b: CropRect | null) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(a.sx - b.sx),
    Math.abs(a.sy - b.sy),
    Math.abs(a.sw - b.sw),
    Math.abs(a.sh - b.sh),
  );
};

const isFramingOnlyEffect = (effects: VideoEffectsState) =>
  effects.framing &&
  effects.background === "none" &&
  effects.filter === "none" &&
  effects.style === "none" &&
  !effects.studioLighting &&
  !effects.studioLook;

const getFaceModelMinIntervalMs = (effects: VideoEffectsState) =>
  effects.filter !== "none" ? MIN_FACE_FILTER_INTERVAL_MS : MIN_FACE_INTERVAL_MS;

const capFaceModelIntervalForActiveFilter = (
  effects: VideoEffectsState,
  intervalMs: number,
) =>
  effects.filter !== "none"
    ? Math.min(intervalMs, MAX_ACTIVE_FACE_FILTER_INTERVAL_MS)
    : intervalMs;

const getNormalizedLandmarkCenter = (landmarks: NormalizedLandmarkList) => {
  let x = 0;
  let y = 0;
  for (const landmark of landmarks) {
    x += landmark.x;
    y += landmark.y;
  }
  return {
    x: x / landmarks.length,
    y: y / landmarks.length,
  };
};

const getNormalizedLandmarkMetrics = (landmarks: NormalizedLandmarkList) => {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const landmark of landmarks) {
    minX = Math.min(minX, landmark.x);
    minY = Math.min(minY, landmark.y);
    maxX = Math.max(maxX, landmark.x);
    maxY = Math.max(maxY, landmark.y);
  }
  const center = getNormalizedLandmarkCenter(landmarks);
  return {
    centerX: center.x,
    centerY: center.y,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
};

const cloneFaceLandmarks = (
  landmarks: NormalizedLandmarkList,
): NormalizedLandmarkList => landmarks.map((landmark) => ({ ...landmark }));

const createFaceLandmarkSmoothingStats = (
  reason: FaceLandmarkSmoothingStats["reason"],
  previous: NormalizedLandmarkList | null,
  next: NormalizedLandmarkList | null,
  alpha: number,
  motionScore = 0,
  centerDrift = 0,
  sizeDrift = 0,
): FaceLandmarkSmoothingStats => ({
  alpha: Number(alpha.toFixed(3)),
  motionScore: Number(motionScore.toFixed(4)),
  centerDrift: Number(centerDrift.toFixed(4)),
  sizeDrift: Number(sizeDrift.toFixed(4)),
  reset: reason !== "adaptive",
  reason,
  previousCount: previous?.length ?? 0,
  nextCount: next?.length ?? 0,
});

const smoothFaceLandmarks = (
  previous: NormalizedLandmarkList | null,
  next: NormalizedLandmarkList | null,
  alpha = FACE_LANDMARK_SMOOTHING_ALPHA,
  fastAlpha = FACE_LANDMARK_FAST_SMOOTHING_ALPHA,
  motionStart = FACE_LANDMARK_ADAPTIVE_MOTION_START,
  motionEnd = FACE_LANDMARK_ADAPTIVE_MOTION_END,
): FaceLandmarkSmoothingResult => {
  if (!next?.length) {
    return {
      landmarks: null,
      stats: createFaceLandmarkSmoothingStats(
        "missing-result",
        previous,
        next,
        1,
      ),
    };
  }
  if (!previous || previous.length !== next.length) {
    return {
      landmarks: cloneFaceLandmarks(next),
      stats: createFaceLandmarkSmoothingStats(
        previous ? "landmark-count-change" : "first-result",
        previous,
        next,
        1,
      ),
    };
  }

  const previousMetrics = getNormalizedLandmarkMetrics(previous);
  const nextMetrics = getNormalizedLandmarkMetrics(next);
  const centerJump = Math.hypot(
    nextMetrics.centerX - previousMetrics.centerX,
    nextMetrics.centerY - previousMetrics.centerY,
  );
  const sizeJump = Math.max(
    Math.abs(nextMetrics.width - previousMetrics.width),
    Math.abs(nextMetrics.height - previousMetrics.height),
  );
  if (centerJump > 0.16) {
    return {
      landmarks: cloneFaceLandmarks(next),
      stats: createFaceLandmarkSmoothingStats(
        "large-jump",
        previous,
        next,
        1,
        centerJump,
        centerJump,
        sizeJump,
      ),
    };
  }

  const motionScore = Math.max(centerJump, sizeJump * 0.65);
  const motionProgress = smoothStep(
    clamp(
      (motionScore - motionStart) /
        Math.max(0.0001, motionEnd - motionStart),
      0,
      1,
    ),
  );
  const adaptiveAlpha = clamp(
    lerp(alpha, fastAlpha, motionProgress),
    alpha,
    fastAlpha,
  );

  return {
    landmarks: next.map((landmark, index) => {
      const previousLandmark = previous[index];
      return {
        ...landmark,
        x: lerp(previousLandmark.x, landmark.x, adaptiveAlpha),
        y: lerp(previousLandmark.y, landmark.y, adaptiveAlpha),
        z:
          typeof landmark.z === "number" &&
          typeof previousLandmark.z === "number"
            ? lerp(previousLandmark.z, landmark.z, adaptiveAlpha)
            : landmark.z,
      };
    }),
    stats: createFaceLandmarkSmoothingStats(
      "adaptive",
      previous,
      next,
      adaptiveAlpha,
      motionScore,
      centerJump,
      sizeJump,
    ),
  };
};

const isVideoEffectsDebugEnabled = () => {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(DEBUG_VIDEO_EFFECTS_STORAGE_KEY) === "1" ||
      window.localStorage.getItem(DEBUG_VIDEO_EFFECTS_VERBOSE_STORAGE_KEY) ===
        "1"
    );
  } catch {
    return false;
  }
};

const isVideoEffectsVerboseDebugEnabled = () => {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(DEBUG_VIDEO_EFFECTS_VERBOSE_STORAGE_KEY) ===
      "1"
    );
  } catch {
    return false;
  }
};

const getTrackDebugSnapshot = (track: MediaStreamTrack | null) => {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    settings = {};
  }
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings,
  };
};

const getStreamDebugSnapshot = (stream: MediaStream | null) => {
  if (!stream) return null;
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(getTrackDebugSnapshot),
    videoTracks: stream.getVideoTracks().map(getTrackDebugSnapshot),
  };
};

const getEffectsDebugSnapshot = (effects: VideoEffectsState) => ({
  background: effects.background,
  customBackground: Boolean(
    effects.customBackgroundDataUrl || effects.customBackgroundId,
  ),
  customBackgroundId: effects.customBackgroundId,
  customBackgroundName: effects.customBackgroundName,
  filter: effects.filter,
  style: effects.style,
  studioLighting: effects.studioLighting,
  studioLook: effects.studioLook,
  framing: effects.framing,
  active: hasActiveVideoEffects(effects),
});

const createVisualEffectTransitionSnapshot = (
  effects: VideoEffectsState,
): VisualEffectTransitionSnapshot => getEffectsDebugSnapshot(effects);

const createVisualEffectTransitionState = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D | null,
): VisualEffectTransitionState => ({
  canvas,
  ctx,
  active: false,
  startedAt: 0,
  lastStartedAt: 0,
  lastCompletedAt: 0,
  transitionMs: VISUAL_EFFECT_BACKGROUND_TRANSITION_MS,
  progress: 1,
  easedProgress: 1,
  runCount: 0,
  completedCount: 0,
  skippedCount: 0,
  reason: "none",
  lastReason: "none",
  from: null,
  to: null,
  lastSkippedReason: null,
});

const getVisualEffectTransitionReason = (
  previous: VisualEffectTransitionSnapshot,
  next: VisualEffectTransitionSnapshot,
): VisualEffectTransitionReason => {
  const reasons = new Set<Exclude<VisualEffectTransitionReason, "none" | "mixed">>();
  if (previous.background !== next.background) {
    reasons.add("background");
  }
  if (
    previous.customBackground !== next.customBackground ||
    previous.customBackgroundId !== next.customBackgroundId ||
    previous.customBackgroundName !== next.customBackgroundName
  ) {
    reasons.add("custom-background");
  }
  if (previous.filter !== next.filter) {
    reasons.add("filter");
  }
  if (previous.style !== next.style) {
    reasons.add("style");
  }
  if (
    previous.studioLighting !== next.studioLighting ||
    previous.studioLook !== next.studioLook
  ) {
    reasons.add("appearance");
  }
  if (previous.framing !== next.framing) {
    reasons.add("framing");
  }

  if (reasons.size === 0) return "none";
  if (reasons.size > 1) return "mixed";
  return reasons.values().next().value ?? "none";
};

const easeVisualEffectTransition = (progress: number) => {
  const clampedProgress = clamp(progress, 0, 1);
  return 1 - Math.pow(1 - clampedProgress, 3);
};

const getVisualEffectTransitionMs = (reason: VisualEffectTransitionReason) => {
  switch (reason) {
    case "background":
    case "custom-background":
      return VISUAL_EFFECT_BACKGROUND_TRANSITION_MS;
    case "filter":
      return VISUAL_EFFECT_FILTER_TRANSITION_MS;
    case "style":
      return VISUAL_EFFECT_STYLE_TRANSITION_MS;
    case "appearance":
      return VISUAL_EFFECT_APPEARANCE_TRANSITION_MS;
    case "framing":
      return VISUAL_EFFECT_FRAMING_TRANSITION_MS;
    case "mixed":
      return VISUAL_EFFECT_MIXED_TRANSITION_MS;
    case "none":
    default:
      return VISUAL_EFFECT_BACKGROUND_TRANSITION_MS;
  }
};

const skipVisualEffectTransition = (
  state: VisualEffectTransitionState,
  reason: string,
  from: VisualEffectTransitionSnapshot,
  to: VisualEffectTransitionSnapshot,
) => {
  state.active = false;
  state.progress = 1;
  state.easedProgress = 1;
  state.reason = "none";
  state.from = from;
  state.to = to;
  state.skippedCount += 1;
  state.lastSkippedReason = reason;
};

const startVisualEffectTransition = (
  state: VisualEffectTransitionState,
  outputCanvas: HTMLCanvasElement,
  from: VisualEffectTransitionSnapshot,
  to: VisualEffectTransitionSnapshot,
  reason: VisualEffectTransitionReason,
  canUsePreviousOutputFrame: boolean,
  now: number,
) => {
  state.transitionMs = getVisualEffectTransitionMs(reason);
  if (reason === "none") {
    return false;
  }
  if (!state.ctx) {
    skipVisualEffectTransition(state, "snapshot context unavailable", from, to);
    return false;
  }
  if (!canUsePreviousOutputFrame) {
    skipVisualEffectTransition(state, "no previous visible output frame", from, to);
    return false;
  }
  if (outputCanvas.width <= 0 || outputCanvas.height <= 0) {
    skipVisualEffectTransition(state, "output canvas is empty", from, to);
    return false;
  }

  try {
    if (
      state.canvas.width !== outputCanvas.width ||
      state.canvas.height !== outputCanvas.height
    ) {
      state.canvas.width = outputCanvas.width;
      state.canvas.height = outputCanvas.height;
    }
    state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    state.ctx.drawImage(outputCanvas, 0, 0, state.canvas.width, state.canvas.height);
  } catch {
    skipVisualEffectTransition(state, "previous frame snapshot failed", from, to);
    return false;
  }

  state.active = true;
  state.startedAt = now;
  state.lastStartedAt = now;
  state.progress = 0;
  state.easedProgress = 0;
  state.reason = reason;
  state.lastReason = reason;
  state.from = from;
  state.to = to;
  state.lastSkippedReason = null;
  state.runCount += 1;
  return true;
};

const applyVisualEffectTransition = (
  state: VisualEffectTransitionState,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  now: number,
) => {
  if (
    !state.active ||
    !state.ctx ||
    state.canvas.width !== width ||
    state.canvas.height !== height
  ) {
    return;
  }

  const progress = clamp((now - state.startedAt) / state.transitionMs, 0, 1);
  const easedProgress = easeVisualEffectTransition(progress);
  state.progress = progress;
  state.easedProgress = easedProgress;

  const previousOpacity = 1 - easedProgress;
  if (previousOpacity > 0.001) {
    ctx.save();
    ctx.globalAlpha = previousOpacity;
    ctx.drawImage(state.canvas, 0, 0, width, height);
    ctx.restore();
  }

  if (progress >= 1) {
    state.active = false;
    state.progress = 1;
    state.easedProgress = 1;
    state.completedCount += 1;
    state.lastCompletedAt = now;
    state.reason = "none";
  }
};

const getVisualEffectTransitionStats = (
  state: VisualEffectTransitionState | null,
  now: number,
): VisualEffectTransitionStats => {
  if (!state) {
    return {
      enabled: false,
      active: false,
      transitionMs: VISUAL_EFFECT_BACKGROUND_TRANSITION_MS,
      progress: 1,
      easedProgress: 1,
      previousOpacity: 0,
      runCount: 0,
      completedCount: 0,
      skippedCount: 0,
      reason: "none",
      lastReason: "none",
      startedAt: 0,
      lastStartedAgeMs: null,
      lastCompletedAgeMs: null,
      timeLeftMs: 0,
      from: null,
      to: null,
      lastSkippedReason: null,
      canvas: null,
    };
  }

  const progress = state.active
    ? clamp((now - state.startedAt) / state.transitionMs, 0, 1)
    : state.progress;
  const easedProgress = state.active
    ? easeVisualEffectTransition(progress)
    : state.easedProgress;
  return {
    enabled: Boolean(state.ctx),
    active: state.active,
    transitionMs: state.transitionMs,
    progress: Number(progress.toFixed(3)),
    easedProgress: Number(easedProgress.toFixed(3)),
    previousOpacity: Number((1 - easedProgress).toFixed(3)),
    runCount: state.runCount,
    completedCount: state.completedCount,
    skippedCount: state.skippedCount,
    reason: state.reason,
    lastReason: state.lastReason,
    startedAt: Math.round(state.startedAt),
    lastStartedAgeMs:
      state.lastStartedAt > 0 ? Math.round(now - state.lastStartedAt) : null,
    lastCompletedAgeMs:
      state.lastCompletedAt > 0 ? Math.round(now - state.lastCompletedAt) : null,
    timeLeftMs: state.active
      ? Math.round(Math.max(0, state.transitionMs - (now - state.startedAt)))
      : 0,
    from: state.from,
    to: state.to,
    lastSkippedReason: state.lastSkippedReason,
    canvas:
      state.canvas.width > 0 && state.canvas.height > 0
        ? { width: state.canvas.width, height: state.canvas.height }
        : null,
  };
};

const createInactiveDebugStats = ({
  active,
  sourceStream,
  sourceVideoTrack,
  effects,
}: {
  active: boolean;
  sourceStream: MediaStream | null;
  sourceVideoTrack: MediaStreamTrack | null;
  effects: VideoEffectsState;
}): VideoEffectsDebugStats => ({
  needsSegmentation: false,
  needsFace: false,
  frameSource:
    sourceVideoTrack && sourceVideoTrack.readyState === "live" ? "raw" : "none",
  outputTrackPublished: false,
  outputMode: null,
  renderedFrames: 0,
  taskSegmentationRuns: 0,
  taskFaceRuns: 0,
  faceLandmarkCount: 0,
  faceFilterRender: null,
  backgroundRender: null,
  visualTransition: getVisualEffectTransitionStats(null, 0),
  effectSwitchLatency: {
    sequence: 0,
    pending: false,
    reason: "none",
    sinceMs: null,
    firstDeliveredLatencyMs: null,
    firstVisibleLatencyMs: null,
  } satisfies EffectSwitchLatencyStats,
  latestSegmentationMaskAgeMs: null,
  latestFaceLandmarksAgeMs: null,
  latestOutputFrameVisible: false,
  blackOutputFrameCount: 0,
  temporalMask: {
    enabled: false,
    alpha: MASK_TEMPORAL_ALPHA,
    confidenceFloor: MASK_CONFIDENCE_FLOOR,
    confidenceCeiling: MASK_CONFIDENCE_CEILING,
    confidenceGamma: MASK_CONFIDENCE_GAMMA,
    frameCount: 0,
    shapeFrameCount: 0,
    smoothedFrameCount: 0,
    resetCount: 0,
    source: "none",
    pixelCount: 0,
    canvas: {
      width: 0,
      height: 0,
      scratchWidth: 0,
      scratchHeight: 0,
    },
    latestAgeMs: null,
    hasHistory: false,
  } satisfies TemporalMaskStats,
    framePipeline: {
    processor: "main-thread",
    targetFps: TARGET_FPS,
    processingConfigId: 0,
    modelProcessingConfigId: 0,
    schedulerMode: "timer",
    framePoller: {
      mode: "timer",
      callbackCount: 0,
      timerPollCount: 0,
      duplicateFrameSkipCount: 0,
      watchdogFallbackCount: 0,
      scheduleFailureCount: 0,
      lastMetadata: null,
      lastFrameKey: null,
      lastProcessedFrameKey: null,
      lastDuplicateFrameKey: null,
      currentTime: null,
    },
    outputMode: null,
    outputWriter: {
      mode: "main-thread",
      workerSupported: false,
      workerReady: false,
      workerHasVideoFrame: null,
      workerHasWritableStream: null,
      workerHasOffscreenCanvas: null,
      workerRenderer: null,
      workerInputMode: null,
      workerVideoFrameUnsupported: false,
      workerPendingFrameCount: 0,
      workerPendingFrameLimit: OUTPUT_WRITER_STEADY_MAX_PENDING_FRAMES,
      workerOldestPendingFrameAgeMs: null,
      workerFramesSent: 0,
      workerFramesWritten: 0,
      workerFramesDropped: 0,
      workerFrameMetadataCount: 0,
      workerFirstFrameSeen: false,
      workerSkipCount: 0,
      workerBackpressureSkipCount: 0,
      workerCadenceSkipCount: 0,
      workerUnavailableSkipCount: 0,
      workerWriteFailures: 0,
      workerPostFailures: 0,
      latestSkipReason: "inactive",
      latestWorkerWriteMs: null,
      latestWorkerBackpressureMs: null,
      latestWorkerRoundTripMs: null,
      latestWorkerFrameBuildMs: null,
      averageWorkerFrameBuildMs: null,
      maxWorkerFrameBuildMs: null,
      workerFrameBuildSampleCount: 0,
      latestWorkerSequence: 0,
      latestWorkerAckSequence: 0,
      latestWorkerFrameMetadata: null,
      fallbackReason: "inactive",
      lastError: null,
    } satisfies OutputWriterStats,
    segmentationProcessor: {
      mode: "none",
      workerSupported: false,
      workerReady: false,
      workerDelegate: null,
      workerPendingFrameCount: 0,
      workerFramesSent: 0,
      workerResults: 0,
      workerStaleResults: 0,
      workerFailures: 0,
      workerFirstResultSeen: false,
      latestWorkerSequence: 0,
      latestWorkerAckSequence: 0,
      latestWorkerProcessingMs: null,
      latestWorkerRoundTripMs: null,
      latestWorkerResult: null,
      fallbackReason: "inactive",
      lastError: null,
    } satisfies SegmentationProcessorStats,
    faceProcessor: {
      mode: "none",
      workerSupported: false,
      workerReady: false,
      workerDelegate: null,
      workerPendingFrameCount: 0,
      workerFramesSent: 0,
      workerResults: 0,
      workerStaleResults: 0,
      workerFailures: 0,
      workerFirstResultSeen: false,
      latestWorkerSequence: 0,
      latestWorkerAckSequence: 0,
      latestWorkerProcessingMs: null,
      latestWorkerRoundTripMs: null,
      latestWorkerResult: null,
      fallbackReason: "inactive",
      lastError: null,
    } satisfies FaceProcessorStats,
    frameSequence: 0,
    outputFrameSequence: 0,
    outputFramesWritten: 0,
    outputReady: false,
    outputTrackPublished: false,
    lastVisibleOutputFrameAgeMs: null,
    lastVisibleOutputRecoveryCount: 0,
    latestLastVisibleOutputRecoveryReason: null,
    firstSourceFrameAgeMs: null,
    firstOutputFrameAgeMs: null,
    firstVisibleOutputFrameAgeMs: null,
    firstPublishedTrackAgeMs: null,
    sourceFrame: {
      selection: "none",
      fallbackReason: "none",
      blackSourceVideoFrameCount: 0,
      fallbackCount: 0,
      latestVideoProbe: null,
      trackProcessor: {
        started: false,
        unavailable: false,
        frameCount: 0,
        restartCount: 0,
        latestFrameAgeMs: null,
      },
    } satisfies SourceFrameStats,
    lastFrame: null,
  } satisfies FramePipelineStats,
  sourceStream: getStreamDebugSnapshot(sourceStream),
  sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
  outputTrack: null,
  effects: {
    ...getEffectsDebugSnapshot(effects),
    active,
  },
});

const createMeetVideoPipeDirectDebugStats = ({
  sourceStream,
  sourceVideoTrack,
  outputTrack,
  effects,
  meetVideoPipe,
}: {
  sourceStream: MediaStream | null;
  sourceVideoTrack: MediaStreamTrack | null;
  outputTrack: MediaStreamTrack;
  effects: VideoEffectsState;
  meetVideoPipe: Record<string, unknown>;
}): VideoEffectsDebugStats => {
  const base = createInactiveDebugStats({
    active: true,
    sourceStream,
    sourceVideoTrack,
    effects,
  });
  const baseFramePipeline =
    typeof base.framePipeline === "object" && base.framePipeline !== null
      ? (base.framePipeline as Record<string, unknown>)
      : {};

  return {
    ...base,
    needsFace: true,
    frameSource: "meet-videopipe",
    outputTrackPublished: true,
    outputMode: "meet-videopipe",
    latestOutputFrameVisible: true,
    framePipeline: {
      ...baseFramePipeline,
      outputMode: "meet-videopipe",
      outputReady: true,
      outputTrackPublished: true,
    },
    sourceStream: getStreamDebugSnapshot(sourceStream),
    sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
    outputTrack: getTrackDebugSnapshot(outputTrack),
    effects: {
      ...getEffectsDebugSnapshot(effects),
      active: true,
    },
    meetVideoPipe,
  };
};

const getErrorDebugSnapshot = (err: unknown) => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
};

const isVideoEffectsProcessorCleanupError = (err: unknown) =>
  err instanceof Error && err.message === VIDEO_EFFECTS_PROCESSOR_CLEANUP_MESSAGE;

const serializeDebugPayload = (payload: unknown) => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
};

const logVideoEffects = (
  instanceId: number,
  event: string,
  payload?: unknown,
) => {
  if (!isVideoEffectsDebugEnabled()) return;
  if (HOT_DEBUG_EVENTS.has(event) && !isVideoEffectsVerboseDebugEnabled()) {
    return;
  }
  if (payload === undefined) {
    console.debug(`[VideoEffects#${instanceId}] ${event}`);
    return;
  }
  console.debug(
    `[VideoEffects#${instanceId}] ${event}`,
    serializeDebugPayload(payload),
  );
};

const warnVideoEffects = (
  instanceId: number,
  event: string,
  payload?: unknown,
) => {
  if (!isVideoEffectsDebugEnabled()) return;
  if (payload === undefined) {
    console.warn(`[VideoEffects#${instanceId}] ${event}`);
    return;
  }
  console.warn(
    `[VideoEffects#${instanceId}] ${event}`,
    serializeDebugPayload(payload),
  );
};

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const getBackgroundImageSource = (
  background: BackgroundEffectId,
  customBackgroundDataUrl?: string | null,
  customBackgroundId?: string | null,
) => {
  if (background === "custom") {
    if (!customBackgroundDataUrl) return null;
    return {
      cacheKey: customBackgroundId
        ? `custom:${customBackgroundId}`
        : `custom:${customBackgroundDataUrl.length}:${hashString(
            customBackgroundDataUrl,
          )}`,
      src: customBackgroundDataUrl,
      source: "custom",
    };
  }

  const assetPath =
    BACKGROUND_ASSET_PATHS[background as keyof typeof BACKGROUND_ASSET_PATHS] ??
    null;
  return assetPath
    ? { cacheKey: `asset:${assetPath}`, src: assetPath, source: "asset" }
    : null;
};

const getFaceFilterEffectGraphStats = (
  filter: FaceFilterId,
): FaceFilterEffectGraphStats | null => {
  const graph = getFaceFilterEffectGraph(filter);
  if (!graph) return null;
  return {
    meetGraphId: graph.meetGraphId,
    meetEffectIdNumber: graph.meetEffectIdNumber,
    renderMode: graph.renderMode,
    assetProfile: graph.assetProfile,
    dependencies: graph.dependencies,
    requiresFaceLandmarks: graph.requiresFaceLandmarks,
    requiresSegmentation: graph.requiresSegmentation,
    requiresMeetVideoPipe: graph.requiresMeetVideoPipe,
    bundleAssets: graph.bundleAssets,
    thumbnailAsset: graph.thumbnailAsset,
    modelIntervalMs: graph.modelIntervalMs,
    liveBundleVersion: graph.liveBundleVersion,
  };
};

const loadBackgroundImage = (
  background: BackgroundEffectId,
  instanceId: number,
  customBackgroundDataUrl?: string | null,
  customBackgroundId?: string | null,
): Promise<HTMLImageElement | null> => {
  const imageSource = getBackgroundImageSource(
    background,
    customBackgroundDataUrl,
    customBackgroundId,
  );
  if (!imageSource || typeof window === "undefined") {
    return Promise.resolve(null);
  }

  const cached = backgroundImageCache.get(imageSource.cacheKey);
  if (cached?.image) {
    return Promise.resolve(cached.image);
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const image = new Image();
  image.decoding = "async";
  image.loading = "eager";

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    image.onload = () => {
      image
        .decode()
        .catch(() => undefined)
        .finally(() => {
          backgroundImageCache.set(imageSource.cacheKey, {
            image,
            promise: null,
          });
          logVideoEffects(instanceId, "background_image_loaded", {
            background,
            source: imageSource.source,
            cacheKey: imageSource.cacheKey,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
          resolve(image);
        });
    };
    image.onerror = () => {
      backgroundImageCache.set(imageSource.cacheKey, {
        image: null,
        promise: null,
      });
      warnVideoEffects(instanceId, "background_image_failed", {
        background,
        source: imageSource.source,
        cacheKey: imageSource.cacheKey,
      });
      resolve(null);
    };
  });

  backgroundImageCache.set(imageSource.cacheKey, {
    image: null,
    promise,
  });
  logVideoEffects(instanceId, "background_image_load_start", {
    background,
    source: imageSource.source,
    cacheKey: imageSource.cacheKey,
  });
  image.src = imageSource.src;
  return promise;
};

const waitForBackgroundPrewarmCadence = () =>
  new Promise<void>((resolve) => {
    if (typeof window === "undefined") {
      resolve();
      return;
    }
    const delayMs = isVideoEffectsPipelineBusyForPrewarm()
      ? BACKGROUND_PREWARM_ACTIVE_PIPELINE_DELAY_MS
      : BACKGROUND_PREWARM_IDLE_DELAY_MS;
    window.setTimeout(resolve, delayMs);
  });

const prewarmBackgroundImages = async (
  backgrounds: BackgroundEffectId[],
  instanceId: number,
  reason: string,
) => {
  const queuedBackgrounds = Array.from(
    new Set(
      backgrounds.filter((background) =>
        Boolean(getBackgroundImageSource(background)),
      ),
    ),
  );
  if (queuedBackgrounds.length === 0) return;

  const queueKey = queuedBackgrounds.join("|");
  const existingQueue = backgroundPrewarmQueuePromises.get(queueKey);
  if (existingQueue) {
    logVideoEffects(instanceId, "background_prewarm_queue_reuse", {
      reason,
      count: queuedBackgrounds.length,
      key: queueKey,
    });
    await existingQueue;
    return;
  }

  const bulkPrewarm = queuedBackgrounds.length > 1;
  const initialConcurrency = bulkPrewarm
    ? isVideoEffectsPipelineBusyForPrewarm()
      ? BACKGROUND_PREWARM_ACTIVE_PIPELINE_CONCURRENCY
      : BACKGROUND_PREWARM_IDLE_CONCURRENCY
    : 1;
  logVideoEffects(instanceId, "background_prewarm_queue_start", {
    reason,
    count: queuedBackgrounds.length,
    concurrency: initialConcurrency,
    bulk: bulkPrewarm,
    activePipelineCount: activeVideoEffectsPipelineCount,
  });

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < queuedBackgrounds.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (bulkPrewarm && index > 0) {
        await waitForBackgroundPrewarmCadence();
      }
      await loadBackgroundImage(queuedBackgrounds[index], instanceId).then(
        () => undefined,
      );
    }
  };

  const workerCount = Math.min(initialConcurrency, queuedBackgrounds.length);
  const queuePromise = Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  ).then(() => undefined);
  backgroundPrewarmQueuePromises.set(queueKey, queuePromise);
  await queuePromise.finally(() => {
    if (backgroundPrewarmQueuePromises.get(queueKey) === queuePromise) {
      backgroundPrewarmQueuePromises.delete(queueKey);
    }
  });
  logVideoEffects(instanceId, "background_prewarm_queue_done", {
    reason,
    count: queuedBackgrounds.length,
    concurrency: initialConcurrency,
  });
};

const getLoadedBackgroundImage = (
  background: BackgroundEffectId,
  customBackgroundDataUrl?: string | null,
  customBackgroundId?: string | null,
) => {
  const imageSource = getBackgroundImageSource(
    background,
    customBackgroundDataUrl,
    customBackgroundId,
  );
  if (!imageSource) return null;
  const image = backgroundImageCache.get(imageSource.cacheKey)?.image ?? null;
  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
  return image;
};

const loadSharedTasksVision = async (
  instanceId: number,
): Promise<TasksVisionModule> => {
  if (sharedTasksVisionModule) {
    logVideoEffects(instanceId, "tasks_vision_import_reuse");
    return sharedTasksVisionModule;
  }

  if (!sharedTasksVisionModulePromise) {
    logVideoEffects(instanceId, "tasks_vision_import_start", {
      wasmLocalPath: TASKS_VISION_WASM_LOCAL_PATH,
      wasmCdn: TASKS_VISION_WASM_CDN,
    });
    sharedTasksVisionModulePromise = import("@mediapipe/tasks-vision")
      .then((module) => {
        sharedTasksVisionModule = module;
        logVideoEffects(instanceId, "tasks_vision_import_done");
        return module;
      })
      .catch((err) => {
        sharedTasksVisionModulePromise = null;
        throw err;
      });
  } else {
    logVideoEffects(instanceId, "tasks_vision_import_wait");
  }

  return sharedTasksVisionModulePromise;
};

const resolveSharedTasksVisionFileset = async (
  module: TasksVisionModule,
  instanceId: number,
): Promise<TasksVisionFileset> => {
  const candidates = [
    {
      source: "same-origin",
      wasmBaseUrl: TASKS_VISION_WASM_LOCAL_PATH,
    },
    {
      source: "cdn",
      wasmBaseUrl: TASKS_VISION_WASM_CDN,
    },
  ] as const;

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      logVideoEffects(instanceId, "tasks_fileset_resolve_start", candidate);
      const fileset = await module.FilesetResolver.forVisionTasks(
        candidate.wasmBaseUrl,
      );
      logVideoEffects(instanceId, "tasks_fileset_resolve_done", candidate);
      return fileset;
    } catch (err) {
      lastError = err;
      warnVideoEffects(instanceId, "tasks_fileset_resolve_failed", {
        ...candidate,
        error: getErrorDebugSnapshot(err),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to resolve MediaPipe Tasks Vision fileset");
};

const ensureSharedTasksVisionFileset = async (
  instanceId: number,
): Promise<TasksVisionFileset> => {
  if (sharedTasksVisionFileset) {
    logVideoEffects(instanceId, "tasks_fileset_reuse");
    return sharedTasksVisionFileset;
  }

  if (!sharedTasksVisionFilesetPromise) {
    logVideoEffects(instanceId, "tasks_fileset_start", {
      wasmLocalPath: TASKS_VISION_WASM_LOCAL_PATH,
      fallbackWasmCdn: TASKS_VISION_WASM_CDN,
    });
    sharedTasksVisionFilesetPromise = loadSharedTasksVision(instanceId)
      .then((module) => resolveSharedTasksVisionFileset(module, instanceId))
      .then((fileset) => {
        sharedTasksVisionFileset = fileset;
        logVideoEffects(instanceId, "tasks_fileset_done", fileset);
        return fileset;
      })
      .catch((err) => {
        sharedTasksVisionFilesetPromise = null;
        throw err;
      });
  } else {
    logVideoEffects(instanceId, "tasks_fileset_wait");
  }

  return sharedTasksVisionFilesetPromise;
};

const prewarmModelAsset = (
  instanceId: number,
  label: string,
  candidates: readonly ModelAssetCandidate[],
  currentPromise: Promise<void> | null,
  setPromise: (promise: Promise<void> | null) => void,
) => {
  if (currentPromise) {
    logVideoEffects(instanceId, "model_prewarm_wait", {
      label,
      candidates,
    });
    return currentPromise;
  }

  const promise = (async () => {
    if (typeof window === "undefined" || typeof fetch !== "function") return;

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        logVideoEffects(instanceId, "model_prewarm_start", {
          label,
          ...candidate,
        });
        const response = await fetch(candidate.url, {
          cache: "force-cache",
          credentials: "omit",
          mode: candidate.source === "same-origin" ? "same-origin" : "cors",
        });
        if (!response.ok) {
          throw new Error(`Failed to prewarm ${label}: ${response.status}`);
        }
        await response.arrayBuffer();
        logVideoEffects(instanceId, "model_prewarm_done", {
          label,
          ...candidate,
        });
        return;
      } catch (err) {
        lastError = err;
        warnVideoEffects(instanceId, "model_prewarm_candidate_failed", {
          label,
          ...candidate,
          error: getErrorDebugSnapshot(err),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to prewarm ${label}`);
  })().catch((err) => {
    setPromise(null);
    warnVideoEffects(instanceId, "model_prewarm_failed", {
      label,
      candidates,
      error: getErrorDebugSnapshot(err),
    });
  });

  setPromise(promise);
  return promise;
};

const markVideoEffectsPipelineBusy = () => {
  if (typeof performance === "undefined") return;
  activeVideoEffectsPipelineBusyUntil = Math.max(
    activeVideoEffectsPipelineBusyUntil,
    performance.now() + ACTIVE_PIPELINE_PREWARM_SUPPRESSION_HOLD_MS,
  );
};

const isVideoEffectsPipelineBusyForPrewarm = () => {
  if (typeof performance === "undefined") {
    return activeVideoEffectsPipelineCount > 0;
  }
  return (
    activeVideoEffectsPipelineCount > 0 ||
    performance.now() < activeVideoEffectsPipelineBusyUntil
  );
};

const disposePrewarmedOutputWriterWorker = (reason: string) => {
  const entry = prewarmedOutputWriterWorker;
  if (!entry) return;
  prewarmedOutputWriterWorker = null;
  if (entry.idleTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(entry.idleTimerId);
  }
  logVideoEffects(entry.instanceId, "output_writer_worker_prewarm_dispose", {
    reason,
    ageMs: Math.round(performance.now() - entry.storedAt),
    outputTrack: getTrackDebugSnapshot(entry.track),
  });
  try {
    entry.worker.postMessage({ type: "CLOSE" });
  } catch {}
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      try {
        entry.worker.terminate();
      } catch {}
      try {
        entry.track.stop();
      } catch {}
    }, PROCESSOR_PREWARM_CLOSE_GRACE_MS);
  } else {
    try {
      entry.worker.terminate();
    } catch {}
    try {
      entry.track.stop();
    } catch {}
  }
};

const storePrewarmedOutputWriterWorker = (
  worker: Worker,
  track: MediaStreamTrackGeneratorInstance,
  ready: OutputWriterWorkerReadyMessage,
  instanceId: number,
) => {
  disposePrewarmedOutputWriterWorker("replaced");
  const entry: PrewarmedOutputWriterWorker = {
    worker,
    track,
    hasVideoFrame: ready.hasVideoFrame,
    hasWritableStream: ready.hasWritableStream,
    hasOffscreenCanvas: ready.hasOffscreenCanvas,
    renderer: ready.renderer,
    storedAt: performance.now(),
    instanceId,
    idleTimerId: null,
  };
  if (typeof window !== "undefined") {
    entry.idleTimerId = window.setTimeout(() => {
      if (prewarmedOutputWriterWorker?.worker === worker) {
        disposePrewarmedOutputWriterWorker("idle-timeout");
      }
    }, PROCESSOR_PREWARM_IDLE_TIMEOUT_MS);
  }
  prewarmedOutputWriterWorker = entry;
  logVideoEffects(instanceId, "output_writer_worker_prewarm_stored", {
    hasVideoFrame: ready.hasVideoFrame,
    hasWritableStream: ready.hasWritableStream,
    hasOffscreenCanvas: ready.hasOffscreenCanvas,
    renderer: ready.renderer,
    idleTimeoutMs: PROCESSOR_PREWARM_IDLE_TIMEOUT_MS,
    outputTrack: getTrackDebugSnapshot(track),
  });
};

const claimPrewarmedOutputWriterWorker = () => {
  const entry = prewarmedOutputWriterWorker;
  if (!entry) return null;
  prewarmedOutputWriterWorker = null;
  if (entry.idleTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(entry.idleTimerId);
  }
  return entry;
};

const closeClaimedOutputWriterWorker = (
  entry: PrewarmedOutputWriterWorker,
  reason: string,
) => {
  logVideoEffects(entry.instanceId, "output_writer_worker_claim_discarded", {
    reason,
    ageMs: Math.round(performance.now() - entry.storedAt),
    outputTrack: getTrackDebugSnapshot(entry.track),
  });
  try {
    entry.worker.postMessage({ type: "CLOSE" });
  } catch {}
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      try {
        entry.worker.terminate();
      } catch {}
      try {
        entry.track.stop();
      } catch {}
    }, PROCESSOR_PREWARM_CLOSE_GRACE_MS);
  } else {
    try {
      entry.worker.terminate();
    } catch {}
    try {
      entry.track.stop();
    } catch {}
  }
};

const getStoredPrewarmedProcessorWorker = (kind: ProcessorPrewarmKind) =>
  kind === "segmentation"
    ? prewarmedSegmentationProcessorWorker
    : prewarmedFaceProcessorWorker;

const setStoredPrewarmedProcessorWorker = (
  kind: ProcessorPrewarmKind,
  worker: PrewarmedProcessorWorker | null,
) => {
  if (kind === "segmentation") {
    prewarmedSegmentationProcessorWorker = worker;
  } else {
    prewarmedFaceProcessorWorker = worker;
  }
};

const disposePrewarmedProcessorWorker = (
  kind: ProcessorPrewarmKind,
  reason: string,
) => {
  const entry = getStoredPrewarmedProcessorWorker(kind);
  if (!entry) return;
  setStoredPrewarmedProcessorWorker(kind, null);
  if (entry.idleTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(entry.idleTimerId);
  }
  logVideoEffects(entry.instanceId, "processor_worker_prewarm_dispose", {
    kind,
    reason,
    warmupRan: entry.warmupRan,
    ageMs: Math.round(performance.now() - entry.storedAt),
  });
  try {
    entry.worker.postMessage({ type: "CLOSE" });
  } catch {}
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      try {
        entry.worker.terminate();
      } catch {}
    }, PROCESSOR_PREWARM_CLOSE_GRACE_MS);
  } else {
    try {
      entry.worker.terminate();
    } catch {}
  }
};

const storePrewarmedProcessorWorker = (
  kind: ProcessorPrewarmKind,
  worker: Worker,
  delegate: MediaPipeDelegate,
  warmupRan: boolean,
  instanceId: number,
) => {
  disposePrewarmedProcessorWorker(kind, "replaced");
  const entry: PrewarmedProcessorWorker = {
    worker,
    delegate,
    warmupRan,
    storedAt: performance.now(),
    instanceId,
    idleTimerId: null,
  };
  if (typeof window !== "undefined") {
    entry.idleTimerId = window.setTimeout(() => {
      if (getStoredPrewarmedProcessorWorker(kind)?.worker === worker) {
        disposePrewarmedProcessorWorker(kind, "idle-timeout");
      }
    }, PROCESSOR_PREWARM_IDLE_TIMEOUT_MS);
  }
  setStoredPrewarmedProcessorWorker(kind, entry);
  logVideoEffects(instanceId, "processor_worker_prewarm_stored", {
    kind,
    delegate,
    warmupRan,
    idleTimeoutMs: PROCESSOR_PREWARM_IDLE_TIMEOUT_MS,
  });
};

const claimPrewarmedProcessorWorker = (kind: ProcessorPrewarmKind) => {
  const entry = getStoredPrewarmedProcessorWorker(kind);
  if (!entry) return null;
  setStoredPrewarmedProcessorWorker(kind, null);
  if (entry.idleTimerId !== null && typeof window !== "undefined") {
    window.clearTimeout(entry.idleTimerId);
  }
  return entry;
};

const createProcessorPrewarmFrameSource = async () => {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = PROCESSOR_PREWARM_FRAME_WIDTH;
  canvas.height = PROCESSOR_PREWARM_FRAME_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d8b4a0";
  ctx.beginPath();
  ctx.ellipse(
    canvas.width * 0.5,
    canvas.height * 0.48,
    canvas.width * 0.16,
    canvas.height * 0.28,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.arc(canvas.width * 0.45, canvas.height * 0.42, 3, 0, Math.PI * 2);
  ctx.arc(canvas.width * 0.55, canvas.height * 0.42, 3, 0, Math.PI * 2);
  ctx.fill();

  const VideoFrameCtor = (
    globalThis as unknown as { VideoFrame?: unknown }
  ).VideoFrame as VideoFrameConstructor | undefined;
  if (VideoFrameCtor) {
    const frame = new VideoFrameCtor(canvas, { timestamp: 0 });
    return {
      source: frame,
      kind: "video-frame" as ModelWorkerInputSource,
      transfer: frame as unknown as Transferable,
      width: canvas.width,
      height: canvas.height,
    };
  }

  if (typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(canvas);
  return {
    source: bitmap,
    kind: "image-bitmap" as ModelWorkerInputSource,
    transfer: bitmap as unknown as Transferable,
    width: canvas.width,
    height: canvas.height,
  };
};

const postProcessorPrewarmFrame = async (
  worker: Worker,
  kind: ProcessorPrewarmKind,
) => {
  const frameSource = await createProcessorPrewarmFrameSource();
  if (!frameSource) return false;
  try {
    worker.postMessage(
      {
        type: kind === "segmentation" ? "SEGMENT" : "FACE",
        sequence: 1,
        processingConfigId: PROCESSOR_PREWARM_CONFIG_ID,
        source: frameSource.source,
        sourceKind: frameSource.kind,
        width: frameSource.width,
        height: frameSource.height,
        timestamp: 0,
      },
      [frameSource.transfer],
    );
    return true;
  } catch (err) {
    try {
      frameSource.source.close?.();
    } catch {}
    throw err;
  }
};

const createProcessorPrewarmWorker = (kind: ProcessorPrewarmKind) => {
  if (kind === "segmentation") {
    return new Worker(
      new URL(
        "../workers/video-effects-segmentation-processor-worker.ts",
        import.meta.url,
      ),
      {
        type: "module",
        name: "conclave-video-effects-segmentation-prewarm",
      },
    );
  }

  return new Worker(
    new URL(
      "../workers/video-effects-face-processor-worker.ts",
      import.meta.url,
    ),
    {
      type: "module",
      name: "conclave-video-effects-face-prewarm",
    },
  );
};

const prewarmProcessorWorker = (
  instanceId: number,
  kind: ProcessorPrewarmKind,
  currentPromise: Promise<void> | null,
  setPromise: (promise: Promise<void> | null) => void,
) => {
  if (isVideoEffectsPipelineBusyForPrewarm()) {
    logVideoEffects(instanceId, "processor_worker_prewarm_suppressed_busy", {
      kind,
      activePipelineCount: activeVideoEffectsPipelineCount,
      busyForMs:
        typeof performance === "undefined"
          ? null
          : Math.round(
              Math.max(0, activeVideoEffectsPipelineBusyUntil - performance.now()),
            ),
    });
    return Promise.resolve();
  }
  if (getStoredPrewarmedProcessorWorker(kind)) {
    logVideoEffects(instanceId, "processor_worker_prewarm_reuse_stored", {
      kind,
    });
    return Promise.resolve();
  }
  if (currentPromise) {
    logVideoEffects(instanceId, "processor_worker_prewarm_wait", { kind });
    return currentPromise;
  }

  const promise = new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      resolve();
      return;
    }

    let worker: Worker | null = null;
    let settled = false;
    let closePosted = false;
    let delegate: MediaPipeDelegate | null = null;
    let warmupStartedAt = 0;
    let warmupRan = false;
    const startedAt = performance.now();
    let timeoutId: number | null = null;
    const closeWorker = () => {
      if (!worker) return;
      if (!closePosted) {
        closePosted = true;
        try {
          worker.postMessage({ type: "CLOSE" });
        } catch {}
      }
      window.setTimeout(() => {
        try {
          worker?.terminate();
        } catch {}
        worker = null;
      }, PROCESSOR_PREWARM_CLOSE_GRACE_MS);
    };
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
      if (err) {
        closeWorker();
      }
    };
    timeoutId = window.setTimeout(() => {
      finish(new Error(`${kind} processor worker prewarm timed out.`));
    }, PROCESSOR_PREWARM_TIMEOUT_MS);

    try {
      logVideoEffects(instanceId, "processor_worker_prewarm_start", { kind });
      worker = createProcessorPrewarmWorker(kind);
      worker.onmessage = (
        event: MessageEvent<
          SegmentationProcessorWorkerMessage | FaceProcessorWorkerMessage
        >,
      ) => {
        const message = event.data;
        if (message.type === "READY") {
          delegate = message.delegate;
          if (isVideoEffectsPipelineBusyForPrewarm()) {
            logVideoEffects(instanceId, "processor_worker_prewarm_cancelled_busy", {
              kind,
              delegate,
              phase: "ready",
              elapsedMs: Math.round(performance.now() - startedAt),
              activePipelineCount: activeVideoEffectsPipelineCount,
            });
            closeWorker();
            finish();
            return;
          }
          warmupStartedAt = performance.now();
          postProcessorPrewarmFrame(worker as Worker, kind)
            .then((posted) => {
              if (!posted) {
                if (worker && delegate) {
                  storePrewarmedProcessorWorker(
                    kind,
                    worker,
                    delegate,
                    false,
                    instanceId,
                  );
                  worker = null;
                }
                logVideoEffects(instanceId, "processor_worker_prewarm_done", {
                  kind,
                  delegate,
                  warmupRan: false,
                  elapsedMs: Math.round(performance.now() - startedAt),
                });
                finish();
              }
            })
            .catch((err) => {
              warnVideoEffects(instanceId, "processor_worker_prewarm_frame_failed", {
                kind,
                error: getErrorDebugSnapshot(err),
              });
              if (worker && delegate) {
                storePrewarmedProcessorWorker(
                  kind,
                  worker,
                  delegate,
                  false,
                  instanceId,
                );
                worker = null;
              }
              logVideoEffects(instanceId, "processor_worker_prewarm_done", {
                kind,
                delegate,
                warmupRan: false,
                elapsedMs: Math.round(performance.now() - startedAt),
              });
              finish();
            });
        } else if (
          (kind === "segmentation" &&
            message.type === "SEGMENTATION_RESULT" &&
            message.processingConfigId === PROCESSOR_PREWARM_CONFIG_ID) ||
          (kind === "face" &&
            message.type === "FACE_RESULT" &&
            message.processingConfigId === PROCESSOR_PREWARM_CONFIG_ID)
        ) {
          warmupRan = true;
          if (isVideoEffectsPipelineBusyForPrewarm()) {
            logVideoEffects(instanceId, "processor_worker_prewarm_cancelled_busy", {
              kind,
              delegate,
              phase: "warmup-result",
              processingMs: Number(message.processingMs.toFixed(2)),
              elapsedMs: Math.round(performance.now() - startedAt),
              activePipelineCount: activeVideoEffectsPipelineCount,
            });
            closeWorker();
          } else if (worker && delegate) {
            storePrewarmedProcessorWorker(
              kind,
              worker,
              delegate,
              true,
              instanceId,
            );
            worker = null;
          }
          logVideoEffects(instanceId, "processor_worker_prewarm_frame_done", {
            kind,
            delegate,
            processingMs: Number(message.processingMs.toFixed(2)),
            elapsedMs: Math.round(performance.now() - warmupStartedAt),
          });
          logVideoEffects(instanceId, "processor_worker_prewarm_done", {
            kind,
            delegate,
            warmupRan,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          finish();
        } else if (message.type === "ERROR") {
          if (
            message.sequence === 1 &&
            delegate &&
            message.error &&
            worker
          ) {
            warnVideoEffects(instanceId, "processor_worker_prewarm_frame_failed", {
              kind,
              error: message.error,
            });
            storePrewarmedProcessorWorker(
              kind,
              worker,
              delegate,
              false,
              instanceId,
            );
            worker = null;
            logVideoEffects(instanceId, "processor_worker_prewarm_done", {
              kind,
              delegate,
              warmupRan: false,
              elapsedMs: Math.round(performance.now() - startedAt),
            });
            finish();
          } else {
            finish(message.error);
          }
        } else if (message.type === "CLOSED") {
          try {
            worker?.terminate();
          } catch {}
          worker = null;
        }
      };
      worker.onerror = (event) => {
        finish({
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        });
      };
      worker.postMessage({ type: "INIT" });
    } catch (err) {
      finish(err);
    }
  })
    .then(() => {
      setPromise(null);
    })
    .catch((err) => {
      setPromise(null);
      warnVideoEffects(instanceId, "processor_worker_prewarm_failed", {
        kind,
        error: getErrorDebugSnapshot(err),
      });
    });

  setPromise(promise);
  return promise;
};

const prewarmOutputWriterWorker = (
  instanceId: number,
  currentPromise: Promise<void> | null,
  setPromise: (promise: Promise<void> | null) => void,
) => {
  if (isVideoEffectsPipelineBusyForPrewarm()) {
    logVideoEffects(instanceId, "output_writer_worker_prewarm_suppressed_busy", {
      phase: "start",
      activePipelineCount: activeVideoEffectsPipelineCount,
      busyForMs:
        typeof performance === "undefined"
          ? null
          : Math.round(
              Math.max(0, activeVideoEffectsPipelineBusyUntil - performance.now()),
            ),
    });
    return Promise.resolve();
  }
  if (prewarmedOutputWriterWorker) {
    logVideoEffects(instanceId, "output_writer_worker_prewarm_reuse_stored", {
      ageMs: Math.round(
        performance.now() - prewarmedOutputWriterWorker.storedAt,
      ),
      outputTrack: getTrackDebugSnapshot(prewarmedOutputWriterWorker.track),
    });
    return Promise.resolve();
  }
  if (currentPromise) {
    logVideoEffects(instanceId, "output_writer_worker_prewarm_wait");
    return currentPromise;
  }

  const promise = new Promise<void>((resolve, reject) => {
    if (
      typeof window === "undefined" ||
      typeof Worker === "undefined"
    ) {
      resolve();
      return;
    }

    const GeneratorCtor = (
      globalThis as unknown as {
        MediaStreamTrackGenerator?: unknown;
      }
    ).MediaStreamTrackGenerator as
      | MediaStreamTrackGeneratorConstructor
      | undefined;
    if (!GeneratorCtor) {
      resolve();
      return;
    }

    let worker: Worker | null = null;
    let generatorTrack: MediaStreamTrackGeneratorInstance | null = null;
    let settled = false;
    let closePosted = false;
    let timeoutId: number | null = null;
    const startedAt = performance.now();
    const closeWorker = () => {
      if (worker && !closePosted) {
        closePosted = true;
        try {
          worker.postMessage({ type: "CLOSE" });
        } catch {}
      }
      window.setTimeout(() => {
        try {
          worker?.terminate();
        } catch {}
        worker = null;
        try {
          generatorTrack?.stop();
        } catch {}
        generatorTrack = null;
      }, PROCESSOR_PREWARM_CLOSE_GRACE_MS);
    };
    const finish = (err?: unknown, closeOnSuccess = true) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
      if (err || closeOnSuccess) {
        closeWorker();
      }
    };
    timeoutId = window.setTimeout(() => {
      if (isVideoEffectsPipelineBusyForPrewarm()) {
        logVideoEffects(
          instanceId,
          "output_writer_worker_prewarm_suppressed_busy",
          {
            phase: "timeout",
            elapsedMs: Math.round(performance.now() - startedAt),
            activePipelineCount: activeVideoEffectsPipelineCount,
            busyForMs: Math.round(
              Math.max(0, activeVideoEffectsPipelineBusyUntil - performance.now()),
            ),
          },
        );
        finish();
        return;
      }
      finish(new Error("output writer worker prewarm timed out."));
    }, PROCESSOR_PREWARM_TIMEOUT_MS);

    try {
      logVideoEffects(instanceId, "output_writer_worker_prewarm_start");
      const track = new GeneratorCtor({ kind: "video" });
      generatorTrack = track;
      worker = new Worker("/effects/video-effects-output-writer.js", {
        type: "module",
        name: "conclave-video-effects-output-writer-prewarm",
      });
      worker.onmessage = (
        event: MessageEvent<OutputWriterWorkerMessage>,
      ) => {
        const message = event.data;
        if (message.type === "READY") {
          if (isVideoEffectsPipelineBusyForPrewarm()) {
            logVideoEffects(
              instanceId,
              "output_writer_worker_prewarm_suppressed_busy",
              {
                phase: "ready",
                hasVideoFrame: message.hasVideoFrame,
                hasWritableStream: message.hasWritableStream,
                hasOffscreenCanvas: message.hasOffscreenCanvas,
                renderer: message.renderer,
                elapsedMs: Math.round(performance.now() - startedAt),
                activePipelineCount: activeVideoEffectsPipelineCount,
              },
            );
            finish();
            return;
          }
          if (!message.hasVideoFrame || !worker || !generatorTrack) {
            logVideoEffects(instanceId, "output_writer_worker_prewarm_done", {
              hasVideoFrame: message.hasVideoFrame,
              hasWritableStream: message.hasWritableStream,
              hasOffscreenCanvas: message.hasOffscreenCanvas,
              renderer: message.renderer,
              stored: false,
              elapsedMs: Math.round(performance.now() - startedAt),
            });
            finish();
            return;
          }
          storePrewarmedOutputWriterWorker(
            worker,
            generatorTrack,
            message,
            instanceId,
          );
          worker = null;
          generatorTrack = null;
          logVideoEffects(instanceId, "output_writer_worker_prewarm_done", {
            hasVideoFrame: message.hasVideoFrame,
            hasWritableStream: message.hasWritableStream,
            hasOffscreenCanvas: message.hasOffscreenCanvas,
            renderer: message.renderer,
            stored: true,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          finish(undefined, false);
        } else if (message.type === "ERROR") {
          finish(message.error);
        } else if (message.type === "CLOSED") {
          try {
            worker?.terminate();
          } catch {}
          worker = null;
          try {
            generatorTrack?.stop();
          } catch {}
          generatorTrack = null;
        }
      };
      worker.onerror = (event) => {
        finish({
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        });
      };
      let rendererCanvas: OffscreenCanvas | null = null;
      try {
        rendererCanvas = new OffscreenCanvas(1, 1);
      } catch {}
      const transferables: Transferable[] = [
        track.writable as unknown as Transferable,
      ];
      if (rendererCanvas) {
        transferables.push(rendererCanvas as unknown as Transferable);
      }
      worker.postMessage(
        {
          type: "INIT",
          writable: track.writable,
          canvas: rendererCanvas,
        },
        transferables,
      );
    } catch (err) {
      finish(err);
    }
  })
    .then(() => {
      setPromise(null);
    })
    .catch((err) => {
      setPromise(null);
      warnVideoEffects(instanceId, "output_writer_worker_prewarm_failed", {
        error: getErrorDebugSnapshot(err),
      });
    });

  setPromise(promise);
  return promise;
};

export const prewarmVideoEffectsRuntime = async ({
  reason = "manual",
  outputWriter = true,
}: {
  reason?: string;
  outputWriter?: boolean;
} = {}) => {
  if (typeof window === "undefined") return;
  const instanceId = 0;

  if (videoEffectsRuntimePrewarmDone) {
    logVideoEffects(instanceId, "runtime_prewarm_reuse", {
      reason,
      outputWriter,
    });
    return;
  }
  if (videoEffectsRuntimePrewarmPromise) {
    logVideoEffects(instanceId, "runtime_prewarm_wait", {
      reason,
      outputWriter,
    });
    return videoEffectsRuntimePrewarmPromise;
  }

  videoEffectsRuntimePrewarmPromise = (async () => {
    logVideoEffects(instanceId, "runtime_prewarm_requested", {
      reason,
      outputWriter,
    });
    const tasksReady = ensureSharedTasksVisionFileset(instanceId)
      .then(() => undefined)
      .catch((err) => {
        warnVideoEffects(instanceId, "runtime_tasks_fileset_prewarm_failed", {
          reason,
          error: getErrorDebugSnapshot(err),
        });
      });
    const outputWriterReady = outputWriter
      ? prewarmOutputWriterWorker(
          instanceId,
          outputWriterWorkerPrewarmPromise,
          (promise) => {
            outputWriterWorkerPrewarmPromise = promise;
          },
        )
      : Promise.resolve();

    await Promise.all([tasksReady, outputWriterReady]);
    videoEffectsRuntimePrewarmDone = true;
    logVideoEffects(instanceId, "runtime_prewarm_done", {
      reason,
      outputWriter,
    });
  })().finally(() => {
    videoEffectsRuntimePrewarmPromise = null;
  });

  return videoEffectsRuntimePrewarmPromise;
};

export const prewarmVideoEffectsAssets = async ({
  segmentation = false,
  face = false,
  faceFilter,
  backgrounds = [],
  reason = "manual",
}: {
  segmentation?: boolean;
  face?: boolean;
  faceFilter?: FaceFilterId;
  backgrounds?: BackgroundEffectId[];
  reason?: string;
} = {}) => {
  if (typeof window === "undefined") return;
  const instanceId = 0;
  const requestedBackgrounds = Array.from(new Set(backgrounds));
  const faceFilterGraph = faceFilter
    ? getFaceFilterEffectGraph(faceFilter)
    : null;
  const faceFilterGraphStats = faceFilter
    ? getFaceFilterEffectGraphStats(faceFilter)
    : null;
  const effectiveFace = face || Boolean(faceFilterGraph?.requiresFaceLandmarks);
  const effectiveSegmentation =
    segmentation || Boolean(faceFilterGraph?.requiresSegmentation);
  const canonicalBackgrounds = [...requestedBackgrounds].sort();
  const prewarmKey = JSON.stringify({
    segmentation: effectiveSegmentation,
    face: effectiveFace,
    faceFilter: faceFilterGraph?.meetGraphId ?? faceFilter ?? null,
    backgrounds: canonicalBackgrounds,
  });
  const existingPrewarm = videoEffectsAssetPrewarmPromises.get(prewarmKey);
  if (existingPrewarm) {
    logVideoEffects(instanceId, "prewarm_coalesce_inflight", {
      segmentation: effectiveSegmentation,
      face: effectiveFace,
      faceFilter,
      faceFilterGraph: faceFilterGraphStats,
      backgrounds: requestedBackgrounds,
      reason,
    });
    return existingPrewarm;
  }

  let prewarmPromise: Promise<void>;
  prewarmPromise = (async () => {
    logVideoEffects(instanceId, "prewarm_requested", {
      segmentation: effectiveSegmentation,
      face: effectiveFace,
      faceFilter,
      faceFilterGraph: faceFilterGraphStats,
      backgrounds: requestedBackgrounds,
      reason,
    });

    const tasksReady = ensureSharedTasksVisionFileset(instanceId)
      .then(() => undefined)
      .catch((err) => {
        warnVideoEffects(instanceId, "tasks_fileset_prewarm_failed", {
          reason,
          error: getErrorDebugSnapshot(err),
        });
      });

    const modelPromises: Promise<void>[] = [tasksReady];
    if (effectiveSegmentation || effectiveFace || requestedBackgrounds.length > 0) {
      modelPromises.push(
        prewarmOutputWriterWorker(
          instanceId,
          outputWriterWorkerPrewarmPromise,
          (promise) => {
            outputWriterWorkerPrewarmPromise = promise;
          },
        ),
      );
    }
    if (effectiveSegmentation) {
      modelPromises.push(
        prewarmModelAsset(
          instanceId,
          "selfie-segmenter",
          TASKS_SELFIE_SEGMENTER_MODELS,
          segmentationModelPrewarmPromise,
          (promise) => {
            segmentationModelPrewarmPromise = promise;
          },
        ),
        prewarmProcessorWorker(
          instanceId,
          "segmentation",
          segmentationProcessorWorkerPrewarmPromise,
          (promise) => {
            segmentationProcessorWorkerPrewarmPromise = promise;
          },
        ),
      );
    }
    if (effectiveFace) {
      modelPromises.push(
        prewarmModelAsset(
          instanceId,
          "face-landmarker",
          TASKS_FACE_LANDMARKER_MODELS,
          faceModelPrewarmPromise,
          (promise) => {
            faceModelPrewarmPromise = promise;
          },
        ),
        prewarmProcessorWorker(
          instanceId,
          "face",
          faceProcessorWorkerPrewarmPromise,
          (promise) => {
            faceProcessorWorkerPrewarmPromise = promise;
          },
        ),
      );
    }
    if (faceFilterGraph?.requiresMeetVideoPipe === true) {
      modelPromises.push(
        prewarmMeetVideoPipeRuntime(({ event, level, error, data }) => {
          const payload = {
            faceFilter,
            reason,
            data,
            error: error ? getErrorDebugSnapshot(error) : undefined,
          };
          if (level === "warn" || level === "error") {
            warnVideoEffects(instanceId, `meet_videopipe_${event}`, payload);
            return;
          }
          logVideoEffects(instanceId, `meet_videopipe_${event}`, payload);
        }),
      );
    }
    await Promise.all(modelPromises);
    await prewarmBackgroundImages(requestedBackgrounds, instanceId, reason);
    logVideoEffects(instanceId, "prewarm_done", {
      segmentation: effectiveSegmentation,
      face: effectiveFace,
      faceFilter,
      faceFilterGraph: faceFilterGraphStats,
      backgrounds: requestedBackgrounds,
      reason,
    });
  })().finally(() => {
    if (videoEffectsAssetPrewarmPromises.get(prewarmKey) === prewarmPromise) {
      videoEffectsAssetPrewarmPromises.delete(prewarmKey);
    }
  });
  videoEffectsAssetPrewarmPromises.set(prewarmKey, prewarmPromise);
  return prewarmPromise;
};

const stopProcessedTrackAfterGrace = (
  instanceId: number,
  track: MediaStreamTrack,
  reason: string,
) => {
  logVideoEffects(instanceId, "schedule_processed_track_stop", {
    reason,
    delayMs: PROCESSED_TRACK_STOP_GRACE_MS,
    track: getTrackDebugSnapshot(track),
  });
  window.setTimeout(() => {
    if (track.readyState !== "live") return;
    warnVideoEffects(instanceId, "stop_stale_processed_track", {
      reason,
      track: getTrackDebugSnapshot(track),
    });
    track.stop();
  }, PROCESSED_TRACK_STOP_GRACE_MS);
};

const probeCanvasFrameVisibility = (
  source: HTMLCanvasElement,
  probeCanvas: HTMLCanvasElement,
  probeCtx: CanvasRenderingContext2D | null,
): CanvasVisibilityProbe => {
  if (!probeCtx || source.width <= 0 || source.height <= 0) {
    return { averageLuma: 255, peakLuma: 255, visible: true };
  }
  if (
    probeCanvas.width !== OUTPUT_PROBE_WIDTH ||
    probeCanvas.height !== OUTPUT_PROBE_HEIGHT
  ) {
    probeCanvas.width = OUTPUT_PROBE_WIDTH;
    probeCanvas.height = OUTPUT_PROBE_HEIGHT;
  }

  probeCtx.drawImage(source, 0, 0, OUTPUT_PROBE_WIDTH, OUTPUT_PROBE_HEIGHT);
  const data = probeCtx.getImageData(
    0,
    0,
    OUTPUT_PROBE_WIDTH,
    OUTPUT_PROBE_HEIGHT,
  ).data;
  let totalLuma = 0;
  let peakLuma = 0;
  const pixelCount = OUTPUT_PROBE_WIDTH * OUTPUT_PROBE_HEIGHT;
  for (let offset = 0; offset < data.length; offset += 4) {
    const luma =
      data[offset] * 0.2126 +
      data[offset + 1] * 0.7152 +
      data[offset + 2] * 0.0722;
    totalLuma += luma;
    peakLuma = Math.max(peakLuma, luma);
  }

  const averageLuma = totalLuma / pixelCount;
  return {
    averageLuma,
    peakLuma,
    visible:
      averageLuma >= MIN_VISIBLE_AVERAGE_LUMA ||
      peakLuma >= MIN_VISIBLE_PEAK_LUMA,
  };
};

const probeVideoFrameVisibility = (
  video: HTMLVideoElement,
  probeCanvas: HTMLCanvasElement,
  probeCtx: CanvasRenderingContext2D | null,
): CanvasVisibilityProbe => {
  if (!probeCtx || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return { averageLuma: 0, peakLuma: 0, visible: false };
  }
  if (
    probeCanvas.width !== OUTPUT_PROBE_WIDTH ||
    probeCanvas.height !== OUTPUT_PROBE_HEIGHT
  ) {
    probeCanvas.width = OUTPUT_PROBE_WIDTH;
    probeCanvas.height = OUTPUT_PROBE_HEIGHT;
  }

  try {
    probeCtx.drawImage(video, 0, 0, OUTPUT_PROBE_WIDTH, OUTPUT_PROBE_HEIGHT);
  } catch {
    return { averageLuma: 0, peakLuma: 0, visible: false };
  }

  const data = probeCtx.getImageData(
    0,
    0,
    OUTPUT_PROBE_WIDTH,
    OUTPUT_PROBE_HEIGHT,
  ).data;
  let totalLuma = 0;
  let peakLuma = 0;
  const pixelCount = OUTPUT_PROBE_WIDTH * OUTPUT_PROBE_HEIGHT;
  for (let offset = 0; offset < data.length; offset += 4) {
    const luma =
      data[offset] * 0.2126 +
      data[offset + 1] * 0.7152 +
      data[offset + 2] * 0.0722;
    totalLuma += luma;
    peakLuma = Math.max(peakLuma, luma);
  }

  const averageLuma = totalLuma / pixelCount;
  return {
    averageLuma,
    peakLuma,
    visible:
      averageLuma >= MIN_VISIBLE_AVERAGE_LUMA ||
      peakLuma >= MIN_VISIBLE_PEAK_LUMA,
  };
};

const getLowLightSampleContexts = () => {
  if (typeof document === "undefined") return null;

  if (!lowLightSourceSampleCanvas) {
    lowLightSourceSampleCanvas = document.createElement("canvas");
    lowLightSourceSampleCtx = lowLightSourceSampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }
  if (!lowLightMaskSampleCanvas) {
    lowLightMaskSampleCanvas = document.createElement("canvas");
    lowLightMaskSampleCtx = lowLightMaskSampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }
  if (!lowLightSourceSampleCtx || !lowLightMaskSampleCtx) return null;

  if (
    lowLightSourceSampleCanvas.width !== LOW_LIGHT_SAMPLE_WIDTH ||
    lowLightSourceSampleCanvas.height !== LOW_LIGHT_SAMPLE_HEIGHT
  ) {
    lowLightSourceSampleCanvas.width = LOW_LIGHT_SAMPLE_WIDTH;
    lowLightSourceSampleCanvas.height = LOW_LIGHT_SAMPLE_HEIGHT;
  }
  if (
    lowLightMaskSampleCanvas.width !== LOW_LIGHT_SAMPLE_WIDTH ||
    lowLightMaskSampleCanvas.height !== LOW_LIGHT_SAMPLE_HEIGHT
  ) {
    lowLightMaskSampleCanvas.width = LOW_LIGHT_SAMPLE_WIDTH;
    lowLightMaskSampleCanvas.height = LOW_LIGHT_SAMPLE_HEIGHT;
  }

  return {
    sourceCanvas: lowLightSourceSampleCanvas,
    maskCanvas: lowLightMaskSampleCanvas,
    sourceCtx: lowLightSourceSampleCtx,
    maskCtx: lowLightMaskSampleCtx,
  };
};

const readCanvasSourceDimension = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "baseVal" in value &&
    typeof (value as { baseVal?: { value?: unknown } }).baseVal?.value ===
      "number"
  ) {
    return (value as { baseVal: { value: number } }).baseVal.value;
  }
  return 0;
};

const getCanvasImageSourceSize = (source: CanvasImageSource) => {
  const sourceLike = source as Partial<{
    width: unknown;
    height: unknown;
    videoWidth: unknown;
    videoHeight: unknown;
    naturalWidth: unknown;
    naturalHeight: unknown;
    displayWidth: unknown;
    displayHeight: unknown;
    codedWidth: unknown;
    codedHeight: unknown;
  }>;
  const width =
    readCanvasSourceDimension(sourceLike.videoWidth) ||
    readCanvasSourceDimension(sourceLike.naturalWidth) ||
    readCanvasSourceDimension(sourceLike.displayWidth) ||
    readCanvasSourceDimension(sourceLike.codedWidth) ||
    readCanvasSourceDimension(sourceLike.width);
  const height =
    readCanvasSourceDimension(sourceLike.videoHeight) ||
    readCanvasSourceDimension(sourceLike.naturalHeight) ||
    readCanvasSourceDimension(sourceLike.displayHeight) ||
    readCanvasSourceDimension(sourceLike.codedHeight) ||
    readCanvasSourceDimension(sourceLike.height);

  if (width <= 0 || height <= 0) return null;
  return { width, height };
};

const isSameCanvasSize = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= 1;

const drawSegmentationMaskToOutput = (
  ctx: CanvasRenderingContext2D,
  segmentationMask: CanvasImageSource,
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  renderWidth: number,
  renderHeight: number,
  targetWidth = renderWidth,
  targetHeight = renderHeight,
) => {
  const maskSize = getCanvasImageSourceSize(segmentationMask);
  const resolvedSourceWidth = sourceWidth > 0 ? sourceWidth : renderWidth;
  const resolvedSourceHeight = sourceHeight > 0 ? sourceHeight : renderHeight;
  const isFullSourceCrop =
    crop.sx <= 1 &&
    crop.sy <= 1 &&
    Math.abs(crop.sw - resolvedSourceWidth) <= 1 &&
    Math.abs(crop.sh - resolvedSourceHeight) <= 1;
  const isRenderSizedMask =
    maskSize &&
    isSameCanvasSize(maskSize.width, renderWidth) &&
    isSameCanvasSize(maskSize.height, renderHeight);

  if (isRenderSizedMask && isFullSourceCrop && maskSize) {
    ctx.drawImage(
      segmentationMask,
      0,
      0,
      maskSize.width,
      maskSize.height,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    return "render-output";
  }

  if (maskSize) {
    const cropScaleX = maskSize.width / resolvedSourceWidth;
    const cropScaleY = maskSize.height / resolvedSourceHeight;
    const sx = clamp(crop.sx * cropScaleX, 0, Math.max(0, maskSize.width - 1));
    const sy = clamp(crop.sy * cropScaleY, 0, Math.max(0, maskSize.height - 1));
    const sw = clamp(crop.sw * cropScaleX, 1, Math.max(1, maskSize.width - sx));
    const sh = clamp(crop.sh * cropScaleY, 1, Math.max(1, maskSize.height - sy));
    ctx.drawImage(
      segmentationMask,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    return isRenderSizedMask ? "render-crop" : "source-crop";
  }

  ctx.drawImage(
    segmentationMask,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  return "source-crop";
};

const createLowLightSourceFallback = (
  sourceProbe: CanvasVisibilityProbe,
  reason: string,
  overrides: Partial<LowLightSourceStats> = {},
): LowLightSourceStats => ({
  foregroundAverageLuma: sourceProbe.averageLuma,
  backgroundAverageLuma: sourceProbe.averageLuma,
  hasSegmentationMask: false,
  foregroundSampleWeight: 0,
  backgroundSampleWeight: 0,
  maskAverageConfidence: 0,
  maskMinConfidence: 0,
  maskMaxConfidence: 0,
  maskSampleMode: "none",
  samplePixelCount: 0,
  sampleReason: reason,
  ...overrides,
});

const getAutoFrameMaskSampleContext = () => {
  if (typeof document === "undefined") return null;
  if (!autoFrameMaskSampleCanvas) {
    autoFrameMaskSampleCanvas = document.createElement("canvas");
    autoFrameMaskSampleCtx = autoFrameMaskSampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }
  if (!autoFrameMaskSampleCtx) return null;
  if (
    autoFrameMaskSampleCanvas.width !== AUTO_FRAME_MASK_SAMPLE_WIDTH ||
    autoFrameMaskSampleCanvas.height !== AUTO_FRAME_MASK_SAMPLE_HEIGHT
  ) {
    autoFrameMaskSampleCanvas.width = AUTO_FRAME_MASK_SAMPLE_WIDTH;
    autoFrameMaskSampleCanvas.height = AUTO_FRAME_MASK_SAMPLE_HEIGHT;
  }
  return {
    canvas: autoFrameMaskSampleCanvas,
    ctx: autoFrameMaskSampleCtx,
  };
};

const sampleForegroundBoundsFromSegmentationMask = (
  segmentationMask: CanvasImageSource | null,
  sourceWidth: number,
  sourceHeight: number,
  renderWidth: number,
  renderHeight: number,
): ForegroundBounds | null => {
  if (
    !segmentationMask ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    renderWidth <= 0 ||
    renderHeight <= 0
  ) {
    return null;
  }
  const sample = getAutoFrameMaskSampleContext();
  if (!sample) return null;

  const { canvas, ctx } = sample;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const fullFrameCrop = {
    sx: 0,
    sy: 0,
    sw: sourceWidth,
    sh: sourceHeight,
  };
  let maskSampleMode = "none";
  try {
    maskSampleMode = drawSegmentationMaskToOutput(
      ctx,
      segmentationMask,
      fullFrameCrop,
      sourceWidth,
      sourceHeight,
      renderWidth,
      renderHeight,
      canvas.width,
      canvas.height,
    );
  } catch {
    return null;
  }

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const samplePixelCount = canvas.width * canvas.height;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  let weightedX = 0;
  let weightedY = 0;
  let confidenceWeight = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const maskLuma =
        (data[offset] * 0.2126 +
          data[offset + 1] * 0.7152 +
          data[offset + 2] * 0.0722) /
        255;
      const maskAlpha = data[offset + 3] / 255;
      const confidence = clamp(
        maskAlpha < 0.995 ? maskAlpha : maskLuma,
        0,
        1,
      );
      if (confidence < AUTO_FRAME_FOREGROUND_THRESHOLD) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1);
      maxY = Math.max(maxY, y + 1);
      weightedX += (x + 0.5) * confidence;
      weightedY += (y + 0.5) * confidence;
      confidenceWeight += confidence;
    }
  }

  if (
    maxX <= minX ||
    maxY <= minY ||
    confidenceWeight < samplePixelCount * AUTO_FRAME_MIN_WEIGHT_RATIO
  ) {
    return null;
  }

  const scaleX = sourceWidth / canvas.width;
  const scaleY = sourceHeight / canvas.height;
  const bounds = {
    minX: clamp(minX * scaleX, 0, sourceWidth),
    minY: clamp(minY * scaleY, 0, sourceHeight),
    maxX: clamp(maxX * scaleX, 0, sourceWidth),
    maxY: clamp(maxY * scaleY, 0, sourceHeight),
    centerX: clamp((weightedX / confidenceWeight) * scaleX, 0, sourceWidth),
    centerY: clamp((weightedY / confidenceWeight) * scaleY, 0, sourceHeight),
  };
  return {
    ...bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    confidenceWeight: Number(confidenceWeight.toFixed(2)),
    coverage: Number((confidenceWeight / samplePixelCount).toFixed(4)),
    samplePixelCount,
    maskSampleMode,
  };
};

const sampleLowLightSourceStats = (
  source: CanvasImageSource,
  segmentationMask: CanvasImageSource | null,
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  renderWidth: number,
  renderHeight: number,
  sourceProbe: CanvasVisibilityProbe,
): LowLightSourceStats => {
  if (!segmentationMask) {
    return createLowLightSourceFallback(sourceProbe, "no mask");
  }
  if (
    crop.sw <= 0 ||
    crop.sh <= 0 ||
    renderWidth <= 0 ||
    renderHeight <= 0
  ) {
    return createLowLightSourceFallback(sourceProbe, "invalid geometry");
  }

  const contexts = getLowLightSampleContexts();
  if (!contexts) {
    return createLowLightSourceFallback(sourceProbe, "no sample context");
  }

  const { sourceCtx, maskCtx, sourceCanvas, maskCanvas } = contexts;
  try {
    sourceCtx.clearRect(0, 0, LOW_LIGHT_SAMPLE_WIDTH, LOW_LIGHT_SAMPLE_HEIGHT);
    maskCtx.clearRect(0, 0, LOW_LIGHT_SAMPLE_WIDTH, LOW_LIGHT_SAMPLE_HEIGHT);
    sourceCtx.drawImage(
      source,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      LOW_LIGHT_SAMPLE_WIDTH,
      LOW_LIGHT_SAMPLE_HEIGHT,
    );
    const maskSampleMode = drawSegmentationMaskToOutput(
      maskCtx,
      segmentationMask,
      crop,
      sourceWidth,
      sourceHeight,
      renderWidth,
      renderHeight,
      LOW_LIGHT_SAMPLE_WIDTH,
      LOW_LIGHT_SAMPLE_HEIGHT,
    );

    const sourceData = sourceCtx.getImageData(
      0,
      0,
      sourceCanvas.width,
      sourceCanvas.height,
    ).data;
    const maskData = maskCtx.getImageData(
      0,
      0,
      maskCanvas.width,
      maskCanvas.height,
    ).data;
    let foregroundWeightedLuma = 0;
    let backgroundWeightedLuma = 0;
    let foregroundWeight = 0;
    let backgroundWeight = 0;
    let maskConfidenceTotal = 0;
    let maskMinConfidence = 1;
    let maskMaxConfidence = 0;
    const samplePixelCount = LOW_LIGHT_SAMPLE_WIDTH * LOW_LIGHT_SAMPLE_HEIGHT;

    for (let offset = 0; offset < sourceData.length; offset += 4) {
      const sourceLuma =
        sourceData[offset] * 0.2126 +
        sourceData[offset + 1] * 0.7152 +
        sourceData[offset + 2] * 0.0722;
      const maskLuma =
        (maskData[offset] * 0.2126 +
          maskData[offset + 1] * 0.7152 +
          maskData[offset + 2] * 0.0722) /
        255;
      const maskAlpha = maskData[offset + 3] / 255;
      const foregroundConfidence = clamp(
        maskAlpha < 0.995 ? maskAlpha : maskLuma,
        0,
        1,
      );
      const backgroundConfidence = 1 - foregroundConfidence;
      maskConfidenceTotal += foregroundConfidence;
      maskMinConfidence = Math.min(maskMinConfidence, foregroundConfidence);
      maskMaxConfidence = Math.max(maskMaxConfidence, foregroundConfidence);
      foregroundWeightedLuma += sourceLuma * foregroundConfidence;
      backgroundWeightedLuma += sourceLuma * backgroundConfidence;
      foregroundWeight += foregroundConfidence;
      backgroundWeight += backgroundConfidence;
    }

    const maskAverageConfidence = maskConfidenceTotal / samplePixelCount;
    const debugSampleStats = {
      maskAverageConfidence: Number(maskAverageConfidence.toFixed(4)),
      maskMinConfidence: Number(maskMinConfidence.toFixed(4)),
      maskMaxConfidence: Number(maskMaxConfidence.toFixed(4)),
      maskSampleMode,
      samplePixelCount,
    };

    const minUsefulWeight = samplePixelCount * 0.02;
    if (foregroundWeight < minUsefulWeight && backgroundWeight < minUsefulWeight) {
      return createLowLightSourceFallback(sourceProbe, "unusable mask weights", {
        foregroundSampleWeight: Number(foregroundWeight.toFixed(2)),
        backgroundSampleWeight: Number(backgroundWeight.toFixed(2)),
        ...debugSampleStats,
      });
    }
    const hasForeground = foregroundWeight >= minUsefulWeight;
    const hasBackground = backgroundWeight >= minUsefulWeight;
    const foregroundAverageLuma = hasForeground
      ? foregroundWeightedLuma / foregroundWeight
      : sourceProbe.averageLuma;
    const backgroundAverageLuma = hasBackground
      ? backgroundWeightedLuma / backgroundWeight
      : sourceProbe.averageLuma;

    return {
      foregroundAverageLuma,
      backgroundAverageLuma,
      hasSegmentationMask: true,
      foregroundSampleWeight: Number(foregroundWeight.toFixed(2)),
      backgroundSampleWeight: Number(backgroundWeight.toFixed(2)),
      ...debugSampleStats,
      sampleReason:
        hasForeground && hasBackground
          ? "ok"
          : hasForeground
            ? "foreground only mask"
            : "background only mask",
    };
  } catch (err) {
    return createLowLightSourceFallback(sourceProbe, "sample failed", {
      sampleReason:
        err instanceof Error && err.message
          ? `sample failed: ${err.message}`
          : "sample failed",
    });
  }
};

const getStyleFilter = (
  style: AppearanceStyleId,
  studioLook: boolean,
  lowLightStrength = 0,
): string => {
  const filters: string[] = [];
  if (lowLightStrength > 0) {
    filters.push(
      `brightness(${(1 + lowLightStrength * 0.34).toFixed(3)})`,
      `contrast(${(1 + lowLightStrength * 0.08).toFixed(3)})`,
      `saturate(${(1 + lowLightStrength * 0.05).toFixed(3)})`,
    );
  }
  if (style === "cloudy") {
    filters.push("brightness(1.08)", "saturate(0.92)");
  } else if (style === "ocean") {
    filters.push("brightness(1.02)", "saturate(1.16)", "hue-rotate(188deg)");
  } else if (style === "mono") {
    filters.push("grayscale(1)", "contrast(1.06)");
  } else if (style === "glow") {
    filters.push("brightness(1.08)", "contrast(1.18)", "saturate(1.12)");
  } else if (style === "bloom") {
    filters.push("brightness(1.1)", "contrast(1.04)", "saturate(1.18)");
  } else if (style === "moonlight") {
    filters.push(
      "brightness(0.94)",
      "contrast(1.1)",
      "saturate(0.82)",
      "hue-rotate(196deg)",
    );
  } else if (style === "sunlight") {
    filters.push(
      "brightness(1.09)",
      "contrast(1.05)",
      "saturate(1.12)",
      "sepia(0.08)",
    );
  }
  if (studioLook) {
    filters.push("contrast(1.08)", "saturate(1.06)");
  }
  return filters.length ? filters.join(" ") : "none";
};

const applyAppearanceStyleOverlay = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: AppearanceStyleId,
) => {
  if (style === "none" || style === "cloudy" || style === "ocean" || style === "mono") {
    return;
  }

  ctx.save();
  if (style === "glow") {
    ctx.globalCompositeOperation = "screen";
    ctx.strokeStyle = "rgba(250,204,21,0.3)";
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, width - 8, height - 8);
  } else if (style === "bloom") {
    const gradient = ctx.createRadialGradient(
      width * 0.5,
      height * 0.42,
      Math.min(width, height) * 0.08,
      width * 0.5,
      height * 0.45,
      Math.max(width, height) * 0.68,
    );
    gradient.addColorStop(0, "rgba(255,255,245,0.2)");
    gradient.addColorStop(0.46, "rgba(255,214,170,0.1)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else if (style === "moonlight") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "rgba(56,94,185,0.22)");
    gradient.addColorStop(0.58, "rgba(21,42,92,0.08)");
    gradient.addColorStop(1, "rgba(4,11,28,0.16)");
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = "rgba(112,154,255,0.08)";
    ctx.fillRect(0, 0, width, height);
  } else if (style === "sunlight") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "rgba(255,235,169,0.22)");
    gradient.addColorStop(0.42, "rgba(255,181,95,0.08)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
};

const computeLowLightRenderStats = (
  effects: VideoEffectsState,
  sourceProbe: CanvasVisibilityProbe,
  lowLightSourceStats: LowLightSourceStats,
): LowLightRenderStats => {
  const sourceAverageLuma = Number(sourceProbe.averageLuma.toFixed(3));
  const sourcePeakLuma = Number(sourceProbe.peakLuma.toFixed(3));
  const foregroundAverageLuma = Number(
    lowLightSourceStats.foregroundAverageLuma.toFixed(3),
  );
  const backgroundAverageLuma = Number(
    lowLightSourceStats.backgroundAverageLuma.toFixed(3),
  );
  const foregroundBrightness = Number(
    clamp(
      (lowLightSourceStats.foregroundAverageLuma / 255) * 100,
      0,
      100,
    ).toFixed(2),
  );
  const backgroundBrightness = Number(
    clamp(
      (lowLightSourceStats.backgroundAverageLuma / 255) * 100,
      0,
      100,
    ).toFixed(2),
  );
  if (!effects.studioLighting) {
    return {
      enabled: false,
      foregroundBrightness,
      backgroundBrightness,
      brighteningStrength: 0,
      targetBrighteningStrength: 0,
      transitionProgress: 1,
      transitionActive: false,
      transitionMs: LOW_LIGHT_TRANSITION_MS,
      sourceAverageLuma,
      sourcePeakLuma,
      foregroundAverageLuma,
      backgroundAverageLuma,
      hasSegmentationMask: lowLightSourceStats.hasSegmentationMask,
      foregroundSampleWeight: lowLightSourceStats.foregroundSampleWeight,
      backgroundSampleWeight: lowLightSourceStats.backgroundSampleWeight,
      maskAverageConfidence: lowLightSourceStats.maskAverageConfidence,
      maskMinConfidence: lowLightSourceStats.maskMinConfidence,
      maskMaxConfidence: lowLightSourceStats.maskMaxConfidence,
      maskSampleMode: lowLightSourceStats.maskSampleMode,
      samplePixelCount: lowLightSourceStats.samplePixelCount,
      sampleReason: lowLightSourceStats.sampleReason,
    };
  }

  const targetAverageLuma = 132;
  const adaptiveStrength = clamp(
    (targetAverageLuma - lowLightSourceStats.foregroundAverageLuma) /
      targetAverageLuma,
    0,
    1,
  );
  const backlightCompensation = clamp(
    (lowLightSourceStats.backgroundAverageLuma -
      lowLightSourceStats.foregroundAverageLuma) /
      96,
    0,
    0.55,
  );
  const brighteningStrength = Math.max(
    0.12,
    clamp(adaptiveStrength + backlightCompensation, 0, 1),
  );
  return {
    enabled: true,
    foregroundBrightness,
    backgroundBrightness,
    brighteningStrength: Number((brighteningStrength * 100).toFixed(2)),
    targetBrighteningStrength: Number((brighteningStrength * 100).toFixed(2)),
    transitionProgress: 1,
    transitionActive: false,
    transitionMs: LOW_LIGHT_TRANSITION_MS,
    sourceAverageLuma,
    sourcePeakLuma,
    foregroundAverageLuma,
    backgroundAverageLuma,
    hasSegmentationMask: lowLightSourceStats.hasSegmentationMask,
    foregroundSampleWeight: lowLightSourceStats.foregroundSampleWeight,
    backgroundSampleWeight: lowLightSourceStats.backgroundSampleWeight,
    maskAverageConfidence: lowLightSourceStats.maskAverageConfidence,
    maskMinConfidence: lowLightSourceStats.maskMinConfidence,
    maskMaxConfidence: lowLightSourceStats.maskMaxConfidence,
    maskSampleMode: lowLightSourceStats.maskSampleMode,
    samplePixelCount: lowLightSourceStats.samplePixelCount,
    sampleReason: lowLightSourceStats.sampleReason,
  };
};

const createLowLightTransitionState = (): LowLightTransitionState => ({
  renderedStrength: 0,
  startStrength: 0,
  targetStrength: 0,
  startedAt: 0,
  lastUpdatedAt: 0,
  targetEnabled: false,
});

const applyLowLightTransition = (
  rawStats: LowLightRenderStats,
  transition: LowLightTransitionState,
  now: number,
): LowLightRenderStats => {
  const targetStrength = rawStats.enabled ? rawStats.brighteningStrength : 0;
  const targetChanged =
    transition.lastUpdatedAt === 0 ||
    rawStats.enabled !== transition.targetEnabled ||
    Math.abs(targetStrength - transition.targetStrength) >
      LOW_LIGHT_TARGET_CHANGE_THRESHOLD;

  if (targetChanged) {
    transition.startStrength = transition.renderedStrength;
    transition.targetStrength = targetStrength;
    transition.startedAt = now;
    transition.targetEnabled = rawStats.enabled;
  }

  transition.lastUpdatedAt = now;
  const progress = clamp(
    (now - transition.startedAt) / LOW_LIGHT_TRANSITION_MS,
    0,
    1,
  );
  const easedProgress = smoothStep(progress);
  transition.renderedStrength = Number(
    lerp(
      transition.startStrength,
      transition.targetStrength,
      easedProgress,
    ).toFixed(2),
  );

  if (progress >= 1) {
    transition.renderedStrength = Number(transition.targetStrength.toFixed(2));
  }

  const transitionActive =
    progress < 1 ||
    Math.abs(transition.renderedStrength - transition.targetStrength) > 0.1;

  return {
    ...rawStats,
    brighteningStrength: transition.renderedStrength,
    targetBrighteningStrength: Number(transition.targetStrength.toFixed(2)),
    transitionProgress: Number(progress.toFixed(3)),
    transitionActive,
    transitionMs: LOW_LIGHT_TRANSITION_MS,
  };
};

const getPoint = (
  landmark: NormalizedLandmark | undefined,
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) => {
  if (!landmark) return null;
  const sourceX = landmark.x * sourceWidth;
  const sourceY = landmark.y * sourceHeight;
  return {
    x: ((sourceX - crop.sx) / crop.sw) * outputWidth,
    y: ((sourceY - crop.sy) / crop.sh) * outputHeight,
  };
};

type CanvasPoint = {
  x: number;
  y: number;
};

const getAveragePoint = (points: Array<CanvasPoint | null>) => {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const point of points) {
    if (!point) continue;
    x += point.x;
    y += point.y;
    count += 1;
  }
  if (count <= 0) return null;
  return { x: x / count, y: y / count };
};

const getPointBounds = (points: Array<CanvasPoint | null>) => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const point of points) {
    if (!point) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    count += 1;
  }
  if (count <= 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
};

const sortPointPairByX = <T extends CanvasPoint>(points: [T, T]): [T, T] =>
  points[0].x <= points[1].x ? points : [points[1], points[0]];

const getPointDistance = (a: CanvasPoint, b: CanvasPoint) =>
  Math.hypot(b.x - a.x, b.y - a.y);

const getLandmarkBounds = (
  landmarks: NormalizedLandmarkList | null,
  width: number,
  height: number,
) => {
  if (!landmarks?.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    minX: minX * width,
    minY: minY * height,
    maxX: maxX * width,
    maxY: maxY * height,
    centerX: ((minX + maxX) / 2) * width,
    centerY: ((minY + maxY) / 2) * height,
  };
};

const computeCrop = (
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  effects: VideoEffectsState,
  landmarks: NormalizedLandmarkList | null,
  foregroundBounds: ForegroundBounds | null,
): AutoFrameTarget => {
  const fullFrameCrop = { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight };
  if (!effects.framing) {
    return {
      enabled: false,
      source: "off",
      zoom: 1,
      targetCrop: fullFrameCrop,
      foregroundBounds,
      faceBounds: null,
    };
  }

  const faceBounds = getLandmarkBounds(landmarks, sourceWidth, sourceHeight);
  let source: AutoFrameSource = "center";
  let zoom = 1.06;
  let sw = sourceWidth / zoom;
  let sh = sourceHeight / zoom;
  let targetX = sourceWidth / 2;
  let targetY = sourceHeight / 2;

  if (faceBounds) {
    source = "face";
    zoom = 1.14;
    sw = sourceWidth / zoom;
    sh = sourceHeight / zoom;
    targetX = faceBounds.centerX;
    targetY = faceBounds.centerY - sourceHeight * 0.035;
  } else if (foregroundBounds) {
    source = "foreground";
    const targetAspect =
      width > 0 && height > 0 ? width / height : sourceWidth / sourceHeight;
    const minCropWidth = sourceWidth / AUTO_FRAME_MAX_ZOOM;
    const foregroundCropWidth = foregroundBounds.width * 2.28;
    const foregroundCropHeight = foregroundBounds.height * 1.58;
    sw = clamp(
      Math.max(
        foregroundCropWidth,
        foregroundCropHeight * targetAspect,
        minCropWidth,
      ),
      minCropWidth,
      sourceWidth,
    );
    sh = sw / targetAspect;
    if (sh > sourceHeight) {
      sh = sourceHeight;
      sw = clamp(sh * targetAspect, minCropWidth, sourceWidth);
    }
    zoom = sourceWidth / sw;
    targetX = foregroundBounds.centerX;
    targetY = foregroundBounds.centerY - foregroundBounds.height * 0.08;
  }

  const targetCrop = {
    sx: clamp(targetX - sw / 2, 0, Math.max(0, sourceWidth - sw)),
    sy: clamp(targetY - sh / 2, 0, Math.max(0, sourceHeight - sh)),
    sw,
    sh,
  };
  return {
    enabled: true,
    source,
    zoom: Number(zoom.toFixed(3)),
    targetCrop,
    foregroundBounds,
    faceBounds,
  };
};

const roundFrameNumber = (value: number, digits = 4) =>
  Number(value.toFixed(digits));

const roundCropRect = (crop: CropRect): CropRect => ({
  sx: roundFrameNumber(crop.sx, 2),
  sy: roundFrameNumber(crop.sy, 2),
  sw: roundFrameNumber(crop.sw, 2),
  sh: roundFrameNumber(crop.sh, 2),
});

const createHumanTrackFromBounds = (
  trackId: string,
  source: VideoEffectsHumanTrack["source"],
  bounds: LandmarkBounds | ForegroundBounds,
  frameWidth: number,
  frameHeight: number,
): VideoEffectsHumanTrack | null => {
  if (frameWidth <= 0 || frameHeight <= 0) return null;
  const width = clamp((bounds.maxX - bounds.minX) / frameWidth, 0, 1);
  const height = clamp((bounds.maxY - bounds.minY) / frameHeight, 0, 1);
  return {
    trackId,
    source,
    centerX: roundFrameNumber(clamp(bounds.centerX / frameWidth, 0, 1)),
    centerY: roundFrameNumber(clamp(bounds.centerY / frameHeight, 0, 1)),
    width: roundFrameNumber(width),
    height: roundFrameNumber(height),
    coverage: roundFrameNumber(width * height),
  };
};

const drawVideo = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  crop: CropRect,
  width: number,
  height: number,
  filter = "none",
) => {
  ctx.save();
  ctx.filter = filter;
  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  ctx.restore();
};

const drawImageCover = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  filter = "none",
) => {
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceAspect > targetAspect) {
    sw = sourceHeight * targetAspect;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceAspect < targetAspect) {
    sh = sourceWidth / targetAspect;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.save();
  ctx.filter = filter;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  ctx.restore();
};

type BackgroundBlurScratch = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
};

const drawBlurredVideoBackground = (
  ctx: CanvasRenderingContext2D,
  scratch: BackgroundBlurScratch,
  source: CanvasImageSource,
  crop: CropRect,
  width: number,
  height: number,
  background: BackgroundEffectId,
) => {
  if (!scratch.ctx || width <= 0 || height <= 0) {
    const blur = background === "blur-light" ? 8 : 18;
    drawVideo(ctx, source, crop, width, height, `blur(${blur}px) brightness(0.86)`);
    return;
  }

  const scale = background === "blur-light" ? 0.48 : 0.32;
  const scratchWidth = getEvenDimension(
    clamp(Math.round(width * scale), 160, width),
  );
  const scratchHeight = getEvenDimension(
    clamp(Math.round(height * scale), 90, height),
  );
  if (
    scratch.canvas.width !== scratchWidth ||
    scratch.canvas.height !== scratchHeight
  ) {
    scratch.canvas.width = scratchWidth;
    scratch.canvas.height = scratchHeight;
  }

  const blur = background === "blur-light" ? 3 : 5.5;
  scratch.ctx.save();
  scratch.ctx.clearRect(0, 0, scratchWidth, scratchHeight);
  scratch.ctx.imageSmoothingEnabled = true;
  scratch.ctx.imageSmoothingQuality = "medium";
  scratch.ctx.filter = `blur(${blur}px) brightness(0.86)`;
  scratch.ctx.drawImage(
    source,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    scratchWidth,
    scratchHeight,
  );
  scratch.ctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(scratch.canvas, 0, 0, scratchWidth, scratchHeight, 0, 0, width, height);
  ctx.restore();
};

const fillRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
};

type MakeupFaceFilterId = Extract<
  FaceFilterId,
  | "makeup-barely-there"
  | "makeup-simply-radiant"
  | "makeup-dewy-fresh"
  | "makeup-warm-glow"
  | "makeup-coral-hint"
  | "makeup-berry-blush"
  | "makeup-cat-eye"
  | "makeup-dramatic-eye"
  | "makeup-lip-gloss"
  | "makeup-pink-dewy"
  | "makeup-red-lipstick"
  | "makeup-rosy-pink"
  | "makeup-signature-statement"
  | "makeup-goth-chic"
  | "makeup-mummy"
  | "makeup-zombie"
>;

type MakeupFaceFilterConfig = {
  cheek: string;
  cheekAlpha: number;
  lip: string;
  lipAlpha: number;
  eye: string;
  eyeAlpha: number;
  line: string;
  lineAlpha: number;
  lineWidth: number;
  mode?: "natural" | "cat-eye" | "dramatic" | "gloss" | "goth" | "mummy" | "zombie";
};

const MAKEUP_FACE_FILTER_CONFIG: Record<
  MakeupFaceFilterId,
  MakeupFaceFilterConfig
> = {
  "makeup-barely-there": {
    cheek: "#f9a8d4",
    cheekAlpha: 0.2,
    lip: "#fb7185",
    lipAlpha: 0.22,
    eye: "#fbcfe8",
    eyeAlpha: 0.14,
    line: "#7f1d1d",
    lineAlpha: 0.22,
    lineWidth: 0.008,
    mode: "natural",
  },
  "makeup-simply-radiant": {
    cheek: "#fb7185",
    cheekAlpha: 0.27,
    lip: "#e11d48",
    lipAlpha: 0.32,
    eye: "#f9a8d4",
    eyeAlpha: 0.2,
    line: "#831843",
    lineAlpha: 0.28,
    lineWidth: 0.01,
    mode: "natural",
  },
  "makeup-dewy-fresh": {
    cheek: "#fda4af",
    cheekAlpha: 0.26,
    lip: "#fb7185",
    lipAlpha: 0.28,
    eye: "#fecdd3",
    eyeAlpha: 0.2,
    line: "#9f1239",
    lineAlpha: 0.24,
    lineWidth: 0.009,
    mode: "gloss",
  },
  "makeup-warm-glow": {
    cheek: "#fb923c",
    cheekAlpha: 0.28,
    lip: "#ea580c",
    lipAlpha: 0.28,
    eye: "#fed7aa",
    eyeAlpha: 0.24,
    line: "#7c2d12",
    lineAlpha: 0.28,
    lineWidth: 0.01,
    mode: "natural",
  },
  "makeup-coral-hint": {
    cheek: "#fb923c",
    cheekAlpha: 0.24,
    lip: "#f97316",
    lipAlpha: 0.32,
    eye: "#fdba74",
    eyeAlpha: 0.18,
    line: "#9a3412",
    lineAlpha: 0.26,
    lineWidth: 0.009,
    mode: "natural",
  },
  "makeup-berry-blush": {
    cheek: "#be185d",
    cheekAlpha: 0.3,
    lip: "#9d174d",
    lipAlpha: 0.38,
    eye: "#f0abfc",
    eyeAlpha: 0.2,
    line: "#4a044e",
    lineAlpha: 0.34,
    lineWidth: 0.012,
    mode: "natural",
  },
  "makeup-cat-eye": {
    cheek: "#f9a8d4",
    cheekAlpha: 0.16,
    lip: "#be123c",
    lipAlpha: 0.26,
    eye: "#e5e7eb",
    eyeAlpha: 0.14,
    line: "#0f172a",
    lineAlpha: 0.82,
    lineWidth: 0.018,
    mode: "cat-eye",
  },
  "makeup-dramatic-eye": {
    cheek: "#a855f7",
    cheekAlpha: 0.18,
    lip: "#7f1d1d",
    lipAlpha: 0.28,
    eye: "#312e81",
    eyeAlpha: 0.34,
    line: "#020617",
    lineAlpha: 0.9,
    lineWidth: 0.02,
    mode: "dramatic",
  },
  "makeup-lip-gloss": {
    cheek: "#fb7185",
    cheekAlpha: 0.18,
    lip: "#f43f5e",
    lipAlpha: 0.42,
    eye: "#fbcfe8",
    eyeAlpha: 0.12,
    line: "#9f1239",
    lineAlpha: 0.22,
    lineWidth: 0.009,
    mode: "gloss",
  },
  "makeup-pink-dewy": {
    cheek: "#ec4899",
    cheekAlpha: 0.26,
    lip: "#db2777",
    lipAlpha: 0.32,
    eye: "#f9a8d4",
    eyeAlpha: 0.22,
    line: "#831843",
    lineAlpha: 0.28,
    lineWidth: 0.01,
    mode: "gloss",
  },
  "makeup-red-lipstick": {
    cheek: "#fb7185",
    cheekAlpha: 0.18,
    lip: "#dc2626",
    lipAlpha: 0.54,
    eye: "#fecaca",
    eyeAlpha: 0.14,
    line: "#450a0a",
    lineAlpha: 0.26,
    lineWidth: 0.01,
    mode: "gloss",
  },
  "makeup-rosy-pink": {
    cheek: "#f43f5e",
    cheekAlpha: 0.28,
    lip: "#e11d48",
    lipAlpha: 0.34,
    eye: "#fecdd3",
    eyeAlpha: 0.2,
    line: "#881337",
    lineAlpha: 0.26,
    lineWidth: 0.01,
    mode: "natural",
  },
  "makeup-signature-statement": {
    cheek: "#a21caf",
    cheekAlpha: 0.25,
    lip: "#be123c",
    lipAlpha: 0.48,
    eye: "#c084fc",
    eyeAlpha: 0.26,
    line: "#3b0764",
    lineAlpha: 0.76,
    lineWidth: 0.016,
    mode: "dramatic",
  },
  "makeup-goth-chic": {
    cheek: "#6b7280",
    cheekAlpha: 0.18,
    lip: "#111827",
    lipAlpha: 0.62,
    eye: "#111827",
    eyeAlpha: 0.42,
    line: "#020617",
    lineAlpha: 0.92,
    lineWidth: 0.018,
    mode: "goth",
  },
  "makeup-mummy": {
    cheek: "#d6d3d1",
    cheekAlpha: 0.18,
    lip: "#78716c",
    lipAlpha: 0.22,
    eye: "#a8a29e",
    eyeAlpha: 0.22,
    line: "#57534e",
    lineAlpha: 0.48,
    lineWidth: 0.012,
    mode: "mummy",
  },
  "makeup-zombie": {
    cheek: "#84cc16",
    cheekAlpha: 0.22,
    lip: "#7f1d1d",
    lipAlpha: 0.42,
    eye: "#166534",
    eyeAlpha: 0.28,
    line: "#365314",
    lineAlpha: 0.56,
    lineWidth: 0.014,
    mode: "zombie",
  },
};

const getMakeupFaceFilterConfig = (
  filter: FaceFilterId,
): MakeupFaceFilterConfig | null =>
  MAKEUP_FACE_FILTER_CONFIG[filter as MakeupFaceFilterId] ?? null;

const FACE_OVAL_LANDMARK_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
] as const;

const createFaceFilterRenderStats = (
  filter: FaceFilterId,
  landmarkCount: number,
  reason: string,
): FaceFilterRenderStats => ({
  filter,
  effectGraph: getFaceFilterEffectGraphStats(filter),
  drawn: false,
  reason,
  landmarkCount,
  changedPixels: 0,
  changedPixelRatio: 0,
  samplePixelCount: 0,
  anchor: null,
  bounds: null,
});

const selectFacePoseCandidate = (
  pose: FacePoseTransform | null,
  referenceRoll: number,
): FacePoseCandidate | null => {
  if (!pose?.candidates.length) return null;
  let bestCandidate: FacePoseCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of pose.candidates) {
    const distance = Math.abs(normalizeAngleDelta(candidate.roll - referenceRoll));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  if (!bestCandidate || bestDistance > 0.48) return null;
  if (Math.abs(bestCandidate.yaw) > 0.95 || Math.abs(bestCandidate.pitch) > 0.95) {
    return null;
  }
  return bestCandidate;
};

const createBackgroundRenderStats = (
  background: BackgroundEffectId,
  reason: string,
  hasSegmentationMask = false,
  hasBackgroundImage = false,
): BackgroundRenderStats => ({
  background,
  active: false,
  reason,
  changedPixels: 0,
  changedPixelRatio: 0,
  samplePixelCount: 0,
  sampleRegions: [],
  hasSegmentationMask,
  hasBackgroundImage,
});

const toCanvasBounds = (
  localBounds: { left: number; right: number; top: number; bottom: number },
  anchor: NonNullable<FaceFilterRenderStats["anchor"]>,
  width: number,
  height: number,
): CanvasBounds | null => {
  const cos = Math.cos(anchor.faceAngle);
  const sin = Math.sin(anchor.faceAngle);
  const points = [
    [localBounds.left, localBounds.top],
    [localBounds.right, localBounds.top],
    [localBounds.right, localBounds.bottom],
    [localBounds.left, localBounds.bottom],
  ].map(([x, y]) => ({
    x: anchor.centerX + x * cos - y * sin,
    y: anchor.centerY + x * sin + y * cos,
  }));
  const left = clamp(
    Math.floor(Math.min(...points.map((point) => point.x))) - 4,
    0,
    width,
  );
  const top = clamp(
    Math.floor(Math.min(...points.map((point) => point.y))) - 4,
    0,
    height,
  );
  const right = clamp(
    Math.ceil(Math.max(...points.map((point) => point.x))) + 4,
    0,
    width,
  );
  const bottom = clamp(
    Math.ceil(Math.max(...points.map((point) => point.y))) + 4,
    0,
    height,
  );
  const sampleWidth = right - left;
  const sampleHeight = bottom - top;
  if (sampleWidth <= 0 || sampleHeight <= 0) return null;
  return {
    x: left,
    y: top,
    width: sampleWidth,
    height: sampleHeight,
  };
};

type ProceduralRoomScene = {
  wall: [string, string];
  floor: string;
  trim: string;
  accent: string;
  furniture: string;
  shelf?: "wide" | "left" | "right" | "library";
  books?: number;
  sofa?: "left" | "center" | "wide";
  table?: boolean;
  plants?: number;
  window?: "left" | "right" | "wide";
  conference?: boolean;
  cafe?: boolean;
  lamp?: boolean;
  art?: boolean;
};

const PROCEDURAL_ROOM_SCENES: Partial<
  Record<BackgroundEffectId, ProceduralRoomScene>
> = {
  bookshelf: {
    wall: ["#78350f", "#292524"],
    floor: "#1c1917",
    trim: "#f59e0b",
    accent: "#fbbf24",
    furniture: "#451a03",
    shelf: "wide",
    books: 20,
    lamp: true,
  },
  "coffee-shop": {
    wall: ["#92400e", "#431407"],
    floor: "#1f2937",
    trim: "#fed7aa",
    accent: "#f97316",
    furniture: "#3f2412",
    cafe: true,
    plants: 2,
    window: "left",
  },
  "home-office-bookshelf": {
    wall: ["#a16207", "#44403c"],
    floor: "#292524",
    trim: "#fef3c7",
    accent: "#84cc16",
    furniture: "#57534e",
    shelf: "right",
    books: 14,
    table: true,
    lamp: true,
    plants: 1,
  },
  "home-office-sofa": {
    wall: ["#7c2d12", "#1c1917"],
    floor: "#27272a",
    trim: "#fdba74",
    accent: "#f97316",
    furniture: "#44403c",
    sofa: "center",
    shelf: "left",
    books: 8,
    plants: 1,
  },
  "living-room-shelf": {
    wall: ["#854d0e", "#292524"],
    floor: "#1c1917",
    trim: "#fde68a",
    accent: "#ea580c",
    furniture: "#3f3f46",
    sofa: "left",
    shelf: "right",
    books: 10,
    art: true,
    plants: 2,
  },
  "modern-conference-room": {
    wall: ["#cbd5e1", "#64748b"],
    floor: "#334155",
    trim: "#e2e8f0",
    accent: "#38bdf8",
    furniture: "#1e293b",
    conference: true,
    window: "wide",
    plants: 1,
  },
  "office-library": {
    wall: ["#365314", "#1c1917"],
    floor: "#292524",
    trim: "#bef264",
    accent: "#65a30d",
    furniture: "#3f3f46",
    shelf: "library",
    books: 24,
    table: true,
  },
  "office-meeting-space": {
    wall: ["#0f766e", "#134e4a"],
    floor: "#164e63",
    trim: "#ccfbf1",
    accent: "#2dd4bf",
    furniture: "#1f2937",
    conference: true,
    shelf: "left",
    books: 8,
  },
  "office-green-space": {
    wall: ["#bbf7d0", "#166534"],
    floor: "#14532d",
    trim: "#dcfce7",
    accent: "#22c55e",
    furniture: "#365314",
    window: "right",
    plants: 5,
    table: true,
  },
  "shelf-with-plants": {
    wall: ["#d6d3d1", "#78716c"],
    floor: "#292524",
    trim: "#f5f5f4",
    accent: "#16a34a",
    furniture: "#44403c",
    shelf: "wide",
    books: 6,
    plants: 4,
  },
  "stylish-home-office": {
    wall: ["#e7e5e4", "#57534e"],
    floor: "#1c1917",
    trim: "#fafaf9",
    accent: "#a3e635",
    furniture: "#3f3f46",
    table: true,
    lamp: true,
    art: true,
    plants: 2,
  },
  "stylish-living-room-couch": {
    wall: ["#991b1b", "#1c1917"],
    floor: "#292524",
    trim: "#fecaca",
    accent: "#f87171",
    furniture: "#3f3f46",
    sofa: "wide",
    art: true,
    plants: 2,
  },
};

const drawShelf = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  scene: ProceduralRoomScene,
) => {
  ctx.fillStyle = "rgba(28,25,23,0.36)";
  fillRoundRect(ctx, x, y, width, height, Math.max(8, height * 0.04));
  const shelfCount = scene.shelf === "library" ? 4 : 3;
  const bookCount = scene.books ?? 10;
  for (let shelf = 0; shelf < shelfCount; shelf += 1) {
    const shelfY = y + height * (0.18 + shelf * (0.68 / shelfCount));
    ctx.fillStyle = "rgba(250,250,249,0.28)";
    fillRoundRect(ctx, x + width * 0.08, shelfY, width * 0.84, height * 0.025, 4);
    for (let item = 0; item < bookCount / shelfCount; item += 1) {
      const bookX = x + width * 0.12 + item * width * 0.065;
      const bookHeight = height * (0.1 + ((item + shelf) % 3) * 0.025);
      ctx.fillStyle =
        (item + shelf) % 3 === 0
          ? scene.accent
          : (item + shelf) % 3 === 1
            ? scene.trim
            : "#f8fafc";
      fillRoundRect(ctx, bookX, shelfY - bookHeight, width * 0.035, bookHeight, 3);
    }
  }
};

const drawPlant = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  accent: string,
) => {
  ctx.fillStyle = "#292524";
  fillRoundRect(ctx, x - 10 * scale, y, 20 * scale, 18 * scale, 4 * scale);
  ctx.strokeStyle = "#166534";
  ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 54 * scale);
  ctx.stroke();
  ctx.fillStyle = accent;
  for (let leaf = 0; leaf < 5; leaf += 1) {
    const angle = -1.25 + leaf * 0.55;
    ctx.beginPath();
    ctx.ellipse(
      x + Math.cos(angle) * 22 * scale,
      y - 44 * scale + Math.sin(angle) * 14 * scale,
      18 * scale,
      8 * scale,
      angle,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
};

const drawSofa = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) => {
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  fillRoundRect(ctx, x + width * 0.04, y + height * 0.18, width, height, 20);
  ctx.fillStyle = color;
  fillRoundRect(ctx, x, y, width, height * 0.68, 24);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  fillRoundRect(ctx, x + width * 0.08, y + height * 0.12, width * 0.36, height * 0.32, 14);
  fillRoundRect(ctx, x + width * 0.56, y + height * 0.12, width * 0.36, height * 0.32, 14);
};

const drawWindow = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  trim: string,
) => {
  const glass = ctx.createLinearGradient(x, y, x + width, y + height);
  glass.addColorStop(0, "rgba(224,242,254,0.74)");
  glass.addColorStop(1, "rgba(14,116,144,0.42)");
  ctx.fillStyle = glass;
  fillRoundRect(ctx, x, y, width, height, 12);
  ctx.strokeStyle = trim;
  ctx.lineWidth = Math.max(2, width * 0.015);
  ctx.strokeRect(x + width * 0.08, y + height * 0.1, width * 0.84, height * 0.8);
  ctx.beginPath();
  ctx.moveTo(x + width * 0.5, y + height * 0.1);
  ctx.lineTo(x + width * 0.5, y + height * 0.9);
  ctx.moveTo(x + width * 0.08, y + height * 0.52);
  ctx.lineTo(x + width * 0.92, y + height * 0.52);
  ctx.stroke();
};

const drawProceduralRoomBackground = (
  ctx: CanvasRenderingContext2D,
  background: BackgroundEffectId,
  width: number,
  height: number,
) => {
  const scene = PROCEDURAL_ROOM_SCENES[background];
  if (!scene) return false;

  const wall = ctx.createLinearGradient(0, 0, width, height);
  wall.addColorStop(0, scene.wall[0]);
  wall.addColorStop(1, scene.wall[1]);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  fillRoundRect(ctx, width * 0.08, height * 0.09, width * 0.84, height * 0.12, 18);
  ctx.fillStyle = scene.floor;
  ctx.fillRect(0, height * 0.72, width, height * 0.28);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, height * 0.7, width, height * 0.04);
  ctx.fillStyle = scene.trim;
  ctx.fillRect(0, height * 0.7, width, Math.max(4, height * 0.012));

  if (scene.window === "wide") {
    drawWindow(ctx, width * 0.23, height * 0.16, width * 0.54, height * 0.26, scene.trim);
  } else if (scene.window === "left") {
    drawWindow(ctx, width * 0.1, height * 0.16, width * 0.28, height * 0.34, scene.trim);
  } else if (scene.window === "right") {
    drawWindow(ctx, width * 0.62, height * 0.16, width * 0.28, height * 0.34, scene.trim);
  }

  if (scene.art) {
    ctx.fillStyle = "rgba(250,250,249,0.18)";
    fillRoundRect(ctx, width * 0.42, height * 0.18, width * 0.18, height * 0.18, 10);
    ctx.fillStyle = scene.accent;
    fillRoundRect(ctx, width * 0.46, height * 0.22, width * 0.1, height * 0.1, 8);
  }

  if (scene.shelf) {
    const shelfWidth =
      scene.shelf === "wide" || scene.shelf === "library"
        ? width * 0.72
        : width * 0.3;
    const shelfX =
      scene.shelf === "right"
        ? width * 0.62
        : scene.shelf === "left"
          ? width * 0.08
          : width * 0.14;
    drawShelf(ctx, shelfX, height * 0.2, shelfWidth, height * 0.38, scene);
  }

  if (scene.table) {
    ctx.fillStyle = scene.furniture;
    fillRoundRect(ctx, width * 0.34, height * 0.58, width * 0.32, height * 0.08, 14);
    ctx.fillStyle = "rgba(0,0,0,0.24)";
    ctx.fillRect(width * 0.39, height * 0.66, width * 0.035, height * 0.14);
    ctx.fillRect(width * 0.58, height * 0.66, width * 0.035, height * 0.14);
  }

  if (scene.conference) {
    ctx.fillStyle = scene.furniture;
    fillRoundRect(ctx, width * 0.18, height * 0.58, width * 0.64, height * 0.12, 24);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    fillRoundRect(ctx, width * 0.29, height * 0.56, width * 0.42, height * 0.035, 10);
    ctx.fillStyle = "rgba(15,23,42,0.52)";
    for (let chair = 0; chair < 4; chair += 1) {
      fillRoundRect(
        ctx,
        width * (0.22 + chair * 0.16),
        height * 0.72,
        width * 0.08,
        height * 0.07,
        10,
      );
    }
  }

  if (scene.cafe) {
    ctx.fillStyle = scene.furniture;
    fillRoundRect(ctx, width * 0.48, height * 0.48, width * 0.4, height * 0.16, 18);
    ctx.fillStyle = scene.trim;
    fillRoundRect(ctx, width * 0.54, height * 0.34, width * 0.24, height * 0.08, 12);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    for (let cup = 0; cup < 5; cup += 1) {
      fillRoundRect(
        ctx,
        width * (0.54 + cup * 0.055),
        height * 0.52,
        width * 0.025,
        height * 0.05,
        4,
      );
    }
  }

  if (scene.sofa) {
    const sofaWidth = scene.sofa === "wide" ? width * 0.76 : width * 0.55;
    const sofaX =
      scene.sofa === "left"
        ? width * 0.08
        : scene.sofa === "wide"
          ? width * 0.12
          : width * 0.23;
    drawSofa(ctx, sofaX, height * 0.62, sofaWidth, height * 0.18, scene.furniture);
  }

  if (scene.lamp) {
    ctx.fillStyle = "rgba(250,204,21,0.24)";
    ctx.beginPath();
    ctx.arc(width * 0.78, height * 0.32, width * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = scene.trim;
    fillRoundRect(ctx, width * 0.76, height * 0.28, width * 0.04, height * 0.08, 8);
    ctx.fillStyle = scene.furniture;
    ctx.fillRect(width * 0.78, height * 0.36, width * 0.012, height * 0.22);
  }

  for (let plant = 0; plant < (scene.plants ?? 0); plant += 1) {
    const x = plant % 2 === 0 ? width * (0.12 + plant * 0.08) : width * (0.88 - plant * 0.05);
    const y = height * (0.65 + (plant % 3) * 0.04);
    drawPlant(ctx, x, y, Math.max(0.7, Math.min(width, height) / 700), scene.accent);
  }

  return true;
};

const drawCachedProceduralLayer = (
  targetCtx: CanvasRenderingContext2D,
  cache: ProceduralBackgroundLayerCache | null | undefined,
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
) => {
  if (!cache?.ctx) {
    draw(targetCtx);
    return;
  }
  if (
    cache.key !== key ||
    cache.canvas.width !== width ||
    cache.canvas.height !== height
  ) {
    cache.canvas.width = width;
    cache.canvas.height = height;
    cache.ctx.clearRect(0, 0, width, height);
    draw(cache.ctx);
    cache.key = key;
  }
  targetCtx.drawImage(cache.canvas, 0, 0, width, height);
};

const drawMotionDeskBase = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  const wall = ctx.createLinearGradient(0, 0, width, height);
  wall.addColorStop(0, "#dbeafe");
  wall.addColorStop(0.45, "#64748b");
  wall.addColorStop(1, "#172554");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, height * 0.72, width, height * 0.28);
  drawWindow(ctx, width * 0.09, height * 0.14, width * 0.32, height * 0.32, "#e0f2fe");
  ctx.fillStyle = "rgba(15,23,42,0.38)";
  fillRoundRect(ctx, width * 0.58, height * 0.14, width * 0.27, height * 0.34, 18);
  ctx.fillStyle = "#1e293b";
  fillRoundRect(ctx, width * 0.2, height * 0.58, width * 0.62, height * 0.095, 16);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(width * 0.28, height * 0.67, width * 0.035, height * 0.18);
  ctx.fillRect(width * 0.7, height * 0.67, width * 0.035, height * 0.18);
  ctx.fillStyle = "rgba(241,245,249,0.28)";
  fillRoundRect(ctx, width * 0.36, height * 0.52, width * 0.16, height * 0.08, 12);
  drawPlant(ctx, width * 0.78, height * 0.62, Math.max(0.8, Math.min(width, height) / 760), "#22c55e");
};

const drawMotionDeskOverlay = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
) => {
  const cloudOffset = (seconds * width * 0.035) % (width * 0.36);
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  fillRoundRect(
    ctx,
    width * 0.11 + cloudOffset,
    height * 0.24,
    width * 0.13,
    height * 0.035,
    999,
  );
  fillRoundRect(
    ctx,
    width * 0.2 + cloudOffset * 0.6,
    height * 0.31,
    width * 0.1,
    height * 0.028,
    999,
  );
  const pulse = 0.16 + Math.sin(seconds * 1.4) * 0.035;
  const light = ctx.createRadialGradient(
    width * 0.72,
    height * 0.3,
    0,
    width * 0.72,
    height * 0.3,
    width * 0.36,
  );
  light.addColorStop(0, `rgba(251,191,36,${pulse})`);
  light.addColorStop(1, "rgba(251,191,36,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
};

const drawMotionLoftBase = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  const wall = ctx.createLinearGradient(0, 0, width, height);
  wall.addColorStop(0, "#fed7aa");
  wall.addColorStop(0.46, "#92400e");
  wall.addColorStop(1, "#1c1917");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#292524";
  ctx.fillRect(0, height * 0.72, width, height * 0.28);
  drawWindow(ctx, width * 0.6, height * 0.13, width * 0.28, height * 0.34, "#fed7aa");
  drawShelf(ctx, width * 0.08, height * 0.18, width * 0.34, height * 0.38, {
    wall: ["#fed7aa", "#92400e"],
    floor: "#292524",
    trim: "#fde68a",
    accent: "#f97316",
    furniture: "#3f2412",
    shelf: "left",
    books: 12,
  });
  drawSofa(ctx, width * 0.24, height * 0.62, width * 0.52, height * 0.17, "#3f3f46");
  drawPlant(ctx, width * 0.83, height * 0.65, Math.max(0.8, Math.min(width, height) / 760), "#84cc16");
};

const drawMotionLoftOverlay = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
) => {
  const sweep = (Math.sin(seconds * 0.65) + 1) / 2;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const light = ctx.createLinearGradient(
    width * (0.56 + sweep * 0.08),
    height * 0.16,
    width * (0.32 + sweep * 0.08),
    height,
  );
  light.addColorStop(0, "rgba(253,186,116,0.24)");
  light.addColorStop(0.48, "rgba(253,186,116,0.08)");
  light.addColorStop(1, "rgba(253,186,116,0)");
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(width * 0.62, height * 0.36);
  ctx.lineTo(width * (0.18 + sweep * 0.12), height);
  ctx.lineTo(width * (0.55 + sweep * 0.08), height);
  ctx.lineTo(width * 0.88, height * 0.36);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

const drawMotionAuroraBase = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#020617");
  sky.addColorStop(0.6, "#0f172a");
  sky.addColorStop(1, "#164e63");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  for (let index = 0; index < 24; index += 1) {
    const x = ((index * 97) % 1000) / 1000 * width;
    const y = ((index * 53) % 360) / 1000 * height;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.fillStyle = "rgba(2,6,23,0.34)";
  ctx.beginPath();
  ctx.moveTo(0, height * 0.78);
  ctx.lineTo(width * 0.22, height * 0.58);
  ctx.lineTo(width * 0.42, height * 0.75);
  ctx.lineTo(width * 0.62, height * 0.54);
  ctx.lineTo(width, height * 0.76);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();
};

const drawAuroraBand = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
  phase: number,
  color: string,
) => {
  const yBase = height * (0.24 + phase * 0.1);
  const amplitude = height * (0.055 + phase * 0.018);
  ctx.beginPath();
  ctx.moveTo(0, yBase);
  for (let point = 0; point <= 5; point += 1) {
    const x = (width / 5) * point;
    const y = yBase + Math.sin(seconds * 0.7 + phase * 2.2 + point * 1.1) * amplitude;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, yBase + height * 0.24);
  ctx.lineTo(0, yBase + height * 0.2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
};

const drawMotionAuroraOverlay = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
) => {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  drawAuroraBand(ctx, width, height, seconds, 0.15, "rgba(20,184,166,0.26)");
  drawAuroraBand(ctx, width, height, seconds + 1.6, 0.45, "rgba(34,197,94,0.2)");
  drawAuroraBand(ctx, width, height, seconds + 2.4, 0.75, "rgba(96,165,250,0.2)");
  ctx.restore();
};

const drawMotionBackground = (
  ctx: CanvasRenderingContext2D,
  background: BackgroundEffectId,
  width: number,
  height: number,
  now: number,
  cache?: ProceduralBackgroundLayerCache | null,
) => {
  const seconds = now / 1000;
  if (background === "desk-motion") {
    drawCachedProceduralLayer(ctx, cache, `${background}:base`, width, height, (baseCtx) =>
      drawMotionDeskBase(baseCtx, width, height),
    );
    drawMotionDeskOverlay(ctx, width, height, seconds);
    return true;
  }
  if (background === "loft-motion") {
    drawCachedProceduralLayer(ctx, cache, `${background}:base`, width, height, (baseCtx) =>
      drawMotionLoftBase(baseCtx, width, height),
    );
    drawMotionLoftOverlay(ctx, width, height, seconds);
    return true;
  }
  if (background === "aurora-motion") {
    drawCachedProceduralLayer(ctx, cache, `${background}:base`, width, height, (baseCtx) =>
      drawMotionAuroraBase(baseCtx, width, height),
    );
    drawMotionAuroraOverlay(ctx, width, height, seconds);
    return true;
  }
  return false;
};

const drawProceduralBackgroundDirect = (
  ctx: CanvasRenderingContext2D,
  background: BackgroundEffectId,
  width: number,
  height: number,
) => {
  if (drawProceduralRoomBackground(ctx, background, width, height)) return;

  if (background === "office" || background === "studio") {
    const wall = ctx.createLinearGradient(0, 0, width, height);
    wall.addColorStop(0, background === "office" ? "#d6d3d1" : "#cbd5e1");
    wall.addColorStop(1, background === "office" ? "#a8a29e" : "#64748b");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(63,63,70,0.22)";
    ctx.fillRect(0, height * 0.72, width, height * 0.28);
    ctx.fillStyle = "rgba(24,24,27,0.2)";
    fillRoundRect(ctx, width * 0.12, height * 0.22, width * 0.76, 16, 8);
    for (let i = 0; i < 10; i += 1) {
      ctx.fillStyle = i % 2 ? "#57534e" : "#f8fafc";
      fillRoundRect(
        ctx,
        width * 0.16 + i * width * 0.06,
        height * 0.25,
        width * 0.035,
        height * 0.18,
        4,
      );
    }
    return;
  }

  if (background === "lounge") {
    const wall = ctx.createLinearGradient(0, 0, width, height);
    wall.addColorStop(0, "#7c2d12");
    wall.addColorStop(1, "#1c1917");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(253,186,116,0.18)";
    ctx.beginPath();
    ctx.arc(width * 0.78, height * 0.2, width * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3f3f46";
    fillRoundRect(ctx, width * 0.12, height * 0.66, width * 0.76, height * 0.16, 22);
    return;
  }

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#1d4ed8");
  gradient.addColorStop(0.42, "#7c3aed");
  gradient.addColorStop(1, "#f97316");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
};

const drawProceduralBackground = (
  ctx: CanvasRenderingContext2D,
  background: BackgroundEffectId,
  width: number,
  height: number,
  now: number,
  cache?: ProceduralBackgroundLayerCache | null,
) => {
  if (isAnimatedBackgroundEffect(background)) {
    if (drawMotionBackground(ctx, background, width, height, now, cache)) return;
  }

  drawCachedProceduralLayer(
    ctx,
    cache,
    `${background}:static`,
    width,
    height,
    (backgroundCtx) =>
      drawProceduralBackgroundDirect(backgroundCtx, background, width, height),
  );
};

const applyLighting = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  effects: VideoEffectsState,
  lowLight: LowLightRenderStats,
) => {
  if (!effects.studioLighting && lowLight.brighteningStrength <= 0.1) return;
  const strength = clamp(lowLight.brighteningStrength / 100, 0, 1);
  if (strength <= 0.001) return;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const light = ctx.createRadialGradient(
    width * 0.28,
    height * 0.18,
    0,
    width * 0.28,
    height * 0.18,
    width * 0.72,
  );
  light.addColorStop(0, `rgba(255,255,255,${0.18 + strength * 0.2})`);
  light.addColorStop(0.44, `rgba(255,244,214,${0.08 + strength * 0.12})`);
  light.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
};

const drawFaceFilter = (
  ctx: CanvasRenderingContext2D,
  filter: FaceFilterId,
  landmarks: NormalizedLandmarkList | null,
  pose: FacePoseTransform | null,
  crop: CropRect,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  probeRender: boolean,
): FaceFilterRenderStats => {
  const landmarkCount = landmarks?.length ?? 0;
  if (filter === "none") {
    return createFaceFilterRenderStats(filter, landmarkCount, "no filter");
  }
  if (requiresMeetVideoPipeFaceFilter(filter)) {
    return createFaceFilterRenderStats(
      filter,
      landmarkCount,
      "requires Meet VideoPipe runtime",
    );
  }
  if (!landmarks) {
    return createFaceFilterRenderStats(filter, landmarkCount, "no landmarks");
  }

  const mapLandmark = (landmark: NormalizedLandmark | undefined) =>
    getPoint(landmark, crop, sourceWidth, sourceHeight, width, height);
  const mapLandmarks = (indices: number[]) =>
    getAveragePoint(indices.map((index) => mapLandmark(landmarks[index])));
  const mappedFaceBounds = getPointBounds(landmarks.map(mapLandmark));
  const leftOuterEye = mapLandmark(landmarks[33]);
  const rightOuterEye = mapLandmark(landmarks[263]);
  const outerEyePair =
    leftOuterEye && rightOuterEye
      ? sortPointPairByX([leftOuterEye, rightOuterEye])
      : null;
  const leftContourEye = getAveragePoint([
    mapLandmark(landmarks[33]),
    mapLandmark(landmarks[133]),
  ]);
  const rightContourEye = getAveragePoint([
    mapLandmark(landmarks[263]),
    mapLandmark(landmarks[362]),
  ]);
  const contourEyePair =
    leftContourEye && rightContourEye
      ? sortPointPairByX([leftContourEye, rightContourEye])
      : null;
  const irisEyeA = mapLandmarks([468, 469, 470, 471, 472]);
  const irisEyeB = mapLandmarks([473, 474, 475, 476, 477]);
  const irisEyePair =
    irisEyeA && irisEyeB ? sortPointPairByX([irisEyeA, irisEyeB]) : null;
  const eyePair = irisEyePair ?? contourEyePair ?? outerEyePair;
  const eyeAnchorBasis = irisEyePair ? "iris" : "contour";
  const leftEye = eyePair?.[0] ?? null;
  const rightEye = eyePair?.[1] ?? null;
  const outerLeftEye = outerEyePair?.[0] ?? leftEye;
  const outerRightEye = outerEyePair?.[1] ?? rightEye;
  const nose = mapLandmark(landmarks[1]);
  const upperLip = mapLandmark(landmarks[13]);
  const lowerLip = mapLandmark(landmarks[14]);
  const leftMouthCorner = mapLandmark(landmarks[61]);
  const rightMouthCorner = mapLandmark(landmarks[291]);
  const forehead = mapLandmark(landmarks[10]);
  const chin = mapLandmark(landmarks[152]);
  if (!leftEye || !rightEye || !nose || !forehead) {
    return createFaceFilterRenderStats(
      filter,
      landmarkCount,
      "missing face anchors",
    );
  }

  const eyeDistance = getPointDistance(leftEye, rightEye);
  const outerEyeDistance =
    outerLeftEye && outerRightEye
      ? getPointDistance(outerLeftEye, outerRightEye)
      : 0;
  const faceBoundsWidth = mappedFaceBounds?.width ?? 0;
  const faceWidthEstimate = Math.max(
    outerEyeDistance > 0 ? outerEyeDistance * 1.56 : 0,
    eyeDistance * 2.18,
    faceBoundsWidth > 0 ? faceBoundsWidth * 1.02 : 0,
  );
  const faceWidth = Math.max(
    72,
    Math.min(faceWidthEstimate, eyeDistance * 2.85),
  );
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const centerX = (leftEye.x + rightEye.x) / 2;
  const eyeLineAngle = Math.atan2(
    rightEye.y - leftEye.y,
    rightEye.x - leftEye.x,
  );
  const poseCandidate = selectFacePoseCandidate(pose, eyeLineAngle);
  const poseBlend = poseCandidate
    ? clamp(0.2 + Math.min(Math.abs(poseCandidate.yaw), 0.42) * 0.35, 0.2, 0.34)
    : 0;
  const faceAngle = poseCandidate
    ? lerpAngle(eyeLineAngle, poseCandidate.roll, poseBlend)
    : eyeLineAngle;
  const cos = Math.cos(faceAngle);
  const sin = Math.sin(faceAngle);
  const toFaceSpace = (point: { x: number; y: number }) => {
    const dx = point.x - centerX;
    const dy = point.y - eyeY;
    return {
      x: dx * cos + dy * sin,
      y: -dx * sin + dy * cos,
    };
  };
  const leftEyeLocal = toFaceSpace(leftEye);
  const rightEyeLocal = toFaceSpace(rightEye);
  const noseLocal = toFaceSpace(nose);
  const upperLipLocal = upperLip ? toFaceSpace(upperLip) : null;
  const lowerLipLocal = lowerLip ? toFaceSpace(lowerLip) : null;
  const mouthCornerPair =
    leftMouthCorner && rightMouthCorner
      ? sortPointPairByX([leftMouthCorner, rightMouthCorner])
      : null;
  const leftMouthCornerLocal = mouthCornerPair
    ? toFaceSpace(mouthCornerPair[0])
    : null;
  const rightMouthCornerLocal = mouthCornerPair
    ? toFaceSpace(mouthCornerPair[1])
    : null;
  const foreheadLocal = toFaceSpace(forehead);
  const chinLocal = chin ? toFaceSpace(chin) : null;
  const midlineLocal =
    getAveragePoint(
      [10, 168, 6, 1, 13, 14, 152].map((index) => {
        const point = mapLandmark(landmarks[index]);
        return point ? toFaceSpace(point) : null;
      }),
    ) ?? foreheadLocal;
  const localFaceBounds = getPointBounds(
    landmarks.map((landmark) => {
      const point = mapLandmark(landmark);
      return point ? toFaceSpace(point) : null;
    }),
  );
  const faceLocalLeft = localFaceBounds?.minX ?? -faceWidth * 0.44;
  const faceLocalRight = localFaceBounds?.maxX ?? faceWidth * 0.44;
  const faceLocalTop = localFaceBounds?.minY ?? foreheadLocal.y;
  const faceLocalBottom =
    localFaceBounds?.maxY ?? chinLocal?.y ?? faceWidth * 0.56;
  const rawHeadTopY = Math.min(foreheadLocal.y, faceLocalTop);
  const rawChinY = Math.max(chinLocal?.y ?? faceLocalBottom, faceLocalBottom);
  const canonicalHeadTopY = chinLocal
    ? -clamp(chinLocal.y * 0.62, faceWidth * 0.32, faceWidth * 0.58)
    : -faceWidth * 0.42;
  const headTopY = clamp(
    lerp(rawHeadTopY, canonicalHeadTopY, 0.55),
    -faceWidth * 0.62,
    -faceWidth * 0.26,
  );
  const faceBottomY = Math.max(rawChinY, faceWidth * 0.48);
  const faceHeight = Math.max(faceWidth * 0.9, faceBottomY - headTopY);
  const headCenterX = clamp(
    lerp(
      (faceLocalLeft + faceLocalRight) / 2,
      midlineLocal.x + (poseCandidate?.yaw ?? 0) * faceWidth * 0.06,
      poseCandidate ? 0.68 : 0.56,
    ),
    -faceWidth * 0.18,
    faceWidth * 0.18,
  );
  const mouthCenterLocal =
    getAveragePoint([
      leftMouthCornerLocal,
      rightMouthCornerLocal,
      upperLipLocal,
      lowerLipLocal,
    ]) ??
    upperLipLocal ??
    { x: noseLocal.x, y: noseLocal.y + faceWidth * 0.12 };
  const mouthWidth = clamp(
    leftMouthCornerLocal && rightMouthCornerLocal
      ? getPointDistance(leftMouthCornerLocal, rightMouthCornerLocal)
      : faceWidth * 0.28,
    faceWidth * 0.18,
    faceWidth * 0.42,
  );
  const eyewearLensW = clamp(
    (outerEyeDistance || eyeDistance) * 0.4,
    faceWidth * 0.18,
    faceWidth * 0.29,
  );
  const eyewearLensH = clamp(
    eyewearLensW * 0.56,
    faceWidth * 0.1,
    faceWidth * 0.18,
  );
  const eyewearLineY = (leftEyeLocal.y + rightEyeLocal.y) / 2;
  const anchor: NonNullable<FaceFilterRenderStats["anchor"]> = {
    centerX: Math.round(centerX),
    centerY: Math.round(eyeY),
    faceAngle,
    faceWidth: Math.round(faceWidth),
    faceHeight: Math.round(faceHeight),
    headTopY: Math.round(headTopY),
    headCenterX: Math.round(headCenterX),
    chinY: Math.round(faceBottomY),
    noseY: Math.round(noseLocal.y),
    mouthCenterX: Math.round(mouthCenterLocal.x),
    mouthCenterY: Math.round(mouthCenterLocal.y),
    mouthWidth: Math.round(mouthWidth),
    eyeAnchorBasis,
    eyeCenterDistance: Math.round(eyeDistance),
    outerEyeDistance: Math.round(outerEyeDistance || eyeDistance),
    poseBasis: poseCandidate?.basis,
    poseRoll: poseCandidate
      ? Number(poseCandidate.roll.toFixed(4))
      : undefined,
    poseYaw: poseCandidate ? Number(poseCandidate.yaw.toFixed(4)) : undefined,
    poseBlend: poseCandidate ? Number(poseBlend.toFixed(3)) : undefined,
  };
  let bounds: CanvasBounds | null = null;
  const faceOvalLocalPoints = FACE_OVAL_LANDMARK_INDICES.map((index) => {
    const point = mapLandmark(landmarks[index]);
    return point ? toFaceSpace(point) : null;
  }).filter((point): point is { x: number; y: number } => Boolean(point));

  const beginFaceSurfacePath = () => {
    ctx.beginPath();
    if (faceOvalLocalPoints.length >= 24) {
      const first = faceOvalLocalPoints[0];
      ctx.moveTo(first.x, first.y);
      for (let index = 1; index < faceOvalLocalPoints.length; index += 1) {
        const previous = faceOvalLocalPoints[index - 1];
        const point = faceOvalLocalPoints[index];
        ctx.quadraticCurveTo(
          previous.x,
          previous.y,
          (previous.x + point.x) / 2,
          (previous.y + point.y) / 2,
        );
      }
      const last = faceOvalLocalPoints[faceOvalLocalPoints.length - 1];
      ctx.quadraticCurveTo(
        last.x,
        last.y,
        (last.x + first.x) / 2,
        (last.y + first.y) / 2,
      );
      ctx.closePath();
      return;
    }
    ctx.ellipse(
      headCenterX,
      lerp(headTopY, faceBottomY, 0.55),
      faceWidth * 0.39,
      Math.max(faceWidth * 0.47, faceHeight * 0.42),
      0,
      0,
      Math.PI * 2,
    );
  };

  const beginProbe = (localBounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }) => {
    bounds = toCanvasBounds(localBounds, anchor, width, height);
  };

  ctx.save();
  ctx.translate(centerX, eyeY);
  ctx.rotate(faceAngle);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const makeup = getMakeupFaceFilterConfig(filter);
  if (makeup) {
    const eyeTopY = eyewearLineY - faceWidth * 0.08;
    const lipTopY = upperLipLocal?.y ?? mouthCenterLocal.y - faceWidth * 0.035;
    const lipBottomY = lowerLipLocal?.y ?? mouthCenterLocal.y + faceWidth * 0.04;
    const lipY = (lipTopY + lipBottomY) / 2;
    const lipW = clamp(mouthWidth * 0.72, faceWidth * 0.16, faceWidth * 0.32);
    const lipH = clamp(Math.max(lipBottomY - lipTopY, faceWidth * 0.035), faceWidth * 0.035, faceWidth * 0.08);
    const cheekY = lerp(noseLocal.y, mouthCenterLocal.y, 0.68);
    const cheekX = clamp(faceWidth * 0.23, mouthWidth * 0.72, faceWidth * 0.32);
    const cheekW = faceWidth * 0.12;
    const cheekH = faceWidth * 0.07;
    beginProbe({
      left: headCenterX - faceWidth * 0.45,
      right: headCenterX + faceWidth * 0.45,
      top: Math.min(eyeTopY - faceWidth * 0.08, headTopY - faceWidth * 0.02),
      bottom: Math.max(lipY + lipH * 1.8, faceBottomY + faceWidth * 0.08),
    });
    ctx.save();
    const skinTint =
      makeup.mode === "goth"
        ? "rgba(31,41,55,0.26)"
        : makeup.mode === "mummy"
          ? "rgba(214,211,209,0.42)"
          : makeup.mode === "zombie"
            ? "rgba(101,163,13,0.34)"
            : makeup.mode === "dramatic"
              ? "rgba(168,85,247,0.12)"
              : makeup.mode === "gloss"
                ? "rgba(244,114,182,0.1)"
                : `${makeup.cheek.slice(0, 7)}1f`;
    const contourTint =
      makeup.mode === "zombie"
        ? "rgba(54,83,20,0.2)"
        : makeup.mode === "mummy"
          ? "rgba(87,83,78,0.16)"
          : makeup.mode === "goth"
            ? "rgba(2,6,23,0.18)"
            : "rgba(120,53,15,0.08)";
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    beginFaceSurfacePath();
    ctx.clip();
    ctx.fillStyle = skinTint;
    ctx.globalAlpha = 1;
    ctx.fillRect(
      headCenterX - faceWidth * 0.58,
      headTopY - faceWidth * 0.08,
      faceWidth * 1.16,
      faceHeight + faceWidth * 0.16,
    );
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = contourTint;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(
        headCenterX + side * faceWidth * 0.27,
        lerp(headTopY, faceBottomY, 0.58),
        faceWidth * 0.09,
        faceWidth * 0.28,
        side * 0.08,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle =
      makeup.mode === "goth" || makeup.mode === "zombie"
        ? "rgba(255,255,255,0.06)"
        : "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.ellipse(
      headCenterX - faceWidth * 0.06,
      lerp(headTopY, noseLocal.y, 0.62),
      faceWidth * 0.1,
      faceWidth * 0.22,
      -0.08,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = makeup.eye;
    ctx.globalAlpha = makeup.eyeAlpha;
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      ctx.beginPath();
      ctx.ellipse(
        eye.x,
        eye.y - faceWidth * 0.035,
        faceWidth * 0.13,
        faceWidth * 0.045,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.fillStyle = makeup.cheek;
    ctx.globalAlpha = makeup.cheekAlpha;
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(side * cheekX, cheekY, cheekW, cheekH, side * 0.12, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = makeup.lip;
    ctx.globalAlpha = makeup.lipAlpha;
    ctx.beginPath();
    ctx.ellipse(mouthCenterLocal.x, lipY - lipH * 0.18, lipW * 0.48, lipH * 0.48, 0, 0, Math.PI * 2);
    ctx.ellipse(mouthCenterLocal.x, lipY + lipH * 0.22, lipW * 0.5, lipH * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
    if (makeup.mode === "gloss") {
      ctx.strokeStyle = "rgba(255,255,255,0.72)";
      ctx.globalAlpha = 0.34;
      ctx.lineWidth = Math.max(1.5, faceWidth * 0.008);
      ctx.beginPath();
      ctx.moveTo(mouthCenterLocal.x - lipW * 0.16, lipY - lipH * 0.2);
      ctx.lineTo(mouthCenterLocal.x + lipW * 0.2, lipY - lipH * 0.28);
      ctx.stroke();
    }
    ctx.strokeStyle = makeup.line;
    ctx.globalAlpha = makeup.lineAlpha;
    ctx.lineWidth = Math.max(1.5, faceWidth * makeup.lineWidth);
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      const side = index === 0 ? -1 : 1;
      const innerX = eye.x - side * faceWidth * 0.04;
      const outerX = eye.x + side * faceWidth * 0.1;
      const wingX = outerX + side * faceWidth * (makeup.mode === "cat-eye" || makeup.mode === "dramatic" ? 0.09 : 0.045);
      const wingY = eye.y - faceWidth * (makeup.mode === "dramatic" ? 0.08 : 0.045);
      ctx.beginPath();
      ctx.moveTo(innerX, eye.y - faceWidth * 0.006);
      ctx.quadraticCurveTo(eye.x, eye.y - faceWidth * 0.025, outerX, eye.y - faceWidth * 0.012);
      ctx.lineTo(wingX, wingY);
      ctx.stroke();
    });
    if (makeup.mode === "goth" || makeup.mode === "dramatic") {
      ctx.globalAlpha = makeup.mode === "goth" ? 0.46 : 0.28;
      ctx.fillStyle = makeup.line;
      [leftEyeLocal, rightEyeLocal].forEach((eye) => {
        ctx.beginPath();
        ctx.ellipse(eye.x, eye.y + faceWidth * 0.03, faceWidth * 0.11, faceWidth * 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (makeup.mode === "mummy") {
      ctx.globalAlpha = 0.42;
      ctx.strokeStyle = "rgba(231,229,228,0.88)";
      ctx.lineWidth = Math.max(3, faceWidth * 0.025);
      for (let stripe = 0; stripe < 4; stripe += 1) {
        const y = headTopY + faceWidth * (0.34 + stripe * 0.15);
        ctx.beginPath();
        ctx.moveTo(headCenterX - faceWidth * 0.34, y + stripe * faceWidth * 0.01);
        ctx.lineTo(headCenterX + faceWidth * 0.34, y - stripe * faceWidth * 0.015);
        ctx.stroke();
      }
    } else if (makeup.mode === "zombie") {
      ctx.globalAlpha = 0.56;
      ctx.strokeStyle = "#3f6212";
      ctx.lineWidth = Math.max(2, faceWidth * 0.012);
      [-1, 1].forEach((side) => {
        const scarX = side * faceWidth * 0.2;
        ctx.beginPath();
        ctx.moveTo(scarX - side * faceWidth * 0.04, cheekY - faceWidth * 0.12);
        ctx.lineTo(scarX + side * faceWidth * 0.04, cheekY + faceWidth * 0.02);
        ctx.stroke();
        for (let mark = -1; mark <= 1; mark += 1) {
          ctx.beginPath();
          ctx.moveTo(scarX - side * faceWidth * 0.03, cheekY - faceWidth * (0.06 - mark * 0.03));
          ctx.lineTo(scarX + side * faceWidth * 0.015, cheekY - faceWidth * (0.04 - mark * 0.03));
          ctx.stroke();
        }
      });
    }
    ctx.restore();
  } else if (filter === "glasses") {
    const lensW = eyewearLensW;
    const lensH = eyewearLensH;
    const leftLensX = leftEyeLocal.x - lensW / 2;
    const rightLensX = rightEyeLocal.x - lensW / 2;
    const lensY = eyewearLineY - lensH / 2;
    beginProbe({
      left: leftLensX - faceWidth * 0.04,
      right: rightLensX + lensW + faceWidth * 0.04,
      top: lensY - faceWidth * 0.04,
      bottom: lensY + lensH + faceWidth * 0.04,
    });
    ctx.strokeStyle = "rgba(10,10,11,0.92)";
    ctx.lineWidth = Math.max(5, faceWidth * 0.035);
    ctx.strokeRect(leftLensX, lensY, lensW, lensH);
    ctx.strokeRect(rightLensX, lensY, lensW, lensH);
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW / 2, lensY + lensH / 2);
    ctx.lineTo(rightEyeLocal.x - lensW / 2, lensY + lensH / 2);
    ctx.stroke();
  } else if (filter === "cute-glasses") {
    const lensW = clamp(eyewearLensW * 1.04, faceWidth * 0.2, faceWidth * 0.31);
    const lensH = clamp(eyewearLensH * 1.02, faceWidth * 0.11, faceWidth * 0.18);
    const lensY = eyewearLineY - lensH / 2;
    beginProbe({
      left: leftEyeLocal.x - lensW * 0.7,
      right: rightEyeLocal.x + lensW * 0.7,
      top: lensY - faceWidth * 0.09,
      bottom: lensY + lensH + faceWidth * 0.12,
    });
    ctx.strokeStyle = "rgba(236,72,153,0.95)";
    ctx.fillStyle = "rgba(251,207,232,0.18)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.03);
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      const cx = eye.x;
      const cy = lensY + lensH * 0.48;
      const r = lensW * 0.32;
      ctx.beginPath();
      ctx.moveTo(cx, cy + r * 0.92);
      ctx.bezierCurveTo(cx - r * 1.08, cy + r * 0.16, cx - r * 0.9, cy - r * 0.78, cx, cy - r * 0.34);
      ctx.bezierCurveTo(cx + r * 0.9, cy - r * 0.78, cx + r * 1.08, cy + r * 0.16, cx, cy + r * 0.92);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.36, lensY + lensH * 0.52);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.36, lensY + lensH * 0.52);
    ctx.stroke();
  } else if (filter === "aviator") {
    const lensW = clamp(eyewearLensW * 1.12, faceWidth * 0.2, faceWidth * 0.32);
    const lensH = clamp(eyewearLensH * 1.12, faceWidth * 0.12, faceWidth * 0.2);
    const lensY = eyewearLineY - lensH / 2;
    const mustacheX = mouthCenterLocal.x;
    const mustacheY = upperLipLocal
      ? lerp(noseLocal.y, upperLipLocal.y, 0.7)
      : mouthCenterLocal.y - faceWidth * 0.02;
    const mustacheLobeW = clamp(mouthWidth * 0.58, faceWidth * 0.1, faceWidth * 0.18);
    const mustacheLobeH = clamp(mouthWidth * 0.22, faceWidth * 0.035, faceWidth * 0.07);
    beginProbe({
      left: Math.min(leftEyeLocal.x - lensW * 0.62, mustacheX - mouthWidth * 0.82) - faceWidth * 0.06,
      right: Math.max(rightEyeLocal.x + lensW * 0.62, mustacheX + mouthWidth * 0.82) + faceWidth * 0.06,
      top: lensY - faceWidth * 0.08,
      bottom: mustacheY + faceWidth * 0.16,
    });
    ctx.fillStyle = "rgba(15,23,42,0.78)";
    ctx.strokeStyle = "rgba(248,250,252,0.72)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.025);
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      ctx.beginPath();
      ctx.ellipse(
        eye.x,
        lensY + lensH * 0.5,
        lensW * 0.5,
        lensH * (index === 0 ? 0.56 : 0.52),
        index === 0 ? -0.1 : 0.1,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.44, lensY + lensH * 0.5);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.44, lensY + lensH * 0.5);
    ctx.stroke();
    ctx.fillStyle = "rgba(28,25,23,0.94)";
    ctx.beginPath();
    ctx.ellipse(
      mustacheX - mouthWidth * 0.22,
      mustacheY,
      mustacheLobeW,
      mustacheLobeH,
      0.18,
      0,
      Math.PI * 2,
    );
    ctx.ellipse(
      mustacheX + mouthWidth * 0.22,
      mustacheY,
      mustacheLobeW,
      mustacheLobeH,
      -0.18,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  } else if (filter === "cat-eye-beret") {
    const lensW = clamp(eyewearLensW * 1.04, faceWidth * 0.2, faceWidth * 0.3);
    const lensH = clamp(eyewearLensH * 0.94, faceWidth * 0.1, faceWidth * 0.16);
    const lensY = eyewearLineY - lensH / 2;
    const beretY = headTopY - faceWidth * 0.06;
    const beretX = headCenterX - faceWidth * 0.06;
    beginProbe({
      left: Math.min(leftEyeLocal.x - lensW * 0.75, beretX - faceWidth * 0.36),
      right: Math.max(rightEyeLocal.x + lensW * 0.75, beretX + faceWidth * 0.36),
      top: beretY - faceWidth * 0.22,
      bottom: lensY + lensH + faceWidth * 0.08,
    });
    ctx.fillStyle = "#be123c";
    ctx.beginPath();
    ctx.ellipse(
      beretX,
      beretY,
      faceWidth * 0.34,
      faceWidth * 0.13,
      -0.12,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillStyle = "rgba(244,63,94,0.95)";
    ctx.beginPath();
    ctx.arc(beretX + faceWidth * 0.16, beretY - faceWidth * 0.12, faceWidth * 0.025, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(24,24,27,0.92)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.03);
    ctx.fillStyle = "rgba(251,113,133,0.18)";
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      const direction = index === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(eye.x + direction * lensW * 0.6, lensY + lensH * 0.5);
      ctx.lineTo(eye.x + direction * lensW * 0.18, lensY);
      ctx.lineTo(eye.x - direction * lensW * 0.44, lensY + lensH * 0.14);
      ctx.lineTo(eye.x - direction * lensW * 0.38, lensY + lensH);
      ctx.lineTo(eye.x + direction * lensW * 0.12, lensY + lensH * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
  } else if (filter === "cyber-glasses") {
    const lensW = clamp(eyewearLensW * 1.14, faceWidth * 0.2, faceWidth * 0.34);
    const lensH = clamp(eyewearLensH * 0.82, faceWidth * 0.08, faceWidth * 0.15);
    const lensY = eyewearLineY - lensH / 2;
    beginProbe({
      left: leftEyeLocal.x - lensW * 0.7,
      right: rightEyeLocal.x + lensW * 0.7,
      top: lensY - faceWidth * 0.08,
      bottom: lensY + lensH + faceWidth * 0.1,
    });
    ctx.shadowColor = "rgba(34,211,238,0.9)";
    ctx.shadowBlur = faceWidth * 0.06;
    ctx.fillStyle = "rgba(8,13,24,0.9)";
    ctx.strokeStyle = "rgba(103,232,249,0.95)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.024);
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      const skew = index === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(eye.x - lensW * 0.56, lensY + lensH * 0.12);
      ctx.lineTo(eye.x + lensW * 0.44, lensY);
      ctx.lineTo(eye.x + lensW * 0.58, lensY + lensH * 0.76);
      ctx.lineTo(eye.x - lensW * 0.38, lensY + lensH);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(eye.x - lensW * 0.36, lensY + lensH * 0.52);
      ctx.lineTo(eye.x + skew * lensW * 0.28, lensY + lensH * 0.34);
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.48, lensY + lensH * 0.45);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.48, lensY + lensH * 0.45);
    ctx.stroke();
  } else if (filter === "cat-ear-headphones") {
    const earBaseY = headTopY + faceWidth * 0.03;
    const earH = faceWidth * 0.28;
    const earW = faceWidth * 0.18;
    const cupY = eyewearLineY + faceWidth * 0.03;
    const cupW = faceWidth * 0.14;
    const cupH = faceWidth * 0.25;
    beginProbe({
      left: headCenterX - faceWidth * 0.56,
      right: headCenterX + faceWidth * 0.56,
      top: earBaseY - earH - faceWidth * 0.1,
      bottom: cupY + cupH * 0.62,
    });
    [
      { x: headCenterX - faceWidth * 0.26, rotate: -0.16 },
      { x: headCenterX + faceWidth * 0.26, rotate: 0.16 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.45);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(24,24,27,0.96)";
      ctx.beginPath();
      ctx.moveTo(-earW, earH * 0.48);
      ctx.lineTo(0, -earH * 0.6);
      ctx.lineTo(earW, earH * 0.48);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(216,180,254,0.82)";
      ctx.beginPath();
      ctx.moveTo(-earW * 0.46, earH * 0.3);
      ctx.lineTo(0, -earH * 0.28);
      ctx.lineTo(earW * 0.46, earH * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.strokeStyle = "rgba(24,24,27,0.96)";
    ctx.lineWidth = Math.max(7, faceWidth * 0.055);
    ctx.beginPath();
    ctx.arc(
      headCenterX,
      earBaseY + faceWidth * 0.1,
      faceWidth * 0.43,
      Math.PI * 1.08,
      Math.PI * 1.92,
    );
    ctx.stroke();
    ctx.fillStyle = "rgba(124,58,237,0.95)";
    [
      { x: headCenterX - faceWidth * 0.43, side: -1 },
      { x: headCenterX + faceWidth * 0.43, side: 1 },
    ].forEach((cup) => {
      ctx.beginPath();
      ctx.ellipse(cup.x, cupY, cupW, cupH, cup.side * 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(24,24,27,0.88)";
      ctx.beginPath();
      ctx.ellipse(cup.x, cupY, cupW * 0.58, cupH * 0.72, cup.side * 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(124,58,237,0.95)";
    });
  } else if (filter === "crown") {
    const baseY = headTopY + faceWidth * 0.04;
    const crownW = faceWidth * 0.78;
    const crownH = faceWidth * 0.26;
    beginProbe({
      left: headCenterX - crownW / 2 - faceWidth * 0.04,
      right: headCenterX + crownW / 2 + faceWidth * 0.04,
      top: baseY - crownH - faceWidth * 0.04,
      bottom: baseY + faceWidth * 0.04,
    });
    ctx.fillStyle = "#f59e0b";
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(headCenterX - crownW / 2, baseY);
    ctx.lineTo(headCenterX - crownW * 0.28, baseY - crownH);
    ctx.lineTo(headCenterX, baseY - crownH * 0.35);
    ctx.lineTo(headCenterX + crownW * 0.28, baseY - crownH);
    ctx.lineTo(headCenterX + crownW / 2, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (filter === "halo") {
    const haloY = headTopY - faceWidth * 0.13;
    beginProbe({
      left: headCenterX - faceWidth * 0.42,
      right: headCenterX + faceWidth * 0.42,
      top: haloY - faceWidth * 0.16,
      bottom: haloY + faceWidth * 0.16,
    });
    ctx.strokeStyle = "rgba(253,224,71,0.9)";
    ctx.lineWidth = Math.max(6, faceWidth * 0.04);
    ctx.beginPath();
    ctx.ellipse(
      headCenterX,
      haloY,
      faceWidth * 0.34,
      faceWidth * 0.09,
      -0.08,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (filter === "bunny-ears") {
    const earBaseY = headTopY + faceWidth * 0.06;
    const earH = faceWidth * 0.58;
    const earW = faceWidth * 0.16;
    beginProbe({
      left: headCenterX - faceWidth * 0.42,
      right: headCenterX + faceWidth * 0.42,
      top: earBaseY - earH - faceWidth * 0.08,
      bottom: earBaseY + faceWidth * 0.12,
    });
    [
      { x: headCenterX - faceWidth * 0.2, rotate: -0.18 },
      { x: headCenterX + faceWidth * 0.2, rotate: 0.18 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.48);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.beginPath();
      ctx.ellipse(0, 0, earW, earH * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(244,114,182,0.78)";
      ctx.beginPath();
      ctx.ellipse(0, earH * 0.04, earW * 0.48, earH * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.28, earBaseY - faceWidth * 0.08, faceWidth * 0.56, faceWidth * 0.1, 18);
  } else if (filter === "bunny") {
    const earBaseY = headTopY + faceWidth * 0.06;
    const earH = faceWidth * 0.56;
    const earW = faceWidth * 0.16;
    const noseX = lerp(noseLocal.x, mouthCenterLocal.x, 0.28);
    const noseY = lerp(noseLocal.y, mouthCenterLocal.y, 0.34);
    beginProbe({
      left: headCenterX - faceWidth * 0.44,
      right: headCenterX + faceWidth * 0.44,
      top: earBaseY - earH - faceWidth * 0.08,
      bottom: mouthCenterLocal.y + faceWidth * 0.22,
    });
    [
      { x: headCenterX - faceWidth * 0.2, rotate: -0.2 },
      { x: headCenterX + faceWidth * 0.2, rotate: 0.2 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.48);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.beginPath();
      ctx.ellipse(0, 0, earW, earH * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(251,207,232,0.82)";
      ctx.beginPath();
      ctx.ellipse(0, earH * 0.04, earW * 0.5, earH * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.28, earBaseY - faceWidth * 0.08, faceWidth * 0.56, faceWidth * 0.1, 18);
    ctx.fillStyle = "rgba(244,114,182,0.95)";
    ctx.beginPath();
    ctx.moveTo(noseX, noseY + faceWidth * 0.045);
    ctx.bezierCurveTo(noseX - faceWidth * 0.08, noseY, noseX - faceWidth * 0.045, noseY - faceWidth * 0.08, noseX, noseY - faceWidth * 0.03);
    ctx.bezierCurveTo(noseX + faceWidth * 0.045, noseY - faceWidth * 0.08, noseX + faceWidth * 0.08, noseY, noseX, noseY + faceWidth * 0.045);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.86)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.014);
    [-1, 1].forEach((side) => {
      for (let whisker = -1; whisker <= 1; whisker += 1) {
        const startY = noseY + faceWidth * 0.02 + whisker * faceWidth * 0.035;
        const endY = startY + whisker * faceWidth * 0.022;
        ctx.beginPath();
        ctx.moveTo(noseX + side * faceWidth * 0.05, startY);
        ctx.lineTo(noseX + side * faceWidth * 0.32, endY);
        ctx.stroke();
      }
    });
  } else if (filter === "working-bunny") {
    const earBaseY = headTopY + faceWidth * 0.04;
    const earH = faceWidth * 0.46;
    const earW = faceWidth * 0.13;
    const lensW = clamp(eyewearLensW * 1.02, faceWidth * 0.19, faceWidth * 0.3);
    const lensH = clamp(eyewearLensH * 0.92, faceWidth * 0.1, faceWidth * 0.16);
    const lensY = eyewearLineY - lensH / 2;
    const badgeY = faceBottomY + faceWidth * 0.06;
    beginProbe({
      left: Math.min(leftEyeLocal.x - lensW * 0.66, headCenterX - faceWidth * 0.42),
      right: Math.max(rightEyeLocal.x + lensW * 0.66, headCenterX + faceWidth * 0.42),
      top: earBaseY - earH - faceWidth * 0.1,
      bottom: badgeY + faceWidth * 0.22,
    });
    [
      { x: headCenterX - faceWidth * 0.22, rotate: -0.26 },
      { x: headCenterX + faceWidth * 0.22, rotate: 0.26 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.48);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(248,250,252,0.96)";
      ctx.beginPath();
      ctx.ellipse(0, 0, earW, earH * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(191,219,254,0.8)";
      ctx.beginPath();
      ctx.ellipse(0, earH * 0.04, earW * 0.45, earH * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(37,99,235,0.94)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.24, earBaseY - faceWidth * 0.07, faceWidth * 0.48, faceWidth * 0.09, 14);
    ctx.strokeStyle = "rgba(15,23,42,0.94)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.028);
    ctx.fillStyle = "rgba(219,234,254,0.18)";
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      fillRoundRect(ctx, eye.x - lensW / 2, lensY, lensW, lensH, lensH * 0.35);
      ctx.strokeRect(eye.x - lensW / 2, lensY, lensW, lensH);
    });
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.48, lensY + lensH * 0.5);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.48, lensY + lensH * 0.5);
    ctx.stroke();
    ctx.strokeStyle = "rgba(37,99,235,0.9)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.018);
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.14, faceBottomY + faceWidth * 0.02);
    ctx.lineTo(headCenterX, badgeY);
    ctx.lineTo(headCenterX + faceWidth * 0.14, faceBottomY + faceWidth * 0.02);
    ctx.stroke();
    ctx.fillStyle = "rgba(248,250,252,0.96)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.13, badgeY - faceWidth * 0.02, faceWidth * 0.26, faceWidth * 0.14, faceWidth * 0.025);
    ctx.fillStyle = "rgba(37,99,235,0.9)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.08, badgeY + faceWidth * 0.015, faceWidth * 0.16, faceWidth * 0.026, faceWidth * 0.012);
  } else if (filter === "cute-alien") {
    const headY = headTopY + faceWidth * 0.04;
    const headW = faceWidth * 0.5;
    const headH = faceWidth * 0.34;
    beginProbe({
      left: headCenterX - faceWidth * 0.48,
      right: headCenterX + faceWidth * 0.48,
      top: headY - headH * 0.78 - faceWidth * 0.18,
      bottom: Math.max(headY + headH * 0.7, faceBottomY + faceWidth * 0.08),
    });
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(74,222,128,0.2)";
    ctx.beginPath();
    ctx.ellipse(
      headCenterX,
      lerp(headTopY, faceBottomY, 0.56),
      faceWidth * 0.36,
      faceWidth * 0.48,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(22,101,52,0.16)";
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(
        headCenterX + side * faceWidth * 0.27,
        lerp(headTopY, faceBottomY, 0.56),
        faceWidth * 0.08,
        faceWidth * 0.26,
        side * 0.08,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(21,128,61,0.84)";
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      const side = index === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.ellipse(
        eye.x + side * faceWidth * 0.015,
        eye.y - faceWidth * 0.01,
        faceWidth * 0.075,
        faceWidth * 0.12,
        side * 0.16,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.fillStyle = "rgba(187,247,208,0.55)";
      ctx.beginPath();
      ctx.arc(
        eye.x - side * faceWidth * 0.02,
        eye.y - faceWidth * 0.045,
        faceWidth * 0.018,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.fillStyle = "rgba(21,128,61,0.84)";
    });
    ctx.restore();
    ctx.strokeStyle = "rgba(22,101,52,0.9)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.018);
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.moveTo(headCenterX + side * headW * 0.18, headY - headH * 0.34);
      ctx.lineTo(headCenterX + side * headW * 0.32, headY - headH * 0.86);
      ctx.stroke();
      ctx.fillStyle = "rgba(134,239,172,0.95)";
      ctx.beginPath();
      ctx.arc(
        headCenterX + side * headW * 0.34,
        headY - headH * 0.92,
        faceWidth * 0.035,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.fillStyle = "rgba(74,222,128,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, headY, headW * 0.5, headH * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(21,128,61,0.95)";
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(
        headCenterX + side * headW * 0.18,
        headY - headH * 0.05,
        faceWidth * 0.045,
        faceWidth * 0.07,
        side * 0.12,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.strokeStyle = "rgba(21,128,61,0.85)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.014);
    ctx.beginPath();
    ctx.arc(headCenterX, headY + headH * 0.16, faceWidth * 0.07, 0.18, Math.PI - 0.18);
    ctx.stroke();
  } else if (filter === "cute-astronaut") {
    const helmetCenterY = lerp(headTopY, faceBottomY, 0.46);
    const helmetW = faceWidth * 0.86;
    const helmetH = faceWidth * 0.92;
    const collarY = faceBottomY + faceWidth * 0.06;
    beginProbe({
      left: headCenterX - helmetW * 0.58,
      right: headCenterX + helmetW * 0.58,
      top: helmetCenterY - helmetH * 0.62,
      bottom: collarY + faceWidth * 0.18,
    });
    ctx.fillStyle = "rgba(248,250,252,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, helmetCenterY, helmetW * 0.5, helmetH * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(147,197,253,0.24)";
    ctx.strokeStyle = "rgba(37,99,235,0.92)";
    ctx.lineWidth = Math.max(5, faceWidth * 0.032);
    ctx.beginPath();
    ctx.ellipse(headCenterX, helmetCenterY, helmetW * 0.39, helmetH * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.72)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.018);
    ctx.beginPath();
    ctx.arc(headCenterX - helmetW * 0.08, helmetCenterY - helmetH * 0.08, helmetW * 0.18, Math.PI * 1.12, Math.PI * 1.58);
    ctx.stroke();
    ctx.fillStyle = "rgba(37,99,235,0.95)";
    fillRoundRect(ctx, headCenterX - helmetW * 0.28, collarY - faceWidth * 0.04, helmetW * 0.56, faceWidth * 0.15, faceWidth * 0.04);
    ctx.fillStyle = "rgba(248,250,252,0.96)";
    fillRoundRect(ctx, headCenterX - helmetW * 0.18, collarY, helmetW * 0.36, faceWidth * 0.14, faceWidth * 0.035);
    ctx.fillStyle = "rgba(239,68,68,0.95)";
    ctx.beginPath();
    ctx.arc(headCenterX + helmetW * 0.18, collarY + faceWidth * 0.03, faceWidth * 0.025, 0, Math.PI * 2);
    ctx.fill();
  } else if (filter === "cat-ears-glasses") {
    const earBaseY = headTopY + faceWidth * 0.05;
    const earH = faceWidth * 0.3;
    const earW = faceWidth * 0.18;
    const lensW = clamp(eyewearLensW * 1.02, faceWidth * 0.2, faceWidth * 0.3);
    const lensH = clamp(eyewearLensH * 0.95, faceWidth * 0.1, faceWidth * 0.16);
    const lensY = eyewearLineY - lensH / 2;
    beginProbe({
      left: Math.min(leftEyeLocal.x - lensW * 0.7, headCenterX - faceWidth * 0.44),
      right: Math.max(rightEyeLocal.x + lensW * 0.7, headCenterX + faceWidth * 0.44),
      top: earBaseY - earH - faceWidth * 0.08,
      bottom: lensY + lensH + faceWidth * 0.08,
    });
    [
      { x: headCenterX - faceWidth * 0.26, rotate: -0.18 },
      { x: headCenterX + faceWidth * 0.26, rotate: 0.18 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.44);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(24,24,27,0.96)";
      ctx.beginPath();
      ctx.moveTo(-earW, earH * 0.46);
      ctx.lineTo(0, -earH * 0.58);
      ctx.lineTo(earW, earH * 0.46);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(244,114,182,0.74)";
      ctx.beginPath();
      ctx.moveTo(-earW * 0.45, earH * 0.28);
      ctx.lineTo(0, -earH * 0.28);
      ctx.lineTo(earW * 0.45, earH * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.strokeStyle = "rgba(24,24,27,0.94)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.03);
    ctx.fillStyle = "rgba(244,114,182,0.16)";
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      ctx.beginPath();
      ctx.ellipse(eye.x, lensY + lensH * 0.52, lensW * 0.52, lensH * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.5, lensY + lensH * 0.5);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.5, lensY + lensH * 0.5);
    ctx.stroke();
  } else if (filter === "cat-on-head") {
    const catY = headTopY - faceWidth * 0.2;
    const catW = faceWidth * 0.48;
    const catH = faceWidth * 0.28;
    beginProbe({
      left: headCenterX - catW * 0.62,
      right: headCenterX + catW * 0.62,
      top: catY - catH * 0.75,
      bottom: catY + catH * 0.72,
    });
    ctx.fillStyle = "rgba(251,191,36,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, catY, catW * 0.5, catH * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    [
      { x: headCenterX - catW * 0.28, rotate: -0.08 },
      { x: headCenterX + catW * 0.28, rotate: 0.08 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, catY - catH * 0.36);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(251,191,36,0.96)";
      ctx.beginPath();
      ctx.moveTo(-catW * 0.14, catH * 0.12);
      ctx.lineTo(0, -catH * 0.46);
      ctx.lineTo(catW * 0.14, catH * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(251,113,133,0.72)";
      ctx.beginPath();
      ctx.moveTo(-catW * 0.06, catH * 0.02);
      ctx.lineTo(0, -catH * 0.24);
      ctx.lineTo(catW * 0.06, catH * 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(24,24,27,0.9)";
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(headCenterX + side * catW * 0.16, catY - catH * 0.05, catW * 0.035, catH * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "rgba(244,114,182,0.9)";
    ctx.beginPath();
    ctx.moveTo(headCenterX, catY + catH * 0.1);
    ctx.lineTo(headCenterX - catW * 0.045, catY + catH * 0.02);
    ctx.lineTo(headCenterX + catW * 0.045, catY + catH * 0.02);
    ctx.closePath();
    ctx.fill();
  } else if (filter === "fuzzy-cat") {
    const earBaseY = headTopY + faceWidth * 0.04;
    const earH = faceWidth * 0.32;
    const earW = faceWidth * 0.2;
    const noseX = lerp(noseLocal.x, mouthCenterLocal.x, 0.28);
    const noseY = lerp(noseLocal.y, mouthCenterLocal.y, 0.34);
    beginProbe({
      left: headCenterX - faceWidth * 0.48,
      right: headCenterX + faceWidth * 0.48,
      top: earBaseY - earH - faceWidth * 0.1,
      bottom: noseY + faceWidth * 0.22,
    });
    [
      { x: headCenterX - faceWidth * 0.26, rotate: -0.2 },
      { x: headCenterX + faceWidth * 0.26, rotate: 0.2 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.42);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(168,85,247,0.94)";
      ctx.beginPath();
      ctx.moveTo(-earW, earH * 0.48);
      ctx.lineTo(0, -earH * 0.6);
      ctx.lineTo(earW, earH * 0.48);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(253,244,255,0.82)";
      ctx.beginPath();
      ctx.moveTo(-earW * 0.45, earH * 0.28);
      ctx.lineTo(0, -earH * 0.24);
      ctx.lineTo(earW * 0.45, earH * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(168,85,247,0.38)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.28, earBaseY - faceWidth * 0.07, faceWidth * 0.56, faceWidth * 0.11, faceWidth * 0.04);
    ctx.fillStyle = "rgba(244,114,182,0.95)";
    ctx.beginPath();
    ctx.arc(noseX, noseY, faceWidth * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(253,244,255,0.9)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.014);
    [-1, 1].forEach((side) => {
      for (let whisker = -1; whisker <= 1; whisker += 1) {
        const startY = noseY + whisker * faceWidth * 0.035;
        ctx.beginPath();
        ctx.moveTo(noseX + side * faceWidth * 0.045, startY);
        ctx.lineTo(noseX + side * faceWidth * 0.34, startY + whisker * faceWidth * 0.02);
        ctx.stroke();
      }
    });
  } else if (filter === "halloween-cat") {
    const earBaseY = headTopY + faceWidth * 0.04;
    const earH = faceWidth * 0.34;
    const hatBaseY = headTopY - faceWidth * 0.01;
    const hatW = faceWidth * 0.46;
    const hatH = faceWidth * 0.38;
    const noseX = lerp(noseLocal.x, mouthCenterLocal.x, 0.28);
    const noseY = lerp(noseLocal.y, mouthCenterLocal.y, 0.34);
    beginProbe({
      left: headCenterX - faceWidth * 0.48,
      right: headCenterX + faceWidth * 0.48,
      top: hatBaseY - hatH - faceWidth * 0.08,
      bottom: noseY + faceWidth * 0.2,
    });
    [
      { x: headCenterX - faceWidth * 0.28, rotate: -0.2 },
      { x: headCenterX + faceWidth * 0.28, rotate: 0.2 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earBaseY - earH * 0.42);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(17,24,39,0.96)";
      ctx.beginPath();
      ctx.moveTo(-faceWidth * 0.18, earH * 0.48);
      ctx.lineTo(0, -earH * 0.58);
      ctx.lineTo(faceWidth * 0.18, earH * 0.48);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(249,115,22,0.78)";
      ctx.beginPath();
      ctx.moveTo(-faceWidth * 0.08, earH * 0.25);
      ctx.lineTo(0, -earH * 0.22);
      ctx.lineTo(faceWidth * 0.08, earH * 0.25);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(249,115,22,0.96)";
    ctx.beginPath();
    ctx.moveTo(headCenterX - hatW * 0.32, hatBaseY);
    ctx.lineTo(headCenterX, hatBaseY - hatH);
    ctx.lineTo(headCenterX + hatW * 0.32, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(17,24,39,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, hatBaseY + faceWidth * 0.02, hatW * 0.52, faceWidth * 0.055, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(249,115,22,0.9)";
    ctx.beginPath();
    ctx.arc(noseX, noseY, faceWidth * 0.032, 0, Math.PI * 2);
    ctx.fill();
  } else if (filter === "velvety-dog") {
    const earTopY = headTopY + faceWidth * 0.02;
    const earH = faceWidth * 0.58;
    const earW = faceWidth * 0.18;
    const noseX = lerp(noseLocal.x, mouthCenterLocal.x, 0.24);
    const noseY = lerp(noseLocal.y, mouthCenterLocal.y, 0.42);
    beginProbe({
      left: headCenterX - faceWidth * 0.54,
      right: headCenterX + faceWidth * 0.54,
      top: earTopY - faceWidth * 0.08,
      bottom: noseY + faceWidth * 0.24,
    });
    [
      { x: headCenterX - faceWidth * 0.34, rotate: 0.16 },
      { x: headCenterX + faceWidth * 0.34, rotate: -0.16 },
    ].forEach((ear) => {
      ctx.save();
      ctx.translate(ear.x, earTopY + earH * 0.34);
      ctx.rotate(ear.rotate);
      ctx.fillStyle = "rgba(120,53,15,0.94)";
      ctx.beginPath();
      ctx.ellipse(0, 0, earW, earH * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(180,83,9,0.7)";
      ctx.beginPath();
      ctx.ellipse(0, earH * 0.08, earW * 0.52, earH * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.fillStyle = "rgba(254,243,199,0.84)";
    ctx.beginPath();
    ctx.ellipse(noseX, noseY + faceWidth * 0.025, faceWidth * 0.16, faceWidth * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(41,37,36,0.96)";
    ctx.beginPath();
    ctx.ellipse(noseX, noseY - faceWidth * 0.02, faceWidth * 0.055, faceWidth * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(41,37,36,0.78)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.012);
    ctx.beginPath();
    ctx.moveTo(noseX, noseY + faceWidth * 0.02);
    ctx.quadraticCurveTo(noseX - faceWidth * 0.05, noseY + faceWidth * 0.08, noseX - faceWidth * 0.1, noseY + faceWidth * 0.04);
    ctx.moveTo(noseX, noseY + faceWidth * 0.02);
    ctx.quadraticCurveTo(noseX + faceWidth * 0.05, noseY + faceWidth * 0.08, noseX + faceWidth * 0.1, noseY + faceWidth * 0.04);
    ctx.stroke();
  } else if (filter === "hair-medium-beard") {
    const hairTopY = headTopY - faceWidth * 0.05;
    const hairlineY = headTopY + faceWidth * 0.2;
    const beardTopY = lerp(noseLocal.y, mouthCenterLocal.y, 0.62);
    const beardBottomY = faceBottomY + faceWidth * 0.16;
    const sideburnTopY = headTopY + faceWidth * 0.22;
    beginProbe({
      left: headCenterX - faceWidth * 0.52,
      right: headCenterX + faceWidth * 0.52,
      top: hairTopY - faceWidth * 0.06,
      bottom: beardBottomY + faceWidth * 0.04,
    });
    const hairGradient = ctx.createLinearGradient(
      headCenterX - faceWidth * 0.48,
      hairTopY,
      headCenterX + faceWidth * 0.48,
      beardBottomY,
    );
    hairGradient.addColorStop(0, "rgba(74,47,30,0.98)");
    hairGradient.addColorStop(0.55, "rgba(45,31,23,0.96)");
    hairGradient.addColorStop(1, "rgba(28,25,23,0.94)");
    ctx.fillStyle = hairGradient;
    ctx.beginPath();
    ctx.ellipse(
      headCenterX,
      hairTopY + faceWidth * 0.2,
      faceWidth * 0.46,
      faceWidth * 0.26,
      -0.02,
      Math.PI,
      Math.PI * 2,
    );
    ctx.lineTo(headCenterX + faceWidth * 0.34, hairlineY);
    ctx.quadraticCurveTo(
      headCenterX + faceWidth * 0.1,
      hairlineY + faceWidth * 0.12,
      headCenterX - faceWidth * 0.36,
      hairlineY,
    );
    ctx.closePath();
    ctx.fill();
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.moveTo(headCenterX + side * faceWidth * 0.36, sideburnTopY);
      ctx.bezierCurveTo(
        headCenterX + side * faceWidth * 0.5,
        sideburnTopY + faceWidth * 0.14,
        headCenterX + side * faceWidth * 0.4,
        beardTopY + faceWidth * 0.18,
        headCenterX + side * faceWidth * 0.26,
        beardBottomY - faceWidth * 0.02,
      );
      ctx.lineTo(headCenterX + side * faceWidth * 0.16, beardTopY);
      ctx.quadraticCurveTo(
        headCenterX + side * faceWidth * 0.28,
        sideburnTopY + faceWidth * 0.1,
        headCenterX + side * faceWidth * 0.36,
        sideburnTopY,
      );
      ctx.closePath();
      ctx.fill();
    });
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.28, beardTopY);
    ctx.quadraticCurveTo(
      headCenterX - faceWidth * 0.34,
      faceBottomY,
      headCenterX,
      beardBottomY,
    );
    ctx.quadraticCurveTo(
      headCenterX + faceWidth * 0.34,
      faceBottomY,
      headCenterX + faceWidth * 0.28,
      beardTopY,
    );
    ctx.quadraticCurveTo(
      headCenterX + faceWidth * 0.16,
      beardTopY + faceWidth * 0.14,
      headCenterX,
      beardTopY + faceWidth * 0.1,
    );
    ctx.quadraticCurveTo(
      headCenterX - faceWidth * 0.16,
      beardTopY + faceWidth * 0.14,
      headCenterX - faceWidth * 0.28,
      beardTopY,
    );
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = "rgba(251,191,36,0.52)";
    ctx.lineWidth = Math.max(1.5, faceWidth * 0.008);
    [-0.22, 0, 0.22].forEach((offset) => {
      ctx.beginPath();
      ctx.moveTo(headCenterX + faceWidth * offset, hairTopY + faceWidth * 0.06);
      ctx.quadraticCurveTo(
        headCenterX + faceWidth * (offset * 0.4),
        hairlineY + faceWidth * 0.08,
        headCenterX + faceWidth * (offset * 1.2),
        hairlineY + faceWidth * 0.02,
      );
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  } else if (filter === "long-wavy-hair") {
    const hairTopY = headTopY - faceWidth * 0.08;
    const hairBottomY = faceBottomY + faceWidth * 0.3;
    const hairColor = ctx.createLinearGradient(
      headCenterX - faceWidth * 0.5,
      hairTopY,
      headCenterX + faceWidth * 0.5,
      hairBottomY,
    );
    hairColor.addColorStop(0, "rgba(92,48,18,0.98)");
    hairColor.addColorStop(0.5, "rgba(67,34,16,0.96)");
    hairColor.addColorStop(1, "rgba(28,25,23,0.95)");
    beginProbe({
      left: headCenterX - faceWidth * 0.62,
      right: headCenterX + faceWidth * 0.62,
      top: hairTopY - faceWidth * 0.08,
      bottom: hairBottomY + faceWidth * 0.04,
    });
    ctx.fillStyle = hairColor;
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.34, headTopY + faceWidth * 0.08);
    ctx.bezierCurveTo(
      headCenterX - faceWidth * 0.56,
      headTopY + faceWidth * 0.2,
      headCenterX - faceWidth * 0.58,
      hairBottomY - faceWidth * 0.18,
      headCenterX - faceWidth * 0.28,
      hairBottomY,
    );
    ctx.bezierCurveTo(
      headCenterX - faceWidth * 0.42,
      faceBottomY - faceWidth * 0.08,
      headCenterX - faceWidth * 0.38,
      headTopY + faceWidth * 0.28,
      headCenterX - faceWidth * 0.18,
      hairTopY + faceWidth * 0.12,
    );
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(headCenterX + faceWidth * 0.34, headTopY + faceWidth * 0.08);
    ctx.bezierCurveTo(
      headCenterX + faceWidth * 0.56,
      headTopY + faceWidth * 0.2,
      headCenterX + faceWidth * 0.58,
      hairBottomY - faceWidth * 0.18,
      headCenterX + faceWidth * 0.28,
      hairBottomY,
    );
    ctx.bezierCurveTo(
      headCenterX + faceWidth * 0.42,
      faceBottomY - faceWidth * 0.08,
      headCenterX + faceWidth * 0.38,
      headTopY + faceWidth * 0.28,
      headCenterX + faceWidth * 0.18,
      hairTopY + faceWidth * 0.12,
    );
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(
      headCenterX,
      hairTopY + faceWidth * 0.16,
      faceWidth * 0.43,
      faceWidth * 0.22,
      -0.04,
      Math.PI,
      Math.PI * 2,
    );
    ctx.lineTo(headCenterX + faceWidth * 0.28, headTopY + faceWidth * 0.16);
    ctx.quadraticCurveTo(headCenterX, headTopY + faceWidth * 0.26, headCenterX - faceWidth * 0.28, headTopY + faceWidth * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(251,191,36,0.34)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.012);
    [
      { side: -1, x: headCenterX - faceWidth * 0.36 },
      { side: 1, x: headCenterX + faceWidth * 0.36 },
    ].forEach((lock) => {
      for (let wave = 0; wave < 3; wave += 1) {
        const offset = wave * faceWidth * 0.045 * -lock.side;
        ctx.beginPath();
        ctx.moveTo(lock.x + offset, headTopY + faceWidth * 0.1);
        ctx.bezierCurveTo(
          lock.x + lock.side * faceWidth * 0.08 + offset,
          headTopY + faceWidth * 0.34,
          lock.x - lock.side * faceWidth * 0.1 + offset,
          faceBottomY + faceWidth * 0.04,
          lock.x + lock.side * faceWidth * 0.06 + offset,
          hairBottomY - faceWidth * 0.04,
        );
        ctx.stroke();
      }
    });
  } else if (filter === "beach-day") {
    const lensW = clamp(eyewearLensW * 1.02, faceWidth * 0.19, faceWidth * 0.3);
    const lensH = clamp(eyewearLensH * 0.96, faceWidth * 0.1, faceWidth * 0.16);
    const lensY = eyewearLineY - lensH / 2;
    const sunX = headCenterX + faceWidth * 0.35;
    const sunY = headTopY - faceWidth * 0.1;
    beginProbe({
      left: Math.min(leftEyeLocal.x - lensW * 0.62, headCenterX - faceWidth * 0.45),
      right: Math.max(rightEyeLocal.x + lensW * 0.62, sunX + faceWidth * 0.2),
      top: sunY - faceWidth * 0.2,
      bottom: lensY + lensH + faceWidth * 0.16,
    });
    ctx.fillStyle = "rgba(251,191,36,0.95)";
    ctx.beginPath();
    ctx.arc(sunX, sunY, faceWidth * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(14,165,233,0.92)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.032);
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.38, lensY + lensH + faceWidth * 0.1);
    for (let step = 0; step <= 6; step += 1) {
      const x = headCenterX - faceWidth * 0.38 + step * faceWidth * 0.13;
      const y =
        lensY +
        lensH +
        faceWidth * (step % 2 === 0 ? 0.11 : 0.06);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(8,47,73,0.82)";
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      fillRoundRect(ctx, eye.x - lensW / 2, lensY, lensW, lensH, lensH * 0.5);
    });
    ctx.strokeStyle = "rgba(248,250,252,0.68)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.02);
    ctx.beginPath();
    ctx.moveTo(leftEyeLocal.x + lensW * 0.48, lensY + lensH * 0.5);
    ctx.lineTo(rightEyeLocal.x - lensW * 0.48, lensY + lensH * 0.5);
    ctx.stroke();
  } else if (filter === "pirate") {
    const hatBaseY = headTopY + faceWidth * 0.02;
    const hatW = faceWidth * 0.84;
    const hatH = faceWidth * 0.34;
    const patchEye = rightEyeLocal;
    const patchW = clamp(eyewearLensW * 0.92, faceWidth * 0.18, faceWidth * 0.28);
    const patchH = clamp(eyewearLensH * 0.96, faceWidth * 0.1, faceWidth * 0.18);
    const patchY = eyewearLineY - patchH / 2;
    const beardY = lowerLipLocal
      ? lerp(lowerLipLocal.y, faceBottomY, 0.44)
      : mouthCenterLocal.y + faceWidth * 0.12;
    beginProbe({
      left: Math.min(headCenterX - hatW * 0.56, patchEye.x - patchW * 0.7),
      right: Math.max(headCenterX + hatW * 0.56, patchEye.x + patchW * 0.7),
      top: hatBaseY - hatH - faceWidth * 0.08,
      bottom: beardY + faceWidth * 0.14,
    });
    ctx.fillStyle = "rgba(17,24,39,0.98)";
    ctx.beginPath();
    ctx.moveTo(headCenterX - hatW * 0.5, hatBaseY);
    ctx.quadraticCurveTo(headCenterX - hatW * 0.28, hatBaseY - hatH * 0.78, headCenterX, hatBaseY - hatH * 0.58);
    ctx.quadraticCurveTo(headCenterX + hatW * 0.28, hatBaseY - hatH * 0.78, headCenterX + hatW * 0.5, hatBaseY);
    ctx.quadraticCurveTo(headCenterX + hatW * 0.22, hatBaseY + faceWidth * 0.09, headCenterX, hatBaseY + faceWidth * 0.02);
    ctx.quadraticCurveTo(headCenterX - hatW * 0.22, hatBaseY + faceWidth * 0.09, headCenterX - hatW * 0.5, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(248,250,252,0.94)";
    ctx.beginPath();
    ctx.arc(headCenterX, hatBaseY - hatH * 0.28, faceWidth * 0.048, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(248,250,252,0.88)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.016);
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.moveTo(headCenterX, hatBaseY - hatH * 0.2);
      ctx.lineTo(headCenterX + side * faceWidth * 0.12, hatBaseY - hatH * 0.04);
      ctx.moveTo(headCenterX + side * faceWidth * 0.02, hatBaseY - hatH * 0.04);
      ctx.lineTo(headCenterX + side * faceWidth * 0.14, hatBaseY - hatH * 0.2);
      ctx.stroke();
    });
    ctx.fillStyle = "rgba(15,23,42,0.96)";
    ctx.beginPath();
    ctx.ellipse(patchEye.x, patchY + patchH * 0.5, patchW * 0.5, patchH * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(15,23,42,0.92)";
    ctx.lineWidth = Math.max(4, faceWidth * 0.025);
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.32, eyewearLineY - faceWidth * 0.12);
    ctx.lineTo(patchEye.x + patchW * 0.18, patchY + patchH * 0.26);
    ctx.lineTo(headCenterX + faceWidth * 0.36, eyewearLineY - faceWidth * 0.1);
    ctx.stroke();
    ctx.fillStyle = "rgba(55,65,81,0.88)";
    ctx.beginPath();
    ctx.moveTo(mouthCenterLocal.x - faceWidth * 0.18, beardY - faceWidth * 0.04);
    ctx.quadraticCurveTo(mouthCenterLocal.x, beardY + faceWidth * 0.16, mouthCenterLocal.x + faceWidth * 0.18, beardY - faceWidth * 0.04);
    ctx.quadraticCurveTo(mouthCenterLocal.x, beardY + faceWidth * 0.04, mouthCenterLocal.x - faceWidth * 0.18, beardY - faceWidth * 0.04);
    ctx.fill();
  } else if (filter === "cake") {
    const cakeBaseY = headTopY + faceWidth * 0.02;
    const cakeW = faceWidth * 0.6;
    const layerH = faceWidth * 0.13;
    const candleH = faceWidth * 0.2;
    beginProbe({
      left: headCenterX - cakeW * 0.6,
      right: headCenterX + cakeW * 0.6,
      top: cakeBaseY - layerH * 2 - candleH - faceWidth * 0.08,
      bottom: cakeBaseY + faceWidth * 0.08,
    });
    ctx.fillStyle = "rgba(236,72,153,0.96)";
    fillRoundRect(
      ctx,
      headCenterX - cakeW * 0.45,
      cakeBaseY - layerH,
      cakeW * 0.9,
      layerH,
      faceWidth * 0.035,
    );
    ctx.fillStyle = "rgba(254,205,211,0.98)";
    fillRoundRect(
      ctx,
      headCenterX - cakeW * 0.34,
      cakeBaseY - layerH * 1.9,
      cakeW * 0.68,
      layerH * 0.95,
      faceWidth * 0.035,
    );
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    for (let drip = 0; drip < 4; drip += 1) {
      const x = headCenterX - cakeW * 0.3 + drip * cakeW * 0.2;
      ctx.beginPath();
      ctx.arc(x, cakeBaseY - layerH * 0.92, faceWidth * 0.026, 0, Math.PI * 2);
      ctx.fill();
    }
    [
      { x: headCenterX - cakeW * 0.18, color: "#22c55e" },
      { x: headCenterX, color: "#3b82f6" },
      { x: headCenterX + cakeW * 0.18, color: "#f97316" },
    ].forEach((candle) => {
      ctx.fillStyle = candle.color;
      fillRoundRect(
        ctx,
        candle.x - faceWidth * 0.012,
        cakeBaseY - layerH * 1.9 - candleH,
        faceWidth * 0.024,
        candleH,
        faceWidth * 0.008,
      );
      const flameY = cakeBaseY - layerH * 1.9 - candleH - faceWidth * 0.035;
      ctx.fillStyle = "rgba(250,204,21,0.96)";
      ctx.beginPath();
      ctx.moveTo(candle.x, flameY - faceWidth * 0.04);
      ctx.bezierCurveTo(
        candle.x - faceWidth * 0.035,
        flameY,
        candle.x - faceWidth * 0.018,
        flameY + faceWidth * 0.035,
        candle.x,
        flameY + faceWidth * 0.04,
      );
      ctx.bezierCurveTo(
        candle.x + faceWidth * 0.018,
        flameY + faceWidth * 0.035,
        candle.x + faceWidth * 0.035,
        flameY,
        candle.x,
        flameY - faceWidth * 0.04,
      );
      ctx.closePath();
      ctx.fill();
    });
    ctx.fillStyle = "rgba(248,250,252,0.88)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, cakeBaseY + faceWidth * 0.02, cakeW * 0.52, faceWidth * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (filter === "party-hat") {
    const hatBaseY = headTopY + faceWidth * 0.03;
    const hatW = faceWidth * 0.48;
    const hatH = faceWidth * 0.52;
    const hatX = headCenterX - faceWidth * 0.05;
    beginProbe({
      left: hatX - hatW * 0.55,
      right: hatX + hatW * 0.55,
      top: hatBaseY - hatH - faceWidth * 0.08,
      bottom: hatBaseY + faceWidth * 0.08,
    });
    const cone = ctx.createLinearGradient(hatX - hatW / 2, hatBaseY, hatX + hatW / 2, hatBaseY - hatH);
    cone.addColorStop(0, "#f97316");
    cone.addColorStop(0.5, "#ec4899");
    cone.addColorStop(1, "#7c3aed");
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(hatX - hatW / 2, hatBaseY);
    ctx.lineTo(hatX, hatBaseY - hatH);
    ctx.lineTo(hatX + hatW / 2, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.62)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.02);
    for (let stripe = 0; stripe < 3; stripe += 1) {
      const y = hatBaseY - hatH * (0.22 + stripe * 0.2);
      ctx.beginPath();
      ctx.moveTo(hatX - hatW * (0.38 - stripe * 0.08), y);
      ctx.lineTo(hatX + hatW * (0.38 - stripe * 0.08), y - faceWidth * 0.02);
      ctx.stroke();
    }
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(hatX, hatBaseY - hatH - faceWidth * 0.03, faceWidth * 0.055, 0, Math.PI * 2);
    ctx.fill();
  } else if (filter === "pilot-hat") {
    const capY = headTopY + faceWidth * 0.03;
    const capW = faceWidth * 0.72;
    const capH = faceWidth * 0.24;
    beginProbe({
      left: headCenterX - capW * 0.56,
      right: headCenterX + capW * 0.56,
      top: capY - capH - faceWidth * 0.12,
      bottom: capY + capH * 0.7,
    });
    ctx.fillStyle = "rgba(30,41,59,0.98)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY - capH * 0.22, capW * 0.48, capH * 0.52, 0, Math.PI, 0);
    ctx.lineTo(headCenterX + capW * 0.45, capY);
    ctx.lineTo(headCenterX - capW * 0.45, capY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(15,23,42,0.95)";
    fillRoundRect(ctx, headCenterX - capW * 0.44, capY - capH * 0.06, capW * 0.88, capH * 0.22, capH * 0.08);
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.moveTo(headCenterX - capW * 0.08, capY - capH * 0.18);
    ctx.lineTo(headCenterX, capY - capH * 0.32);
    ctx.lineTo(headCenterX + capW * 0.08, capY - capH * 0.18);
    ctx.lineTo(headCenterX, capY - capH * 0.1);
    ctx.closePath();
    ctx.fill();
  } else if (filter === "trucker-hat") {
    const capY = headTopY + faceWidth * 0.02;
    const capW = faceWidth * 0.74;
    const capH = faceWidth * 0.28;
    beginProbe({
      left: headCenterX - capW * 0.58,
      right: headCenterX + capW * 0.58,
      top: capY - capH - faceWidth * 0.08,
      bottom: capY + capH * 0.78,
    });
    ctx.fillStyle = "rgba(37,99,235,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY - capH * 0.24, capW * 0.47, capH * 0.55, 0, Math.PI, 0);
    ctx.lineTo(headCenterX + capW * 0.43, capY);
    ctx.lineTo(headCenterX - capW * 0.43, capY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(248,250,252,0.92)";
    fillRoundRect(
      ctx,
      headCenterX - capW * 0.18,
      capY - capH * 0.42,
      capW * 0.36,
      capH * 0.32,
      capH * 0.1,
    );
    ctx.fillStyle = "rgba(15,23,42,0.72)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY + capH * 0.12, capW * 0.36, capH * 0.16, 0, 0, Math.PI);
    ctx.fill();
  } else if (filter === "glowing-hat") {
    const hatBaseY = headTopY + faceWidth * 0.04;
    const hatW = faceWidth * 0.66;
    const hatH = faceWidth * 0.4;
    beginProbe({
      left: headCenterX - hatW * 0.62,
      right: headCenterX + hatW * 0.62,
      top: hatBaseY - hatH - faceWidth * 0.16,
      bottom: hatBaseY + faceWidth * 0.13,
    });
    ctx.shadowColor = "rgba(250,204,21,0.92)";
    ctx.shadowBlur = faceWidth * 0.12;
    const glowingHat = ctx.createLinearGradient(
      headCenterX - hatW / 2,
      hatBaseY,
      headCenterX + hatW / 2,
      hatBaseY - hatH,
    );
    glowingHat.addColorStop(0, "#f97316");
    glowingHat.addColorStop(0.5, "#facc15");
    glowingHat.addColorStop(1, "#fef3c7");
    ctx.fillStyle = glowingHat;
    ctx.beginPath();
    ctx.moveTo(headCenterX - hatW * 0.34, hatBaseY);
    ctx.quadraticCurveTo(headCenterX - hatW * 0.2, hatBaseY - hatH * 0.58, headCenterX, hatBaseY - hatH);
    ctx.quadraticCurveTo(headCenterX + hatW * 0.2, hatBaseY - hatH * 0.58, headCenterX + hatW * 0.34, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(146,64,14,0.95)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, hatBaseY + faceWidth * 0.02, hatW * 0.55, faceWidth * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    [
      { x: headCenterX - hatW * 0.16, y: hatBaseY - hatH * 0.42, r: faceWidth * 0.03 },
      { x: headCenterX + hatW * 0.12, y: hatBaseY - hatH * 0.62, r: faceWidth * 0.024 },
      { x: headCenterX + hatW * 0.02, y: hatBaseY - hatH * 0.24, r: faceWidth * 0.02 },
    ].forEach((sparkle) => {
      ctx.beginPath();
      ctx.moveTo(sparkle.x, sparkle.y - sparkle.r);
      ctx.lineTo(sparkle.x + sparkle.r * 0.32, sparkle.y - sparkle.r * 0.32);
      ctx.lineTo(sparkle.x + sparkle.r, sparkle.y);
      ctx.lineTo(sparkle.x + sparkle.r * 0.32, sparkle.y + sparkle.r * 0.32);
      ctx.lineTo(sparkle.x, sparkle.y + sparkle.r);
      ctx.lineTo(sparkle.x - sparkle.r * 0.32, sparkle.y + sparkle.r * 0.32);
      ctx.lineTo(sparkle.x - sparkle.r, sparkle.y);
      ctx.lineTo(sparkle.x - sparkle.r * 0.32, sparkle.y - sparkle.r * 0.32);
      ctx.closePath();
      ctx.fill();
    });
  } else if (filter === "noogler-hat") {
    const capY = headTopY + faceWidth * 0.03;
    const capW = faceWidth * 0.7;
    const capH = faceWidth * 0.3;
    beginProbe({
      left: headCenterX - capW * 0.58,
      right: headCenterX + capW * 0.58,
      top: capY - capH - faceWidth * 0.26,
      bottom: capY + capH * 0.72,
    });
    ctx.strokeStyle = "rgba(15,23,42,0.86)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.02);
    ctx.beginPath();
    ctx.moveTo(headCenterX, capY - capH * 0.48);
    ctx.lineTo(headCenterX, capY - capH - faceWidth * 0.12);
    ctx.stroke();
    ctx.fillStyle = "rgba(251,191,36,0.95)";
    ctx.beginPath();
    ctx.ellipse(headCenterX - faceWidth * 0.1, capY - capH - faceWidth * 0.13, faceWidth * 0.18, faceWidth * 0.035, -0.12, 0, Math.PI * 2);
    ctx.ellipse(headCenterX + faceWidth * 0.1, capY - capH - faceWidth * 0.13, faceWidth * 0.18, faceWidth * 0.035, 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY - capH * 0.24, capW * 0.47, capH * 0.56, 0, Math.PI, 0);
    ctx.lineTo(headCenterX + capW * 0.43, capY);
    ctx.lineTo(headCenterX - capW * 0.43, capY);
    ctx.closePath();
    ctx.clip();
    [
      { color: "#ef4444", x: -0.48 },
      { color: "#facc15", x: -0.16 },
      { color: "#22c55e", x: 0.16 },
      { color: "#3b82f6", x: 0.48 },
    ].forEach((panel) => {
      ctx.fillStyle = panel.color;
      ctx.fillRect(headCenterX + capW * panel.x - capW * 0.16, capY - capH * 0.9, capW * 0.32, capH * 1.1);
    });
    ctx.restore();
    ctx.fillStyle = "rgba(248,250,252,0.92)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY + capH * 0.1, capW * 0.34, capH * 0.15, 0, 0, Math.PI);
    ctx.fill();
  } else if (filter === "intern-hat") {
    const capY = headTopY + faceWidth * 0.03;
    const capW = faceWidth * 0.72;
    const capH = faceWidth * 0.28;
    beginProbe({
      left: headCenterX - capW * 0.58,
      right: headCenterX + capW * 0.58,
      top: capY - capH - faceWidth * 0.08,
      bottom: capY + capH * 0.76,
    });
    ctx.fillStyle = "rgba(71,85,105,0.98)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY - capH * 0.22, capW * 0.48, capH * 0.55, 0, Math.PI, 0);
    ctx.lineTo(headCenterX + capW * 0.44, capY);
    ctx.lineTo(headCenterX - capW * 0.44, capY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(226,232,240,0.92)";
    fillRoundRect(
      ctx,
      headCenterX - capW * 0.2,
      capY - capH * 0.42,
      capW * 0.4,
      capH * 0.3,
      capH * 0.08,
    );
    ctx.fillStyle = "rgba(30,41,59,0.96)";
    ctx.font = `700 ${Math.max(10, faceWidth * 0.075)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("INT", headCenterX, capY - capH * 0.27);
    ctx.fillStyle = "rgba(15,23,42,0.82)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, capY + capH * 0.12, capW * 0.37, capH * 0.15, 0, 0, Math.PI);
    ctx.fill();
  } else if (filter === "winter-hat-scarf") {
    const hatY = headTopY + faceWidth * 0.02;
    const hatW = faceWidth * 0.66;
    const hatH = faceWidth * 0.32;
    const scarfY = faceBottomY - faceWidth * 0.02;
    beginProbe({
      left: headCenterX - hatW * 0.6,
      right: headCenterX + hatW * 0.6,
      top: hatY - hatH - faceWidth * 0.12,
      bottom: scarfY + faceWidth * 0.2,
    });
    ctx.fillStyle = "rgba(14,165,233,0.95)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, hatY - hatH * 0.18, hatW * 0.48, hatH * 0.58, 0, Math.PI, 0);
    ctx.lineTo(headCenterX + hatW * 0.44, hatY);
    ctx.lineTo(headCenterX - hatW * 0.44, hatY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(224,242,254,0.96)";
    fillRoundRect(ctx, headCenterX - hatW * 0.48, hatY - hatH * 0.02, hatW * 0.96, hatH * 0.18, hatH * 0.08);
    ctx.beginPath();
    ctx.arc(headCenterX, hatY - hatH * 0.78, faceWidth * 0.055, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(2,132,199,0.92)";
    fillRoundRect(ctx, headCenterX - faceWidth * 0.32, scarfY, faceWidth * 0.64, faceWidth * 0.12, faceWidth * 0.06);
    ctx.fillStyle = "rgba(224,242,254,0.96)";
    fillRoundRect(ctx, headCenterX + faceWidth * 0.04, scarfY + faceWidth * 0.06, faceWidth * 0.16, faceWidth * 0.2, faceWidth * 0.04);
  } else if (filter === "wizard-hat") {
    const hatBaseY = headTopY + faceWidth * 0.05;
    const hatW = faceWidth * 0.64;
    const hatH = faceWidth * 0.72;
    const hatX = headCenterX + faceWidth * 0.02;
    beginProbe({
      left: hatX - hatW * 0.62,
      right: hatX + hatW * 0.62,
      top: hatBaseY - hatH - faceWidth * 0.06,
      bottom: hatBaseY + faceWidth * 0.12,
    });
    const wizardCone = ctx.createLinearGradient(hatX - hatW / 2, hatBaseY, hatX + hatW / 2, hatBaseY - hatH);
    wizardCone.addColorStop(0, "#312e81");
    wizardCone.addColorStop(0.55, "#6d28d9");
    wizardCone.addColorStop(1, "#a78bfa");
    ctx.fillStyle = wizardCone;
    ctx.beginPath();
    ctx.moveTo(hatX - hatW * 0.36, hatBaseY);
    ctx.quadraticCurveTo(hatX - hatW * 0.08, hatBaseY - hatH * 0.42, hatX + hatW * 0.04, hatBaseY - hatH);
    ctx.quadraticCurveTo(hatX + hatW * 0.26, hatBaseY - hatH * 0.48, hatX + hatW * 0.36, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(49,46,129,0.98)";
    ctx.beginPath();
    ctx.ellipse(hatX, hatBaseY + faceWidth * 0.02, hatW * 0.54, faceWidth * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fde047";
    [
      { x: hatX - hatW * 0.12, y: hatBaseY - hatH * 0.46, r: faceWidth * 0.03 },
      { x: hatX + hatW * 0.13, y: hatBaseY - hatH * 0.28, r: faceWidth * 0.024 },
      { x: hatX + hatW * 0.02, y: hatBaseY - hatH * 0.68, r: faceWidth * 0.02 },
    ].forEach((star) => {
      ctx.beginPath();
      ctx.moveTo(star.x, star.y - star.r);
      ctx.lineTo(star.x + star.r * 0.3, star.y - star.r * 0.3);
      ctx.lineTo(star.x + star.r, star.y);
      ctx.lineTo(star.x + star.r * 0.3, star.y + star.r * 0.3);
      ctx.lineTo(star.x, star.y + star.r);
      ctx.lineTo(star.x - star.r * 0.3, star.y + star.r * 0.3);
      ctx.lineTo(star.x - star.r, star.y);
      ctx.lineTo(star.x - star.r * 0.3, star.y - star.r * 0.3);
      ctx.closePath();
      ctx.fill();
    });
  } else if (filter === "dia-de-los-muertos") {
    const hatBaseY = headTopY + faceWidth * 0.03;
    const hatW = faceWidth * 0.88;
    const hatH = faceWidth * 0.34;
    const x = mouthCenterLocal.x;
    const y = upperLipLocal
      ? lerp(noseLocal.y, upperLipLocal.y, 0.72)
      : mouthCenterLocal.y - faceWidth * 0.02;
    const lobeW = clamp(mouthWidth * 0.6, faceWidth * 0.1, faceWidth * 0.18);
    const lobeH = clamp(mouthWidth * 0.2, faceWidth * 0.035, faceWidth * 0.07);
    beginProbe({
      left: Math.min(headCenterX - hatW * 0.58, x - mouthWidth * 0.86),
      right: Math.max(headCenterX + hatW * 0.58, x + mouthWidth * 0.86),
      top: hatBaseY - hatH - faceWidth * 0.13,
      bottom: y + faceWidth * 0.17,
    });
    ctx.fillStyle = "rgba(124,45,18,0.96)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, hatBaseY + faceWidth * 0.02, hatW * 0.48, faceWidth * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    const hatCrown = ctx.createLinearGradient(
      headCenterX - hatW * 0.2,
      hatBaseY,
      headCenterX + hatW * 0.2,
      hatBaseY - hatH,
    );
    hatCrown.addColorStop(0, "#c2410c");
    hatCrown.addColorStop(0.55, "#ea580c");
    hatCrown.addColorStop(1, "#fbbf24");
    ctx.fillStyle = hatCrown;
    ctx.beginPath();
    ctx.moveTo(headCenterX - hatW * 0.22, hatBaseY);
    ctx.quadraticCurveTo(headCenterX - hatW * 0.14, hatBaseY - hatH * 0.78, headCenterX, hatBaseY - hatH);
    ctx.quadraticCurveTo(headCenterX + hatW * 0.14, hatBaseY - hatH * 0.78, headCenterX + hatW * 0.22, hatBaseY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(254,240,138,0.95)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.018);
    ctx.beginPath();
    ctx.moveTo(headCenterX - hatW * 0.24, hatBaseY - hatH * 0.18);
    ctx.quadraticCurveTo(headCenterX, hatBaseY - hatH * 0.02, headCenterX + hatW * 0.24, hatBaseY - hatH * 0.18);
    ctx.stroke();
    [
      { x: headCenterX - hatW * 0.32, y: hatBaseY - faceWidth * 0.015, color: "#facc15" },
      { x: headCenterX + hatW * 0.32, y: hatBaseY - faceWidth * 0.015, color: "#fb7185" },
      { x: headCenterX, y: hatBaseY - hatH * 0.46, color: "#fde047" },
    ].forEach((flower) => {
      ctx.fillStyle = flower.color;
      for (let petal = 0; petal < 6; petal += 1) {
        const angle = (Math.PI * 2 * petal) / 6;
        ctx.beginPath();
        ctx.ellipse(
          flower.x + Math.cos(angle) * faceWidth * 0.026,
          flower.y + Math.sin(angle) * faceWidth * 0.026,
          faceWidth * 0.026,
          faceWidth * 0.014,
          angle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = "rgba(124,45,18,0.9)";
      ctx.beginPath();
      ctx.arc(flower.x, flower.y, faceWidth * 0.012, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "rgba(28,25,23,0.96)";
    ctx.beginPath();
    ctx.ellipse(
      x - mouthWidth * 0.24,
      y,
      lobeW,
      lobeH,
      0.18,
      0,
      Math.PI * 2,
    );
    ctx.ellipse(
      x + mouthWidth * 0.24,
      y,
      lobeW,
      lobeH,
      -0.18,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillStyle = "rgba(249,115,22,0.82)";
    [-1, 1].forEach((side) => {
      const cheekX = mouthCenterLocal.x + side * faceWidth * 0.2;
      const cheekY = lerp(noseLocal.y, mouthCenterLocal.y, 0.64);
      ctx.beginPath();
      ctx.arc(cheekX, cheekY, faceWidth * 0.028, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(250,204,21,0.86)";
      ctx.beginPath();
      ctx.arc(cheekX + side * faceWidth * 0.035, cheekY - faceWidth * 0.018, faceWidth * 0.016, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(249,115,22,0.82)";
    });
  } else if (filter === "dia-de-los-muertos-flower") {
    const crownY = headTopY + faceWidth * 0.02;
    const flowerRadius = faceWidth * 0.065;
    const eyePetalR = clamp(eyewearLensW * 0.34, faceWidth * 0.07, faceWidth * 0.11);
    const noseX = lerp(noseLocal.x, mouthCenterLocal.x, 0.18);
    const noseY = lerp(noseLocal.y, mouthCenterLocal.y, 0.32);
    beginProbe({
      left: Math.min(headCenterX - faceWidth * 0.48, leftEyeLocal.x - eyePetalR * 1.55),
      right: Math.max(headCenterX + faceWidth * 0.48, rightEyeLocal.x + eyePetalR * 1.55),
      top: crownY - faceWidth * 0.18,
      bottom: mouthCenterLocal.y + faceWidth * 0.2,
    });
    [
      { x: headCenterX - faceWidth * 0.28, y: crownY, color: "#f97316" },
      { x: headCenterX - faceWidth * 0.12, y: crownY - faceWidth * 0.06, color: "#db2777" },
      { x: headCenterX + faceWidth * 0.05, y: crownY - faceWidth * 0.07, color: "#facc15" },
      { x: headCenterX + faceWidth * 0.23, y: crownY - faceWidth * 0.02, color: "#be123c" },
    ].forEach((flower) => {
      ctx.fillStyle = flower.color;
      for (let petal = 0; petal < 8; petal += 1) {
        const angle = (Math.PI * 2 * petal) / 8;
        ctx.beginPath();
        ctx.ellipse(
          flower.x + Math.cos(angle) * flowerRadius * 0.62,
          flower.y + Math.sin(angle) * flowerRadius * 0.62,
          flowerRadius * 0.46,
          flowerRadius * 0.26,
          angle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = "rgba(88,28,135,0.9)";
      ctx.beginPath();
      ctx.arc(flower.x, flower.y, flowerRadius * 0.24, 0, Math.PI * 2);
      ctx.fill();
    });
    [leftEyeLocal, rightEyeLocal].forEach((eye, eyeIndex) => {
      ctx.strokeStyle = eyeIndex === 0 ? "rgba(219,39,119,0.88)" : "rgba(234,88,12,0.88)";
      ctx.lineWidth = Math.max(2, faceWidth * 0.012);
      for (let petal = 0; petal < 10; petal += 1) {
        const angle = (Math.PI * 2 * petal) / 10;
        ctx.beginPath();
        ctx.ellipse(
          eye.x + Math.cos(angle) * eyePetalR * 0.62,
          eye.y + Math.sin(angle) * eyePetalR * 0.5,
          eyePetalR * 0.2,
          eyePetalR * 0.32,
          angle,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    });
    ctx.fillStyle = "rgba(88,28,135,0.9)";
    ctx.beginPath();
    ctx.moveTo(noseX, noseY + faceWidth * 0.052);
    ctx.bezierCurveTo(noseX - faceWidth * 0.062, noseY, noseX - faceWidth * 0.034, noseY - faceWidth * 0.064, noseX, noseY - faceWidth * 0.026);
    ctx.bezierCurveTo(noseX + faceWidth * 0.034, noseY - faceWidth * 0.064, noseX + faceWidth * 0.062, noseY, noseX, noseY + faceWidth * 0.052);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(219,39,119,0.86)";
    ctx.lineWidth = Math.max(2, faceWidth * 0.012);
    [-1, 1].forEach((side) => {
      const cheekX = mouthCenterLocal.x + side * faceWidth * 0.2;
      const cheekY = lerp(noseLocal.y, mouthCenterLocal.y, 0.7);
      ctx.beginPath();
      ctx.arc(cheekX, cheekY, faceWidth * 0.035, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mouthCenterLocal.x + side * faceWidth * 0.06, mouthCenterLocal.y + faceWidth * 0.04);
      ctx.lineTo(mouthCenterLocal.x + side * faceWidth * 0.18, mouthCenterLocal.y + faceWidth * 0.08);
      ctx.stroke();
    });
  } else if (filter === "mustache") {
    const x = mouthCenterLocal.x;
    const y = upperLipLocal
      ? lerp(noseLocal.y, upperLipLocal.y, 0.7)
      : mouthCenterLocal.y - faceWidth * 0.02;
    const lobeW = clamp(mouthWidth * 0.58, faceWidth * 0.1, faceWidth * 0.18);
    const lobeH = clamp(mouthWidth * 0.22, faceWidth * 0.035, faceWidth * 0.07);
    beginProbe({
      left: x - mouthWidth * 0.82,
      right: x + mouthWidth * 0.82,
      top: y - faceWidth * 0.12,
      bottom: y + faceWidth * 0.12,
    });
    ctx.fillStyle = "rgba(28,25,23,0.94)";
    ctx.beginPath();
    ctx.ellipse(
      x - mouthWidth * 0.22,
      y,
      lobeW,
      lobeH,
      0.18,
      0,
      Math.PI * 2,
    );
    ctx.ellipse(
      x + mouthWidth * 0.22,
      y,
      lobeW,
      lobeH,
      -0.18,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  } else if (filter === "thin-mustache") {
    const x = mouthCenterLocal.x;
    const y = upperLipLocal
      ? lerp(noseLocal.y, upperLipLocal.y, 0.72)
      : mouthCenterLocal.y - faceWidth * 0.02;
    const curl = clamp(mouthWidth * 0.42, faceWidth * 0.08, faceWidth * 0.16);
    beginProbe({
      left: x - mouthWidth * 0.85,
      right: x + mouthWidth * 0.85,
      top: y - faceWidth * 0.08,
      bottom: y + faceWidth * 0.08,
    });
    ctx.strokeStyle = "rgba(28,25,23,0.96)";
    ctx.lineWidth = Math.max(3, faceWidth * 0.018);
    ctx.beginPath();
    ctx.moveTo(x - faceWidth * 0.02, y);
    ctx.quadraticCurveTo(x - mouthWidth * 0.35, y - faceWidth * 0.035, x - curl, y + faceWidth * 0.015);
    ctx.quadraticCurveTo(x - mouthWidth * 0.52, y + faceWidth * 0.05, x - mouthWidth * 0.7, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + faceWidth * 0.02, y);
    ctx.quadraticCurveTo(x + mouthWidth * 0.35, y - faceWidth * 0.035, x + curl, y + faceWidth * 0.015);
    ctx.quadraticCurveTo(x + mouthWidth * 0.52, y + faceWidth * 0.05, x + mouthWidth * 0.7, y);
    ctx.stroke();
  } else if (filter === "idea") {
    const mouthOpen =
      upperLipLocal && lowerLipLocal
        ? Math.abs(lowerLipLocal.y - upperLipLocal.y) >
          Math.max(12, faceWidth * 0.08)
        : false;
    const bulbY = headTopY - faceWidth * 0.16;
    beginProbe({
      left: headCenterX - faceWidth * 0.18,
      right: headCenterX + faceWidth * 0.18,
      top: bulbY - faceWidth * 0.18,
      bottom: bulbY + faceWidth * 0.18,
    });
    ctx.fillStyle = mouthOpen ? "#fde047" : "rgba(250,250,250,0.72)";
    ctx.strokeStyle = mouthOpen ? "rgba(253,224,71,0.45)" : "rgba(250,250,250,0.28)";
    ctx.lineWidth = mouthOpen ? 12 : 5;
    ctx.beginPath();
    ctx.arc(headCenterX, bulbY, faceWidth * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(10,10,11,0.85)";
    fillRoundRect(
      ctx,
      headCenterX - faceWidth * 0.06,
      bulbY + faceWidth * 0.08,
      faceWidth * 0.12,
      faceWidth * 0.06,
      3,
    );
  } else if (filter === "alien") {
    const shipY = headTopY - faceWidth * 0.16;
    beginProbe({
      left: headCenterX - faceWidth * 0.46,
      right: headCenterX + faceWidth * 0.46,
      top: shipY - faceWidth * 0.2,
      bottom: faceBottomY + faceWidth * 0.08,
    });
    const beam = ctx.createLinearGradient(
      headCenterX,
      shipY,
      noseLocal.x,
      noseLocal.y + faceWidth * 0.1,
    );
    beam.addColorStop(0, "rgba(34,197,94,0.36)");
    beam.addColorStop(1, "rgba(34,197,94,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(headCenterX - faceWidth * 0.22, shipY + faceWidth * 0.05);
    ctx.lineTo(headCenterX + faceWidth * 0.22, shipY + faceWidth * 0.05);
    ctx.lineTo(noseLocal.x + faceWidth * 0.1, noseLocal.y + faceWidth * 0.1);
    ctx.lineTo(noseLocal.x - faceWidth * 0.1, noseLocal.y + faceWidth * 0.1);
    ctx.closePath();
    ctx.fill();
    const faceBeam = ctx.createRadialGradient(
      noseLocal.x,
      noseLocal.y,
      faceWidth * 0.08,
      headCenterX,
      lerp(headTopY, faceBottomY, 0.56),
      faceWidth * 0.5,
    );
    faceBeam.addColorStop(0, "rgba(187,247,208,0.22)");
    faceBeam.addColorStop(0.56, "rgba(34,197,94,0.12)");
    faceBeam.addColorStop(1, "rgba(34,197,94,0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = faceBeam;
    ctx.beginPath();
    ctx.ellipse(
      headCenterX,
      lerp(headTopY, faceBottomY, 0.56),
      faceWidth * 0.38,
      faceWidth * 0.48,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(22,101,52,0.36)";
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      ctx.beginPath();
      ctx.ellipse(
        eye.x,
        eye.y - faceWidth * 0.005,
        faceWidth * 0.07,
        faceWidth * 0.055,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.fillStyle = "rgba(20,184,166,0.95)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, shipY, faceWidth * 0.34, faceWidth * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(187,247,208,0.9)";
    ctx.beginPath();
    ctx.ellipse(headCenterX, shipY - faceWidth * 0.06, faceWidth * 0.14, faceWidth * 0.08, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "rgba(34,197,94,0.9)";
    for (let light = -1; light <= 1; light += 1) {
      ctx.beginPath();
      ctx.arc(headCenterX + light * faceWidth * 0.16, shipY + faceWidth * 0.02, faceWidth * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (filter === "sparkles") {
    const bounds = {
      left: Math.max(faceLocalLeft - faceWidth * 0.05, -faceWidth * 0.45),
      right: Math.min(faceLocalRight + faceWidth * 0.05, faceWidth * 0.45),
      top: Math.max(faceLocalTop + faceWidth * 0.03, headTopY + faceWidth * 0.02),
      bottom: Math.min(faceLocalBottom - faceWidth * 0.03, faceWidth * 0.56),
    };
    ctx.fillStyle = "rgba(216,180,254,0.9)";
    beginProbe(bounds);
    const points = [
      [bounds.left, bounds.top],
      [bounds.right, bounds.top + faceWidth * 0.08],
      [bounds.left + faceWidth * 0.08, bounds.bottom - faceWidth * 0.16],
      [bounds.right - faceWidth * 0.1, bounds.bottom - faceWidth * 0.08],
    ];
    points.forEach(([x, y], index) => {
      const r = faceWidth * (index % 2 ? 0.035 : 0.05);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.35, y - r * 0.35);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x + r * 0.35, y + r * 0.35);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.35, y + r * 0.35);
      ctx.lineTo(x - r, y);
      ctx.lineTo(x - r * 0.35, y - r * 0.35);
      ctx.closePath();
      ctx.fill();
    });
  } else if (filter === "butterflies") {
    const localBounds = {
      left: Math.max(faceLocalLeft - faceWidth * 0.08, -faceWidth * 0.48),
      right: Math.min(faceLocalRight + faceWidth * 0.08, faceWidth * 0.48),
      top: Math.max(faceLocalTop, headTopY - faceWidth * 0.02),
      bottom: Math.min(faceLocalBottom - faceWidth * 0.06, faceWidth * 0.5),
    };
    beginProbe(localBounds);
    const lipTopY = upperLipLocal?.y ?? mouthCenterLocal.y - faceWidth * 0.035;
    const lipBottomY = lowerLipLocal?.y ?? mouthCenterLocal.y + faceWidth * 0.04;
    const lipY = (lipTopY + lipBottomY) / 2;
    const lipW = clamp(mouthWidth * 0.72, faceWidth * 0.16, faceWidth * 0.32);
    const lipH = clamp(
      Math.max(lipBottomY - lipTopY, faceWidth * 0.035),
      faceWidth * 0.035,
      faceWidth * 0.08,
    );
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    beginFaceSurfacePath();
    ctx.clip();
    ctx.fillStyle = "rgba(244,114,182,0.14)";
    ctx.fillRect(
      headCenterX - faceWidth * 0.58,
      headTopY - faceWidth * 0.08,
      faceWidth * 1.16,
      faceHeight + faceWidth * 0.16,
    );
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.ellipse(
      headCenterX - faceWidth * 0.06,
      lerp(headTopY, noseLocal.y, 0.62),
      faceWidth * 0.1,
      faceWidth * 0.22,
      -0.08,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#f9a8d4";
    [leftEyeLocal, rightEyeLocal].forEach((eye) => {
      ctx.beginPath();
      ctx.ellipse(
        eye.x,
        eye.y - faceWidth * 0.035,
        faceWidth * 0.13,
        faceWidth * 0.045,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.fillStyle = "#ec4899";
    [-1, 1].forEach((side) => {
      ctx.beginPath();
      ctx.ellipse(
        side * faceWidth * 0.24,
        lerp(noseLocal.y, mouthCenterLocal.y, 0.68),
        faceWidth * 0.12,
        faceWidth * 0.07,
        side * 0.12,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = "#db2777";
    ctx.beginPath();
    ctx.ellipse(
      mouthCenterLocal.x,
      lipY - lipH * 0.18,
      lipW * 0.48,
      lipH * 0.48,
      0,
      0,
      Math.PI * 2,
    );
    ctx.ellipse(
      mouthCenterLocal.x,
      lipY + lipH * 0.22,
      lipW * 0.5,
      lipH * 0.46,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = 0.64;
    ctx.strokeStyle = "#4a044e";
    ctx.lineWidth = Math.max(1.5, faceWidth * 0.012);
    [leftEyeLocal, rightEyeLocal].forEach((eye, index) => {
      const side = index === 0 ? -1 : 1;
      const outerX = eye.x + side * faceWidth * 0.1;
      ctx.beginPath();
      ctx.moveTo(eye.x - side * faceWidth * 0.04, eye.y - faceWidth * 0.006);
      ctx.quadraticCurveTo(
        eye.x,
        eye.y - faceWidth * 0.025,
        outerX,
        eye.y - faceWidth * 0.012,
      );
      ctx.lineTo(outerX + side * faceWidth * 0.085, eye.y - faceWidth * 0.055);
      ctx.stroke();
    });
    ctx.restore();
    [
      { x: -faceWidth * 0.38, y: localBounds.top + faceWidth * 0.08, scale: 0.95 },
      { x: faceWidth * 0.34, y: localBounds.top + faceWidth * 0.18, scale: 0.78 },
      { x: -faceWidth * 0.26, y: localBounds.bottom - faceWidth * 0.12, scale: 0.7 },
      { x: faceWidth * 0.3, y: localBounds.bottom - faceWidth * 0.08, scale: 0.62 },
    ].forEach((butterfly, index) => {
      const wing = faceWidth * 0.055 * butterfly.scale;
      ctx.fillStyle = index % 2 === 0 ? "rgba(244,114,182,0.9)" : "rgba(168,85,247,0.86)";
      ctx.beginPath();
      ctx.ellipse(butterfly.x - wing * 0.45, butterfly.y, wing, wing * 0.62, -0.55, 0, Math.PI * 2);
      ctx.ellipse(butterfly.x + wing * 0.45, butterfly.y, wing, wing * 0.62, 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(24,24,27,0.82)";
      fillRoundRect(ctx, butterfly.x - wing * 0.12, butterfly.y - wing * 0.65, wing * 0.24, wing * 1.3, wing * 0.12);
    });
  }

  ctx.restore();
  const finalBounds = bounds as CanvasBounds | null;
  if (!finalBounds) {
    return createFaceFilterRenderStats(filter, landmarkCount, "unsupported filter");
  }
  const samplePixelCount = finalBounds.width * finalBounds.height;
  const changedPixels = samplePixelCount > 0 ? 1 : 0;
  return {
    filter,
    effectGraph: getFaceFilterEffectGraphStats(filter),
    drawn: changedPixels > 0,
    reason: probeRender ? "geometry sampled" : undefined,
    landmarkCount,
    changedPixels,
    changedPixelRatio: samplePixelCount
      ? Number((changedPixels / samplePixelCount).toFixed(4))
      : 0,
    samplePixelCount,
    anchor,
    bounds: finalBounds,
  };
};

const renderFrame = (
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  effects: VideoEffectsState,
  landmarks: NormalizedLandmarkList | null,
  facePose: FacePoseTransform | null,
  segmentationMask: CanvasImageSource | null,
  backgroundImage: HTMLImageElement | null,
  backgroundBlurScratch: BackgroundBlurScratch,
  proceduralBackgroundCache: ProceduralBackgroundLayerCache | null,
  crop: CropRect,
  sourceProbe: CanvasVisibilityProbe,
  lowLightSourceStats: LowLightSourceStats,
  probeBackgroundRender: boolean,
  probeFaceRender: boolean,
  lowLightTransition: LowLightTransitionState,
  now: number,
): FrameRenderStats => {
  const rawLowLightRenderStats = computeLowLightRenderStats(
    effects,
    sourceProbe,
    lowLightSourceStats,
  );
  const lowLightRenderStats = applyLowLightTransition(
    rawLowLightRenderStats,
    lowLightTransition,
    now,
  );
  const sourceFilter = getStyleFilter(
    effects.style,
    effects.studioLook,
    lowLightRenderStats.brighteningStrength / 100,
  );
  const hasImageBackedBackground =
    effects.background === "custom" ||
    Boolean(
      BACKGROUND_ASSET_PATHS[
        effects.background as keyof typeof BACKGROUND_ASSET_PATHS
      ],
    );
  const customBackgroundReady =
    effects.background !== "custom" || Boolean(backgroundImage);
  const needsSegmentation =
    customBackgroundReady &&
    effects.background !== "none" &&
    effects.background !== "gradient";
  const hasBackgroundEffect =
    customBackgroundReady && effects.background !== "none";
  const hasSegmentationMask = Boolean(segmentationMask);
  const hasBackgroundImage = Boolean(backgroundImage);
  let backgroundRenderStats = createBackgroundRenderStats(
    effects.background,
    hasBackgroundEffect ? "not sampled" : "no background",
    hasSegmentationMask,
    hasBackgroundImage,
  );

  ctx.clearRect(0, 0, width, height);

  if (needsSegmentation && segmentationMask) {
    ctx.save();
    drawSegmentationMaskToOutput(
      ctx,
      segmentationMask,
      crop,
      sourceWidth,
      sourceHeight,
      width,
      height,
      width,
      height,
    );
    ctx.globalCompositeOperation = "source-in";
    drawVideo(ctx, source, crop, width, height, sourceFilter);
    ctx.globalCompositeOperation = "destination-over";

    if (effects.background === "blur-light" || effects.background === "blur-strong") {
      drawBlurredVideoBackground(
        ctx,
        backgroundBlurScratch,
        source,
        crop,
        width,
        height,
        effects.background,
      );
    } else if (backgroundImage) {
      drawImageCover(
        ctx,
        backgroundImage,
        backgroundImage.naturalWidth,
        backgroundImage.naturalHeight,
        width,
        height,
        "brightness(0.92) saturate(1.04)",
      );
    } else if (hasImageBackedBackground) {
      drawBlurredVideoBackground(
        ctx,
        backgroundBlurScratch,
        source,
        crop,
        width,
        height,
        "blur-strong",
      );
    } else {
      drawProceduralBackground(
        ctx,
        effects.background,
        width,
        height,
        now,
        proceduralBackgroundCache,
      );
    }
    ctx.restore();
  } else if (effects.background === "gradient") {
    drawProceduralBackground(
      ctx,
      effects.background,
      width,
      height,
      now,
      proceduralBackgroundCache,
    );
    ctx.save();
    ctx.globalAlpha = 0.94;
    drawVideo(ctx, source, crop, width, height, sourceFilter);
    ctx.restore();
  } else {
    drawVideo(ctx, source, crop, width, height, sourceFilter);
  }

  applyAppearanceStyleOverlay(ctx, width, height, effects.style);

  applyLighting(ctx, width, height, effects, lowLightRenderStats);

  if (hasBackgroundEffect) {
    const active = !needsSegmentation || hasSegmentationMask;
    backgroundRenderStats = {
      background: effects.background,
      active,
      reason: active
        ? probeBackgroundRender
          ? "geometry sampled"
          : "sample throttled"
        : "waiting for segmentation mask",
      changedPixels: active ? 1 : 0,
      changedPixelRatio: active ? 1 : 0,
      samplePixelCount: active ? 1 : 0,
      sampleRegions: [],
      hasSegmentationMask,
      hasBackgroundImage,
    };
  }

  const faceFilterStats = drawFaceFilter(
    ctx,
    effects.filter,
    landmarks,
    facePose,
    crop,
    sourceWidth,
    sourceHeight,
    width,
    height,
    probeFaceRender,
  );
  return {
    faceFilter: faceFilterStats,
    background: backgroundRenderStats,
    lowLight: lowLightRenderStats,
  };
};

export function useVideoEffects({
  sourceStream,
  effects,
  processedVideoTrackRef,
  framingRecenterToken = 0,
}: UseVideoEffectsOptions): UseVideoEffectsResult {
  const debugInstanceIdRef = useRef(0);
  if (debugInstanceIdRef.current === 0) {
    videoEffectsInstanceCounter += 1;
    debugInstanceIdRef.current = videoEffectsInstanceCounter;
  }
  const debugId = debugInstanceIdRef.current;
  const selectedEffectsRef = useRef(effects);
  const effectsRef = useRef(effects);
  const hasObservedEffectsRef = useRef(false);
  const externalEffectChangePumpUntilRef = useRef(0);
  const effectChangeFramePumpRef = useRef<((reason: string) => void) | null>(
    null,
  );
  const framingRecenterTokenRef = useRef(framingRecenterToken);
  framingRecenterTokenRef.current = framingRecenterToken;
  const [processedTrack, setProcessedTrack] = useState<MediaStreamTrack | null>(
    null,
  );
  const [processedTrackReady, setProcessedTrackReady] = useState(false);
  const [processedTrackVersion, setProcessedTrackVersion] = useState(0);
  const [meetVideoPipeTrack, setMeetVideoPipeTrack] =
    useState<MediaStreamTrack | null>(null);
  const [meetVideoPipeTrackReady, setMeetVideoPipeTrackReady] = useState(false);
  const [meetVideoPipeFailedRequestKey, setMeetVideoPipeFailedRequestKey] =
    useState<string | null>(null);
  const [meetVideoPipeLastFailure, setMeetVideoPipeLastFailure] =
    useState<MeetVideoPipeFailureSnapshot | null>(null);
  const [status, setStatus] = useState<VideoEffectsRuntimeStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [debugStats, setDebugStats] = useState<VideoEffectsDebugStats | null>(
    null,
  );

  const rawSourceVideoTrack = sourceStream?.getVideoTracks()[0] ?? null;
  const active = hasActiveVideoEffects(effects);
  const meetVideoPipeEffectGraph =
    active && effects.filter !== "none"
      ? getFaceFilterEffectGraph(effects.filter)
      : null;
  const meetVideoPipeEffectIdNumber =
    meetVideoPipeEffectGraph?.meetEffectIdNumber;
  const meetVideoPipeRequestKey =
    sourceStream &&
    rawSourceVideoTrack &&
    typeof meetVideoPipeEffectIdNumber === "number"
      ? [
          sourceStream.id,
          rawSourceVideoTrack.id,
          effects.filter,
          meetVideoPipeEffectIdNumber,
        ].join(":")
      : null;
  const meetVideoPipeRuntimeEnabled = isMeetVideoPipeRuntimeEnabled();
  const meetVideoPipeGate = useMemo(
    () => {
      const hasSourceStream = Boolean(sourceStream);
      const rawTrackLive = rawSourceVideoTrack?.readyState === "live";
      const graphRequiresMeetVideoPipe =
        meetVideoPipeEffectGraph?.requiresMeetVideoPipe === true;
      const hasNumericEffectId = typeof meetVideoPipeEffectIdNumber === "number";
      const failedRequestMatched =
        Boolean(meetVideoPipeRequestKey) &&
        meetVideoPipeFailedRequestKey === meetVideoPipeRequestKey;
      const lastFailure =
        meetVideoPipeLastFailure?.requestKey === meetVideoPipeRequestKey
          ? meetVideoPipeLastFailure
          : null;
      return {
        active:
          hasSourceStream &&
          rawTrackLive &&
          meetVideoPipeRuntimeEnabled &&
          graphRequiresMeetVideoPipe &&
          hasNumericEffectId &&
          !failedRequestMatched,
        selectedFilter: effects.filter,
        hasSourceStream,
        rawTrackLive,
        rawTrack: getTrackDebugSnapshot(rawSourceVideoTrack),
        runtimeEnabled: meetVideoPipeRuntimeEnabled,
        hasEffectGraph: Boolean(meetVideoPipeEffectGraph),
        graphRequiresMeetVideoPipe,
        effectIdNumber: meetVideoPipeEffectIdNumber ?? null,
        requestKey: meetVideoPipeRequestKey,
        failedRequestKey: meetVideoPipeFailedRequestKey,
        failedRequestMatched,
        lastFailure,
      };
    },
    [
      effects.filter,
      meetVideoPipeEffectGraph,
      meetVideoPipeEffectIdNumber,
      meetVideoPipeFailedRequestKey,
      meetVideoPipeLastFailure,
      meetVideoPipeRequestKey,
      meetVideoPipeRuntimeEnabled,
      rawSourceVideoTrack,
      sourceStream,
    ],
  );
  const meetVideoPipeActive = meetVideoPipeGate.active;
  const meetVideoPipeOnlyFilterSelected =
    meetVideoPipeEffectGraph?.requiresMeetVideoPipe === true;
  const localProcessingEffects = useMemo<VideoEffectsState>(
    () =>
      meetVideoPipeOnlyFilterSelected
        ? {
            ...effects,
            filter: "none",
          }
        : effects,
    [effects, meetVideoPipeOnlyFilterSelected],
  );
  const localPipelineActive = hasActiveVideoEffects(localProcessingEffects);
  const meetVideoPipeOutputReady =
    meetVideoPipeTrackReady && meetVideoPipeTrack?.readyState === "live";
  const localSourceVideoTrack = meetVideoPipeActive
    ? meetVideoPipeOutputReady
      ? meetVideoPipeTrack
      : null
    : rawSourceVideoTrack;
  const localPipelineSourceStream = useMemo(() => {
    if (!sourceStream) return null;
    if (!localSourceVideoTrack) return meetVideoPipeActive ? null : sourceStream;
    const tracks = sourceStream
      .getTracks()
      .filter((track) => track.kind !== "video");
    tracks.push(localSourceVideoTrack);
    return new MediaStream(tracks);
  }, [localSourceVideoTrack, meetVideoPipeActive, sourceStream]);
  const sourceVideoTrack = localSourceVideoTrack;
  const sourceStreamRef = useRef(localPipelineSourceStream);
  const finalTrackOwnerRef = useRef<FinalProcessedTrackOwner>("none");
  const retainedLocalOutputTrackRef = useRef<MediaStreamTrack | null>(null);
  const retainedLocalOutputCleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const processingContinuityRef = useRef({
    active,
    localPipelineActive,
    meetVideoPipeActive,
  });
  processingContinuityRef.current = {
    active,
    localPipelineActive,
    meetVideoPipeActive,
  };
  const roomTilingPolicyContextRef =
    useRef<VideoEffectsRoomTilingPolicyContext | null>(null);

  const shouldRetainProcessedTrackForTransition = (
    track: MediaStreamTrack | null,
  ) => {
    const continuity = processingContinuityRef.current;
    return Boolean(
      track &&
        track.readyState === "live" &&
        mountedRef.current &&
        continuity.active &&
        (continuity.localPipelineActive || continuity.meetVideoPipeActive),
    );
  };

  const retainLocalProcessedTrackForTransition = (
    track: MediaStreamTrack,
    reason: string,
    cleanupResources?: () => void,
  ) => {
    if (!shouldRetainProcessedTrackForTransition(track)) return false;
    const retainedTrack = retainedLocalOutputTrackRef.current;
    if (retainedTrack && retainedTrack !== track) {
      retainedLocalOutputCleanupRef.current?.();
      retainedLocalOutputCleanupRef.current = null;
      stopProcessedTrackAfterGrace(
        debugId,
        retainedTrack,
        "superseded retained processed output",
      );
    }
    retainedLocalOutputTrackRef.current = track;
    if (cleanupResources) {
      retainedLocalOutputCleanupRef.current = cleanupResources;
    }
    processedVideoTrackRef.current = track;
    setProcessedTrackReady(true);
    setStatus("loading");
    setProcessedTrack((current) => {
      if (!current || current === track) return track;
      return current;
    });
    logVideoEffects(debugId, "retain_processed_track_during_transition", {
      reason,
      retainedTrack: getTrackDebugSnapshot(track),
      continuity: processingContinuityRef.current,
    });
    return true;
  };

  const releaseRetainedLocalProcessedTrack = (
    reason: string,
    replacementTrack?: MediaStreamTrack | null,
  ) => {
    const retainedTrack = retainedLocalOutputTrackRef.current;
    if (!retainedTrack) return;
    const cleanupResources = retainedLocalOutputCleanupRef.current;
    retainedLocalOutputTrackRef.current = null;
    retainedLocalOutputCleanupRef.current = null;
    if (retainedTrack === replacementTrack) return;
    cleanupResources?.();
    stopProcessedTrackAfterGrace(debugId, retainedTrack, reason);
  };

  useEffect(() => {
    sourceStreamRef.current = localPipelineSourceStream;
  }, [localPipelineSourceStream]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const retainedTrack = retainedLocalOutputTrackRef.current;
      const cleanupResources = retainedLocalOutputCleanupRef.current;
      retainedLocalOutputTrackRef.current = null;
      retainedLocalOutputCleanupRef.current = null;
      cleanupResources?.();
      if (!retainedTrack || retainedTrack.readyState !== "live") return;
      logVideoEffects(debugId, "stop_retained_processed_track_unmount", {
        retainedTrack: getTrackDebugSnapshot(retainedTrack),
      });
      retainedTrack.stop();
    };
  }, [debugId]);

  useEffect(() => {
    const ingestRoomTilingMetadata = (value: unknown) => {
      const context = readRoomTilingPolicyContext(value);
      if (context) {
        roomTilingPolicyContextRef.current = context;
        return true;
      }
      return false;
    };
    const ingestRoomTilingMetadataFromDom = () => {
      const context = readRoomTilingPolicyContextFromDom();
      if (context) {
        roomTilingPolicyContextRef.current = context;
        return true;
      }
      return false;
    };
    const windowWithRoomTiling = window as Window & {
      __conclaveGetMeetRoomTilingDebug?: () => { current?: unknown };
    };
    try {
      const ingestedDebugMetadata = ingestRoomTilingMetadata(
        windowWithRoomTiling.__conclaveGetMeetRoomTilingDebug?.().current,
      );
      if (!ingestedDebugMetadata) {
        ingestRoomTilingMetadataFromDom();
      }
    } catch {
      ingestRoomTilingMetadataFromDom();
    }
    const handleRoomTiling = (event: Event) => {
      if (!ingestRoomTilingMetadata((event as CustomEvent<unknown>).detail)) {
        ingestRoomTilingMetadataFromDom();
      }
    };
    const handleViewportRoomTilingUpdate = () => {
      ingestRoomTilingMetadataFromDom();
    };
    window.addEventListener("conclave:meet-room-tiling", handleRoomTiling);
    window.addEventListener("resize", handleViewportRoomTilingUpdate);
    window.addEventListener("orientationchange", handleViewportRoomTilingUpdate);
    window.visualViewport?.addEventListener(
      "resize",
      handleViewportRoomTilingUpdate,
    );
    const fallbackInterval = window.setInterval(
      ingestRoomTilingMetadataFromDom,
      1000,
    );
    return () => {
      window.clearInterval(fallbackInterval);
      window.removeEventListener("conclave:meet-room-tiling", handleRoomTiling);
      window.removeEventListener("resize", handleViewportRoomTilingUpdate);
      window.removeEventListener(
        "orientationchange",
        handleViewportRoomTilingUpdate,
      );
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportRoomTilingUpdate,
      );
    };
  }, []);

  useEffect(() => {
    selectedEffectsRef.current = effects;
    effectsRef.current = localProcessingEffects;
    if (hasObservedEffectsRef.current) {
      externalEffectChangePumpUntilRef.current =
        performance.now() + VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_PUMP_MS;
      effectChangeFramePumpRef.current?.("effects-ref-change");
      // The output MediaStreamTrack can remain stable while its rendered
      // effect changes. Tick the version so publishers that fell back to raw
      // video get another chance to switch back to the processed track.
      setProcessedTrackVersion((version) => version + 1);
    } else {
      hasObservedEffectsRef.current = true;
    }
    logVideoEffects(debugId, "effects_changed", {
      selected: getEffectsDebugSnapshot(effects),
      localPipeline: getEffectsDebugSnapshot(localProcessingEffects),
      meetVideoPipeActive,
      meetVideoPipeGate,
    });
  }, [
    debugId,
    effects,
    localProcessingEffects,
    meetVideoPipeActive,
    meetVideoPipeGate,
  ]);

  useEffect(() => {
    processedVideoTrackRef.current = processedTrack;
    setProcessedTrackVersion((version) => version + 1);
    logVideoEffects(debugId, "processed_track_ref_changed", {
      processedTrack: getTrackDebugSnapshot(processedTrack),
    });
  }, [debugId, processedTrack, processedVideoTrackRef]);

  useEffect(() => {
    if (
      !meetVideoPipeActive ||
      !sourceStream ||
      !rawSourceVideoTrack ||
      !meetVideoPipeEffectGraph ||
      !meetVideoPipeRequestKey
    ) {
      setMeetVideoPipeTrackReady(false);
      setMeetVideoPipeTrack((current) => {
        if (current) {
          logVideoEffects(debugId, "meet_videopipe_release_inactive", {
            outputTrack: getTrackDebugSnapshot(current),
          });
        }
        return null;
      });
      return;
    }

    let cancelled = false;
    let outputTrack: MediaStreamTrack | null = null;
    let disposeSession: (() => Promise<void>) | null = null;

    const publishMeetVideoPipeTrack = (track: MediaStreamTrack) => {
      if (cancelled || track.readyState !== "live") return;
      setMeetVideoPipeTrack(track);
      setMeetVideoPipeTrackReady(true);
      setMeetVideoPipeFailedRequestKey((current) =>
        current === meetVideoPipeRequestKey ? null : current,
      );
      setMeetVideoPipeLastFailure((current) =>
        current?.requestKey === meetVideoPipeRequestKey ? null : current,
      );

      if (localPipelineActive) {
        logVideoEffects(debugId, "meet_videopipe_source_track_ready", {
          localPipelineActive,
          outputTrack: getTrackDebugSnapshot(track),
        });
        return;
      }

      finalTrackOwnerRef.current = "meet-videopipe";
      processedVideoTrackRef.current = track;
      setProcessedTrackReady(true);
      setStatus("running");
      setError(null);
      releaseRetainedLocalProcessedTrack(
        "replaced by meet-videopipe output",
        track,
      );
      setDebugStats(
        createMeetVideoPipeDirectDebugStats({
          sourceStream,
          sourceVideoTrack: rawSourceVideoTrack,
          outputTrack: track,
          effects: selectedEffectsRef.current,
          meetVideoPipe: {
            active: true,
            mode: "direct",
            graphId: meetVideoPipeEffectGraph.meetGraphId,
            effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber,
            requestKey: meetVideoPipeRequestKey,
            gate: meetVideoPipeGate,
            sourceTrack: getTrackDebugSnapshot(rawSourceVideoTrack),
            outputTrack: getTrackDebugSnapshot(track),
          },
        }),
      );
      logVideoEffects(debugId, "meet_videopipe_publish_processed_track", {
        graphId: meetVideoPipeEffectGraph.meetGraphId,
        effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber,
        outputTrack: getTrackDebugSnapshot(track),
      });
      setProcessedTrack(track);
    };

    const handleOutputMute = () => {
      warnVideoEffects(debugId, "meet_videopipe_output_track_mute", {
        outputTrack: getTrackDebugSnapshot(outputTrack),
      });
    };
    const handleOutputUnmute = () => {
      logVideoEffects(debugId, "meet_videopipe_output_track_unmute", {
        outputTrack: getTrackDebugSnapshot(outputTrack),
      });
    };
    const handleOutputEnded = () => {
      warnVideoEffects(debugId, "meet_videopipe_output_track_ended", {
        outputTrack: getTrackDebugSnapshot(outputTrack),
      });
      setMeetVideoPipeTrackReady(false);
      if (finalTrackOwnerRef.current === "meet-videopipe") {
        finalTrackOwnerRef.current = "none";
        processedVideoTrackRef.current = null;
        setProcessedTrackReady(false);
        setProcessedTrack((current) =>
          current === outputTrack ? null : current,
        );
      }
    };

    setMeetVideoPipeTrackReady(false);
    setStatus("loading");
    setError(null);
    logVideoEffects(debugId, "meet_videopipe_start", {
      graphId: meetVideoPipeEffectGraph.meetGraphId,
      effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber,
      requestKey: meetVideoPipeRequestKey,
      localPipelineActive,
      sourceStream: getStreamDebugSnapshot(sourceStream),
      sourceTrack: getTrackDebugSnapshot(rawSourceVideoTrack),
    });

    void startMeetVideoPipeEffect({
      sourceStream,
      effectGraph: meetVideoPipeEffectGraph,
      onOutputStream: (stream) => {
        logVideoEffects(debugId, "meet_videopipe_output_stream", {
          stream: getStreamDebugSnapshot(stream),
        });
      },
      onLog: ({ event, level, message, error: logError, data }) => {
        const payload = {
          message,
          error: logError ? getErrorDebugSnapshot(logError) : undefined,
          data,
        };
        if (level === "warn" || level === "error") {
          warnVideoEffects(debugId, `meet_videopipe_${event}`, payload);
          return;
        }
        logVideoEffects(debugId, `meet_videopipe_${event}`, payload);
      },
    })
      .then((session) => {
        if (cancelled) {
          void session.dispose();
          return;
        }
        disposeSession = session.dispose;
        outputTrack = session.outputTrack;
        if ("contentHint" in outputTrack) {
          outputTrack.contentHint = "motion";
        }
        outputTrack.addEventListener("mute", handleOutputMute);
        outputTrack.addEventListener("unmute", handleOutputUnmute);
        outputTrack.addEventListener("ended", handleOutputEnded);
        publishMeetVideoPipeTrack(outputTrack);
      })
      .catch((err) => {
        if (cancelled) return;
        const errorSnapshot = getErrorDebugSnapshot(err);
        warnVideoEffects(debugId, "meet_videopipe_failed", {
          error: errorSnapshot,
          graphId: meetVideoPipeEffectGraph.meetGraphId,
          effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber,
          requestKey: meetVideoPipeRequestKey,
        });
        setMeetVideoPipeFailedRequestKey(meetVideoPipeRequestKey);
        setMeetVideoPipeLastFailure({
          requestKey: meetVideoPipeRequestKey,
          graphId: meetVideoPipeEffectGraph.meetGraphId,
          effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber ?? null,
          timestampMs: Date.now(),
          error: errorSnapshot,
        });
        setMeetVideoPipeTrackReady(false);
        setMeetVideoPipeTrack((current) => {
          return null;
        });
        if (finalTrackOwnerRef.current === "meet-videopipe") {
          finalTrackOwnerRef.current = "none";
          processedVideoTrackRef.current = null;
          setProcessedTrackReady(false);
          setProcessedTrack(null);
        }
        setStatus("degraded");
        setError("Meet VideoPipe effect failed; using raw video fallback.");
      });

    return () => {
      cancelled = true;
      if (outputTrack) {
        outputTrack.removeEventListener("mute", handleOutputMute);
        outputTrack.removeEventListener("unmute", handleOutputUnmute);
        outputTrack.removeEventListener("ended", handleOutputEnded);
      }
      const releasedTrack = outputTrack;
      logVideoEffects(debugId, "meet_videopipe_cleanup", {
        graphId: meetVideoPipeEffectGraph.meetGraphId,
        effectIdNumber: meetVideoPipeEffectGraph.meetEffectIdNumber,
        requestKey: meetVideoPipeRequestKey,
        outputTrack: getTrackDebugSnapshot(releasedTrack),
      });
      setMeetVideoPipeTrackReady(false);
      setMeetVideoPipeTrack((current) => {
        if (current && current === releasedTrack) {
          return null;
        }
        return current;
      });
      if (
        releasedTrack &&
        finalTrackOwnerRef.current === "meet-videopipe"
      ) {
        if (
          retainLocalProcessedTrackForTransition(
            releasedTrack,
            "meet-videopipe cleanup",
          )
        ) {
          void disposeSession?.();
          return;
        }
        finalTrackOwnerRef.current = "none";
        processedVideoTrackRef.current = null;
        setProcessedTrackReady(false);
        setProcessedTrack((current) =>
          current === releasedTrack ? null : current,
        );
      }
      void disposeSession?.();
    };
  }, [
    debugId,
    localPipelineActive,
    meetVideoPipeActive,
    meetVideoPipeEffectGraph,
    meetVideoPipeGate,
    meetVideoPipeRequestKey,
    processedVideoTrackRef,
    rawSourceVideoTrack,
    sourceStream,
  ]);

  useEffect(() => {
    if (
      !localPipelineActive ||
      !sourceVideoTrack ||
      sourceVideoTrack.readyState !== "live"
    ) {
      logVideoEffects(debugId, "inactive_or_no_live_source", {
        active: localPipelineActive,
        meetVideoPipeActive,
        meetVideoPipeGate,
        sourceStream: getStreamDebugSnapshot(sourceStreamRef.current),
        sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
      });
      if (
        meetVideoPipeActive &&
        meetVideoPipeOutputReady &&
        meetVideoPipeTrack?.readyState === "live" &&
        rawSourceVideoTrack?.readyState === "live"
      ) {
        setDebugStats(
          createMeetVideoPipeDirectDebugStats({
            sourceStream,
            sourceVideoTrack: rawSourceVideoTrack,
            outputTrack: meetVideoPipeTrack,
            effects: selectedEffectsRef.current,
            meetVideoPipe: {
              active: true,
              mode: "direct",
              graphId: meetVideoPipeEffectGraph?.meetGraphId ?? null,
              effectIdNumber:
                meetVideoPipeEffectGraph?.meetEffectIdNumber ?? null,
              requestKey: meetVideoPipeRequestKey,
              gate: meetVideoPipeGate,
              sourceTrack: getTrackDebugSnapshot(rawSourceVideoTrack),
              outputTrack: getTrackDebugSnapshot(meetVideoPipeTrack),
            },
          }),
        );
      } else {
        setDebugStats({
          ...createInactiveDebugStats({
            active: localPipelineActive,
            sourceStream: sourceStreamRef.current,
            sourceVideoTrack,
            effects: effectsRef.current,
          }),
          meetVideoPipe: {
            active: meetVideoPipeActive,
            mode: "gate",
            gate: meetVideoPipeGate,
          },
        });
      }
      if (finalTrackOwnerRef.current === "local") {
        const currentProcessedTrack = processedVideoTrackRef.current;
        if (
          currentProcessedTrack &&
          retainLocalProcessedTrackForTransition(
            currentProcessedTrack,
            "inactive or no live source",
          )
        ) {
          return;
        }
        processedVideoTrackRef.current = null;
        finalTrackOwnerRef.current = "none";
        setProcessedTrackReady(false);
        setProcessedTrack((current) => {
          if (!current) return null;
          logVideoEffects(debugId, "release_processed_track_inactive", {
            processedTrack: getTrackDebugSnapshot(current),
          });
          stopProcessedTrackAfterGrace(debugId, current, "inactive or no live source");
          return null;
        });
      } else if (!active && finalTrackOwnerRef.current !== "meet-videopipe") {
        releaseRetainedLocalProcessedTrack("effects inactive");
        setProcessedTrackReady(false);
      }
      if (!active) {
        setStatus("off");
        setError(null);
      } else if (localPipelineActive && meetVideoPipeActive) {
        setStatus("loading");
      }
      return;
    }

    let cancelled = false;
    activeVideoEffectsPipelineCount += 1;
    markVideoEffectsPipelineBusy();
    logVideoEffects(debugId, "active_pipeline_enter", {
      activePipelineCount: activeVideoEffectsPipelineCount,
    });
    let loopTimerId: number | null = null;
    let effectChangeFramePumpTimerId: number | null = null;
    let effectChangeFramePumpGeneration = 0;
    let effectChangeFramePumpDrainFramesRemaining = 0;
    let videoFrameCallbackId: number | null = null;
    let videoFrameWatchdogTimerId: number | null = null;
    let scheduledVideoFrameToken = 0;
    let schedulerMode: "timer" | "video-frame" | "track-processor" = "timer";
    let tasksSegmenter: TasksImageSegmenter | null = null;
    let tasksFaceLandmarker: TasksFaceLandmarker | null = null;
    let tasksSegmenterPromise: Promise<TasksImageSegmenter | null> | null = null;
    let tasksFaceLandmarkerPromise: Promise<TasksFaceLandmarker | null> | null =
      null;
    let legacySegmentation: SelfieSegmentation | null = null;
    let legacyFaceMesh: FaceMesh | null = null;
    let legacySegmentationPromise: Promise<SelfieSegmentation | null> | null =
      null;
    let legacyFaceMeshPromise: Promise<FaceMesh | null> | null = null;
    let segmentationInFlight = false;
    let faceMeshInFlight = false;
    let lastSegmentationAt = 0;
    let lastFaceAt = 0;
    let segmentationIntervalMs = INITIAL_SEGMENTATION_INTERVAL_MS;
    let faceIntervalMs = getFaceModelMinIntervalMs(effectsRef.current);
    let tasksSegmenterFailed = false;
    let tasksFaceLandmarkerFailed = false;
    let legacySegmentationFailed = false;
    let legacyFaceMeshFailed = false;
    let latestSegmentationMask: CanvasImageSource | null = null;
    let latestSegmentationMaskAt = 0;
    let latestFaceLandmarks: NormalizedLandmarkList | null = null;
    let latestFaceLandmarksAt = 0;
    let latestFaceFilterLandmarks: NormalizedLandmarkList | null = null;
    let latestFaceFilterLandmarksAt = 0;
    let latestFacePose: FacePoseTransform | null = null;
    let latestFaceFilterPose: FacePoseTransform | null = null;
    let latestFaceResultAt = 0;
    let latestFaceLandmarkSmoothingStats =
      createFaceLandmarkSmoothingStats("missing-result", null, null, 1);
    let latestFaceFilterLandmarkSmoothingStats =
      createFaceLandmarkSmoothingStats("missing-result", null, null, 1);
    let consecutiveFaceNoResultCount = 0;
    let latestFaceNoResultBackoffActive = false;
    let latestFaceNoResultBackoffReason: string | null = null;
    let latestFaceNoResultBackoffIntervalMs: number | null = null;
    let nextModelDispatchKind: ModelDispatchKind = "segmentation";
    let currentCrop: CropRect | null = null;
    const lowLightTransition = createLowLightTransitionState();
    const adaptationState = createVideoEffectsAdaptationState();
    let currentStatus: VideoEffectsRuntimeStatus = "loading";
    let outputTrackPublished = false;
    let visibleOutputFrameCount = 0;
    let blackOutputFrameCount = 0;
    let renderedFrames = 0;
    let taskSegmentationRuns = 0;
    let legacySegmentationRuns = 0;
    let taskFaceRuns = 0;
    let legacyFaceRuns = 0;
    let cooperativeSegmentationDispatches = 0;
    let cooperativeFaceDispatches = 0;
    let maskUpdates = 0;
    let maskMisses = 0;
    let closedSegmentationMasks = 0;
    let lastStatsLogAt = performance.now();
    let lastLoopStartedAt = 0;
    let latestLoopProcessingDelayMs = 0;
    let latestLoopFullProcessingDelayMs = 0;
    let latestFrameIntervalMs = 0;
    let latestSegmentationProcessingMs = 0;
    let latestFaceProcessingMs = 0;
    let lastEffectsSnapshot = createVisualEffectTransitionSnapshot(
      effectsRef.current,
    );
    let lastEffectSignature = JSON.stringify(lastEffectsSnapshot);
    let processingConfigId = 1;
    let modelProcessingConfigId = 1;
    let lastModelInputSignature = "";
    let lastAdaptationOutputWriterBackpressureSkipCount = 0;
    let lastAdaptationOutputWriterUnavailableSkipCount = 0;
    let lastAdaptationOutputWriterWriteFailures = 0;
    let lastAdaptationOutputWriterPostFailures = 0;
    let lastAdaptationSegmentationWorkerFailures = 0;
    let lastAdaptationFaceWorkerFailures = 0;
    let adaptationPolicyDownshiftTransitionHoldUntil = 0;
    let adaptationPolicyDownshiftTransitionHoldTierIndex = 0;
    let adaptationPolicyDownshiftTransitionHoldReason: string | null = null;
    let adaptationPolicyUpshiftHoldUntil = 0;
    let adaptationPolicyHoldTierIndex = 0;
    let adaptationPolicyHoldReason: string | null = null;
    let latestEffectSwitchAt = 0;
    let latestEffectSwitchSequence = 0;
    let latestEffectSwitchReason: VisualEffectTransitionReason = "none";
    let latestEffectSwitchFirstDeliveredLatencyMs: number | null = null;
    let latestEffectSwitchFirstVisibleLatencyMs: number | null = null;
    let latestEffectSwitchPending = false;
    let effectSwitchModelCadenceWarmupUntil = 0;
    let adaptationEvaluationHoldUntil =
      performance.now() + VIDEO_EFFECTS_ADAPTATION_WARMUP_HOLD_MS;
    let imageCapture: InstanceType<ImageCaptureConstructor> | null = null;
    let imageCaptureUnavailable = false;
    let trackProcessorSourceTrack: MediaStreamTrack | null = null;
    let trackProcessorReader: ReadableStreamDefaultReader<VideoFrameLike> | null =
      null;
    let outputGeneratorWriter: WritableStreamDefaultWriter<GeneratedVideoFrame> | null =
      null;
    let outputWriterWorker: Worker | null = null;
    let segmentationProcessorWorker: Worker | null = null;
    let segmentationProcessorWorkerPromise: Promise<boolean> | null = null;
    let segmentationProcessorWorkerInitResolve:
      | ((ready: boolean) => void)
      | null = null;
    let segmentationProcessorWorkerInitReject:
      | ((err: unknown) => void)
      | null = null;
    let faceProcessorWorker: Worker | null = null;
    let faceProcessorWorkerPromise: Promise<boolean> | null = null;
    let faceProcessorWorkerInitResolve: ((ready: boolean) => void) | null = null;
    let faceProcessorWorkerInitReject: ((err: unknown) => void) | null = null;
    let outputWriterMode: OutputWriterMode = "main-thread";
    let outputWriterWorkerSupported = false;
    let outputWriterWorkerReady = false;
    let outputWriterWorkerHasVideoFrame: boolean | null = null;
    let outputWriterWorkerHasWritableStream: boolean | null = null;
    let outputWriterWorkerHasOffscreenCanvas: boolean | null = null;
    let outputWriterWorkerRenderer: OutputWriterStats["workerRenderer"] = null;
    let outputWriterInputMode: OutputWriterInputMode | null = null;
    let outputWriterVideoFrameUnsupported = false;
    let outputWriterFallbackReason: string | null = null;
    let outputWriterLastError: unknown = null;
    let outputWriterFramesSent = 0;
    let outputWriterFramesWritten = 0;
    let outputWriterFramesDropped = 0;
    let outputWriterSkipCount = 0;
    let outputWriterBackpressureSkipCount = 0;
    let outputWriterCadenceSkipCount = 0;
    let outputWriterUnavailableSkipCount = 0;
    let outputWriterWriteFailures = 0;
    let outputWriterPostFailures = 0;
    let outputWriterPendingFrameLimit =
      OUTPUT_WRITER_STEADY_MAX_PENDING_FRAMES;
    let latestOutputWriterSkipReason: string | null = null;
    let outputWriterSequence = 0;
    let outputWriterAckSequence = 0;
    let outputWriterFrameMetadataCount = 0;
    let outputWriterFirstFrameSeen = false;
    let consecutiveOutputWriterFailures = 0;
    let latestOutputWriterFrameMetadata:
      | OutputWriterStats["latestWorkerFrameMetadata"]
      | null = null;
    let latestOutputWriterWriteMs: number | null = null;
    let latestOutputWriterBackpressureMs: number | null = null;
    let latestOutputWriterRoundTripMs: number | null = null;
    let latestOutputWriterFrameBuildMs: number | null = null;
    let latestOutputWriterLatencyAt = 0;
    let latestOutputWriterFrameBuildAt = 0;
    let totalOutputWriterFrameBuildMs = 0;
    let maxOutputWriterFrameBuildMs = 0;
    let outputWriterFrameBuildSampleCount = 0;
    let modelWorkerVideoFrameSourceUnavailable = false;
    let modelWorkerVideoFrameSourceFailures = 0;
    const outputWriterPendingFrames = new Map<
      number,
      OutputWriterPendingFrame
    >();
    let segmentationProcessorMode: SegmentationProcessorMode = "none";
    let segmentationProcessorWorkerSupported = false;
    let segmentationProcessorWorkerReady = false;
    let segmentationProcessorWorkerDelegate: MediaPipeDelegate | null = null;
    let segmentationProcessorFallbackReason: string | null = null;
    let segmentationProcessorLastError: unknown = null;
    let segmentationProcessorWorkerFramesSent = 0;
    let segmentationProcessorWorkerResults = 0;
    let segmentationProcessorWorkerStaleResults = 0;
    let segmentationProcessorWorkerFailures = 0;
    let segmentationProcessorWorkerSequence = 0;
    let segmentationProcessorWorkerAckSequence = 0;
    let segmentationProcessorWorkerFirstResultSeen = false;
    let latestSegmentationProcessorWorkerProcessingMs: number | null = null;
    let latestSegmentationProcessorWorkerRoundTripMs: number | null = null;
    let latestSegmentationProcessorWorkerLatencyAt = 0;
    let latestSegmentationProcessorWorkerResult:
      | SegmentationProcessorStats["latestWorkerResult"]
      | null = null;
    const segmentationProcessorPendingFrames = new Map<
      number,
      SegmentationProcessorPendingFrame
    >();
    let faceProcessorMode: FaceProcessorMode = "none";
    let faceProcessorWorkerSupported = false;
    let faceProcessorWorkerReady = false;
    let faceProcessorWorkerDelegate: MediaPipeDelegate | null = null;
    let faceProcessorFallbackReason: string | null = null;
    let faceProcessorLastError: unknown = null;
    let faceProcessorWorkerFramesSent = 0;
    let faceProcessorWorkerResults = 0;
    let faceProcessorWorkerStaleResults = 0;
    let faceProcessorWorkerFailures = 0;
    let faceProcessorWorkerSequence = 0;
    let faceProcessorWorkerAckSequence = 0;
    let faceProcessorWorkerFirstResultSeen = false;
    let latestFaceProcessorWorkerProcessingMs: number | null = null;
    let latestFaceProcessorWorkerRoundTripMs: number | null = null;
    let latestFaceProcessorWorkerLatencyAt = 0;
    let latestFaceProcessorWorkerResult:
      | FaceProcessorStats["latestWorkerResult"]
      | null = null;
    const faceProcessorPendingFrames = new Map<
      number,
      FaceProcessorPendingFrame
    >();
    let outputVideoFrameCtor: VideoFrameConstructor | null = null;
    let outputGeneratorFailed = false;
    let outputFramesWritten = 0;
    let latestOutputFrameDispatchAt = 0;
    let latestOutputFrameAt = 0;
    let latestOutputFrameVisible = false;
    let latestOutputProbe: CanvasVisibilityProbe = {
      averageLuma: 0,
      peakLuma: 0,
      visible: false,
    };
    let latestVisibleOutputFrameAt = 0;
    let lastVisibleOutputRecoveryCount = 0;
    let latestLastVisibleOutputRecoveryReason: string | null = null;
    let outputFrameSequence = 0;
    let frameSequence = 0;
    let frameMetadataSequence = 0;
    let latestFrameMetadata: VideoEffectsFrameMetadata | null = null;
    let frameMetadataHistory: VideoEffectsFrameMetadata[] = [];
    let lastFrameMetadataDispatchAt = 0;
    let roomTilingEnabledFramesCount = 0;
    let roomTilingStableFramesCount = 0;
    let lastRoomTilingTrackSignature: string | null = null;
    let humanTrackingLifetimeTrackCount = 0;
    let hasSeenHumanTracking = false;
    let firstSourceFrameAt = 0;
    let firstOutputFrameAt = 0;
    let firstVisibleOutputFrameAt = 0;
    let firstPublishedTrackAt = 0;
    let latestFramePipelineStats: FramePipelineStats["lastFrame"] = null;
    let videoFrameCallbackCount = 0;
    let timerPollCount = 0;
    let duplicateFrameSkipCount = 0;
    let videoFrameWatchdogFallbackCount = 0;
    let videoFrameScheduleFailureCount = 0;
    let hiddenVideoRearmCount = 0;
    let hiddenVideoMediaEventCount = 0;
    let latestVideoFrameMetadata: VideoFrameCallbackMetadataLike | null = null;
    let latestVideoFrameKey: string | null = null;
    let lastProcessedVideoFrameKey: string | null = null;
    let lastDuplicateVideoFrameKey: string | null = null;
    let lastRenderedSegmentationMaskAt = 0;
    let lastRenderedFaceLandmarksAt = 0;
    let trackProcessorStarted = false;
    let trackProcessorUnavailable = false;
    let trackProcessorFrameCount = 0;
    let trackProcessorRestartCount = 0;
    let lastTrackProcessorRestartAt = 0;
    let latestTrackProcessorFrameAt = 0;
    let latestVideoVisibleAt = 0;
    let latestTrackProcessorFallbackAt = 0;
    let consecutiveFrameSourceMisses = 0;
    let blackSourceVideoFrameCount = 0;
    let sourceFrameFallbackCount = 0;
    let latestVideoSourceProbe: CanvasVisibilityProbe | null = null;
    let latestVideoSourceProbeAt = 0;
    let latestSourceFrameSelection:
      | "video"
      | "track-processor"
      | "image-capture"
      | "none" = "none";
    let latestSourceFrameFallbackReason:
      | "dark-video"
      | "missing-video"
      | "none" = "none";
    let maskImageData: ImageData | null = null;
    let maskAlphaHistory: Uint8Array | null = null;
    let temporalMaskFrameCount = 0;
    let temporalMaskShapeFrameCount = 0;
    let temporalMaskSmoothedFrameCount = 0;
    let temporalMaskResetCount = 0;
    let temporalMaskPixelCount = 0;
    let temporalMaskSource: TemporalMaskSource = "none";
    let latestFaceFilterRenderStats = createFaceFilterRenderStats(
      effectsRef.current.filter,
      0,
      "not rendered",
    );
    let latestBackgroundRenderStats = createBackgroundRenderStats(
      effectsRef.current.background,
      "not rendered",
    );
    let latestLowLightSourceStats = createLowLightSourceFallback(
      { averageLuma: 0, peakLuma: 0, visible: false },
      "not sampled",
    );
    let latestLowLightSourceStatsAt = 0;
    let latestLowLightRenderStats = computeLowLightRenderStats(
      DEFAULT_VIDEO_EFFECTS,
      { averageLuma: 0, peakLuma: 0, visible: false },
      {
        foregroundAverageLuma: 0,
        backgroundAverageLuma: 0,
        hasSegmentationMask: false,
        foregroundSampleWeight: 0,
        backgroundSampleWeight: 0,
        maskAverageConfidence: 0,
        maskMinConfidence: 0,
        maskMaxConfidence: 0,
        maskSampleMode: "none",
        samplePixelCount: 0,
        sampleReason: "not rendered",
      },
    );
    let latestAutoFrameStats: AutoFrameStats = {
      enabled: false,
      source: "off",
      zoom: 1,
      targetCrop: { sx: 0, sy: 0, sw: 0, sh: 0 },
      crop: { sx: 0, sy: 0, sw: 0, sh: 0 },
      foregroundBounds: null,
      faceBounds: null,
      recenterCount: 0,
      recentered: false,
      lastRecenterAgeMs: null,
    };
    let autoFrameRecenterCount = 0;
    let lastAutoFrameRecenterAt = 0;
    let lastFramingRecenterToken = framingRecenterTokenRef.current;
    let staticCropActive = false;
    let staticCropStableFrameCount = 0;
    let staticCropActivationCount = 0;
    let staticCropExitCount = 0;
    let staticCropModelSkipCount = 0;
    let staticCropEnteredAt = 0;
    let staticCropReference: CropRect | null = null;
    let staticCropLastExitReason: StaticCropExitReason = null;
    let latestStaticCropDriftPx: number | null = null;

    const recordFaceDetectionResult = (
      hasFace: boolean,
      source: "worker" | "main-thread" | "legacy",
    ) => {
      if (hasFace) {
        if (consecutiveFaceNoResultCount > 0 || latestFaceNoResultBackoffActive) {
          logVideoEffects(debugId, "face_no_result_backoff_reset", {
            source,
            consecutiveNoResultCount: consecutiveFaceNoResultCount,
            backoffActive: latestFaceNoResultBackoffActive,
          });
        }
        consecutiveFaceNoResultCount = 0;
        latestFaceNoResultBackoffActive = false;
        latestFaceNoResultBackoffReason = null;
        latestFaceNoResultBackoffIntervalMs = null;
        return;
      }

      consecutiveFaceNoResultCount += 1;
      if (
        consecutiveFaceNoResultCount === FACE_NO_RESULT_BACKOFF_AFTER_RESULTS
      ) {
        logVideoEffects(debugId, "face_no_result_backoff_ready", {
          source,
          consecutiveNoResultCount: consecutiveFaceNoResultCount,
        });
      }
    };

    const exitStaticCrop = (reason: Exclude<StaticCropExitReason, null>) => {
      if (staticCropActive) {
        staticCropExitCount += 1;
        logVideoEffects(debugId, "static_crop_exit", {
          reason,
          stableFrameCount: staticCropStableFrameCount,
          referenceCrop: staticCropReference
            ? roundCropRect(staticCropReference)
            : null,
          modelSkipCount: staticCropModelSkipCount,
        });
      }
      staticCropActive = false;
      staticCropStableFrameCount = 0;
      staticCropEnteredAt = 0;
      staticCropReference = null;
      staticCropLastExitReason = reason;
      latestStaticCropDriftPx = null;
    };

    const getStaticCropStats = (
      eligible: boolean,
      now: number,
    ): StaticCropStats => ({
      eligible,
      active: staticCropActive,
      stableFrameCount: staticCropStableFrameCount,
      activationCount: staticCropActivationCount,
      exitCount: staticCropExitCount,
      modelSkipCount: staticCropModelSkipCount,
      enterThresholdFrames: STATIC_CROP_STABLE_FRAME_THRESHOLD,
      enterDriftPx: STATIC_CROP_ENTER_DRIFT_PX,
      exitDriftPx: STATIC_CROP_EXIT_DRIFT_PX,
      faceRevalidationIntervalMs: STATIC_CROP_FACE_REVALIDATION_INTERVAL_MS,
      latestDriftPx:
        latestStaticCropDriftPx === null ||
        !Number.isFinite(latestStaticCropDriftPx)
          ? null
          : Number(latestStaticCropDriftPx.toFixed(2)),
      enteredAgeMs:
        staticCropActive && staticCropEnteredAt > 0
          ? Math.round(now - staticCropEnteredAt)
          : null,
      lastExitReason: staticCropLastExitReason,
      crop: staticCropReference ? roundCropRect(staticCropReference) : null,
    });

    const video = document.createElement("video") as VideoElementWithFrameCallback;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.style.position = "fixed";
    video.style.left = "-1px";
    video.style.top = "-1px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0.001";
    video.style.pointerEvents = "none";
    video.style.zIndex = "-1";
    video.srcObject = new MediaStream([sourceVideoTrack]);
    document.body.appendChild(video);
    logVideoEffects(debugId, "processor_start", {
      sourceStream: getStreamDebugSnapshot(sourceStreamRef.current),
      sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
      effects: getEffectsDebugSnapshot(effectsRef.current),
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });
    const segmenterTaskCanvas = document.createElement("canvas");
    const faceTaskCanvas = document.createElement("canvas");
    const segmentationModelInputCanvas = document.createElement("canvas");
    const segmentationModelInputCtx = segmentationModelInputCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    const faceModelInputCanvas = document.createElement("canvas");
    const faceModelInputCtx = faceModelInputCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    const maskScratchCanvas = document.createElement("canvas");
    const maskScratchCtx = maskScratchCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const maskCanvas = document.createElement("canvas");
    const maskCtx = maskCanvas.getContext("2d", { alpha: true });
    const outputProbeCanvas = document.createElement("canvas");
    const outputProbeCtx = outputProbeCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const sourceProbeCanvas = document.createElement("canvas");
    const sourceProbeCtx = sourceProbeCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const visualTransitionCanvas = document.createElement("canvas");
    const visualTransitionCtx = visualTransitionCanvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });
    const backgroundBlurCanvas = document.createElement("canvas");
    const backgroundBlurCtx = backgroundBlurCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    const proceduralBackgroundCanvas = document.createElement("canvas");
    const proceduralBackgroundCtx = proceduralBackgroundCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    const proceduralBackgroundCache: ProceduralBackgroundLayerCache = {
      canvas: proceduralBackgroundCanvas,
      ctx: proceduralBackgroundCtx,
      key: "",
    };
    const visualTransition = createVisualEffectTransitionState(
      visualTransitionCanvas,
      visualTransitionCtx,
    );
    let latestVisualTransitionStats = getVisualEffectTransitionStats(
      visualTransition,
      performance.now(),
    );
    const capturedFrameCanvas = document.createElement("canvas");
    const capturedFrameCtx = capturedFrameCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    const lastVisibleOutputCanvas = document.createElement("canvas");
    const lastVisibleOutputCtx = lastVisibleOutputCanvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });

    if (!ctx) {
      warnVideoEffects(debugId, "canvas_context_unavailable");
      setStatus("degraded");
      setError("Canvas video processing is not available in this browser.");
      video.srcObject = null;
      return;
    }

    const getImageCapture = () => {
      if (imageCapture || imageCaptureUnavailable) return imageCapture;
      const maybeImageCapture = (
        globalThis as unknown as { ImageCapture?: unknown }
      ).ImageCapture;
      const ImageCaptureCtor = maybeImageCapture as
        | ImageCaptureConstructor
        | undefined;
      if (!ImageCaptureCtor || !capturedFrameCtx) {
        imageCaptureUnavailable = true;
        return null;
      }
      try {
        imageCapture = new ImageCaptureCtor(sourceVideoTrack);
        logVideoEffects(debugId, "image_capture_source_available", {
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        });
      } catch (err) {
        imageCaptureUnavailable = true;
        warnVideoEffects(debugId, "image_capture_source_unavailable", {
          error: getErrorDebugSnapshot(err),
        });
      }
      return imageCapture;
    };

    const grabImageCaptureFrame = async (): Promise<FrameSource | null> => {
      const capture = getImageCapture();
      if (!capture || !capturedFrameCtx) return null;
      try {
        const bitmap = await capture.grabFrame();
        const width = getEvenDimension(bitmap.width || 1280);
        const height = getEvenDimension(bitmap.height || 720);
        if (
          capturedFrameCanvas.width !== width ||
          capturedFrameCanvas.height !== height
        ) {
          capturedFrameCanvas.width = width;
          capturedFrameCanvas.height = height;
        }
        capturedFrameCtx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        return {
          image: capturedFrameCanvas,
          width,
          height,
          source: "image-capture",
        };
      } catch (err) {
        imageCapture = null;
        imageCaptureUnavailable = true;
        warnVideoEffects(debugId, "image_capture_grab_failed", {
          error: getErrorDebugSnapshot(err),
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        });
        return null;
      }
    };

    const startTrackProcessor = () => {
      if (
        trackProcessorStarted ||
        trackProcessorUnavailable ||
        !capturedFrameCtx
      ) {
        return;
      }
      const ProcessorCtor = (
        globalThis as unknown as {
          MediaStreamTrackProcessor?: unknown;
        }
      ).MediaStreamTrackProcessor as
        | MediaStreamTrackProcessorConstructor
        | undefined;
      if (!ProcessorCtor) {
        trackProcessorUnavailable = true;
        warnVideoEffects(debugId, "track_processor_unavailable");
        return;
      }

      try {
        trackProcessorSourceTrack = sourceVideoTrack.clone();
        if ("contentHint" in trackProcessorSourceTrack) {
          trackProcessorSourceTrack.contentHint = "motion";
        }
        const processor = new ProcessorCtor({ track: trackProcessorSourceTrack });
        trackProcessorReader = processor.readable.getReader();
        trackProcessorStarted = true;
        logVideoEffects(debugId, "track_processor_started", {
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          processorTrack: getTrackDebugSnapshot(trackProcessorSourceTrack),
        });
      } catch (err) {
        trackProcessorSourceTrack?.stop();
        trackProcessorSourceTrack = null;
        trackProcessorUnavailable = true;
        warnVideoEffects(debugId, "track_processor_start_failed", {
          error: getErrorDebugSnapshot(err),
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        });
        return;
      }

      const pumpFrames = async () => {
        const reader = trackProcessorReader;
        if (!reader) return;
        while (!cancelled && trackProcessorReader === reader) {
          let frame: VideoFrameLike | undefined;
          try {
            const { done, value } = await reader.read();
            frame = value;
            if (done || !frame) break;

            const settings = sourceVideoTrack.getSettings();
            const width = getEvenDimension(
              frame.displayWidth ||
                frame.codedWidth ||
                settings.width ||
                video.videoWidth ||
                1280,
            );
            const height = getEvenDimension(
              frame.displayHeight ||
                frame.codedHeight ||
                settings.height ||
                video.videoHeight ||
                720,
            );
            if (
              capturedFrameCanvas.width !== width ||
              capturedFrameCanvas.height !== height
            ) {
              capturedFrameCanvas.width = width;
              capturedFrameCanvas.height = height;
            }
            capturedFrameCtx.drawImage(
              frame as unknown as CanvasImageSource,
              0,
              0,
              width,
              height,
            );
            latestTrackProcessorFrameAt = performance.now();
            trackProcessorFrameCount += 1;
          } catch (err) {
            if (!cancelled && trackProcessorReader === reader) {
              trackProcessorUnavailable = true;
              warnVideoEffects(debugId, "track_processor_read_failed", {
                error: getErrorDebugSnapshot(err),
                sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
              });
            }
            break;
          } finally {
            try {
              frame?.close?.();
            } catch {}
          }
        }
      };

      void pumpFrames();
    };

    const closeTrackProcessor = (reason: string) => {
      const reader = trackProcessorReader;
      const processorTrack = trackProcessorSourceTrack;
      trackProcessorReader = null;
      trackProcessorSourceTrack = null;
      trackProcessorStarted = false;
      latestTrackProcessorFrameAt = 0;

      void (async () => {
        try {
          await reader?.cancel();
        } catch (err) {
          logVideoEffects(debugId, "track_processor_cancel_failed", {
            reason,
            error: getErrorDebugSnapshot(err),
          });
        } finally {
          try {
            reader?.releaseLock();
          } catch {}
          processorTrack?.stop();
          logVideoEffects(debugId, "track_processor_closed", {
            reason,
            processorTrack: getTrackDebugSnapshot(processorTrack),
          });
        }
      })();
    };

    const restartTrackProcessor = (reason: string) => {
      if (cancelled || trackProcessorUnavailable) return false;
      const now = performance.now();
      if (
        lastTrackProcessorRestartAt > 0 &&
        now - lastTrackProcessorRestartAt < TRACK_PROCESSOR_RESTART_COOLDOWN_MS
      ) {
        return false;
      }

      const previousProcessorTrack = trackProcessorSourceTrack;
      latestTrackProcessorFrameAt = 0;
      trackProcessorFrameCount = 0;
      trackProcessorRestartCount += 1;
      lastTrackProcessorRestartAt = now;
      logVideoEffects(debugId, "track_processor_restart", {
        reason,
        restartCount: trackProcessorRestartCount,
        sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        processorTrack: getTrackDebugSnapshot(previousProcessorTrack),
      });

      closeTrackProcessor(`restart:${reason}`);
      startTrackProcessor();
      return trackProcessorStarted;
    };

    const getFreshTrackProcessorFrameSource = (
      reason: "primary" | "dark-video" | "missing-video",
    ):
      | {
          frameSource: FrameSource;
          sourceProbe: CanvasVisibilityProbe;
        }
      | null => {
      startTrackProcessor();
      const maxFrameAgeMs =
        reason === "primary" ? TRACK_PROCESSOR_PRIMARY_MAX_AGE_MS : 650;
      const processorFrameFresh =
        latestTrackProcessorFrameAt > 0 &&
        performance.now() - latestTrackProcessorFrameAt < maxFrameAgeMs;

      if (
        !processorFrameFresh ||
        capturedFrameCanvas.width <= 0 ||
        capturedFrameCanvas.height <= 0
      ) {
        return null;
      }

      const processorProbe = probeCanvasFrameVisibility(
        capturedFrameCanvas,
        sourceProbeCanvas,
        sourceProbeCtx,
      );
      if (!processorProbe.visible) {
        warnVideoEffects(debugId, "dark_track_processor_frame_source", {
          reason,
          sourceProbe: processorProbe,
          frame: {
            width: capturedFrameCanvas.width,
            height: capturedFrameCanvas.height,
            frameCount: trackProcessorFrameCount,
            ageMs: Math.round(performance.now() - latestTrackProcessorFrameAt),
          },
        });
        return null;
      }

      if (reason !== "primary") {
        sourceFrameFallbackCount += 1;
        latestTrackProcessorFallbackAt = performance.now();
      }
      latestSourceFrameSelection = "track-processor";
      latestSourceFrameFallbackReason = reason === "primary" ? "none" : reason;
      return {
        frameSource: {
          image: capturedFrameCanvas,
          width: capturedFrameCanvas.width,
          height: capturedFrameCanvas.height,
          source: "track-processor",
        },
        sourceProbe: processorProbe,
      };
    };

    const getImageCaptureFrameSource = async (
      reason: "dark-video" | "missing-video",
    ):
      Promise<
        | {
            frameSource: FrameSource;
            sourceProbe: CanvasVisibilityProbe;
          }
        | null
      > => {
      const capturedFrame = await grabImageCaptureFrame();
      if (!capturedFrame || cancelled) return null;

      const capturedProbe = probeCanvasFrameVisibility(
        capturedFrameCanvas,
        sourceProbeCanvas,
        sourceProbeCtx,
      );
      if (!capturedProbe.visible) {
        warnVideoEffects(debugId, "dark_image_capture_frame_source", {
          reason,
          sourceProbe: capturedProbe,
          frame: {
            width: capturedFrame.width,
            height: capturedFrame.height,
          },
        });
        return null;
      }

      sourceFrameFallbackCount += 1;
      latestSourceFrameSelection = "image-capture";
      latestSourceFrameFallbackReason = reason;
      logVideoEffects(debugId, "using_image_capture_frame_source", {
        reason,
        sourceProbe: capturedProbe,
        frame: {
          width: capturedFrame.width,
          height: capturedFrame.height,
        },
      });
      return {
        frameSource: capturedFrame,
        sourceProbe: capturedProbe,
      };
    };

    const getOutputCanvasSize = (
      sourceWidth?: number,
      sourceHeight?: number,
    ) => {
      const settings = sourceVideoTrack.getSettings();
      const sourceCanvasWidth = getEvenDimension(
        sourceWidth || video.videoWidth || settings.width || 1280,
      );
      const sourceCanvasHeight = getEvenDimension(
        sourceHeight || video.videoHeight || settings.height || 720,
      );
      const tier = getStableAdaptationQualityTier(adaptationState);
      const tierOutputScale =
        VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].outputScale;
      const outputScale = Math.min(
        1,
        MAX_EFFECTS_OUTPUT_WIDTH / sourceCanvasWidth,
        MAX_EFFECTS_OUTPUT_HEIGHT / sourceCanvasHeight,
      ) * tierOutputScale;
      return {
        width: getEvenDimension(sourceCanvasWidth * outputScale),
        height: getEvenDimension(sourceCanvasHeight * outputScale),
        scale: outputScale,
        sourceWidth: sourceCanvasWidth,
        sourceHeight: sourceCanvasHeight,
        tier,
        tierOutputScale,
      };
    };

    const getModelInputCanvasSize = (
      sourceWidth: number,
      sourceHeight: number,
      kind: ModelDispatchKind,
    ) => {
      const sourceCanvasWidth = getEvenDimension(sourceWidth || 1280);
      const sourceCanvasHeight = getEvenDimension(sourceHeight || 720);
      const tier = getStableAdaptationQualityTier(adaptationState);
      const tierInputScale =
        VIDEO_EFFECTS_ADAPTATION_TIER_CONFIG[tier].modelInputScale;
      const maxWidth =
        kind === "segmentation"
          ? MAX_SEGMENTATION_MODEL_INPUT_WIDTH
          : MAX_FACE_MODEL_INPUT_WIDTH;
      const maxHeight =
        kind === "segmentation"
          ? MAX_SEGMENTATION_MODEL_INPUT_HEIGHT
          : MAX_FACE_MODEL_INPUT_HEIGHT;
      const inputScale =
        Math.min(
          1,
          maxWidth / sourceCanvasWidth,
          maxHeight / sourceCanvasHeight,
        ) * tierInputScale;
      return {
        width: getEvenDimension(sourceCanvasWidth * inputScale),
        height: getEvenDimension(sourceCanvasHeight * inputScale),
        scale: inputScale,
        sourceWidth: sourceCanvasWidth,
        sourceHeight: sourceCanvasHeight,
        tier,
        tierInputScale,
      };
    };

    const ensureCanvasSize = (sourceWidth?: number, sourceHeight?: number) => {
      const outputSize = getOutputCanvasSize(sourceWidth, sourceHeight);
      const { width, height } = outputSize;
      if (canvas.width !== width || canvas.height !== height) {
        logVideoEffects(debugId, "canvas_resize", {
          previous: { width: canvas.width, height: canvas.height },
          next: { width, height },
          source: {
            width: outputSize.sourceWidth,
            height: outputSize.sourceHeight,
          },
          scale: Number(outputSize.scale.toFixed(3)),
          tier: outputSize.tier,
          tierOutputScale: outputSize.tierOutputScale,
          video: {
            readyState: video.readyState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          },
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        });
        canvas.width = width;
        canvas.height = height;
      }
      return outputSize;
    };

    const rejectPendingOutputWriterFrames = (err: unknown) => {
      for (const [, pending] of outputWriterPendingFrames) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(err);
      }
      outputWriterPendingFrames.clear();
    };

    const waitForOutputWriterBackpressureDrain = async () => {
      const oldestPending = outputWriterPendingFrames.values().next().value;
      if (!oldestPending) return true;
      let timeoutId: number | null = null;
      try {
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          timeoutId = window.setTimeout(
            () => resolve("timeout"),
            OUTPUT_WRITER_BACKPRESSURE_DRAIN_TIMEOUT_MS,
          );
        });
        await Promise.race([
          oldestPending.completion.catch(() => null),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      }
      return outputWriterPendingFrames.size < outputWriterPendingFrameLimit;
    };

    const getOldestOutputWriterPendingAgeMs = (sampleNow = performance.now()) => {
      const oldestPending = outputWriterPendingFrames.values().next().value;
      if (!oldestPending) return null;
      return Math.max(0, sampleNow - oldestPending.sentAt);
    };

    const rejectPendingSegmentationProcessorFrames = (err: unknown) => {
      for (const [, pending] of segmentationProcessorPendingFrames) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(err);
      }
      segmentationProcessorPendingFrames.clear();
    };

    const rejectPendingFaceProcessorFrames = (err: unknown) => {
      for (const [, pending] of faceProcessorPendingFrames) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(err);
      }
      faceProcessorPendingFrames.clear();
    };

    const closeWorkerAfterGrace = (worker: Worker, label: string) => {
      try {
        worker.postMessage({ type: "CLOSE" });
      } catch (err) {
        logVideoEffects(debugId, "worker_close_post_failed", {
          label,
          error: getErrorDebugSnapshot(err),
        });
      }
      window.setTimeout(() => {
        try {
          worker.terminate();
        } catch {}
      }, WORKER_CLOSE_GRACE_MS);
    };

    const detachWorkerCallbacks = (worker: Worker) => {
      try {
        worker.onmessage = null;
        worker.onerror = null;
      } catch {}
    };

    const resetSegmentationProcessorWorker = (
      reason: string,
      err: unknown,
    ) => {
      const worker = segmentationProcessorWorker;
      const pendingFrameCount = segmentationProcessorPendingFrames.size;
      segmentationProcessorWorker = null;
      segmentationProcessorWorkerPromise = null;
      segmentationProcessorWorkerReady = false;
      segmentationProcessorWorkerDelegate = null;
      segmentationProcessorMode = "none";
      segmentationProcessorFallbackReason = reason;
      segmentationProcessorLastError = getErrorDebugSnapshot(err);
      segmentationProcessorWorkerInitResolve?.(false);
      segmentationProcessorWorkerInitResolve = null;
      segmentationProcessorWorkerInitReject = null;
      rejectPendingSegmentationProcessorFrames(err);
      if (worker) {
        detachWorkerCallbacks(worker);
        closeWorkerAfterGrace(worker, `segmentation-processor:${reason}`);
      }
      logVideoEffects(debugId, "segmentation_processor_worker_reset", {
        reason,
        pendingFrameCount,
        latestSequence: segmentationProcessorWorkerSequence,
        latestAckSequence: segmentationProcessorWorkerAckSequence,
        error: getErrorDebugSnapshot(err),
      });
    };

    const resetFaceProcessorWorker = (reason: string, err: unknown) => {
      const worker = faceProcessorWorker;
      const pendingFrameCount = faceProcessorPendingFrames.size;
      faceProcessorWorker = null;
      faceProcessorWorkerPromise = null;
      faceProcessorWorkerReady = false;
      faceProcessorWorkerDelegate = null;
      faceProcessorMode = "none";
      faceProcessorFallbackReason = reason;
      faceProcessorLastError = getErrorDebugSnapshot(err);
      faceProcessorWorkerInitResolve?.(false);
      faceProcessorWorkerInitResolve = null;
      faceProcessorWorkerInitReject = null;
      rejectPendingFaceProcessorFrames(err);
      if (worker) {
        detachWorkerCallbacks(worker);
        closeWorkerAfterGrace(worker, `face-processor:${reason}`);
      }
      logVideoEffects(debugId, "face_processor_worker_reset", {
        reason,
        pendingFrameCount,
        latestSequence: faceProcessorWorkerSequence,
        latestAckSequence: faceProcessorWorkerAckSequence,
        error: getErrorDebugSnapshot(err),
      });
    };

    const handleOutputWriterWorkerMessage = (
      message: OutputWriterWorkerMessage,
    ) => {
      switch (message.type) {
        case "READY":
          outputWriterWorkerReady = true;
          outputWriterWorkerHasVideoFrame = message.hasVideoFrame;
          outputWriterWorkerHasWritableStream = message.hasWritableStream;
          outputWriterWorkerHasOffscreenCanvas = message.hasOffscreenCanvas;
          outputWriterWorkerRenderer = message.renderer;
          logVideoEffects(debugId, "output_writer_worker_ready", {
            hasVideoFrame: message.hasVideoFrame,
            hasWritableStream: message.hasWritableStream,
            hasOffscreenCanvas: message.hasOffscreenCanvas,
            renderer: message.renderer,
          });
          if (!message.hasVideoFrame) {
            outputGeneratorFailed = true;
            outputWriterFallbackReason = "worker VideoFrame unavailable";
            outputWriterLastError = outputWriterFallbackReason;
          }
          externalEffectChangePumpUntilRef.current = Math.max(
            externalEffectChangePumpUntilRef.current,
            performance.now() + VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_PUMP_MS,
          );
          effectChangeFramePumpRef.current?.("output-writer-ready");
          break;
        case "WRITTEN": {
          const pending = outputWriterPendingFrames.get(message.sequence);
          if (!pending) return;
          outputWriterPendingFrames.delete(message.sequence);
          window.clearTimeout(pending.timeoutId);
          outputWriterAckSequence = Math.max(
            outputWriterAckSequence,
            message.sequence,
          );
          latestOutputWriterWriteMs = message.writeMs;
          latestOutputWriterBackpressureMs = message.backpressureMs;
          outputWriterWorkerRenderer =
            message.renderer ?? outputWriterWorkerRenderer;
          outputWriterInputMode = message.inputMode ?? outputWriterInputMode;
          latestOutputWriterRoundTripMs = Math.max(
            0,
            performance.now() - pending.sentAt,
          );
          latestOutputWriterLatencyAt = performance.now();
          pending.resolve(message);
          break;
        }
        case "DROPPED": {
          const pending = outputWriterPendingFrames.get(message.sequence);
          if (!pending) return;
          outputWriterPendingFrames.delete(message.sequence);
          window.clearTimeout(pending.timeoutId);
          outputWriterAckSequence = Math.max(
            outputWriterAckSequence,
            message.sequence,
          );
          outputWriterFramesDropped += 1;
          latestOutputWriterSkipReason =
            message.reason === "superseded"
              ? "worker superseded queued frame"
              : "worker dropped frame while closing";
          pending.resolve(message);
          break;
        }
        case "FIRST_FRAME":
          outputWriterFirstFrameSeen = true;
          outputWriterWorkerRenderer = message.renderer;
          outputWriterInputMode = message.inputMode ?? outputWriterInputMode;
          logVideoEffects(debugId, "output_writer_worker_first_frame", {
            sequence: message.sequence,
            renderer: message.renderer,
            inputMode: message.inputMode,
          });
          break;
        case "FRAME_METADATA":
          outputWriterFrameMetadataCount += 1;
          outputWriterWorkerRenderer = message.renderer;
          outputWriterInputMode = message.inputMode ?? outputWriterInputMode;
          latestOutputWriterFrameMetadata = {
            sequence: message.sequence,
            width: message.width,
            height: message.height,
            timestamp: message.timestamp,
            duration: message.duration,
            renderer: message.renderer,
            inputMode: message.inputMode,
            writeMs: message.writeMs,
            backpressureMs: message.backpressureMs,
          };
          break;
        case "ERROR": {
          outputWriterLastError = message.error;
          if (typeof message.sequence === "number") {
            const pending = outputWriterPendingFrames.get(message.sequence);
            if (pending) {
              outputWriterPendingFrames.delete(message.sequence);
              window.clearTimeout(pending.timeoutId);
              pending.reject(message.error);
              break;
            }
          }
          outputWriterWriteFailures += 1;
          warnVideoEffects(debugId, "output_writer_worker_error", {
            sequence: message.sequence,
            error: message.error,
          });
          break;
        }
        case "CLOSED":
          outputWriterWorkerReady = false;
          outputWriterInputMode = null;
          break;
      }
    };

    const handleOutputWriterWorkerUncaughtError = (event: ErrorEvent) => {
      const error = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      };
      outputGeneratorFailed = true;
      outputWriterWriteFailures += 1;
      outputWriterLastError = error;
      rejectPendingOutputWriterFrames(error);
      warnVideoEffects(debugId, "output_writer_worker_uncaught_error", error);
    };

    const attachClaimedOutputWriterWorker = (
      claimed: PrewarmedOutputWriterWorker,
    ): ProcessedOutput | null => {
      if (claimed.track.readyState !== "live" || !claimed.hasVideoFrame) {
        closeClaimedOutputWriterWorker(
          claimed,
          claimed.track.readyState !== "live"
            ? "track-ended"
            : "video-frame-unavailable",
        );
        return null;
      }

      const VideoFrameCtor = (
        globalThis as unknown as { VideoFrame?: unknown }
      ).VideoFrame as VideoFrameConstructor | undefined;
      outputWriterWorker = claimed.worker;
      outputWriterMode = "worker";
      outputWriterWorkerSupported = true;
      outputWriterWorkerReady = true;
      outputWriterWorkerHasVideoFrame = claimed.hasVideoFrame;
      outputWriterWorkerHasWritableStream = claimed.hasWritableStream;
      outputWriterWorkerHasOffscreenCanvas = claimed.hasOffscreenCanvas;
      outputWriterWorkerRenderer = claimed.renderer;
      outputVideoFrameCtor = VideoFrameCtor ?? null;
      outputWriterInputMode = null;
      outputWriterVideoFrameUnsupported = false;
      outputWriterFallbackReason = null;
      outputWriterLastError = null;
      claimed.worker.onmessage = (
        event: MessageEvent<OutputWriterWorkerMessage>,
      ) => {
        handleOutputWriterWorkerMessage(event.data);
      };
      claimed.worker.onerror = handleOutputWriterWorkerUncaughtError;
      if ("contentHint" in claimed.track) {
        claimed.track.contentHint = "motion";
      }
      logVideoEffects(debugId, "output_writer_worker_claimed_prewarmed", {
        ageMs: Math.round(performance.now() - claimed.storedAt),
        hasVideoFrame: claimed.hasVideoFrame,
        hasWritableStream: claimed.hasWritableStream,
        hasOffscreenCanvas: claimed.hasOffscreenCanvas,
        renderer: claimed.renderer,
        outputTrack: getTrackDebugSnapshot(claimed.track),
      });
      return {
        mode: "track-generator",
        writerMode: "worker",
        stream: new MediaStream([claimed.track]),
        track: claimed.track,
      };
    };

    const handleSegmentationProcessorWorkerMessage = (
      message: SegmentationProcessorWorkerMessage,
    ) => {
      switch (message.type) {
        case "READY":
          segmentationProcessorWorkerReady = true;
          segmentationProcessorWorkerDelegate = message.delegate;
          segmentationProcessorMode = "worker";
          segmentationProcessorFallbackReason = null;
          logVideoEffects(debugId, "segmentation_processor_worker_ready", {
            delegate: message.delegate,
          });
          segmentationProcessorWorkerInitResolve?.(true);
          segmentationProcessorWorkerInitResolve = null;
          segmentationProcessorWorkerInitReject = null;
          break;
        case "SEGMENTATION_RESULT": {
          const pending = segmentationProcessorPendingFrames.get(
            message.sequence,
          );
          if (!pending) return;
          segmentationProcessorPendingFrames.delete(message.sequence);
          window.clearTimeout(pending.timeoutId);
          segmentationProcessorWorkerResults += 1;
          segmentationProcessorWorkerFirstResultSeen = true;
          segmentationProcessorWorkerAckSequence = Math.max(
            segmentationProcessorWorkerAckSequence,
            message.sequence,
          );
          latestSegmentationProcessorWorkerProcessingMs = message.processingMs;
          latestSegmentationProcessorWorkerRoundTripMs = Math.max(
            0,
            performance.now() - pending.sentAt,
          );
          latestSegmentationProcessorWorkerLatencyAt = performance.now();
          if (
            message.processingConfigId === pending.processingConfigId &&
            message.processingConfigId === modelProcessingConfigId
          ) {
            latestSegmentationProcessorWorkerResult = {
              sequence: message.sequence,
              processingConfigId: message.processingConfigId,
              width: message.width,
              height: message.height,
              timestamp: message.timestamp,
              delegate: message.delegate,
              inputSource: message.inputSource,
              source: message.confidence
                ? "tasks-confidence"
                : message.category
                  ? "tasks-category"
                  : "none",
              qualityScores: message.qualityScores,
              confidenceMaskCount: message.confidenceMaskCount,
              hasCategoryMask: message.hasCategoryMask,
            };
          }
          pending.resolve(message);
          break;
        }
        case "ERROR": {
          segmentationProcessorLastError = message.error;
          if (typeof message.sequence === "number") {
            const pending = segmentationProcessorPendingFrames.get(
              message.sequence,
            );
            if (pending) {
              segmentationProcessorPendingFrames.delete(message.sequence);
              window.clearTimeout(pending.timeoutId);
              pending.reject(message.error);
              break;
            }
          } else {
            segmentationProcessorWorkerInitReject?.(message.error);
            segmentationProcessorWorkerInitResolve = null;
            segmentationProcessorWorkerInitReject = null;
          }
          segmentationProcessorWorkerFailures += 1;
          warnVideoEffects(debugId, "segmentation_processor_worker_error", {
            sequence: message.sequence,
            error: message.error,
          });
          break;
        }
        case "CLOSED":
          segmentationProcessorWorkerReady = false;
          break;
      }
    };

    const handleSegmentationProcessorWorkerUncaughtError = (event: ErrorEvent) => {
      const error = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      };
      segmentationProcessorWorkerFailures += 1;
      segmentationProcessorLastError = error;
      segmentationProcessorFallbackReason = "worker error";
      rejectPendingSegmentationProcessorFrames(error);
      segmentationProcessorWorkerInitReject?.(error);
      segmentationProcessorWorkerInitResolve = null;
      segmentationProcessorWorkerInitReject = null;
      warnVideoEffects(
        debugId,
        "segmentation_processor_worker_uncaught_error",
        error,
      );
    };

    const attachClaimedSegmentationProcessorWorker = (
      claimed: PrewarmedProcessorWorker,
    ) => {
      segmentationProcessorWorker = claimed.worker;
      segmentationProcessorWorkerSupported = true;
      segmentationProcessorWorkerReady = true;
      segmentationProcessorWorkerDelegate = claimed.delegate;
      segmentationProcessorMode = "worker";
      segmentationProcessorFallbackReason = null;
      segmentationProcessorLastError = null;
      claimed.worker.onmessage = (
        event: MessageEvent<SegmentationProcessorWorkerMessage>,
      ) => {
        handleSegmentationProcessorWorkerMessage(event.data);
      };
      claimed.worker.onerror = handleSegmentationProcessorWorkerUncaughtError;
      logVideoEffects(debugId, "segmentation_processor_worker_claimed_prewarmed", {
        delegate: claimed.delegate,
        warmupRan: claimed.warmupRan,
        ageMs: Math.round(performance.now() - claimed.storedAt),
      });
      return true;
    };

    const ensureSegmentationProcessorWorker = (): Promise<boolean> => {
      if (cancelled || segmentationProcessorWorkerReady) {
        return Promise.resolve(segmentationProcessorWorkerReady);
      }
      if (segmentationProcessorFallbackReason === "worker unavailable") {
        return Promise.resolve(false);
      }
      if (segmentationProcessorWorkerPromise) {
        return segmentationProcessorWorkerPromise;
      }
      const claimed = claimPrewarmedProcessorWorker("segmentation");
      if (claimed) {
        return Promise.resolve(attachClaimedSegmentationProcessorWorker(claimed));
      }
      if (
        segmentationProcessorWorkerPrewarmPromise &&
        !isVideoEffectsPipelineBusyForPrewarm()
      ) {
        logVideoEffects(debugId, "segmentation_processor_worker_wait_for_prewarm");
        segmentationProcessorWorkerPromise = segmentationProcessorWorkerPrewarmPromise
          .then(async (): Promise<boolean> => {
            segmentationProcessorWorkerPromise = null;
            if (cancelled || segmentationProcessorWorkerReady) {
              return segmentationProcessorWorkerReady;
            }
            const claimedAfterWait =
              claimPrewarmedProcessorWorker("segmentation");
            if (claimedAfterWait) {
              return attachClaimedSegmentationProcessorWorker(claimedAfterWait);
            }
            return ensureSegmentationProcessorWorker();
          })
          .catch(async (err): Promise<boolean> => {
            segmentationProcessorWorkerPromise = null;
            warnVideoEffects(
              debugId,
              "segmentation_processor_worker_prewarm_wait_failed",
              {
                error: getErrorDebugSnapshot(err),
              },
            );
            return ensureSegmentationProcessorWorker();
          });
        return segmentationProcessorWorkerPromise;
      }
      if (segmentationProcessorWorkerPrewarmPromise) {
        logVideoEffects(
          debugId,
          "segmentation_processor_worker_skip_prewarm_wait_busy",
          {
            activePipelineCount: activeVideoEffectsPipelineCount,
          },
        );
      }
      const hasVideoFrameCtor =
        typeof (globalThis as { VideoFrame?: unknown }).VideoFrame ===
        "function";
      if (
        typeof Worker === "undefined" ||
        (!hasVideoFrameCtor && typeof createImageBitmap !== "function")
      ) {
        segmentationProcessorFallbackReason =
          typeof Worker === "undefined"
            ? "worker unavailable"
            : "model frame source unavailable";
        return Promise.resolve(false);
      }

      segmentationProcessorWorkerPromise = new Promise<boolean>(
        (resolve, reject) => {
          try {
            const worker = new Worker(
              new URL(
                "../workers/video-effects-segmentation-processor-worker.ts",
                import.meta.url,
              ),
              {
                type: "module",
                name: "conclave-video-effects-segmentation-processor",
              },
            );
            segmentationProcessorWorker = worker;
            segmentationProcessorWorkerSupported = true;
            segmentationProcessorWorkerInitResolve = resolve;
            segmentationProcessorWorkerInitReject = reject;
            worker.onmessage = (
              event: MessageEvent<SegmentationProcessorWorkerMessage>,
            ) => {
              handleSegmentationProcessorWorkerMessage(event.data);
            };
            worker.onerror = handleSegmentationProcessorWorkerUncaughtError;
            worker.postMessage({ type: "INIT" });
          } catch (err) {
            segmentationProcessorWorker?.terminate();
            segmentationProcessorWorker = null;
            segmentationProcessorWorkerSupported = false;
            segmentationProcessorWorkerReady = false;
            segmentationProcessorFallbackReason = "worker setup failed";
            segmentationProcessorLastError = getErrorDebugSnapshot(err);
            reject(err);
          }
        },
      )
        .then((ready) => {
          segmentationProcessorWorkerPromise = null;
          return ready;
        })
        .catch((err) => {
          segmentationProcessorWorkerPromise = null;
          segmentationProcessorWorker?.terminate();
          segmentationProcessorWorker = null;
          segmentationProcessorWorkerReady = false;
          segmentationProcessorFallbackReason = "worker initialization failed";
          segmentationProcessorLastError = getErrorDebugSnapshot(err);
          warnVideoEffects(debugId, "segmentation_processor_worker_init_failed", {
            error: getErrorDebugSnapshot(err),
          });
          return false;
        });
      return segmentationProcessorWorkerPromise;
    };

    const handleFaceProcessorWorkerMessage = (
      message: FaceProcessorWorkerMessage,
    ) => {
      switch (message.type) {
        case "READY":
          faceProcessorWorkerReady = true;
          faceProcessorWorkerDelegate = message.delegate;
          faceProcessorMode = "worker";
          faceProcessorFallbackReason = null;
          logVideoEffects(debugId, "face_processor_worker_ready", {
            delegate: message.delegate,
          });
          faceProcessorWorkerInitResolve?.(true);
          faceProcessorWorkerInitResolve = null;
          faceProcessorWorkerInitReject = null;
          break;
        case "FACE_RESULT": {
          const pending = faceProcessorPendingFrames.get(message.sequence);
          if (!pending) return;
          faceProcessorPendingFrames.delete(message.sequence);
          window.clearTimeout(pending.timeoutId);
          faceProcessorWorkerResults += 1;
          faceProcessorWorkerFirstResultSeen = true;
          faceProcessorWorkerAckSequence = Math.max(
            faceProcessorWorkerAckSequence,
            message.sequence,
          );
          latestFaceProcessorWorkerProcessingMs = message.processingMs;
          latestFaceProcessorWorkerRoundTripMs = Math.max(
            0,
            performance.now() - pending.sentAt,
          );
          latestFaceProcessorWorkerLatencyAt = performance.now();
          if (
            message.processingConfigId === pending.processingConfigId &&
            message.processingConfigId === modelProcessingConfigId
          ) {
            latestFaceProcessorWorkerResult = {
              sequence: message.sequence,
              processingConfigId: message.processingConfigId,
              faceCount: message.faceCount,
              landmarkCount: message.landmarks?.length ?? 0,
              blendshapeCount: message.blendshapeCount,
              matrixCount: message.matrixCount,
              width: message.width,
              height: message.height,
              timestamp: message.timestamp,
              delegate: message.delegate,
              inputSource: message.inputSource,
            };
          }
          pending.resolve(message);
          break;
        }
        case "ERROR": {
          faceProcessorLastError = message.error;
          if (typeof message.sequence === "number") {
            const pending = faceProcessorPendingFrames.get(message.sequence);
            if (pending) {
              faceProcessorPendingFrames.delete(message.sequence);
              window.clearTimeout(pending.timeoutId);
              pending.reject(message.error);
              break;
            }
          } else {
            faceProcessorWorkerInitReject?.(message.error);
            faceProcessorWorkerInitResolve = null;
            faceProcessorWorkerInitReject = null;
          }
          faceProcessorWorkerFailures += 1;
          warnVideoEffects(debugId, "face_processor_worker_error", {
            sequence: message.sequence,
            error: message.error,
          });
          break;
        }
        case "CLOSED":
          faceProcessorWorkerReady = false;
          break;
      }
    };

    const handleFaceProcessorWorkerUncaughtError = (event: ErrorEvent) => {
      const error = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      };
      faceProcessorWorkerFailures += 1;
      faceProcessorLastError = error;
      faceProcessorFallbackReason = "worker error";
      rejectPendingFaceProcessorFrames(error);
      faceProcessorWorkerInitReject?.(error);
      faceProcessorWorkerInitResolve = null;
      faceProcessorWorkerInitReject = null;
      warnVideoEffects(debugId, "face_processor_worker_uncaught_error", error);
    };

    const attachClaimedFaceProcessorWorker = (
      claimed: PrewarmedProcessorWorker,
    ) => {
      faceProcessorWorker = claimed.worker;
      faceProcessorWorkerSupported = true;
      faceProcessorWorkerReady = true;
      faceProcessorWorkerDelegate = claimed.delegate;
      faceProcessorMode = "worker";
      faceProcessorFallbackReason = null;
      faceProcessorLastError = null;
      claimed.worker.onmessage = (
        event: MessageEvent<FaceProcessorWorkerMessage>,
      ) => {
        handleFaceProcessorWorkerMessage(event.data);
      };
      claimed.worker.onerror = handleFaceProcessorWorkerUncaughtError;
      logVideoEffects(debugId, "face_processor_worker_claimed_prewarmed", {
        delegate: claimed.delegate,
        warmupRan: claimed.warmupRan,
        ageMs: Math.round(performance.now() - claimed.storedAt),
      });
      return true;
    };

    const ensureFaceProcessorWorker = (): Promise<boolean> => {
      if (cancelled || faceProcessorWorkerReady) {
        return Promise.resolve(faceProcessorWorkerReady);
      }
      if (faceProcessorFallbackReason === "worker unavailable") {
        return Promise.resolve(false);
      }
      if (faceProcessorWorkerPromise) return faceProcessorWorkerPromise;
      const claimed = claimPrewarmedProcessorWorker("face");
      if (claimed) {
        return Promise.resolve(attachClaimedFaceProcessorWorker(claimed));
      }
      if (
        faceProcessorWorkerPrewarmPromise &&
        !isVideoEffectsPipelineBusyForPrewarm()
      ) {
        logVideoEffects(debugId, "face_processor_worker_wait_for_prewarm");
        faceProcessorWorkerPromise = faceProcessorWorkerPrewarmPromise
          .then(async (): Promise<boolean> => {
            faceProcessorWorkerPromise = null;
            if (cancelled || faceProcessorWorkerReady) {
              return faceProcessorWorkerReady;
            }
            const claimedAfterWait = claimPrewarmedProcessorWorker("face");
            if (claimedAfterWait) {
              return attachClaimedFaceProcessorWorker(claimedAfterWait);
            }
            return ensureFaceProcessorWorker();
          })
          .catch(async (err): Promise<boolean> => {
            faceProcessorWorkerPromise = null;
            warnVideoEffects(debugId, "face_processor_worker_prewarm_wait_failed", {
              error: getErrorDebugSnapshot(err),
            });
            return ensureFaceProcessorWorker();
          });
        return faceProcessorWorkerPromise;
      }
      if (faceProcessorWorkerPrewarmPromise) {
        logVideoEffects(debugId, "face_processor_worker_skip_prewarm_wait_busy", {
          activePipelineCount: activeVideoEffectsPipelineCount,
        });
      }
      const hasVideoFrameCtor =
        typeof (globalThis as { VideoFrame?: unknown }).VideoFrame ===
        "function";
      if (
        typeof Worker === "undefined" ||
        (!hasVideoFrameCtor && typeof createImageBitmap !== "function")
      ) {
        faceProcessorFallbackReason =
          typeof Worker === "undefined"
            ? "worker unavailable"
            : "model frame source unavailable";
        return Promise.resolve(false);
      }

      faceProcessorWorkerPromise = new Promise<boolean>((resolve, reject) => {
        try {
          const worker = new Worker(
            new URL(
              "../workers/video-effects-face-processor-worker.ts",
              import.meta.url,
            ),
            {
              type: "module",
              name: "conclave-video-effects-face-processor",
            },
          );
          faceProcessorWorker = worker;
          faceProcessorWorkerSupported = true;
          faceProcessorWorkerInitResolve = resolve;
          faceProcessorWorkerInitReject = reject;
          worker.onmessage = (
            event: MessageEvent<FaceProcessorWorkerMessage>,
          ) => {
            handleFaceProcessorWorkerMessage(event.data);
          };
          worker.onerror = handleFaceProcessorWorkerUncaughtError;
          worker.postMessage({ type: "INIT" });
        } catch (err) {
          faceProcessorWorker?.terminate();
          faceProcessorWorker = null;
          faceProcessorWorkerSupported = false;
          faceProcessorWorkerReady = false;
          faceProcessorFallbackReason = "worker setup failed";
          faceProcessorLastError = getErrorDebugSnapshot(err);
          reject(err);
        }
      })
        .then((ready) => {
          faceProcessorWorkerPromise = null;
          return ready;
        })
        .catch((err) => {
          faceProcessorWorkerPromise = null;
          faceProcessorWorker?.terminate();
          faceProcessorWorker = null;
          faceProcessorWorkerReady = false;
          faceProcessorFallbackReason = "worker initialization failed";
          faceProcessorLastError = getErrorDebugSnapshot(err);
          warnVideoEffects(debugId, "face_processor_worker_init_failed", {
            error: getErrorDebugSnapshot(err),
          });
          return false;
        });
      return faceProcessorWorkerPromise;
    };

    const getRuntimeProcessorNeeds = (currentEffects: VideoEffectsState) => {
      const customBackgroundReady =
        currentEffects.background !== "custom" ||
        Boolean(currentEffects.customBackgroundDataUrl);
      return {
        needsSegmentation:
          customBackgroundReady &&
          currentEffects.background !== "none" &&
          currentEffects.background !== "gradient",
        needsFace: currentEffects.filter !== "none" || currentEffects.framing,
      };
    };

    const prestartNeededProcessorWorkers = (
      reason: string,
      currentEffects: VideoEffectsState,
    ) => {
      const { needsSegmentation, needsFace } =
        getRuntimeProcessorNeeds(currentEffects);
      if (!needsSegmentation && !needsFace) return;
      logVideoEffects(debugId, "processor_worker_prestart", {
        reason,
        needsSegmentation,
        needsFace,
        hasStoredSegmentation: Boolean(
          getStoredPrewarmedProcessorWorker("segmentation"),
        ),
        hasStoredFace: Boolean(getStoredPrewarmedProcessorWorker("face")),
      });
      if (needsSegmentation) {
        void ensureSegmentationProcessorWorker();
      }
      if (needsFace) {
        void ensureFaceProcessorWorker();
      }
    };

    const createWorkerTrackGeneratorOutput = (): ProcessedOutput | null => {
      const GeneratorCtor = (
        globalThis as unknown as {
          MediaStreamTrackGenerator?: unknown;
        }
      ).MediaStreamTrackGenerator as
        | MediaStreamTrackGeneratorConstructor
        | undefined;
      const VideoFrameCtor = (
        globalThis as unknown as { VideoFrame?: unknown }
      ).VideoFrame as VideoFrameConstructor | undefined;

      if (
        !GeneratorCtor ||
        typeof Worker === "undefined" ||
        (!VideoFrameCtor && typeof createImageBitmap !== "function")
      ) {
        outputWriterFallbackReason = !GeneratorCtor
          ? "MediaStreamTrackGenerator unavailable"
          : typeof Worker === "undefined"
            ? "Worker unavailable"
            : "VideoFrame and createImageBitmap unavailable";
        logVideoEffects(debugId, "worker_track_generator_output_unavailable", {
          hasGenerator: Boolean(GeneratorCtor),
          hasWorker: typeof Worker !== "undefined",
          hasVideoFrame: Boolean(VideoFrameCtor),
          hasCreateImageBitmap: typeof createImageBitmap === "function",
        });
        return null;
      }

      const claimed = claimPrewarmedOutputWriterWorker();
      if (claimed) {
        const claimedOutput = attachClaimedOutputWriterWorker(claimed);
        if (claimedOutput) return claimedOutput;
      }

      try {
        const generatorTrack = new GeneratorCtor({ kind: "video" });
        if ("contentHint" in generatorTrack) {
          generatorTrack.contentHint = "motion";
        }
        const worker = new Worker("/effects/video-effects-output-writer.js", {
          type: "module",
          name: "conclave-video-effects-output-writer",
        });
        let rendererCanvas: OffscreenCanvas | null = null;
        if (typeof OffscreenCanvas !== "undefined") {
          try {
            rendererCanvas = new OffscreenCanvas(1, 1);
          } catch (err) {
            logVideoEffects(debugId, "output_writer_offscreen_canvas_unavailable", {
              error: getErrorDebugSnapshot(err),
            });
          }
        }
        worker.onmessage = (event: MessageEvent<OutputWriterWorkerMessage>) => {
          handleOutputWriterWorkerMessage(event.data);
        };
        worker.onerror = handleOutputWriterWorkerUncaughtError;
        const transferables: Transferable[] = [
          generatorTrack.writable as unknown as Transferable,
        ];
        if (rendererCanvas) {
          transferables.push(rendererCanvas as unknown as Transferable);
        }
        worker.postMessage(
          {
            type: "INIT",
            writable: generatorTrack.writable,
            canvas: rendererCanvas,
          },
          transferables,
        );
        outputWriterWorker = worker;
        outputWriterMode = "worker";
        outputWriterWorkerSupported = true;
        outputVideoFrameCtor = VideoFrameCtor ?? null;
        outputWriterInputMode = null;
        outputWriterVideoFrameUnsupported = false;
        outputWriterFallbackReason = null;
        logVideoEffects(debugId, "worker_track_generator_output_created", {
          outputTrack: getTrackDebugSnapshot(generatorTrack),
          hasOffscreenCanvas: Boolean(rendererCanvas),
          hasVideoFrame: Boolean(VideoFrameCtor),
        });
        return {
          mode: "track-generator",
          writerMode: "worker",
          stream: new MediaStream([generatorTrack]),
          track: generatorTrack,
        };
      } catch (err) {
        outputWriterWorker?.terminate();
        outputWriterWorker = null;
        outputWriterMode = "main-thread";
        outputVideoFrameCtor = null;
        outputWriterWorkerSupported = false;
        outputWriterWorkerReady = false;
        outputWriterWorkerHasOffscreenCanvas = null;
        outputWriterWorkerRenderer = null;
        outputWriterInputMode = null;
        outputWriterFallbackReason = "worker track generator setup failed";
        outputWriterLastError = getErrorDebugSnapshot(err);
        logVideoEffects(debugId, "worker_track_generator_output_failed", {
          error: getErrorDebugSnapshot(err),
        });
        return null;
      }
    };

    const createMainThreadTrackGeneratorOutput = (): ProcessedOutput | null => {
      const GeneratorCtor = (
        globalThis as unknown as {
          MediaStreamTrackGenerator?: unknown;
        }
      ).MediaStreamTrackGenerator as
        | MediaStreamTrackGeneratorConstructor
        | undefined;
      const VideoFrameCtor = (
        globalThis as unknown as { VideoFrame?: unknown }
      ).VideoFrame as VideoFrameConstructor | undefined;

      if (!GeneratorCtor || !VideoFrameCtor) {
        logVideoEffects(debugId, "track_generator_output_unavailable", {
          hasGenerator: Boolean(GeneratorCtor),
          hasVideoFrame: Boolean(VideoFrameCtor),
        });
        return null;
      }

      try {
        const generatorTrack = new GeneratorCtor({ kind: "video" });
        outputGeneratorWriter = generatorTrack.writable.getWriter();
        outputVideoFrameCtor = VideoFrameCtor;
        outputWriterMode = "main-thread";
        if ("contentHint" in generatorTrack) {
          generatorTrack.contentHint = "motion";
        }
        logVideoEffects(debugId, "track_generator_output_created", {
          outputTrack: getTrackDebugSnapshot(generatorTrack),
        });
        return {
          mode: "track-generator",
          writerMode: "main-thread",
          stream: new MediaStream([generatorTrack]),
          track: generatorTrack,
        };
      } catch (err) {
        outputGeneratorWriter = null;
        outputVideoFrameCtor = null;
        outputGeneratorFailed = true;
        warnVideoEffects(debugId, "track_generator_output_failed", {
          error: getErrorDebugSnapshot(err),
        });
        return null;
      }
    };

    const createTrackGeneratorOutput = (): ProcessedOutput | null =>
      createWorkerTrackGeneratorOutput() ?? createMainThreadTrackGeneratorOutput();

    const createCanvasCaptureOutput = (): ProcessedOutput | null => {
      if (typeof canvas.captureStream === "function") {
        const capturedStream = canvas.captureStream(TARGET_FPS);
        const [capturedTrack] = capturedStream.getVideoTracks() as [
          CanvasCaptureMediaStreamTrack | undefined,
        ];
        if (capturedTrack) {
          logVideoEffects(debugId, "canvas_capture_output_created", {
            capturedStream: getStreamDebugSnapshot(capturedStream),
            outputTrack: getTrackDebugSnapshot(capturedTrack),
            hasRequestFrame: typeof capturedTrack.requestFrame === "function",
          });
          return {
            mode: "canvas-capture",
            writerMode: "canvas-capture",
            stream: capturedStream,
            track: capturedTrack,
          };
        }
        warnVideoEffects(debugId, "capture_stream_missing_video_track", {
          capturedStream: getStreamDebugSnapshot(capturedStream),
        });
      } else {
        warnVideoEffects(debugId, "capture_stream_unavailable");
      }

      return null;
    };

    const createProcessedOutput = (): ProcessedOutput | null =>
      createTrackGeneratorOutput() ?? createCanvasCaptureOutput();

    const output = createProcessedOutput();
    if (!output) {
      setStatus("degraded");
      setError("Video processing could not create an output track.");
      video.srcObject = null;
      return;
    }

    const { mode: outputMode, writerMode, stream, track } = output;
    outputWriterMode = writerMode;

    if ("contentHint" in track) {
      track.contentHint = "motion";
    }
    const handleSourceMute = () => {
      warnVideoEffects(debugId, "source_track_mute", {
        sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
      });
    };
    const handleSourceUnmute = () => {
      logVideoEffects(debugId, "source_track_unmute", {
        sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
      });
    };
    const handleSourceEnded = () => {
      logVideoEffects(debugId, "source_track_ended", {
        sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
      });
    };
    const handleOutputMute = () => {
      warnVideoEffects(debugId, "output_track_mute", {
        outputTrack: getTrackDebugSnapshot(track),
      });
    };
    const handleOutputUnmute = () => {
      logVideoEffects(debugId, "output_track_unmute", {
        outputTrack: getTrackDebugSnapshot(track),
      });
    };
    const handleOutputEnded = () => {
      warnVideoEffects(debugId, "output_track_ended", {
        outputTrack: getTrackDebugSnapshot(track),
      });
    };
    sourceVideoTrack.addEventListener("mute", handleSourceMute);
    sourceVideoTrack.addEventListener("unmute", handleSourceUnmute);
    sourceVideoTrack.addEventListener("ended", handleSourceEnded);
    track.addEventListener("mute", handleOutputMute);
    track.addEventListener("unmute", handleOutputUnmute);
    track.addEventListener("ended", handleOutputEnded);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    setStatus("loading");
    setError(null);
    logVideoEffects(debugId, "capture_stream_created", {
      mode: outputMode,
      capturedStream: getStreamDebugSnapshot(stream),
      outputTrack: getTrackDebugSnapshot(track),
    });
    prestartNeededProcessorWorkers("startup", effectsRef.current);

    const publishOutputTrack = () => {
      if (outputTrackPublished || cancelled || track.readyState !== "live") return;
      if (
        outputMode === "track-generator" &&
        (outputGeneratorFailed || outputFramesWritten < OUTPUT_READY_FRAMES)
      ) {
        return;
      }
      outputTrackPublished = true;
      if (firstPublishedTrackAt <= 0) {
        firstPublishedTrackAt = performance.now();
      }
      setProcessedTrackReady(true);
      finalTrackOwnerRef.current = "local";
      processedVideoTrackRef.current = track;
      releaseRetainedLocalProcessedTrack(
        "replaced by local processed output",
        track,
      );
      logVideoEffects(debugId, "publish_processed_track", {
        visibleOutputFrameCount,
        blackOutputFrameCount,
        outputMode,
        outputFramesWritten,
        outputTrack: getTrackDebugSnapshot(track),
      });
      setProcessedTrack(track);
    };

    const releaseOutputTrackToRaw = (
      reason: string,
      severity: "debug" | "warn" = "warn",
    ) => {
      if (!outputTrackPublished || cancelled) return;
      outputTrackPublished = false;
      visibleOutputFrameCount = 0;
      if (finalTrackOwnerRef.current === "local") {
        finalTrackOwnerRef.current = "none";
        setProcessedTrackReady(false);
      }
      const logRelease =
        severity === "warn" ? warnVideoEffects : logVideoEffects;
      logRelease(
        debugId,
        severity === "warn"
          ? "release_processed_track_to_raw"
          : "release_processed_track_cleanup",
        {
        reason,
        outputMode,
        outputFramesWritten,
        outputTrack: getTrackDebugSnapshot(track),
        sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        },
      );
      if (finalTrackOwnerRef.current !== "meet-videopipe") {
        processedVideoTrackRef.current = null;
        setProcessedTrack((current) => (current === track ? null : current));
      }
    };

    const recordOutputWriterFrameFailure = (err: unknown, phase: string) => {
      outputWriterWriteFailures += 1;
      consecutiveOutputWriterFailures += 1;
      outputWriterLastError = getErrorDebugSnapshot(err);
      warnVideoEffects(debugId, "output_writer_worker_write_failed", {
        phase,
        consecutiveFailures: consecutiveOutputWriterFailures,
        error: getErrorDebugSnapshot(err),
        outputTrack: getTrackDebugSnapshot(track),
        outputFramesWritten,
        pendingFrameCount: outputWriterPendingFrames.size,
      });
      if (
        consecutiveOutputWriterFailures >=
        OUTPUT_WRITER_FAILURE_RELEASE_THRESHOLD
      ) {
        outputGeneratorFailed = true;
        releaseOutputTrackToRaw("worker output writer failed");
      }
    };

    const writeOutputFrameWithWorker = async (now: number) => {
      if (
        !outputWriterWorker ||
        !outputWriterWorkerSupported ||
        !outputWriterWorkerReady ||
        outputWriterWorkerHasVideoFrame === false ||
        (!outputVideoFrameCtor && typeof createImageBitmap !== "function")
      ) {
        const workerWarmingUp =
          Boolean(outputWriterWorker) &&
          outputWriterWorkerSupported &&
          !outputWriterWorkerReady &&
          outputWriterFramesSent === 0 &&
          outputFramesWritten === 0;
        outputWriterSkipCount += 1;
        if (!workerWarmingUp) {
          outputWriterUnavailableSkipCount += 1;
        }
        latestOutputWriterSkipReason = workerWarmingUp
          ? "worker warming up"
          : !outputWriterWorker
          ? "worker missing"
          : !outputWriterWorkerSupported
            ? "worker unsupported"
            : !outputWriterWorkerReady
              ? "worker not ready"
              : outputWriterWorkerHasVideoFrame === false
                ? "worker VideoFrame unavailable"
                : "VideoFrame and createImageBitmap unavailable";
        return false;
      }
      const transitionBurstActive =
        outputFramesWritten < OUTPUT_READY_FRAMES ||
        visibleOutputFrameCount < OUTPUT_READY_FRAMES ||
        (latestEffectSwitchAt > 0 &&
          performance.now() - latestEffectSwitchAt <
            OUTPUT_WRITER_TRANSITION_BURST_MS);
      outputWriterPendingFrameLimit = transitionBurstActive
        ? OUTPUT_WRITER_TRANSITION_MAX_PENDING_FRAMES
        : OUTPUT_WRITER_STEADY_MAX_PENDING_FRAMES;
      if (outputWriterPendingFrames.size >= outputWriterPendingFrameLimit) {
        const drained = await waitForOutputWriterBackpressureDrain();
        if (outputWriterPendingFrames.size >= outputWriterPendingFrameLimit) {
          outputWriterSkipCount += 1;
          outputWriterBackpressureSkipCount += 1;
          latestOutputWriterSkipReason = drained
            ? "worker pending frame limit"
            : "worker pending frame drain timed out";
          return true;
        }
      }

      let bitmap: ImageBitmap | null = null;
      let frame: GeneratedVideoFrame | null = null;
      try {
        const frameInit = {
          duration: Math.round(1_000_000 / TARGET_FPS),
          timestamp: Math.round(now * 1000),
        };
        let inputMode: OutputWriterInputMode = "bitmap";
        let buildStartedAt = performance.now();
        if (
          !outputWriterVideoFrameUnsupported &&
          outputVideoFrameCtor &&
          outputWriterWorkerHasVideoFrame === true
        ) {
          try {
            frame = new outputVideoFrameCtor(canvas, frameInit);
            inputMode = "video-frame";
          } catch (err) {
            outputWriterVideoFrameUnsupported = true;
            outputWriterLastError = getErrorDebugSnapshot(err);
            logVideoEffects(debugId, "output_writer_video_frame_build_failed", {
              error: getErrorDebugSnapshot(err),
            });
            try {
              frame?.close?.();
            } catch {}
            frame = null;
          }
        }
        if (!frame) {
          if (typeof createImageBitmap !== "function") {
            throw new Error("createImageBitmap unavailable for output writer.");
          }
          inputMode = "bitmap";
          buildStartedAt = performance.now();
          bitmap = await createImageBitmap(canvas);
        }
        const frameBuildMs = Math.max(0, performance.now() - buildStartedAt);
        latestOutputWriterFrameBuildMs = frameBuildMs;
        latestOutputWriterFrameBuildAt = performance.now();
        totalOutputWriterFrameBuildMs += frameBuildMs;
        maxOutputWriterFrameBuildMs = Math.max(
          maxOutputWriterFrameBuildMs,
          frameBuildMs,
        );
        outputWriterFrameBuildSampleCount += 1;

        const sequence = outputWriterSequence + 1;
        outputWriterSequence = sequence;
        outputWriterFramesSent += 1;
        outputWriterInputMode = inputMode;
        latestOutputWriterSkipReason = null;
        const sentAt = performance.now();
        const postFrame = (
          mode: OutputWriterInputMode,
          resource: GeneratedVideoFrame | ImageBitmap,
        ) => {
          let resolveCompletion = (
            _message: OutputWriterWorkerCompletionMessage,
          ) => {};
          let rejectCompletion = (_err: unknown) => {};
          const completion = new Promise<OutputWriterWorkerCompletionMessage>(
            (resolve, reject) => {
              resolveCompletion = resolve;
              rejectCompletion = reject;
            },
          );
          const timeoutId = window.setTimeout(() => {
            outputWriterPendingFrames.delete(sequence);
            const err = new Error("Timed out waiting for output worker write.");
            outputWriterLastError = getErrorDebugSnapshot(err);
            rejectCompletion(err);
          }, OUTPUT_WRITER_FRAME_TIMEOUT_MS);
          outputWriterPendingFrames.set(sequence, {
            resolve: resolveCompletion,
            reject: rejectCompletion,
            completion,
            timeoutId,
            sentAt,
          });
          try {
            outputWriterWorker?.postMessage(
              {
                type: "FRAME",
                sequence,
                inputMode: mode,
                frame: mode === "video-frame" ? resource : undefined,
                bitmap: mode === "bitmap" ? resource : undefined,
                width: canvas.width,
                height: canvas.height,
                duration: frameInit.duration,
                timestamp: frameInit.timestamp,
              },
              [resource as unknown as Transferable],
            );
          } catch (err) {
            window.clearTimeout(timeoutId);
            outputWriterPendingFrames.delete(sequence);
            rejectCompletion(err);
            throw err;
          }
          return completion;
        };
        let completion: Promise<OutputWriterWorkerCompletionMessage>;
        try {
          completion = postFrame(inputMode, frame ?? (bitmap as ImageBitmap));
          if (inputMode === "video-frame") {
            frame = null;
          } else {
            bitmap = null;
          }
        } catch (err) {
          if (
            inputMode === "video-frame" &&
            typeof createImageBitmap === "function"
          ) {
            outputWriterVideoFrameUnsupported = true;
            outputWriterLastError = getErrorDebugSnapshot(err);
            latestOutputWriterSkipReason = "direct VideoFrame transfer failed";
            logVideoEffects(debugId, "output_writer_video_frame_post_failed", {
              error: getErrorDebugSnapshot(err),
            });
            try {
              frame?.close?.();
            } catch {}
            frame = null;
            inputMode = "bitmap";
            const retryBuildStartedAt = performance.now();
            bitmap = await createImageBitmap(canvas);
            const retryBuildMs = Math.max(
              0,
              performance.now() - retryBuildStartedAt,
            );
            latestOutputWriterFrameBuildMs = retryBuildMs;
            latestOutputWriterFrameBuildAt = performance.now();
            totalOutputWriterFrameBuildMs += retryBuildMs;
            maxOutputWriterFrameBuildMs = Math.max(
              maxOutputWriterFrameBuildMs,
              retryBuildMs,
            );
            outputWriterFrameBuildSampleCount += 1;
            outputWriterInputMode = inputMode;
            completion = postFrame(inputMode, bitmap);
            bitmap = null;
          } else {
            outputWriterPostFailures += 1;
            throw err;
          }
        }
        latestOutputFrameDispatchAt = now;
        latestOutputFrameAt = performance.now();
        if (firstOutputFrameAt <= 0) {
          firstOutputFrameAt = latestOutputFrameAt;
        }
        void completion
          .then((result) => {
            if (cancelled) return;
            if (result.type === "DROPPED") return;
            consecutiveOutputWriterFailures = 0;
            outputWriterFramesWritten += 1;
            outputFramesWritten += 1;
            outputFrameSequence += 1;
            latestOutputWriterWriteMs = result.writeMs;
            latestOutputWriterBackpressureMs = result.backpressureMs;
            latestOutputFrameAt = performance.now();
            if (firstOutputFrameAt <= 0) {
              firstOutputFrameAt = latestOutputFrameAt;
            }
          })
          .catch((err) => {
            if (cancelled) return;
            recordOutputWriterFrameFailure(err, "async-write");
          });
        return true;
      } catch (err) {
        recordOutputWriterFrameFailure(err, "create-or-post");
        return false;
      } finally {
        try {
          frame?.close?.();
        } catch {}
        try {
          bitmap?.close?.();
        } catch {}
      }
    };

    const deliverOutputFrame = async (now: number) => {
      if (track.readyState !== "live") return false;
      if (
        outputWriterMode !== "worker" &&
        latestOutputFrameDispatchAt > 0 &&
        now - latestOutputFrameDispatchAt < 1000 / TARGET_FPS
      ) {
        outputWriterSkipCount += 1;
        outputWriterCadenceSkipCount += 1;
        latestOutputWriterSkipReason = "target frame cadence";
        return true;
      }

      if (outputMode === "canvas-capture") {
        try {
          (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
          outputFramesWritten += 1;
          outputFrameSequence += 1;
          latestOutputFrameDispatchAt = now;
          latestOutputFrameAt = performance.now();
          if (firstOutputFrameAt <= 0) {
            firstOutputFrameAt = latestOutputFrameAt;
          }
          return true;
        } catch (err) {
          warnVideoEffects(debugId, "canvas_capture_request_frame_failed", {
            error: getErrorDebugSnapshot(err),
            outputTrack: getTrackDebugSnapshot(track),
          });
          return false;
        }
      }

      if (outputWriterMode === "worker") {
        return writeOutputFrameWithWorker(now);
      }

      if (
        outputGeneratorFailed ||
        !outputGeneratorWriter ||
        !outputVideoFrameCtor
      ) {
        return false;
      }

      let outputFrame: GeneratedVideoFrame | null = null;
      try {
        outputFrame = new outputVideoFrameCtor(canvas, {
          duration: Math.round(1_000_000 / TARGET_FPS),
          timestamp: Math.round(now * 1000),
        });
        latestOutputFrameDispatchAt = now;
        await outputGeneratorWriter.ready;
        await outputGeneratorWriter.write(outputFrame);
        outputFramesWritten += 1;
        outputFrameSequence += 1;
        latestOutputFrameAt = performance.now();
        if (firstOutputFrameAt <= 0) {
          firstOutputFrameAt = latestOutputFrameAt;
        }
        return true;
      } catch (err) {
        outputGeneratorFailed = true;
        warnVideoEffects(debugId, "track_generator_write_failed", {
          error: getErrorDebugSnapshot(err),
          outputTrack: getTrackDebugSnapshot(track),
          outputFramesWritten,
        });
        releaseOutputTrackToRaw("track generator write failed");
        return false;
      } finally {
        try {
          outputFrame?.close?.();
        } catch {}
      }
    };

    const setRuntimeStatus = (
      nextStatus: VideoEffectsRuntimeStatus,
      nextError: string | null = null,
    ) => {
      if (cancelled) return;
      if (currentStatus !== nextStatus) {
        logVideoEffects(debugId, "status_changed", {
          from: currentStatus,
          to: nextStatus,
          error: nextError,
        });
        currentStatus = nextStatus;
        setStatus(nextStatus);
      }
      setError(nextError);
    };

    const snapshotLastVisibleOutputFrame = (force = false) => {
      if (
        !lastVisibleOutputCtx ||
        canvas.width <= 0 ||
        canvas.height <= 0
      ) {
        return;
      }
      const now = performance.now();
      if (
        !force &&
        latestVisibleOutputFrameAt > 0 &&
        now - latestVisibleOutputFrameAt < LAST_VISIBLE_OUTPUT_SNAPSHOT_INTERVAL_MS
      ) {
        return;
      }

      try {
        if (
          lastVisibleOutputCanvas.width !== canvas.width ||
          lastVisibleOutputCanvas.height !== canvas.height
        ) {
          lastVisibleOutputCanvas.width = canvas.width;
          lastVisibleOutputCanvas.height = canvas.height;
        }
        lastVisibleOutputCtx.clearRect(
          0,
          0,
          lastVisibleOutputCanvas.width,
          lastVisibleOutputCanvas.height,
        );
        lastVisibleOutputCtx.drawImage(
          canvas,
          0,
          0,
          lastVisibleOutputCanvas.width,
          lastVisibleOutputCanvas.height,
        );
        latestVisibleOutputFrameAt = now;
      } catch (err) {
        warnVideoEffects(debugId, "snapshot_last_visible_output_failed", {
          error: getErrorDebugSnapshot(err),
          canvas: { width: canvas.width, height: canvas.height },
        });
      }
    };

    const restoreLastVisibleOutputFrame = (
      reason: string,
      failedProbe: CanvasVisibilityProbe,
    ): CanvasVisibilityProbe | null => {
      if (
        !lastVisibleOutputCtx ||
        lastVisibleOutputCanvas.width <= 0 ||
        lastVisibleOutputCanvas.height <= 0 ||
        latestVisibleOutputFrameAt <= 0
      ) {
        return null;
      }

      const ageMs = performance.now() - latestVisibleOutputFrameAt;
      if (ageMs > LAST_VISIBLE_OUTPUT_HOLD_MS) return null;

      try {
        if (
          canvas.width !== lastVisibleOutputCanvas.width ||
          canvas.height !== lastVisibleOutputCanvas.height
        ) {
          canvas.width = lastVisibleOutputCanvas.width;
          canvas.height = lastVisibleOutputCanvas.height;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(lastVisibleOutputCanvas, 0, 0, canvas.width, canvas.height);
        const restoredProbe = probeCanvasFrameVisibility(
          canvas,
          outputProbeCanvas,
          outputProbeCtx,
        );
        if (!restoredProbe.visible) return null;

        lastVisibleOutputRecoveryCount += 1;
        latestLastVisibleOutputRecoveryReason = reason;
        if (
          lastVisibleOutputRecoveryCount <= 3 ||
          lastVisibleOutputRecoveryCount % 30 === 0
        ) {
          logVideoEffects(debugId, "restore_last_visible_output_frame", {
            reason,
            ageMs: Math.round(ageMs),
            recoveryCount: lastVisibleOutputRecoveryCount,
            failedProbe,
            restoredProbe,
            outputTrackPublished,
            outputMode,
            outputFramesWritten,
          });
        }
        return restoredProbe;
      } catch (err) {
        warnVideoEffects(debugId, "restore_last_visible_output_failed", {
          reason,
          error: getErrorDebugSnapshot(err),
          ageMs: Math.round(ageMs),
          failedProbe,
        });
        return null;
      }
    };

    const recordOutputProbeResult = (
      outputProbe: CanvasVisibilityProbe,
      sourceProbe: CanvasVisibilityProbe,
      frameSource: FrameSource | null,
      currentEffects: VideoEffectsState,
    ) => {
      if (outputProbe.visible) {
        const forceSnapshot =
          !outputTrackPublished ||
          visibleOutputFrameCount < OUTPUT_READY_FRAMES ||
          blackOutputFrameCount > 0;
        latestOutputFrameVisible = true;
        visibleOutputFrameCount += 1;
        blackOutputFrameCount = 0;
        snapshotLastVisibleOutputFrame(forceSnapshot);
        if (firstVisibleOutputFrameAt <= 0) {
          firstVisibleOutputFrameAt = performance.now();
        }
        return true;
      }

      latestOutputFrameVisible = false;
      visibleOutputFrameCount = 0;
      blackOutputFrameCount += 1;
      if (
        outputTrackPublished &&
        blackOutputFrameCount >= DARK_OUTPUT_HOLD_WARNING_FRAMES &&
        (blackOutputFrameCount === DARK_OUTPUT_HOLD_WARNING_FRAMES ||
          blackOutputFrameCount % 30 === 0)
      ) {
        warnVideoEffects(debugId, "hold_dark_processed_track", {
          outputProbe,
          sourceProbe,
          frameSource: frameSource?.source ?? "none",
          blackOutputFrameCount,
          outputMode,
          outputFramesWritten,
          outputTrack: getTrackDebugSnapshot(track),
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          effects: getEffectsDebugSnapshot(currentEffects),
        });
        setRuntimeStatus(
          "loading",
          "Effects output is warming up; holding the processed camera track.",
        );
      }
      return false;
    };

    const createTasksSegmenter = async (delegate: MediaPipeDelegate) => {
      const module = await loadSharedTasksVision(debugId);
      const fileset = await ensureSharedTasksVisionFileset(debugId);

      let lastError: unknown = null;
      for (const model of TASKS_SELFIE_SEGMENTER_MODELS) {
        try {
          logVideoEffects(debugId, "tasks_segmenter_create_start", {
            delegate,
            modelSource: model.source,
            model: model.url,
          });
          const instance = await module.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: model.url,
              delegate,
            },
            canvas: delegate === "GPU" ? segmenterTaskCanvas : undefined,
            runningMode: "VIDEO",
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          });
          logVideoEffects(debugId, "tasks_segmenter_create_done", {
            delegate,
            modelSource: model.source,
          });
          return instance;
        } catch (err) {
          lastError = err;
          warnVideoEffects(debugId, "tasks_segmenter_create_model_failed", {
            delegate,
            modelSource: model.source,
            model: model.url,
            error: getErrorDebugSnapshot(err),
          });
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Failed to create MediaPipe image segmenter");
    };

    const createTasksFaceLandmarker = async (delegate: MediaPipeDelegate) => {
      const module = await loadSharedTasksVision(debugId);
      const fileset = await ensureSharedTasksVisionFileset(debugId);

      let lastError: unknown = null;
      for (const model of TASKS_FACE_LANDMARKER_MODELS) {
        try {
          logVideoEffects(debugId, "tasks_face_create_start", {
            delegate,
            modelSource: model.source,
            model: model.url,
          });
          const instance = await module.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: model.url,
              delegate,
            },
            canvas: delegate === "GPU" ? faceTaskCanvas : undefined,
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: 0.55,
            minFacePresenceConfidence: 0.55,
            minTrackingConfidence: 0.55,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
          });
          logVideoEffects(debugId, "tasks_face_create_done", {
            delegate,
            modelSource: model.source,
          });
          return instance;
        } catch (err) {
          lastError = err;
          warnVideoEffects(debugId, "tasks_face_create_model_failed", {
            delegate,
            modelSource: model.source,
            model: model.url,
            error: getErrorDebugSnapshot(err),
          });
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Failed to create MediaPipe face landmarker");
    };

    const ensureTasksSegmenter = async () => {
      if (tasksSegmenter || tasksSegmenterFailed) return tasksSegmenter;
      if (tasksSegmenterPromise) return tasksSegmenterPromise;
      tasksSegmenterPromise = (async () => {
        try {
          const instance = await createTasksSegmenter("GPU");
          if (cancelled) {
            instance.close();
            return null;
          }
          tasksSegmenter = instance;
          return tasksSegmenter;
        } catch (gpuErr) {
          warnVideoEffects(debugId, "tasks_segmenter_gpu_failed", {
            error: getErrorDebugSnapshot(gpuErr),
          });
          try {
            const instance = await createTasksSegmenter("CPU");
            if (cancelled) {
              instance.close();
              return null;
            }
            tasksSegmenter = instance;
            return tasksSegmenter;
          } catch (cpuErr) {
            warnVideoEffects(debugId, "tasks_segmenter_cpu_failed", {
              error: getErrorDebugSnapshot(cpuErr),
            });
            tasksSegmenterFailed = true;
            return null;
          }
        }
      })();
      const clearPromise = () => {
        tasksSegmenterPromise = null;
      };
      tasksSegmenterPromise.then(clearPromise, clearPromise);
      return tasksSegmenterPromise;
    };

    const ensureTasksFaceLandmarker = async () => {
      if (tasksFaceLandmarker || tasksFaceLandmarkerFailed) {
        return tasksFaceLandmarker;
      }
      if (tasksFaceLandmarkerPromise) return tasksFaceLandmarkerPromise;
      tasksFaceLandmarkerPromise = (async () => {
        try {
          const instance = await createTasksFaceLandmarker("GPU");
          if (cancelled) {
            instance.close();
            return null;
          }
          tasksFaceLandmarker = instance;
          return tasksFaceLandmarker;
        } catch (gpuErr) {
          warnVideoEffects(debugId, "tasks_face_gpu_failed", {
            error: getErrorDebugSnapshot(gpuErr),
          });
          try {
            const instance = await createTasksFaceLandmarker("CPU");
            if (cancelled) {
              instance.close();
              return null;
            }
            tasksFaceLandmarker = instance;
            return tasksFaceLandmarker;
          } catch (cpuErr) {
            warnVideoEffects(debugId, "tasks_face_cpu_failed", {
              error: getErrorDebugSnapshot(cpuErr),
            });
            tasksFaceLandmarkerFailed = true;
            return null;
          }
        }
      })();
      const clearPromise = () => {
        tasksFaceLandmarkerPromise = null;
      };
      tasksFaceLandmarkerPromise.then(clearPromise, clearPromise);
      return tasksFaceLandmarkerPromise;
    };

    const closeTasksSegmentationMasks = (result: ImageSegmenterResult) => {
      const masks = [
        ...(result.confidenceMasks ?? []),
        result.categoryMask ?? null,
      ].filter(Boolean) as ClosableMediaPipeResource[];
      masks.forEach((mask) => {
        try {
          mask.close?.();
          closedSegmentationMasks += 1;
        } catch (err) {
          warnVideoEffects(debugId, "tasks_segmentation_mask_close_failed", {
            error: getErrorDebugSnapshot(err),
          });
        }
      });
    };

    const updateSegmentationMaskPixels = ({
      width,
      height,
      confidence,
      category,
      qualityScores,
      confidenceMaskCount = 0,
      hasCategoryMask = false,
      processor,
    }: SegmentationMaskPixels) => {
      if (
        cancelled ||
        !maskScratchCtx ||
        !maskCtx ||
        width <= 0 ||
        height <= 0 ||
        (!confidence && !category)
      ) {
        maskMisses += 1;
        warnVideoEffects(debugId, "tasks_segmentation_empty_mask", {
          processor,
          confidenceMasks: confidenceMaskCount,
          hasCategoryMask,
          qualityScores,
          width,
          height,
        });
        return false;
      }

      maskUpdates += 1;
      logVideoEffects(debugId, "tasks_segmentation_mask", {
        processor,
        confidenceMasks: confidenceMaskCount,
        using: confidence ? "confidence" : "category",
        mask: {
          width,
          height,
          hasFloat32Array: Boolean(confidence),
          hasUint8Array: Boolean(category),
          hasWebGLTexture: processor === "main-thread",
        },
        qualityScores,
      });

      if (
          maskScratchCanvas.width !== width ||
          maskScratchCanvas.height !== height
        ) {
          if (temporalMaskPixelCount > 0) {
            temporalMaskResetCount += 1;
          }
          maskScratchCanvas.width = width;
          maskScratchCanvas.height = height;
          maskImageData = null;
          maskAlphaHistory = null;
          temporalMaskShapeFrameCount = 0;
        }

        const pixelCount = width * height;
        if (
          !maskImageData ||
          maskImageData.width !== width ||
          maskImageData.height !== height
        ) {
          maskImageData = maskScratchCtx.createImageData(width, height);
        }
        if (!maskAlphaHistory || maskAlphaHistory.length !== pixelCount) {
          maskAlphaHistory = new Uint8Array(pixelCount);
        }
        const canSmoothTemporalMask = temporalMaskShapeFrameCount > 0;
        temporalMaskSource = confidence ? "tasks-confidence" : "tasks-category";
        temporalMaskPixelCount = pixelCount;
        const pixels = maskImageData.data;
        const smoothMaskAlpha = (index: number, targetAlpha: number) => {
          const previousAlpha = maskAlphaHistory?.[index] ?? targetAlpha;
          const nextAlpha =
            !canSmoothTemporalMask
              ? targetAlpha
              : Math.round(
                  previousAlpha +
                    (targetAlpha - previousAlpha) * MASK_TEMPORAL_ALPHA,
                );
          if (maskAlphaHistory) {
            maskAlphaHistory[index] = nextAlpha;
          }
          return nextAlpha;
        };

        if (confidence) {
          for (let index = 0, offset = 0; index < pixelCount; index += 1, offset += 4) {
            const targetAlpha = Math.round(
              shapeSegmentationConfidence(confidence[index] ?? 0) * 255,
            );
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = smoothMaskAlpha(index, targetAlpha);
          }
        } else if (category) {
          for (let index = 0, offset = 0; index < pixelCount; index += 1, offset += 4) {
            const targetAlpha = category[index] === 1 ? 255 : 0;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = smoothMaskAlpha(index, targetAlpha);
          }
        }
        temporalMaskFrameCount += 1;
        temporalMaskShapeFrameCount += 1;
        if (canSmoothTemporalMask) {
          temporalMaskSmoothedFrameCount += 1;
        }

        maskScratchCtx.putImageData(maskImageData, 0, 0);
        if (maskCanvas.width !== canvas.width || maskCanvas.height !== canvas.height) {
          maskCanvas.width = canvas.width;
          maskCanvas.height = canvas.height;
        }
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCtx.imageSmoothingEnabled = true;
        maskCtx.imageSmoothingQuality = "high";
        maskCtx.save();
        maskCtx.filter = `blur(${MASK_EDGE_FEATHER_PX}px)`;
        maskCtx.drawImage(
          maskScratchCanvas,
          0,
          0,
          maskCanvas.width,
          maskCanvas.height,
        );
        maskCtx.restore();
        maskCtx.save();
        maskCtx.globalAlpha = MASK_EDGE_REINFORCE_ALPHA;
        maskCtx.drawImage(
          maskScratchCanvas,
          0,
          0,
          maskCanvas.width,
          maskCanvas.height,
        );
        maskCtx.restore();
        latestSegmentationMask = maskCanvas;
        latestSegmentationMaskAt = performance.now();
        return true;
    };

    const updateTasksSegmentationMask = (result: ImageSegmenterResult) => {
      if (cancelled || !maskScratchCtx || !maskCtx) {
        closeTasksSegmentationMasks(result);
        return;
      }
      try {
        const confidenceMask =
          result.confidenceMasks?.[1] ?? result.confidenceMasks?.[0] ?? null;
        const categoryMask = confidenceMask ? null : (result.categoryMask ?? null);
        const mask = confidenceMask ?? categoryMask;
        updateSegmentationMaskPixels({
          width: mask?.width ?? 0,
          height: mask?.height ?? 0,
          confidence: confidenceMask
            ? confidenceMask.getAsFloat32Array()
            : null,
          category: categoryMask ? categoryMask.getAsUint8Array() : null,
          qualityScores: result.qualityScores,
          confidenceMaskCount: result.confidenceMasks?.length ?? 0,
          hasCategoryMask: Boolean(result.categoryMask),
          processor: "main-thread",
        });
      } finally {
        closeTasksSegmentationMasks(result);
      }
    };

    const ensureLegacySegmentation = async () => {
      if (legacySegmentation || legacySegmentationFailed) return legacySegmentation;
      if (legacySegmentationPromise) return legacySegmentationPromise;
      legacySegmentationPromise = (async () => {
        try {
          logVideoEffects(debugId, "legacy_segmentation_create_start", {
            cdn: SELFIE_SEGMENTATION_CDN,
          });
          const module = await import("@mediapipe/selfie_segmentation");
          const instance = new module.SelfieSegmentation({
            locateFile: (file) => `${SELFIE_SEGMENTATION_CDN}/${file}`,
          });
          instance.setOptions({ modelSelection: 1, selfieMode: false });
          instance.onResults((results: SelfieSegmentationResults) => {
            if (cancelled) return;
            maskUpdates += 1;
            temporalMaskSource = "legacy";
            temporalMaskFrameCount += 1;
            temporalMaskShapeFrameCount = 0;
            temporalMaskPixelCount = 0;
            logVideoEffects(debugId, "legacy_segmentation_mask", {
              hasMask: Boolean(results.segmentationMask),
            });
            latestSegmentationMask = results.segmentationMask as CanvasImageSource;
            latestSegmentationMaskAt = performance.now();
          });
          await instance.initialize();
          if (cancelled) {
            await instance.close().catch(() => {});
            return null;
          }
          legacySegmentation = instance;
          logVideoEffects(debugId, "legacy_segmentation_create_done");
          return legacySegmentation;
        } catch (err) {
          legacySegmentationFailed = true;
          warnVideoEffects(debugId, "legacy_segmentation_create_failed", {
            error: getErrorDebugSnapshot(err),
          });
          if (!cancelled) {
            setRuntimeStatus(
              "degraded",
              err instanceof Error
                ? err.message
                : "Background segmentation failed to initialize.",
            );
          }
          return null;
        }
      })();
      const clearPromise = () => {
        legacySegmentationPromise = null;
      };
      legacySegmentationPromise.then(clearPromise, clearPromise);
      return legacySegmentationPromise;
    };

    const ensureLegacyFaceMesh = async () => {
      if (legacyFaceMesh || legacyFaceMeshFailed) return legacyFaceMesh;
      if (legacyFaceMeshPromise) return legacyFaceMeshPromise;
      legacyFaceMeshPromise = (async () => {
        try {
          logVideoEffects(debugId, "legacy_face_create_start", {
            cdn: FACE_MESH_CDN,
          });
          const module = await import("@mediapipe/face_mesh");
          const instance = new module.FaceMesh({
            locateFile: (file) => `${FACE_MESH_CDN}/${file}`,
          });
          instance.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            selfieMode: false,
            minDetectionConfidence: 0.55,
            minTrackingConfidence: 0.55,
          });
          instance.onResults((results: FaceMeshResults) => {
            latestFaceResultAt = performance.now();
            const detectedLandmarks = results.multiFaceLandmarks?.[0] ?? null;
            recordFaceDetectionResult(Boolean(detectedLandmarks?.length), "legacy");
            const smoothedLandmarks = smoothFaceLandmarks(
              latestFaceLandmarks,
              detectedLandmarks,
            );
            const smoothedFaceFilterLandmarks = smoothFaceLandmarks(
              latestFaceFilterLandmarks,
              detectedLandmarks,
              FACE_FILTER_LANDMARK_SMOOTHING_ALPHA,
              FACE_FILTER_LANDMARK_FAST_SMOOTHING_ALPHA,
              FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_START,
              FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_END,
            );
            latestFacePose = null;
            latestFaceFilterPose = null;
            latestFaceLandmarks = smoothedLandmarks.landmarks;
            latestFaceLandmarkSmoothingStats = smoothedLandmarks.stats;
            latestFaceLandmarksAt = latestFaceLandmarks ? performance.now() : 0;
            latestFaceFilterLandmarks = smoothedFaceFilterLandmarks.landmarks;
            latestFaceFilterLandmarkSmoothingStats =
              smoothedFaceFilterLandmarks.stats;
            latestFaceFilterLandmarksAt = latestFaceFilterLandmarks
              ? performance.now()
              : 0;
            logVideoEffects(debugId, "legacy_face_results", {
              faceCount: results.multiFaceLandmarks?.length ?? 0,
              landmarkCount: latestFaceLandmarks?.length ?? 0,
              smoothing: latestFaceLandmarkSmoothingStats,
              filterSmoothing: latestFaceFilterLandmarkSmoothingStats,
            });
          });
          await instance.initialize();
          if (cancelled) {
            await instance.close().catch(() => {});
            return null;
          }
          legacyFaceMesh = instance;
          logVideoEffects(debugId, "legacy_face_create_done");
          return legacyFaceMesh;
        } catch (err) {
          legacyFaceMeshFailed = true;
          warnVideoEffects(debugId, "legacy_face_create_failed", {
            error: getErrorDebugSnapshot(err),
          });
          if (!cancelled) {
            setRuntimeStatus(
              "degraded",
              err instanceof Error
                ? err.message
                : "Face landmark tracking failed to initialize.",
            );
          }
          return null;
        }
      })();
      const clearPromise = () => {
        legacyFaceMeshPromise = null;
      };
      legacyFaceMeshPromise.then(clearPromise, clearPromise);
      return legacyFaceMeshPromise;
    };

    const getVideoFrameMetadataSnapshot = (
      metadata: VideoFrameCallbackMetadataLike | null,
    ) => {
      if (!metadata) return null;
      return {
        presentationTime:
          typeof metadata.presentationTime === "number"
            ? Number(metadata.presentationTime.toFixed(3))
            : null,
        expectedDisplayTime:
          typeof metadata.expectedDisplayTime === "number"
            ? Number(metadata.expectedDisplayTime.toFixed(3))
            : null,
        width: typeof metadata.width === "number" ? metadata.width : null,
        height: typeof metadata.height === "number" ? metadata.height : null,
        mediaTime:
          typeof metadata.mediaTime === "number"
            ? Number(metadata.mediaTime.toFixed(6))
            : null,
        presentedFrames:
          typeof metadata.presentedFrames === "number"
            ? metadata.presentedFrames
            : null,
        processingDuration:
          typeof metadata.processingDuration === "number"
            ? Number(metadata.processingDuration.toFixed(4))
            : null,
      };
    };

    const getVideoFrameKey = (
      frameSource: FrameSource,
      metadata: VideoFrameCallbackMetadataLike | null,
    ) => {
      if (frameSource.source === "track-processor") {
        return `processor:${trackProcessorFrameCount}`;
      }
      if (frameSource.source === "image-capture") {
        return `capture:${frameSequence + 1}`;
      }
      if (typeof metadata?.presentedFrames === "number") {
        return `presented:${metadata.presentedFrames}`;
      }
      if (typeof metadata?.mediaTime === "number") {
        return `media:${metadata.mediaTime.toFixed(6)}`;
      }
      if (Number.isFinite(video.currentTime)) {
        return `time:${video.currentTime.toFixed(6)}`;
      }
      return null;
    };

    const getNextTimerLoopDelayMs = () =>
      Math.max(0, 1000 / TARGET_FPS - Math.max(0, latestLoopProcessingDelayMs));

    const scheduleTimerLoop = (
      delayMs = getNextTimerLoopDelayMs(),
      mode: typeof schedulerMode = "timer",
    ) => {
      schedulerMode = mode;
      loopTimerId = window.setTimeout(() => {
        loopTimerId = null;
        timerPollCount += 1;
        latestVideoFrameMetadata = null;
        void loop(performance.now());
      }, delayMs);
    };

    const clearVideoFrameWatchdog = () => {
      if (videoFrameWatchdogTimerId === null) return;
      window.clearTimeout(videoFrameWatchdogTimerId);
      videoFrameWatchdogTimerId = null;
    };

    const isTransitionFramePumpActive = (sampleNow = performance.now()) =>
      latestEffectSwitchPending ||
      sampleNow < effectSwitchModelCadenceWarmupUntil ||
      sampleNow < externalEffectChangePumpUntilRef.current;

    const schedule = () => {
      if (
        cancelled ||
        loopTimerId !== null ||
        effectChangeFramePumpTimerId !== null ||
        videoFrameCallbackId !== null
      ) {
        return;
      }

      const canUseVideoFrameCallback =
        typeof video.requestVideoFrameCallback === "function" &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        !video.paused &&
        !video.ended;
      if (canUseVideoFrameCallback) {
        const scheduleNow = performance.now();
        const watchdogMs = isTransitionFramePumpActive(scheduleNow)
          ? VIDEO_FRAME_CALLBACK_TRANSITION_WATCHDOG_MS
          : VIDEO_FRAME_CALLBACK_WATCHDOG_MS;
        const token = scheduledVideoFrameToken + 1;
        scheduledVideoFrameToken = token;
        schedulerMode = "video-frame";
        try {
          videoFrameCallbackId = video.requestVideoFrameCallback(
            (callbackNow, metadata) => {
              if (cancelled || scheduledVideoFrameToken !== token) return;
              scheduledVideoFrameToken += 1;
              videoFrameCallbackCount += 1;
              latestVideoFrameMetadata = metadata ?? null;
              videoFrameCallbackId = null;
              clearVideoFrameWatchdog();
              void loop(callbackNow, metadata ?? null);
            },
          );
          videoFrameWatchdogTimerId = window.setTimeout(() => {
            if (cancelled || scheduledVideoFrameToken !== token) return;
            scheduledVideoFrameToken += 1;
            videoFrameWatchdogFallbackCount += 1;
            if (
              videoFrameCallbackId !== null &&
              typeof video.cancelVideoFrameCallback === "function"
            ) {
              try {
                video.cancelVideoFrameCallback(videoFrameCallbackId);
              } catch {}
            }
            videoFrameCallbackId = null;
            videoFrameWatchdogTimerId = null;
            timerPollCount += 1;
            latestVideoFrameMetadata = null;
            void loop(performance.now());
          }, watchdogMs);
        } catch (err) {
          videoFrameCallbackId = null;
          clearVideoFrameWatchdog();
          videoFrameScheduleFailureCount += 1;
          warnVideoEffects(debugId, "video_frame_callback_schedule_failed", {
            error: getErrorDebugSnapshot(err),
          });
          scheduleTimerLoop();
        }
        return;
      }

      const processorFrameUsable =
        latestTrackProcessorFrameAt > 0 &&
        performance.now() - latestTrackProcessorFrameAt <
          TRACK_PROCESSOR_SCHEDULER_MAX_AGE_MS &&
        capturedFrameCanvas.width > 0 &&
        capturedFrameCanvas.height > 0;
      if (processorFrameUsable) {
        scheduleTimerLoop(undefined, "track-processor");
        return;
      }

      scheduleTimerLoop();
    };

    const rearmHiddenVideoPlayback = (reason: string) => {
      if (cancelled || sourceVideoTrack.readyState !== "live") return;
      hiddenVideoRearmCount += 1;
      logVideoEffects(debugId, "hidden_video_rearm", {
        reason,
        rearmCount: hiddenVideoRearmCount,
        video: {
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          paused: video.paused,
          ended: video.ended,
        },
        sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
      });
      video
        .play()
        .then(() => {
          if (!cancelled) schedule();
        })
        .catch((err) => {
          if (cancelled) return;
          warnVideoEffects(debugId, "hidden_video_rearm_failed", {
            reason,
            error: getErrorDebugSnapshot(err),
            sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          });
        });
    };

    const handleHiddenVideoMediaEvent = (event: Event) => {
      if (cancelled) return;
      hiddenVideoMediaEventCount += 1;
      if (hiddenVideoMediaEventCount <= 4) {
        logVideoEffects(debugId, "hidden_video_media_event", {
          type: event.type,
          eventCount: hiddenVideoMediaEventCount,
          video: {
            readyState: video.readyState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            paused: video.paused,
            ended: video.ended,
          },
        });
      }
      schedule();
    };

    video.addEventListener("loadedmetadata", handleHiddenVideoMediaEvent);
    video.addEventListener("loadeddata", handleHiddenVideoMediaEvent);
    video.addEventListener("canplay", handleHiddenVideoMediaEvent);
    video.addEventListener("playing", handleHiddenVideoMediaEvent);

    const getAdaptationRecordOptions = (sampleNow = performance.now()) => {
      const warmupHeld =
        sampleNow < adaptationEvaluationHoldUntil ||
        visibleOutputFrameCount < OUTPUT_READY_FRAMES ||
        outputFramesWritten < OUTPUT_READY_FRAMES;
      return {
        evaluate: !warmupHeld,
        updateSmoothedMetrics: !warmupHeld,
      };
    };

    const recordRuntimePipelinePressure = (sampleNow = performance.now()) => {
      const metricFreshMs = 1500;
      let pressureMs = 0;
      let reason: string | null = null;
      const addPressure = (sampleMs: number, sampleReason: string) => {
        if (!Number.isFinite(sampleMs) || sampleMs <= pressureMs) return;
        pressureMs = sampleMs;
        reason = sampleReason;
      };
      const addFreshMetric = (
        value: number | null,
        collectedAt: number,
        sampleReason: string,
        scale = 1,
      ) => {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          collectedAt <= 0 ||
          sampleNow - collectedAt > metricFreshMs
        ) {
          return;
        }
        addPressure(value * scale, sampleReason);
      };

      addFreshMetric(
        latestOutputWriterRoundTripMs,
        latestOutputWriterLatencyAt,
        "output-writer-round-trip",
      );
      addFreshMetric(
        latestOutputWriterBackpressureMs,
        latestOutputWriterLatencyAt,
        "output-writer-backpressure",
        2,
      );
      addFreshMetric(
        latestOutputWriterFrameBuildMs,
        latestOutputWriterFrameBuildAt,
        "output-frame-build",
      );
      addFreshMetric(
        latestSegmentationProcessorWorkerRoundTripMs,
        latestSegmentationProcessorWorkerLatencyAt,
        "segmentation-worker-round-trip",
      );
      addFreshMetric(
        latestFaceProcessorWorkerRoundTripMs,
        latestFaceProcessorWorkerLatencyAt,
        "face-worker-round-trip",
      );

      const oldestOutputWriterPendingAgeMs =
        getOldestOutputWriterPendingAgeMs(sampleNow);
      if (
        outputWriterMode === "worker" &&
        outputWriterPendingFrameLimit > 0 &&
        outputWriterPendingFrames.size >= outputWriterPendingFrameLimit &&
        oldestOutputWriterPendingAgeMs !== null &&
        oldestOutputWriterPendingAgeMs >= OUTPUT_WRITER_PENDING_PRESSURE_MS
      ) {
        addPressure(
          Math.min(220, oldestOutputWriterPendingAgeMs),
          "output-writer-stale-pending-frame",
        );
      } else if (
        outputWriterMode === "worker" &&
        outputWriterPendingFrames.size > 1
      ) {
        addPressure(105, "output-writer-pending-queue");
      }

      const outputBackpressureSkips =
        outputWriterBackpressureSkipCount -
        lastAdaptationOutputWriterBackpressureSkipCount;
      const outputUnavailableSkips =
        outputWriterUnavailableSkipCount -
        lastAdaptationOutputWriterUnavailableSkipCount;
      const outputWriteFailures =
        outputWriterWriteFailures - lastAdaptationOutputWriterWriteFailures;
      const outputPostFailures =
        outputWriterPostFailures - lastAdaptationOutputWriterPostFailures;
      const segmentationWorkerFailures =
        segmentationProcessorWorkerFailures -
        lastAdaptationSegmentationWorkerFailures;
      const faceWorkerFailures =
        faceProcessorWorkerFailures - lastAdaptationFaceWorkerFailures;

      lastAdaptationOutputWriterBackpressureSkipCount =
        outputWriterBackpressureSkipCount;
      lastAdaptationOutputWriterUnavailableSkipCount =
        outputWriterUnavailableSkipCount;
      lastAdaptationOutputWriterWriteFailures = outputWriterWriteFailures;
      lastAdaptationOutputWriterPostFailures = outputWriterPostFailures;
      lastAdaptationSegmentationWorkerFailures =
        segmentationProcessorWorkerFailures;
      lastAdaptationFaceWorkerFailures = faceProcessorWorkerFailures;

      if (outputBackpressureSkips > 0) {
        addPressure(180, "output-writer-backpressure-skip");
      }
      if (outputUnavailableSkips > 0) {
        addPressure(120, "output-writer-unavailable-skip");
      }
      if (outputWriteFailures > 0 || outputPostFailures > 0) {
        addPressure(220, "output-writer-failure");
      }
      if (segmentationWorkerFailures > 0) {
        addPressure(160, "segmentation-worker-failure");
      }
      if (faceWorkerFailures > 0) {
        addPressure(160, "face-worker-failure");
      }

      const recordOptions = getAdaptationRecordOptions(sampleNow);
      recordVideoEffectsRuntimePressure(
        adaptationState,
        pressureMs,
        reason,
        sampleNow,
        {
          evaluate: false,
          updateSmoothedMetrics: recordOptions.updateSmoothedMetrics,
        },
      );
    };

    const getModelWorkerVideoFrameTimestamp = (
      now: number,
      frameSource: FrameSource,
    ) => {
      if (
        frameSource.source === "video" &&
        Number.isFinite(video.currentTime) &&
        video.currentTime > 0
      ) {
        return Math.round(video.currentTime * 1_000_000);
      }
      return Math.round(now * 1000);
    };

    const getModelFrameInput = (
      frameSource: FrameSource,
      kind: ModelDispatchKind,
    ) => {
      const inputCanvas =
        kind === "segmentation" ? segmentationModelInputCanvas : faceModelInputCanvas;
      const inputCtx =
        kind === "segmentation" ? segmentationModelInputCtx : faceModelInputCtx;
      const modelSize = getModelInputCanvasSize(
        frameSource.width,
        frameSource.height,
        kind,
      );
      const shouldScale =
        modelSize.scale < 0.999 &&
        modelSize.width > 0 &&
        modelSize.height > 0 &&
        Boolean(inputCtx);

      if (!shouldScale || !inputCtx) {
        return {
          image: frameSource.image,
          width: frameSource.width,
          height: frameSource.height,
          scale: 1,
        };
      }

      if (
        inputCanvas.width !== modelSize.width ||
        inputCanvas.height !== modelSize.height
      ) {
        inputCanvas.width = modelSize.width;
        inputCanvas.height = modelSize.height;
      }
      inputCtx.clearRect(0, 0, inputCanvas.width, inputCanvas.height);
      inputCtx.imageSmoothingEnabled = true;
      inputCtx.imageSmoothingQuality = "high";
      inputCtx.drawImage(
        frameSource.image,
        0,
        0,
        frameSource.width,
        frameSource.height,
        0,
        0,
        inputCanvas.width,
        inputCanvas.height,
      );

      return {
        image: inputCanvas,
        width: inputCanvas.width,
        height: inputCanvas.height,
        scale: modelSize.scale,
      };
    };

    const createModelWorkerFrameSource = async (
      now: number,
      frameSource: FrameSource,
      kind: ModelDispatchKind,
    ): Promise<ModelWorkerFrameSource | null> => {
      const modelFrame = getModelFrameInput(frameSource, kind);
      const VideoFrameCtor = (
        globalThis as unknown as { VideoFrame?: unknown }
      ).VideoFrame as VideoFrameConstructor | undefined;
      if (VideoFrameCtor && !modelWorkerVideoFrameSourceUnavailable) {
        try {
          const frame = new VideoFrameCtor(modelFrame.image, {
            timestamp: getModelWorkerVideoFrameTimestamp(now, frameSource),
          });
          return {
            source: frame,
            kind: "video-frame",
            transfer: frame as unknown as Transferable,
            width: modelFrame.width,
            height: modelFrame.height,
            scale: modelFrame.scale,
          };
        } catch (err) {
          modelWorkerVideoFrameSourceFailures += 1;
          modelWorkerVideoFrameSourceUnavailable = true;
          warnVideoEffects(debugId, "model_worker_video_frame_source_failed", {
            error: getErrorDebugSnapshot(err),
            source: frameSource.source,
            failures: modelWorkerVideoFrameSourceFailures,
          });
        }
      }

      if (typeof createImageBitmap !== "function") {
        return null;
      }

      const bitmap = await createImageBitmap(modelFrame.image);
      return {
        source: bitmap,
        kind: "image-bitmap",
        transfer: bitmap as unknown as Transferable,
        width: modelFrame.width,
        height: modelFrame.height,
        scale: modelFrame.scale,
      };
    };

    const processSegmentationFrameWithWorker = async (
      now: number,
      frameSource: FrameSource,
    ) => {
      const workerReady = await ensureSegmentationProcessorWorker();
      if (
        cancelled ||
        !workerReady ||
        !segmentationProcessorWorker ||
        !segmentationProcessorWorkerReady
      ) {
        return false;
      }

      let workerSource: ModelWorkerFrameSource | null = null;
      try {
        workerSource = await createModelWorkerFrameSource(
          now,
          frameSource,
          "segmentation",
        );
        if (!workerSource) {
          return false;
        }
        const sequence = segmentationProcessorWorkerSequence + 1;
        segmentationProcessorWorkerSequence = sequence;
        segmentationProcessorWorkerFramesSent += 1;
        const frameProcessingConfigId = modelProcessingConfigId;
        const sentAt = performance.now();
        const sourceForWorker = workerSource;
        const result =
          await new Promise<SegmentationProcessorWorkerResultMessage>(
            (resolve, reject) => {
              const timeoutId = window.setTimeout(() => {
                segmentationProcessorPendingFrames.delete(sequence);
                const err = new Error(SEGMENTATION_PROCESSOR_TIMEOUT_MESSAGE);
                segmentationProcessorLastError = getErrorDebugSnapshot(err);
                reject(err);
              }, SEGMENTATION_PROCESSOR_FRAME_TIMEOUT_MS);
              segmentationProcessorPendingFrames.set(sequence, {
                resolve,
                reject,
                timeoutId,
                sentAt,
                processingConfigId: frameProcessingConfigId,
              });
              try {
                segmentationProcessorWorker?.postMessage(
                  {
                    type: "SEGMENT",
                    sequence,
                    processingConfigId: frameProcessingConfigId,
                    source: sourceForWorker.source,
                    sourceKind: sourceForWorker.kind,
                    width: sourceForWorker.width,
                    height: sourceForWorker.height,
                    timestamp: now,
                  },
                  [sourceForWorker.transfer],
                );
                workerSource = null;
              } catch (err) {
                window.clearTimeout(timeoutId);
                segmentationProcessorPendingFrames.delete(sequence);
                segmentationProcessorLastError = getErrorDebugSnapshot(err);
                reject(err);
              }
            },
          );
        if (
          cancelled ||
          frameProcessingConfigId !== modelProcessingConfigId ||
          result.processingConfigId !== modelProcessingConfigId
        ) {
          segmentationProcessorWorkerStaleResults += 1;
          logVideoEffects(debugId, "discard_stale_segmentation_processor_result", {
            sequence: result.sequence,
            frameProcessingConfigId,
            resultProcessingConfigId: result.processingConfigId,
            currentProcessingConfigId: processingConfigId,
            currentModelProcessingConfigId: modelProcessingConfigId,
          });
          return true;
        }
        taskSegmentationRuns += 1;
        segmentationProcessorMode = "worker";
        updateSegmentationMaskPixels({
          width: result.width,
          height: result.height,
          confidence: result.confidence ?? null,
          category: result.category ?? null,
          qualityScores: result.qualityScores,
          confidenceMaskCount: result.confidenceMaskCount,
          hasCategoryMask: result.hasCategoryMask,
          processor: "worker",
        });
        logVideoEffects(debugId, "segmentation_processor_worker_results", {
          sequence: result.sequence,
          processingConfigId: result.processingConfigId,
          width: result.width,
          height: result.height,
          input: {
            width: sourceForWorker.width,
            height: sourceForWorker.height,
            scale: Number(sourceForWorker.scale.toFixed(3)),
          },
          using: result.confidence
            ? "confidence"
            : result.category
              ? "category"
              : "none",
          delegate: result.delegate,
          inputSource: result.inputSource,
          processingMs: Number(result.processingMs.toFixed(2)),
        });
        return true;
      } catch (err) {
        if (
          err instanceof Error &&
          err.message === SEGMENTATION_PROCESSOR_TIMEOUT_MESSAGE
        ) {
          warnVideoEffects(debugId, "segmentation_processor_worker_frame_timeout", {
            error: getErrorDebugSnapshot(err),
            hasPreviousMask: Boolean(latestSegmentationMask),
          });
          resetSegmentationProcessorWorker("worker frame timed out", err);
          return false;
        }
        if (isVideoEffectsProcessorCleanupError(err)) {
          logVideoEffects(debugId, "segmentation_processor_worker_frame_cancelled", {
            error: getErrorDebugSnapshot(err),
          });
          return false;
        }
        segmentationProcessorWorkerFailures += 1;
        segmentationProcessorFallbackReason = "worker frame failed";
        segmentationProcessorLastError = getErrorDebugSnapshot(err);
        warnVideoEffects(debugId, "segmentation_processor_worker_frame_failed", {
          error: getErrorDebugSnapshot(err),
        });
        return false;
      } finally {
        try {
          workerSource?.source.close?.();
        } catch {}
      }
    };

    const runMainThreadSegmentationFrame = async (
      now: number,
      frameSource: FrameSource,
    ) => {
      const model = await ensureTasksSegmenter();
      if (cancelled) return;
      const modelFrame = getModelFrameInput(frameSource, "segmentation");
      if (model) {
        try {
          segmentationProcessorMode = "main-thread";
          taskSegmentationRuns += 1;
          logVideoEffects(debugId, "tasks_segmenter_send", {
            timestamp: now,
            source: frameSource.source,
            video: {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
            },
            frame: {
              width: frameSource.width,
              height: frameSource.height,
            },
            input: {
              width: modelFrame.width,
              height: modelFrame.height,
              scale: Number(modelFrame.scale.toFixed(3)),
            },
          });
          model.segmentForVideo(
            modelFrame.image,
            now,
            updateTasksSegmentationMask,
          );
          return;
        } catch (err) {
          warnVideoEffects(debugId, "tasks_segmenter_send_failed", {
            error: getErrorDebugSnapshot(err),
          });
          tasksSegmenterFailed = true;
          model.close();
          if (tasksSegmenter === model) {
            tasksSegmenter = null;
          }
        }
      }
      const legacyModel = await ensureLegacySegmentation();
      if (!legacyModel || cancelled) return;
      segmentationProcessorMode = "legacy";
      legacySegmentationRuns += 1;
      logVideoEffects(debugId, "legacy_segmentation_send", {
        timestamp: now,
        source: frameSource.source,
        input: {
          width: modelFrame.width,
          height: modelFrame.height,
          scale: Number(modelFrame.scale.toFixed(3)),
        },
      });
      return legacyModel.send({ image: modelFrame.image });
    };

    const sendSegmentationFrame = (now: number, frameSource: FrameSource) => {
      if (
        segmentationInFlight ||
        (tasksSegmenterFailed && legacySegmentationFailed) ||
        now - lastSegmentationAt < segmentationIntervalMs
      ) {
        return false;
      }
      segmentationInFlight = true;
      lastSegmentationAt = now;
      const startedAt = now;
      let processingStartedAt = 0;
      void (async () => {
        processingStartedAt = performance.now();
        if (await processSegmentationFrameWithWorker(now, frameSource)) {
          return;
        }
        await runMainThreadSegmentationFrame(now, frameSource);
      })()
        .then(() => {
          if (segmentationProcessorMode === "worker") {
            latestSegmentationProcessingMs =
              latestSegmentationProcessorWorkerProcessingMs ??
              Math.max(1, performance.now() - processingStartedAt);
          }
        })
        .catch((err) => {
          warnVideoEffects(debugId, "segmentation_pipeline_failed", {
            error: getErrorDebugSnapshot(err),
            tasksSegmenterFailed,
            legacySegmentationFailed,
          });
          if (tasksSegmenterFailed) {
            legacySegmentationFailed = true;
          } else {
            tasksSegmenterFailed = true;
          }
        })
        .finally(() => {
          segmentationInFlight = false;
          const elapsed =
            segmentationProcessorMode === "worker" &&
            latestSegmentationProcessorWorkerProcessingMs !== null
              ? Math.max(1, latestSegmentationProcessorWorkerProcessingMs)
              : Math.max(
                  1,
                  performance.now() - (processingStartedAt || startedAt),
                );
          latestSegmentationProcessingMs = elapsed;
          const skipWarmupAdaptation =
            segmentationProcessorMode === "worker" &&
            segmentationProcessorWorkerResults <=
              VIDEO_EFFECTS_ADAPTATION_WARMUP_RESULTS;
          if (!skipWarmupAdaptation) {
            const adaptationSampleNow = performance.now();
            recordVideoEffectsAsyncProcessing(
              adaptationState,
              elapsed,
              adaptationSampleNow,
              getAdaptationRecordOptions(adaptationSampleNow),
            );
          }
          segmentationIntervalMs = getAdaptedModelInterval(
            adaptationState,
            "segmentation",
            skipWarmupAdaptation
              ? INITIAL_SEGMENTATION_INTERVAL_MS
              : elapsed * 1.35,
          );
        });
      return true;
    };

    const processFaceFrameWithWorker = async (
      now: number,
      frameSource: FrameSource,
    ) => {
      const workerReady = await ensureFaceProcessorWorker();
      if (
        cancelled ||
        !workerReady ||
        !faceProcessorWorker ||
        !faceProcessorWorkerReady
      ) {
        return false;
      }

      let workerSource: ModelWorkerFrameSource | null = null;
      try {
        workerSource = await createModelWorkerFrameSource(
          now,
          frameSource,
          "face",
        );
        if (!workerSource) {
          return false;
        }
        const sequence = faceProcessorWorkerSequence + 1;
        faceProcessorWorkerSequence = sequence;
        faceProcessorWorkerFramesSent += 1;
        const frameProcessingConfigId = modelProcessingConfigId;
        const sentAt = performance.now();
        const sourceForWorker = workerSource;
        const result = await new Promise<FaceProcessorWorkerResultMessage>(
          (resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
              faceProcessorPendingFrames.delete(sequence);
              const err = new Error(FACE_PROCESSOR_TIMEOUT_MESSAGE);
              faceProcessorLastError = getErrorDebugSnapshot(err);
              reject(err);
            }, FACE_PROCESSOR_FRAME_TIMEOUT_MS);
            faceProcessorPendingFrames.set(sequence, {
              resolve,
              reject,
              timeoutId,
              sentAt,
              processingConfigId: frameProcessingConfigId,
            });
            try {
              faceProcessorWorker?.postMessage(
                {
                  type: "FACE",
                  sequence,
                  processingConfigId: frameProcessingConfigId,
                  source: sourceForWorker.source,
                  sourceKind: sourceForWorker.kind,
                  width: sourceForWorker.width,
                  height: sourceForWorker.height,
                  timestamp: now,
                },
                [sourceForWorker.transfer],
              );
              workerSource = null;
            } catch (err) {
              window.clearTimeout(timeoutId);
              faceProcessorPendingFrames.delete(sequence);
              faceProcessorLastError = getErrorDebugSnapshot(err);
              reject(err);
            }
          },
        );
        if (
          cancelled ||
          frameProcessingConfigId !== modelProcessingConfigId ||
          result.processingConfigId !== modelProcessingConfigId
        ) {
          faceProcessorWorkerStaleResults += 1;
          logVideoEffects(debugId, "discard_stale_face_processor_result", {
            sequence: result.sequence,
            frameProcessingConfigId,
            resultProcessingConfigId: result.processingConfigId,
            currentProcessingConfigId: processingConfigId,
            currentModelProcessingConfigId: modelProcessingConfigId,
          });
          return true;
        }
        taskFaceRuns += 1;
        faceProcessorMode = "worker";
        latestFaceResultAt = performance.now();
        recordFaceDetectionResult(Boolean(result.landmarks?.length), "worker");
        const smoothedLandmarks = smoothFaceLandmarks(
          latestFaceLandmarks,
          result.landmarks,
        );
        const smoothedFaceFilterLandmarks = smoothFaceLandmarks(
          latestFaceFilterLandmarks,
          result.landmarks,
          FACE_FILTER_LANDMARK_SMOOTHING_ALPHA,
          FACE_FILTER_LANDMARK_FAST_SMOOTHING_ALPHA,
          FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_START,
          FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_END,
        );
        latestFacePose = smoothFacePoseTransform(
          latestFacePose,
          result.pose,
          FACE_LANDMARK_SMOOTHING_ALPHA,
        );
        latestFaceFilterPose = smoothFacePoseTransform(
          latestFaceFilterPose,
          result.pose,
          FACE_FILTER_LANDMARK_SMOOTHING_ALPHA,
        );
        latestFaceLandmarks = smoothedLandmarks.landmarks;
        latestFaceLandmarkSmoothingStats = smoothedLandmarks.stats;
        latestFaceLandmarksAt = latestFaceLandmarks ? performance.now() : 0;
        latestFaceFilterLandmarks = smoothedFaceFilterLandmarks.landmarks;
        latestFaceFilterLandmarkSmoothingStats =
          smoothedFaceFilterLandmarks.stats;
        latestFaceFilterLandmarksAt = latestFaceFilterLandmarks
          ? performance.now()
          : 0;
        logVideoEffects(debugId, "face_processor_worker_results", {
          sequence: result.sequence,
          processingConfigId: result.processingConfigId,
          faceCount: result.faceCount,
          landmarkCount: latestFaceLandmarks?.length ?? 0,
          blendshapeCount: result.blendshapeCount,
          matrixCount: result.matrixCount,
          poseCandidateCount: result.pose?.candidates.length ?? 0,
          pose: latestFacePose,
          delegate: result.delegate,
          inputSource: result.inputSource,
          processingMs: Number(result.processingMs.toFixed(2)),
          smoothing: latestFaceLandmarkSmoothingStats,
          filterSmoothing: latestFaceFilterLandmarkSmoothingStats,
        });
        return true;
      } catch (err) {
        if (
          err instanceof Error &&
          err.message === FACE_PROCESSOR_TIMEOUT_MESSAGE
        ) {
          warnVideoEffects(debugId, "face_processor_worker_frame_timeout", {
            error: getErrorDebugSnapshot(err),
            hasPreviousLandmarks: Boolean(latestFaceLandmarks?.length),
          });
          resetFaceProcessorWorker("worker frame timed out", err);
          return false;
        }
        if (isVideoEffectsProcessorCleanupError(err)) {
          logVideoEffects(debugId, "face_processor_worker_frame_cancelled", {
            error: getErrorDebugSnapshot(err),
          });
          return false;
        }
        faceProcessorWorkerFailures += 1;
        faceProcessorFallbackReason = "worker frame failed";
        faceProcessorLastError = getErrorDebugSnapshot(err);
        warnVideoEffects(debugId, "face_processor_worker_frame_failed", {
          error: getErrorDebugSnapshot(err),
        });
        return false;
      } finally {
        try {
          workerSource?.source.close?.();
        } catch {}
      }
    };

    const runMainThreadFaceFrame = async (
      now: number,
      frameSource: FrameSource,
    ) => {
      const model = await ensureTasksFaceLandmarker();
      if (cancelled) return;
      const modelFrame = getModelFrameInput(frameSource, "face");
      if (model) {
        try {
          faceProcessorMode = "main-thread";
          const processingStartedAt = performance.now();
          taskFaceRuns += 1;
          logVideoEffects(debugId, "tasks_face_send", {
            timestamp: now,
            source: frameSource.source,
            video: {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
            },
            frame: {
              width: frameSource.width,
              height: frameSource.height,
            },
            input: {
              width: modelFrame.width,
              height: modelFrame.height,
              scale: Number(modelFrame.scale.toFixed(3)),
            },
          });
          const results = model.detectForVideo(modelFrame.image, now);
          const detectedLandmarks =
            (results.faceLandmarks?.[0] as
              | NormalizedLandmarkList
              | undefined) ?? null;
          const detectedPose = extractFacePoseTransform(
            results.facialTransformationMatrixes?.[0],
          );
          latestFaceResultAt = performance.now();
          recordFaceDetectionResult(
            Boolean(detectedLandmarks?.length),
            "main-thread",
          );
          const smoothedLandmarks = smoothFaceLandmarks(
            latestFaceLandmarks,
            detectedLandmarks,
          );
          const smoothedFaceFilterLandmarks = smoothFaceLandmarks(
            latestFaceFilterLandmarks,
            detectedLandmarks,
            FACE_FILTER_LANDMARK_SMOOTHING_ALPHA,
            FACE_FILTER_LANDMARK_FAST_SMOOTHING_ALPHA,
            FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_START,
            FACE_FILTER_LANDMARK_ADAPTIVE_MOTION_END,
          );
          latestFacePose = smoothFacePoseTransform(
            latestFacePose,
            detectedPose,
            FACE_LANDMARK_SMOOTHING_ALPHA,
          );
          latestFaceFilterPose = smoothFacePoseTransform(
            latestFaceFilterPose,
            detectedPose,
            FACE_FILTER_LANDMARK_SMOOTHING_ALPHA,
          );
          latestFaceLandmarks = smoothedLandmarks.landmarks;
          latestFaceLandmarkSmoothingStats = smoothedLandmarks.stats;
          latestFaceLandmarksAt = latestFaceLandmarks
            ? performance.now()
            : 0;
          latestFaceFilterLandmarks = smoothedFaceFilterLandmarks.landmarks;
          latestFaceFilterLandmarkSmoothingStats =
            smoothedFaceFilterLandmarks.stats;
          latestFaceFilterLandmarksAt = latestFaceFilterLandmarks
            ? performance.now()
            : 0;
          latestFaceProcessingMs = Math.max(
            1,
            performance.now() - processingStartedAt,
          );
          logVideoEffects(debugId, "tasks_face_results", {
            faceCount: results.faceLandmarks?.length ?? 0,
            landmarkCount: latestFaceLandmarks?.length ?? 0,
            blendshapeCount: results.faceBlendshapes?.length ?? 0,
            matrixCount: results.facialTransformationMatrixes?.length ?? 0,
            poseCandidateCount: detectedPose?.candidates.length ?? 0,
            pose: latestFacePose,
            smoothing: latestFaceLandmarkSmoothingStats,
            filterSmoothing: latestFaceFilterLandmarkSmoothingStats,
          });
          return;
        } catch (err) {
          warnVideoEffects(debugId, "tasks_face_send_failed", {
            error: getErrorDebugSnapshot(err),
          });
          tasksFaceLandmarkerFailed = true;
          model.close();
          if (tasksFaceLandmarker === model) {
            tasksFaceLandmarker = null;
          }
        }
      }
      const legacyModel = await ensureLegacyFaceMesh();
      if (!legacyModel || cancelled) return;
      faceProcessorMode = "legacy";
      legacyFaceRuns += 1;
      logVideoEffects(debugId, "legacy_face_send", {
        timestamp: now,
        source: frameSource.source,
        input: {
          width: modelFrame.width,
          height: modelFrame.height,
          scale: Number(modelFrame.scale.toFixed(3)),
        },
      });
      return legacyModel.send({ image: modelFrame.image });
    };

    const sendFaceFrame = (now: number, frameSource: FrameSource) => {
      const faceFilterActive = effectsRef.current.filter !== "none";
      const effectiveFaceIntervalMs =
        staticCropActive && !faceFilterActive
          ? Math.max(faceIntervalMs, STATIC_CROP_FACE_REVALIDATION_INTERVAL_MS)
          : faceIntervalMs;
      if (
        faceMeshInFlight ||
        (tasksFaceLandmarkerFailed && legacyFaceMeshFailed) ||
        now - lastFaceAt < effectiveFaceIntervalMs
      ) {
        if (
          staticCropActive &&
          !faceMeshInFlight &&
          !(tasksFaceLandmarkerFailed && legacyFaceMeshFailed)
        ) {
          staticCropModelSkipCount += 1;
        }
        return false;
      }
      faceMeshInFlight = true;
      lastFaceAt = now;
      const startedAt = now;
      let processingStartedAt = 0;
      void (async () => {
        processingStartedAt = performance.now();
        if (await processFaceFrameWithWorker(now, frameSource)) {
          return;
        }
        await runMainThreadFaceFrame(now, frameSource);
      })()
        .then(() => {
          if (faceProcessorMode === "worker") {
            latestFaceProcessingMs =
              latestFaceProcessorWorkerProcessingMs ??
              Math.max(1, performance.now() - processingStartedAt);
          }
        })
        .catch((err) => {
          warnVideoEffects(debugId, "face_pipeline_failed", {
            error: getErrorDebugSnapshot(err),
            tasksFaceLandmarkerFailed,
            legacyFaceMeshFailed,
          });
          if (tasksFaceLandmarkerFailed) {
            legacyFaceMeshFailed = true;
          } else {
            tasksFaceLandmarkerFailed = true;
          }
        })
        .finally(() => {
          faceMeshInFlight = false;
          const elapsed =
            faceProcessorMode === "worker" &&
            latestFaceProcessorWorkerProcessingMs !== null
              ? Math.max(1, latestFaceProcessorWorkerProcessingMs)
              : Math.max(
                  1,
                  performance.now() - (processingStartedAt || startedAt),
                );
          latestFaceProcessingMs = elapsed;
          const skipWarmupAdaptation =
            faceProcessorMode === "worker" &&
            faceProcessorWorkerResults <=
              VIDEO_EFFECTS_ADAPTATION_WARMUP_RESULTS;
          if (!skipWarmupAdaptation) {
            const adaptationSampleNow = performance.now();
            recordVideoEffectsAsyncProcessing(
              adaptationState,
              elapsed,
              adaptationSampleNow,
              getAdaptationRecordOptions(adaptationSampleNow),
            );
          }
          const faceMinIntervalMs = getFaceModelMinIntervalMs(effectsRef.current);
          const adaptedFaceIntervalMs = capFaceModelIntervalForActiveFilter(
            effectsRef.current,
            getAdaptedModelInterval(
              adaptationState,
              "face",
              skipWarmupAdaptation ? faceMinIntervalMs : elapsed * 1.35,
              faceMinIntervalMs,
            ),
          );
          const shouldBackoffNoFace =
            !skipWarmupAdaptation &&
            consecutiveFaceNoResultCount >= FACE_NO_RESULT_BACKOFF_AFTER_RESULTS;
          const noFaceBackoffIntervalMs = shouldBackoffNoFace
            ? getAdaptedModelInterval(
                adaptationState,
                "face",
                FACE_NO_RESULT_BACKOFF_INTERVAL_MS,
              )
            : null;
          faceIntervalMs = noFaceBackoffIntervalMs
            ? Math.max(adaptedFaceIntervalMs, noFaceBackoffIntervalMs)
            : adaptedFaceIntervalMs;
          latestFaceNoResultBackoffActive = Boolean(noFaceBackoffIntervalMs);
          latestFaceNoResultBackoffReason = noFaceBackoffIntervalMs
            ? "no-face-result"
            : null;
          latestFaceNoResultBackoffIntervalMs = noFaceBackoffIntervalMs
            ? faceIntervalMs
            : null;
        });
      return true;
    };

    const getFrameMetadataSnapshot =
      (): VideoEffectsFrameMetadataDebugSnapshot => ({
        current: latestFrameMetadata,
        history: frameMetadataHistory,
        sequence: frameMetadataSequence,
      });

    window.__conclaveGetVideoEffectsFrameMetadataDebug =
      getFrameMetadataSnapshot;
    window.__conclaveVideoEffectsFrameMetadataDebug =
      getFrameMetadataSnapshot();

    const publishFrameMetadata = (
      now: number,
      frameSource: FrameSource,
      videoFrameMetadata: VideoFrameCallbackMetadataLike | null,
      currentEffects: VideoEffectsState,
      autoFrame: AutoFrameStats,
    ) => {
      const trackedHumans: VideoEffectsHumanTrack[] = [];
      const faceBounds =
        autoFrame.faceBounds ??
        getLandmarkBounds(
          latestFaceLandmarks,
          frameSource.width,
          frameSource.height,
        );
      if (faceBounds) {
        const track = createHumanTrackFromBounds(
          "face:local:0",
          "face",
          faceBounds,
          frameSource.width,
          frameSource.height,
        );
        if (track) trackedHumans.push(track);
      }
      if (!trackedHumans.length && autoFrame.foregroundBounds) {
        const track = createHumanTrackFromBounds(
          "foreground:local:0",
          "foreground",
          autoFrame.foregroundBounds,
          frameSource.width,
          frameSource.height,
        );
        if (track) trackedHumans.push(track);
      }

      const trackSignature =
        trackedHumans
          .map(
            (track) =>
              `${track.source}:${track.centerX}:${track.centerY}:${track.width}:${track.height}`,
          )
          .join("|") || "none";
      const hasRoomTilingMetadata =
        currentEffects.framing ||
        currentEffects.filter !== "none" ||
        (currentEffects.background !== "none" &&
          currentEffects.background !== "gradient");
      const tilesStable =
        trackedHumans.length > 0 &&
        lastRoomTilingTrackSignature === trackSignature;
      if (hasRoomTilingMetadata) {
        roomTilingEnabledFramesCount += 1;
        if (tilesStable) roomTilingStableFramesCount += 1;
      }
      lastRoomTilingTrackSignature = trackSignature;
      if (trackedHumans.length > 0 && !hasSeenHumanTracking) {
        humanTrackingLifetimeTrackCount += trackedHumans.length;
        hasSeenHumanTracking = true;
      }
      humanTrackingLifetimeTrackCount = Math.max(
        humanTrackingLifetimeTrackCount,
        trackedHumans.length,
      );
      const sourceFallbackLevel =
        latestSourceFrameFallbackReason === "dark-video"
          ? 3
          : latestSourceFrameFallbackReason === "missing-video"
            ? 2
            : blackSourceVideoFrameCount > 0
              ? 1
              : 0;
      const fallbackLevel = Math.max(
        roomTilingPolicyContextRef.current?.fallbackLevel ?? 0,
        sourceFallbackLevel,
      );

      const exactTimestampMs =
        videoFrameMetadata &&
        typeof videoFrameMetadata.mediaTime === "number" &&
        Number.isFinite(videoFrameMetadata.mediaTime)
          ? Math.round(videoFrameMetadata.mediaTime * 1000)
          : Number.isFinite(video.currentTime)
            ? Math.round(video.currentTime * 1000)
            : null;

      const metadata: VideoEffectsFrameMetadata = {
        type: "FRAME_METADATA",
        source: "client-video-effects",
        sequence: frameMetadataSequence + 1,
        processingConfigId,
        approximateTimestampMs: Math.round(now),
        exactTimestampMs,
        frame: {
          width: frameSource.width,
          height: frameSource.height,
          frameSequence,
          outputFrameSequence,
        },
        roomTilingMetadata: {
          tileCount: trackedHumans.length,
          tilesStable,
          enabledFramesCount: roomTilingEnabledFramesCount,
          stableFramesCount: roomTilingStableFramesCount,
          fallbackLevel,
        },
        humanTrackingMetadata: {
          lifetimeTrackCount: humanTrackingLifetimeTrackCount,
          activeTrackCount: trackedHumans.length,
          trackedHumans,
        },
        continuousAutozoomMetadata: {
          enabled: autoFrame.enabled,
          source: autoFrame.source,
          zoomFactor: autoFrame.zoom,
          crop: roundCropRect(autoFrame.crop),
          targetCrop: roundCropRect(autoFrame.targetCrop),
          recentered: autoFrame.recentered,
          recenterCount: autoFrame.recenterCount,
        },
      };
      const previousMetadata = latestFrameMetadata;

      frameMetadataSequence = metadata.sequence;
      latestFrameMetadata = metadata;
      frameMetadataHistory = [...frameMetadataHistory, metadata].slice(-24);
      const snapshot = getFrameMetadataSnapshot();
      window.__conclaveVideoEffectsFrameMetadataDebug = snapshot;
      const trackingCountChanged =
        trackedHumans.length !==
        (previousMetadata?.humanTrackingMetadata.activeTrackCount ?? 0);
      const processingConfigChanged =
        metadata.processingConfigId !== previousMetadata?.processingConfigId;
      const shouldDispatchMetadata =
        !previousMetadata ||
        processingConfigChanged ||
        trackingCountChanged ||
        autoFrame.recentered ||
        now - lastFrameMetadataDispatchAt >= FRAME_METADATA_DISPATCH_INTERVAL_MS;
      if (shouldDispatchMetadata) {
        lastFrameMetadataDispatchAt = now;
        window.dispatchEvent(
          new CustomEvent("conclave:video-effects-frame-metadata", {
            detail: metadata,
          }),
        );
      }
    };

    const loop = async (
      now = performance.now(),
      videoFrameMetadata: VideoFrameCallbackMetadataLike | null =
        latestVideoFrameMetadata,
    ) => {
      if (cancelled) return;
      markVideoEffectsPipelineBusy();
      const loopStartedAt = performance.now();
      latestFrameIntervalMs =
        lastLoopStartedAt > 0
          ? Math.max(0, loopStartedAt - lastLoopStartedAt)
          : 1000 / TARGET_FPS;
      lastLoopStartedAt = loopStartedAt;
      renderedFrames += 1;
      const currentEffects = effectsRef.current;
      const nextEffectsSnapshot =
        createVisualEffectTransitionSnapshot(currentEffects);
      const nextEffectSignature = JSON.stringify(nextEffectsSnapshot);
      let effectsChangedThisFrame = false;
      if (nextEffectSignature !== lastEffectSignature) {
        processingConfigId += 1;
        const previousEffectsSnapshot = lastEffectsSnapshot;
        const transitionReason = getVisualEffectTransitionReason(
          previousEffectsSnapshot,
          nextEffectsSnapshot,
        );
        const transitionStarted = startVisualEffectTransition(
          visualTransition,
          canvas,
          previousEffectsSnapshot,
          nextEffectsSnapshot,
          transitionReason,
          latestOutputFrameAt > 0 && latestOutputFrameVisible,
          performance.now(),
        );
        latestVisualTransitionStats = getVisualEffectTransitionStats(
          visualTransition,
          performance.now(),
        );
        logVideoEffects(debugId, "loop_effects_signature_changed", {
          previous: lastEffectSignature,
          next: nextEffectsSnapshot,
          processingConfigId,
          transition: {
            reason: transitionReason,
            started: transitionStarted,
            stats: latestVisualTransitionStats,
          },
        });
        lastEffectsSnapshot = nextEffectsSnapshot;
        lastEffectSignature = nextEffectSignature;
        visibleOutputFrameCount = 0;
        blackOutputFrameCount = 0;
        const effectSwitchNow = performance.now();
        latestEffectSwitchAt = effectSwitchNow;
        latestEffectSwitchSequence += 1;
        latestEffectSwitchReason = transitionReason;
        latestEffectSwitchFirstDeliveredLatencyMs = null;
        latestEffectSwitchFirstVisibleLatencyMs = null;
        latestEffectSwitchPending = true;
        effectSwitchModelCadenceWarmupUntil =
          effectSwitchNow + EFFECT_SWITCH_MODEL_CADENCE_WARMUP_MS;
        adaptationPolicyDownshiftTransitionHoldUntil =
          effectSwitchNow + VIDEO_EFFECTS_POLICY_DOWNSHIFT_TRANSITION_HOLD_MS;
        adaptationPolicyDownshiftTransitionHoldTierIndex =
          adaptationState.policyTierIndex;
        adaptationPolicyDownshiftTransitionHoldReason =
          adaptationState.policyReason;
        adaptationEvaluationHoldUntil = Math.max(
          adaptationEvaluationHoldUntil,
          effectSwitchNow + VIDEO_EFFECTS_ADAPTATION_WARMUP_HOLD_MS,
        );
        resetAdaptationWarmupMetrics(adaptationState);
        consecutiveFaceNoResultCount = 0;
        latestFaceNoResultBackoffActive = false;
        latestFaceNoResultBackoffReason = null;
        latestFaceNoResultBackoffIntervalMs = null;
        exitStaticCrop("effect-change");
        effectsChangedThisFrame = true;
        prestartNeededProcessorWorkers("effect-change", currentEffects);
      }
      const { needsSegmentation, needsFace } =
        getRuntimeProcessorNeeds(currentEffects);
      if (effectsChangedThisFrame) {
        if (needsSegmentation && !segmentationInFlight) {
          lastSegmentationAt = 0;
        }
        if (needsFace && !faceMeshInFlight) {
          lastFaceAt = 0;
        }
      }
      setAdaptationEffectMode(
        adaptationState,
        needsFace ||
          needsSegmentation ||
          currentEffects.studioLighting ||
          currentEffects.studioLook,
      );
      if (sourceVideoTrack.readyState !== "live") {
        logVideoEffects(debugId, "source_track_ended_cleanup", {
          outputTrackPublished,
          outputMode,
          outputFramesWritten,
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          effects: getEffectsDebugSnapshot(currentEffects),
        });
        releaseOutputTrackToRaw("source track ended", "debug");
        setRuntimeStatus("off", null);
        return;
      }
      let sourceProbe: CanvasVisibilityProbe = {
        averageLuma: 0,
        peakLuma: 0,
        visible: false,
      };
      let frameSource: FrameSource | null = null;

      const processorPrimarySource =
        getFreshTrackProcessorFrameSource("primary");
      if (processorPrimarySource) {
        frameSource = processorPrimarySource.frameSource;
        sourceProbe = processorPrimarySource.sourceProbe;
      }

      if (
        !frameSource &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        const sourceProbeInterval =
          blackSourceVideoFrameCount > 0
            ? SOURCE_VISIBILITY_PROBE_RECOVERY_INTERVAL_FRAMES
            : SOURCE_VISIBILITY_PROBE_INTERVAL_FRAMES;
        const shouldProbeVideoSource =
          !latestVideoSourceProbe ||
          !latestVideoSourceProbe.visible ||
          latestVideoSourceProbeAt <= 0 ||
          effectsChangedThisFrame ||
          !outputTrackPublished ||
          frameSequence < OUTPUT_READY_FRAMES ||
          blackSourceVideoFrameCount > 0 ||
          frameSequence % sourceProbeInterval === 0 ||
          (currentEffects.studioLighting &&
            performance.now() - latestVideoSourceProbeAt >=
              LOW_LIGHT_SAMPLE_INTERVAL_MS);
        const videoProbe = shouldProbeVideoSource
          ? probeVideoFrameVisibility(video, sourceProbeCanvas, sourceProbeCtx)
          : latestVideoSourceProbe ?? {
              averageLuma: 255,
              peakLuma: 255,
              visible: true,
            };
        if (shouldProbeVideoSource) {
          latestVideoSourceProbe = videoProbe;
          latestVideoSourceProbeAt = performance.now();
        }
        if (videoProbe.visible) {
          sourceProbe = videoProbe;
          frameSource = {
            image: video,
            width: getEvenDimension(video.videoWidth || 1280),
            height: getEvenDimension(video.videoHeight || 720),
            source: "video",
          };
          latestSourceFrameSelection = "video";
          latestSourceFrameFallbackReason = "none";
          blackSourceVideoFrameCount = 0;
          latestVideoVisibleAt = performance.now();
          if (
            trackProcessorStarted &&
            latestTrackProcessorFallbackAt > 0 &&
            latestVideoVisibleAt - latestTrackProcessorFallbackAt >
              TRACK_PROCESSOR_RETIRE_AFTER_VIDEO_VISIBLE_MS
          ) {
            closeTrackProcessor("video-source-stable");
          }
        } else {
          blackSourceVideoFrameCount += 1;
          if (
            blackSourceVideoFrameCount <= 3 ||
            blackSourceVideoFrameCount % 30 === 0
          ) {
            warnVideoEffects(debugId, "black_source_video_probe", {
              sourceProbe: videoProbe,
              blackSourceVideoFrameCount,
              sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
              video: {
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                paused: video.paused,
                ended: video.ended,
                currentTime: Number.isFinite(video.currentTime)
                  ? Number(video.currentTime.toFixed(6))
                  : null,
              },
            });
          }
          const processorSource =
            getFreshTrackProcessorFrameSource("dark-video");
          if (processorSource) {
            frameSource = processorSource.frameSource;
            sourceProbe = processorSource.sourceProbe;
          } else {
            sourceProbe = videoProbe;
            frameSource = {
              image: video,
              width: getEvenDimension(video.videoWidth || 1280),
              height: getEvenDimension(video.videoHeight || 720),
              source: "video",
            };
            latestSourceFrameSelection = "video";
            latestSourceFrameFallbackReason = "dark-video";
            if (
              blackSourceVideoFrameCount <= 3 ||
              blackSourceVideoFrameCount % 30 === 0
            ) {
              logVideoEffects(debugId, "using_dark_video_frame_source", {
                sourceProbe: videoProbe,
                blackSourceVideoFrameCount,
                sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
                video: {
                  readyState: video.readyState,
                  videoWidth: video.videoWidth,
                  videoHeight: video.videoHeight,
                  paused: video.paused,
                  ended: video.ended,
                },
              });
            }
          }
        }
      }

      if (!frameSource) {
        const captureSource = await getImageCaptureFrameSource(
          latestVideoSourceProbe && !latestVideoSourceProbe.visible
            ? "dark-video"
            : "missing-video",
        );
        if (captureSource) {
          frameSource = captureSource.frameSource;
          sourceProbe = captureSource.sourceProbe;
        }
      }

      if (!frameSource) {
        consecutiveFrameSourceMisses += 1;
        if (
          consecutiveFrameSourceMisses === SOURCE_VIDEO_REARM_MISS_THRESHOLD ||
          consecutiveFrameSourceMisses %
            (SOURCE_VIDEO_REARM_MISS_THRESHOLD * 4) ===
            0
        ) {
          rearmHiddenVideoPlayback(
            latestVideoSourceProbe && !latestVideoSourceProbe.visible
              ? "dark-video"
              : "missing-video",
          );
        }
        if (
          trackProcessorStarted &&
          trackProcessorFrameCount === 0 &&
          consecutiveFrameSourceMisses >= TRACK_PROCESSOR_RESTART_MISS_THRESHOLD
        ) {
          restartTrackProcessor(
            latestVideoSourceProbe && !latestVideoSourceProbe.visible
              ? "dark-video-zero-frames"
              : "missing-video-zero-frames",
          );
        }
        if (consecutiveFrameSourceMisses >= 3) {
          const processorSource = getFreshTrackProcessorFrameSource(
            latestVideoSourceProbe && !latestVideoSourceProbe.visible
              ? "dark-video"
              : "missing-video",
          );
          if (processorSource) {
            frameSource = processorSource.frameSource;
            sourceProbe = processorSource.sourceProbe;
          }
        }
      } else {
        consecutiveFrameSourceMisses = 0;
      }

      if (!frameSource) {
        latestSourceFrameSelection = "none";
        latestSourceFrameFallbackReason =
          latestVideoSourceProbe && !latestVideoSourceProbe.visible
            ? "dark-video"
            : "missing-video";
        visibleOutputFrameCount = 0;
        blackOutputFrameCount += 1;
        let outputProbe = probeCanvasFrameVisibility(
          canvas,
          outputProbeCanvas,
          outputProbeCtx,
        );
        if (outputTrackPublished && !outputProbe.visible) {
          const restoredProbe = restoreLastVisibleOutputFrame(
            "no-visible-frame-source",
            outputProbe,
          );
          if (restoredProbe?.visible) {
            outputProbe = restoredProbe;
            const outputDelivered = await deliverOutputFrame(now);
            if (outputDelivered) {
              recordOutputProbeResult(
                outputProbe,
                sourceProbe,
                null,
                currentEffects,
              );
              setRuntimeStatus(
                "loading",
                "Effects source video is warming up; holding the last processed frame.",
              );
              latestLoopProcessingDelayMs = Math.max(
                0,
                performance.now() - loopStartedAt,
              );
              latestLoopFullProcessingDelayMs = Math.max(
                latestLoopProcessingDelayMs,
                latestSegmentationProcessingMs,
                latestFaceProcessingMs,
              );
              const adaptationSampleNow = performance.now();
              recordRuntimePipelinePressure(adaptationSampleNow);
              recordVideoEffectsFrameProcessing(
                adaptationState,
                {
                  processingDelayMs: latestLoopProcessingDelayMs,
                  fullProcessingDelayMs: latestLoopFullProcessingDelayMs,
                  frameIntervalMs: latestFrameIntervalMs,
                },
                adaptationSampleNow,
                getAdaptationRecordOptions(adaptationSampleNow),
              );
              schedule();
              return;
            }
          }
        }
        latestOutputFrameVisible = outputProbe.visible;
        if (blackOutputFrameCount <= 3 || blackOutputFrameCount % 30 === 0) {
          const sourceVideoMetadataPending =
            video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0;
          const shouldWarnNoVisibleFrameSource =
            outputTrackPublished ||
            outputFramesWritten > 0 ||
            !sourceVideoMetadataPending;
          const logNoVisibleFrameSource = shouldWarnNoVisibleFrameSource
            ? warnVideoEffects
            : logVideoEffects;
          const noVisibleFrameSourcePayload = {
            sourceProbe,
            outputProbe,
            blackOutputFrameCount,
            outputTrackPublished,
            outputMode,
            outputFramesWritten,
            outputGeneratorFailed,
            sourceFrame: {
              selection: latestSourceFrameSelection,
              fallbackReason: latestSourceFrameFallbackReason,
              blackSourceVideoFrameCount,
              fallbackCount: sourceFrameFallbackCount,
              latestVideoProbe: latestVideoSourceProbe,
            },
            trackProcessor: {
              started: trackProcessorStarted,
              unavailable: trackProcessorUnavailable,
              frameCount: trackProcessorFrameCount,
              restartCount: trackProcessorRestartCount,
              latestFrameAgeMs:
                latestTrackProcessorFrameAt > 0
                  ? Math.round(performance.now() - latestTrackProcessorFrameAt)
                  : null,
            },
            video: {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              paused: video.paused,
              ended: video.ended,
            },
            effects: getEffectsDebugSnapshot(currentEffects),
            sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          };
          logNoVisibleFrameSource(
            debugId,
            shouldWarnNoVisibleFrameSource
              ? "no_visible_frame_source"
              : "source_frame_warming_up",
            noVisibleFrameSourcePayload,
          );
        }
        if (outputTrackPublished && outputProbe.visible) {
          await deliverOutputFrame(now);
        }
        setRuntimeStatus(
          "degraded",
          "Effects source video is warming up; showing raw camera.",
        );
        latestLoopProcessingDelayMs = Math.max(
          0,
          performance.now() - loopStartedAt,
        );
        latestLoopFullProcessingDelayMs = Math.max(
          latestLoopProcessingDelayMs,
          latestSegmentationProcessingMs,
          latestFaceProcessingMs,
        );
        const adaptationSampleNow = performance.now();
        recordRuntimePipelinePressure(adaptationSampleNow);
        recordVideoEffectsFrameProcessing(
          adaptationState,
          {
            processingDelayMs: latestLoopProcessingDelayMs,
            fullProcessingDelayMs: latestLoopFullProcessingDelayMs,
            frameIntervalMs: latestFrameIntervalMs,
          },
          adaptationSampleNow,
          getAdaptationRecordOptions(adaptationSampleNow),
        );
        schedule();
        return;
      }

      latestVideoFrameKey = getVideoFrameKey(frameSource, videoFrameMetadata);
      const hasNewModelResult =
        latestSegmentationMaskAt > lastRenderedSegmentationMaskAt ||
        latestFaceLandmarksAt > lastRenderedFaceLandmarksAt;
      const shouldSkipDuplicateFrame =
        (frameSource.source === "video" ||
          frameSource.source === "track-processor") &&
        Boolean(latestVideoFrameKey) &&
        latestVideoFrameKey === lastProcessedVideoFrameKey &&
        !effectsChangedThisFrame &&
        !hasNewModelResult &&
        outputTrackPublished &&
        latestOutputFrameAt > 0 &&
        track.readyState === "live";
      if (shouldSkipDuplicateFrame) {
        duplicateFrameSkipCount += 1;
        lastDuplicateVideoFrameKey = latestVideoFrameKey;
        latestLoopProcessingDelayMs = Math.max(
          0,
          performance.now() - loopStartedAt,
        );
        latestLoopFullProcessingDelayMs = Math.max(
          latestLoopProcessingDelayMs,
          latestSegmentationProcessingMs,
          latestFaceProcessingMs,
        );
        const adaptationSampleNow = performance.now();
        recordRuntimePipelinePressure(adaptationSampleNow);
        recordVideoEffectsFrameProcessing(
          adaptationState,
          {
            processingDelayMs: latestLoopProcessingDelayMs,
            fullProcessingDelayMs: latestLoopFullProcessingDelayMs,
            frameIntervalMs: latestFrameIntervalMs,
          },
          adaptationSampleNow,
          getAdaptationRecordOptions(adaptationSampleNow),
        );
        schedule();
        return;
      }
      lastProcessedVideoFrameKey = latestVideoFrameKey;

      frameSequence += 1;
      const currentFrameSequence = frameSequence;
      const firstFrame = firstSourceFrameAt <= 0;
      if (firstFrame) {
        firstSourceFrameAt = loopStartedAt;
        logVideoEffects(debugId, "first_frame", {
          id: currentFrameSequence,
          source: frameSource.source,
          frame: {
            width: frameSource.width,
            height: frameSource.height,
          },
          outputMode,
          schedulerMode,
        });
      }

      if (frameSource.source === "track-processor") {
        logVideoEffects(debugId, "using_track_processor_frame_source", {
          sourceProbe,
          frame: {
            width: capturedFrameCanvas.width,
            height: capturedFrameCanvas.height,
            frameCount: trackProcessorFrameCount,
            ageMs: Math.round(performance.now() - latestTrackProcessorFrameAt),
          },
        });
      }

      const roomTilingPolicyContext = roomTilingPolicyContextRef.current;
      let adaptationPolicy = getVideoEffectsAdaptationPolicy(
        currentEffects,
        frameSource.width,
        frameSource.height,
        roomTilingPolicyContext,
      );
      const rawPolicyTierIndex = adaptationPolicy.tier
        ? getAdaptationTierIndex(adaptationState, adaptationPolicy.tier)
        : 0;
      const policyNow = performance.now();
      let effectivePolicyTierIndex = rawPolicyTierIndex;
      if (
        rawPolicyTierIndex > adaptationState.policyTierIndex &&
        policyNow < adaptationPolicyDownshiftTransitionHoldUntil
      ) {
        const heldPolicyTierIndex = clamp(
          adaptationPolicyDownshiftTransitionHoldTierIndex,
          0,
          Math.max(0, adaptationState.availableTiers.length - 1),
        );
        const heldTier =
          adaptationState.availableTiers[heldPolicyTierIndex] ??
          adaptationPolicy.tier;
        if (heldTier) {
          effectivePolicyTierIndex = heldPolicyTierIndex;
          adaptationPolicy = {
            tier: heldTier,
            reason: `${
              adaptationPolicy.reason ?? "effect-policy"
            }:transition-held-from-${
              adaptationPolicyDownshiftTransitionHoldReason ?? "baseline"
            }`,
            score: adaptationPolicy.score,
            sourcePixels: adaptationPolicy.sourcePixels,
          };
        }
      }
      if (effectivePolicyTierIndex > adaptationState.policyTierIndex) {
        adaptationPolicyUpshiftHoldUntil =
          policyNow + VIDEO_EFFECTS_POLICY_UPSHIFT_HOLD_MS;
        adaptationPolicyHoldTierIndex = effectivePolicyTierIndex;
        adaptationPolicyHoldReason = adaptationPolicy.reason;
      } else if (
        effectivePolicyTierIndex < adaptationState.policyTierIndex &&
        policyNow < adaptationPolicyUpshiftHoldUntil
      ) {
        const heldPolicyTierIndex = clamp(
          Math.max(
            effectivePolicyTierIndex,
            adaptationPolicyHoldTierIndex,
            adaptationState.policyTierIndex,
          ),
          0,
          Math.max(0, adaptationState.availableTiers.length - 1),
        );
        const heldTier =
          adaptationState.availableTiers[heldPolicyTierIndex] ??
          adaptationPolicy.tier;
        if (heldTier) {
          adaptationPolicy = {
            tier: heldTier,
            reason: `${adaptationPolicyHoldReason ?? "effect-policy"}:held`,
            score: adaptationPolicy.score,
            sourcePixels: adaptationPolicy.sourcePixels,
          };
        }
      }
      setAdaptationPolicyTier(adaptationState, adaptationPolicy);
      if (
        effectsChangedThisFrame ||
        performance.now() < effectSwitchModelCadenceWarmupUntil
      ) {
        if (needsSegmentation) {
          segmentationIntervalMs = getAdaptedModelInterval(
            adaptationState,
            "segmentation",
            INITIAL_SEGMENTATION_INTERVAL_MS,
          );
        }
        if (needsFace) {
          const faceMinIntervalMs = getFaceModelMinIntervalMs(currentEffects);
          faceIntervalMs = capFaceModelIntervalForActiveFilter(
            currentEffects,
            getAdaptedModelInterval(
              adaptationState,
              "face",
              faceMinIntervalMs,
              faceMinIntervalMs,
            ),
          );
        }
      }
      const nextModelInputSignature = JSON.stringify({
        segmentation: needsSegmentation
          ? getModelInputCanvasSize(
              frameSource.width,
              frameSource.height,
              "segmentation",
            )
          : null,
        face: needsFace
          ? getModelInputCanvasSize(frameSource.width, frameSource.height, "face")
          : null,
      });
      if (lastModelInputSignature === "") {
        lastModelInputSignature = nextModelInputSignature;
      } else if (nextModelInputSignature !== lastModelInputSignature) {
        modelProcessingConfigId += 1;
        logVideoEffects(debugId, "model_input_signature_changed", {
          previous: lastModelInputSignature,
          next: nextModelInputSignature,
          modelProcessingConfigId,
          renderProcessingConfigId: processingConfigId,
        });
        lastModelInputSignature = nextModelInputSignature;
      }
      if (effectsChangedThisFrame && adaptationPolicy.tier) {
        logVideoEffects(debugId, "adaptation_policy_applied", {
          tier: adaptationPolicy.tier,
          reason: adaptationPolicy.reason,
          score: adaptationPolicy.score,
          sourcePixels: adaptationPolicy.sourcePixels,
          roomTiling: roomTilingPolicyContext
            ? {
                sequence: roomTilingPolicyContext.sequence,
                renderedMode: roomTilingPolicyContext.renderedMode,
                totalGridCount: roomTilingPolicyContext.totalGridCount,
                visibleCount: roomTilingPolicyContext.visibleCount,
                hiddenCount: roomTilingPolicyContext.hiddenCount,
                stageRailCount: roomTilingPolicyContext.stageRailCount,
                fallbackLevel: roomTilingPolicyContext.fallbackLevel,
                tileWidth: roomTilingPolicyContext.tileWidth,
                tileHeight: roomTilingPolicyContext.tileHeight,
                selfViewPlacement: roomTilingPolicyContext.selfViewPlacement,
                localIsPrimary: roomTilingPolicyContext.localIsPrimary,
              }
            : null,
          rawPolicyTierIndex,
          policyTierIndex: adaptationState.policyTierIndex,
          holdRemainingMs: Math.max(
            0,
            Math.round(adaptationPolicyUpshiftHoldUntil - policyNow),
          ),
          effectiveTier: getCurrentAdaptationTier(adaptationState),
          modelProcessingConfigId,
          warmupIntervals: {
            segmentationIntervalMs: Number(segmentationIntervalMs.toFixed(2)),
            faceIntervalMs: Number(faceIntervalMs.toFixed(2)),
            warmupMs: EFFECT_SWITCH_MODEL_CADENCE_WARMUP_MS,
          },
        });
      }

      const outputCanvasSize = ensureCanvasSize(
        frameSource.width,
        frameSource.height,
      );

      const dispatchSegmentation = () => {
        const dispatched = sendSegmentationFrame(now, frameSource);
        if (dispatched) {
          cooperativeSegmentationDispatches += 1;
          nextModelDispatchKind = "face";
        }
        return dispatched;
      };

      const dispatchFace = () => {
        const dispatched = sendFaceFrame(now, frameSource);
        if (dispatched) {
          cooperativeFaceDispatches += 1;
          nextModelDispatchKind = "segmentation";
        }
        return dispatched;
      };

      if (needsFace && needsSegmentation) {
        const segmentationResultAge =
          latestSegmentationMaskAt > 0
            ? performance.now() - latestSegmentationMaskAt
            : Number.POSITIVE_INFINITY;
        const faceResultAge =
          latestFaceLandmarksAt > 0
            ? performance.now() - latestFaceLandmarksAt
            : Number.POSITIVE_INFINITY;
        const segmentationStale =
          !latestSegmentationMask ||
          segmentationResultAge > SEGMENTATION_RESULT_STALE_MS;
        const faceStale =
          !latestFaceLandmarks || faceResultAge > FACE_RESULT_STALE_MS;
        const shouldPrimeBothModels =
          segmentationStale &&
          faceStale &&
          !segmentationInFlight &&
          !faceMeshInFlight &&
          (effectsChangedThisFrame ||
            !segmentationProcessorWorkerFirstResultSeen ||
            !faceProcessorWorkerFirstResultSeen);

        if (shouldPrimeBothModels) {
          const segmentationDispatched = dispatchSegmentation();
          const faceDispatched = dispatchFace();
          if (segmentationDispatched || faceDispatched) {
            logVideoEffects(debugId, "dual_model_prime_dispatch", {
              segmentationDispatched,
              faceDispatched,
              effectsChangedThisFrame,
              segmentationResultAgeMs: Number.isFinite(segmentationResultAge)
                ? Math.round(segmentationResultAge)
                : null,
              faceResultAgeMs: Number.isFinite(faceResultAge)
                ? Math.round(faceResultAge)
                : null,
            });
          }
        } else if (segmentationStale) {
          if (!dispatchSegmentation() && faceStale) {
            dispatchFace();
          }
        } else if (faceStale) {
          if (!dispatchFace()) {
            dispatchSegmentation();
          }
        } else if (nextModelDispatchKind === "segmentation") {
          if (!dispatchSegmentation()) {
            dispatchFace();
          }
        } else if (!dispatchFace()) {
          dispatchSegmentation();
        }
      } else if (needsFace) {
        dispatchFace();
      } else {
        latestFaceLandmarks = null;
        latestFaceLandmarksAt = 0;
        latestFaceFilterLandmarks = null;
        latestFaceFilterLandmarksAt = 0;
        latestFacePose = null;
        latestFaceFilterPose = null;
        latestFaceLandmarkSmoothingStats =
          createFaceLandmarkSmoothingStats("missing-result", null, null, 1);
        latestFaceFilterLandmarkSmoothingStats =
          createFaceLandmarkSmoothingStats("missing-result", null, null, 1);
        consecutiveFaceNoResultCount = 0;
        latestFaceNoResultBackoffActive = false;
        latestFaceNoResultBackoffReason = null;
        latestFaceNoResultBackoffIntervalMs = null;
        tasksFaceLandmarkerFailed = false;
        legacyFaceMeshFailed = false;
      }

      if (needsSegmentation && !needsFace) {
        dispatchSegmentation();
      } else if (!needsSegmentation) {
        latestSegmentationMask = null;
        latestSegmentationMaskAt = 0;
        tasksSegmenterFailed = false;
        legacySegmentationFailed = false;
      }

      const foregroundBounds = currentEffects.framing
        ? sampleForegroundBoundsFromSegmentationMask(
            latestSegmentationMask,
            frameSource.width,
            frameSource.height,
            canvas.width,
            canvas.height,
          )
        : null;
      const autoFrameTarget = computeCrop(
        frameSource.width,
        frameSource.height,
        canvas.width,
        canvas.height,
        currentEffects,
        latestFaceLandmarks,
        foregroundBounds,
      );
      const observedRecenterToken = framingRecenterTokenRef.current;
      const recenterRequested =
        currentEffects.framing &&
        observedRecenterToken !== lastFramingRecenterToken;
      if (observedRecenterToken !== lastFramingRecenterToken) {
        lastFramingRecenterToken = observedRecenterToken;
      }
      if (recenterRequested) {
        currentCrop = autoFrameTarget.targetCrop;
        autoFrameRecenterCount += 1;
        lastAutoFrameRecenterAt = performance.now();
        logVideoEffects(debugId, "auto_frame_recenter", {
          token: observedRecenterToken,
          source: autoFrameTarget.source,
          targetCrop: {
            sx: Number(autoFrameTarget.targetCrop.sx.toFixed(2)),
            sy: Number(autoFrameTarget.targetCrop.sy.toFixed(2)),
            sw: Number(autoFrameTarget.targetCrop.sw.toFixed(2)),
            sh: Number(autoFrameTarget.targetCrop.sh.toFixed(2)),
          },
        });
      } else {
        currentCrop = currentEffects.framing
          ? smoothCrop(currentCrop, autoFrameTarget.targetCrop, CROP_SMOOTHING_ALPHA)
          : autoFrameTarget.targetCrop;
      }
      const staticCropEligible =
        isFramingOnlyEffect(currentEffects) &&
        autoFrameTarget.enabled &&
        autoFrameTarget.source === "face" &&
        Boolean(latestFaceLandmarks?.length);
      if (recenterRequested) {
        exitStaticCrop("recenter");
      } else if (!currentEffects.framing) {
        if (staticCropActive || staticCropStableFrameCount > 0) {
          exitStaticCrop("not-framing-only");
        } else {
          staticCropLastExitReason = "not-framing-only";
        }
      } else if (!isFramingOnlyEffect(currentEffects)) {
        if (staticCropActive || staticCropStableFrameCount > 0) {
          exitStaticCrop("not-framing-only");
        } else {
          staticCropLastExitReason = "not-framing-only";
        }
      } else if (!staticCropEligible) {
        if (staticCropActive || staticCropStableFrameCount > 0) {
          exitStaticCrop(
            autoFrameTarget.source === "face" ? "source-lost" : "source-not-face",
          );
        } else {
          staticCropLastExitReason =
            autoFrameTarget.source === "face" ? "source-lost" : "source-not-face";
        }
      } else if (staticCropActive) {
        latestStaticCropDriftPx = getCropDriftPx(
          autoFrameTarget.targetCrop,
          staticCropReference,
        );
        if (latestStaticCropDriftPx > STATIC_CROP_EXIT_DRIFT_PX) {
          exitStaticCrop("crop-drift");
        } else {
          staticCropStableFrameCount += 1;
        }
      } else {
        latestStaticCropDriftPx = getCropDriftPx(
          currentCrop,
          autoFrameTarget.targetCrop,
        );
        if (latestStaticCropDriftPx <= STATIC_CROP_ENTER_DRIFT_PX) {
          staticCropStableFrameCount += 1;
          if (
            staticCropStableFrameCount >= STATIC_CROP_STABLE_FRAME_THRESHOLD &&
            currentCrop
          ) {
            staticCropActive = true;
            staticCropActivationCount += 1;
            staticCropEnteredAt = performance.now();
            staticCropReference = { ...currentCrop };
            staticCropLastExitReason = null;
            logVideoEffects(debugId, "static_crop_enter", {
              stableFrameCount: staticCropStableFrameCount,
              crop: roundCropRect(staticCropReference),
              driftPx: Number(latestStaticCropDriftPx.toFixed(2)),
              faceRevalidationIntervalMs:
                STATIC_CROP_FACE_REVALIDATION_INTERVAL_MS,
            });
          }
        } else {
          staticCropStableFrameCount = 0;
        }
      }
      latestAutoFrameStats = {
        ...autoFrameTarget,
        crop: {
          sx: Number(currentCrop.sx.toFixed(2)),
          sy: Number(currentCrop.sy.toFixed(2)),
          sw: Number(currentCrop.sw.toFixed(2)),
          sh: Number(currentCrop.sh.toFixed(2)),
        },
        targetCrop: {
          sx: Number(autoFrameTarget.targetCrop.sx.toFixed(2)),
          sy: Number(autoFrameTarget.targetCrop.sy.toFixed(2)),
          sw: Number(autoFrameTarget.targetCrop.sw.toFixed(2)),
          sh: Number(autoFrameTarget.targetCrop.sh.toFixed(2)),
        },
        recenterCount: autoFrameRecenterCount,
        recentered: recenterRequested,
        lastRecenterAgeMs:
          lastAutoFrameRecenterAt > 0
            ? Math.round(performance.now() - lastAutoFrameRecenterAt)
            : null,
        staticCrop: getStaticCropStats(staticCropEligible, performance.now()),
      };
      const backgroundImageSource =
        needsSegmentation &&
        currentEffects.background !== "blur-light" &&
        currentEffects.background !== "blur-strong"
          ? getBackgroundImageSource(
              currentEffects.background,
              currentEffects.customBackgroundDataUrl,
              currentEffects.customBackgroundId,
            )
          : null;
      const backgroundImage = backgroundImageSource
        ? getLoadedBackgroundImage(
            currentEffects.background,
            currentEffects.customBackgroundDataUrl,
            currentEffects.customBackgroundId,
          )
        : null;
      if (
        backgroundImageSource &&
        !backgroundImage &&
        currentEffects.background !== "blur-light" &&
        currentEffects.background !== "blur-strong"
      ) {
        void loadBackgroundImage(
          currentEffects.background,
          debugId,
          currentEffects.customBackgroundDataUrl,
          currentEffects.customBackgroundId,
        );
      }
      const debugProbesEnabled = isVideoEffectsDebugEnabled();
      const probeBackgroundRender =
        debugProbesEnabled &&
        (effectsChangedThisFrame ||
          currentFrameSequence <= DEBUG_RENDER_PROBE_READY_FRAMES ||
          !latestBackgroundRenderStats.active ||
          currentFrameSequence % DEBUG_RENDER_PROBE_INTERVAL_FRAMES === 0);
      const probeFaceRender =
        debugProbesEnabled &&
        currentEffects.filter !== "none" &&
        (effectsChangedThisFrame ||
          currentFrameSequence <= DEBUG_RENDER_PROBE_READY_FRAMES ||
          !latestFaceFilterRenderStats.drawn ||
          currentFrameSequence % DEBUG_RENDER_PROBE_INTERVAL_FRAMES === 0);
      let lowLightSourceStats = createLowLightSourceFallback(
        sourceProbe,
        "disabled",
      );
      if (currentEffects.studioLighting) {
        const shouldRefreshLowLightSample =
          effectsChangedThisFrame ||
          !latestLowLightSourceStats.hasSegmentationMask ||
          latestSegmentationMaskAt > latestLowLightSourceStatsAt ||
          performance.now() - latestLowLightSourceStatsAt >=
            LOW_LIGHT_SAMPLE_INTERVAL_MS;
        if (shouldRefreshLowLightSample) {
          latestLowLightSourceStats = sampleLowLightSourceStats(
            frameSource.image,
            latestSegmentationMask,
            currentCrop,
            frameSource.width,
            frameSource.height,
            canvas.width,
            canvas.height,
            sourceProbe,
          );
          latestLowLightSourceStatsAt = performance.now();
        }
        lowLightSourceStats = latestLowLightSourceStats;
      } else {
        latestLowLightSourceStats = lowLightSourceStats;
        latestLowLightSourceStatsAt = performance.now();
      }
      const frameRenderStats = renderFrame(
        ctx,
        frameSource.image,
        frameSource.width,
        frameSource.height,
        canvas.width,
        canvas.height,
        currentEffects,
        currentEffects.filter !== "none"
          ? latestFaceFilterLandmarks ?? latestFaceLandmarks
          : latestFaceLandmarks,
        currentEffects.filter !== "none"
          ? latestFaceFilterPose ?? latestFacePose
          : latestFacePose,
        latestSegmentationMask,
        backgroundImage,
        { canvas: backgroundBlurCanvas, ctx: backgroundBlurCtx },
        proceduralBackgroundCache,
        currentCrop,
        sourceProbe,
        lowLightSourceStats,
        probeBackgroundRender,
        probeFaceRender,
        lowLightTransition,
        now,
      );
      latestFaceFilterRenderStats =
        !probeFaceRender &&
        frameRenderStats.faceFilter.drawn &&
        frameRenderStats.faceFilter.filter === latestFaceFilterRenderStats.filter &&
        latestFaceFilterRenderStats.changedPixels > 0
          ? {
              ...frameRenderStats.faceFilter,
              changedPixels: latestFaceFilterRenderStats.changedPixels,
              changedPixelRatio: latestFaceFilterRenderStats.changedPixelRatio,
              samplePixelCount: latestFaceFilterRenderStats.samplePixelCount,
              reason: "sample throttled",
            }
          : frameRenderStats.faceFilter;
      latestBackgroundRenderStats = frameRenderStats.background;
      latestLowLightRenderStats = frameRenderStats.lowLight;
      applyVisualEffectTransition(
        visualTransition,
        ctx,
        canvas.width,
        canvas.height,
        performance.now(),
      );
      latestVisualTransitionStats = getVisualEffectTransitionStats(
        visualTransition,
        performance.now(),
      );
      lastRenderedSegmentationMaskAt = latestSegmentationMaskAt;
      lastRenderedFaceLandmarksAt = latestFaceLandmarksAt;

      const shouldProbeOutputFrame =
        effectsChangedThisFrame ||
        currentFrameSequence <= OUTPUT_READY_FRAMES ||
        !outputTrackPublished ||
        !latestOutputProbe.visible ||
        blackOutputFrameCount > 0 ||
        currentFrameSequence % OUTPUT_VISIBILITY_PROBE_INTERVAL_FRAMES === 0;
      let outputProbe = latestOutputProbe;
      if (shouldProbeOutputFrame) {
        outputProbe = probeCanvasFrameVisibility(
          canvas,
          outputProbeCanvas,
          outputProbeCtx,
        );
        latestOutputProbe = outputProbe;
      }
      if (outputTrackPublished && !outputProbe.visible) {
        const restoredProbe = restoreLastVisibleOutputFrame(
          "rendered-output-dark",
          outputProbe,
        );
        if (restoredProbe?.visible) {
          outputProbe = restoredProbe;
          latestOutputProbe = restoredProbe;
        }
      }
      const waitingForSegmentationMask =
        needsSegmentation && !latestSegmentationMask;
      let outputDelivered = false;

      if (waitingForSegmentationMask) {
        visibleOutputFrameCount = 0;
        if (outputTrackPublished) {
          const restoredProbe = restoreLastVisibleOutputFrame(
            "waiting-for-segmentation-mask",
            outputProbe,
          );
          if (restoredProbe?.visible) {
            outputProbe = restoredProbe;
            latestOutputProbe = restoredProbe;
          }
        }
        outputDelivered = await deliverOutputFrame(now);
        latestOutputFrameVisible = outputDelivered && outputProbe.visible;
        if (
          currentFrameSequence <= OUTPUT_READY_FRAMES ||
          currentFrameSequence % OUTPUT_VISIBILITY_PROBE_INTERVAL_FRAMES === 0 ||
          !outputDelivered
        ) {
          logVideoEffects(debugId, "hold_output_until_segmentation_mask", {
            sourceProbe,
            outputProbe,
            frameSource: frameSource.source,
            outputDelivered,
            outputTrackPublished,
            outputMode,
            outputFramesWritten,
            canvas: { width: canvas.width, height: canvas.height },
            video: {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              paused: video.paused,
              ended: video.ended,
            },
            effects: getEffectsDebugSnapshot(currentEffects),
            sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
            hasSegmentationMask: Boolean(latestSegmentationMask),
          });
        }
        setRuntimeStatus("loading", null);
      } else {
        outputDelivered = await deliverOutputFrame(now);
        if (!outputDelivered) {
          visibleOutputFrameCount = 0;
          setRuntimeStatus(
            "degraded",
            "Effects output writer is unavailable; showing raw camera.",
          );
        } else {
          recordOutputProbeResult(
            outputProbe,
            sourceProbe,
            frameSource,
            currentEffects,
          );
          if (visibleOutputFrameCount >= OUTPUT_READY_FRAMES) {
            publishOutputTrack();
          }
          if (!outputProbe.visible) {
            warnVideoEffects(debugId, "dark_output_probe", {
              outputProbe,
              sourceProbe,
              frameSource: frameSource.source,
              blackOutputFrameCount,
              outputTrackPublished,
              outputMode,
              outputFramesWritten,
              canvas: { width: canvas.width, height: canvas.height },
              video: {
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                paused: video.paused,
                ended: video.ended,
              },
              effects: getEffectsDebugSnapshot(currentEffects),
              sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
              hasSegmentationMask: Boolean(latestSegmentationMask),
              hasFaceLandmarks: Boolean(latestFaceLandmarks?.length),
            });
          }
        }
      }
      if (latestEffectSwitchPending && latestEffectSwitchAt > 0) {
        const switchLatencyMs = Math.round(
          Math.max(0, performance.now() - latestEffectSwitchAt),
        );
        if (
          !waitingForSegmentationMask &&
          outputDelivered &&
          latestEffectSwitchFirstDeliveredLatencyMs === null
        ) {
          latestEffectSwitchFirstDeliveredLatencyMs = switchLatencyMs;
        }
        if (!waitingForSegmentationMask && outputDelivered && outputProbe.visible) {
          latestEffectSwitchFirstVisibleLatencyMs = switchLatencyMs;
          latestEffectSwitchPending = false;
          logVideoEffects(debugId, "effect_switch_visible_output", {
            sequence: latestEffectSwitchSequence,
            reason: latestEffectSwitchReason,
            firstDeliveredLatencyMs: latestEffectSwitchFirstDeliveredLatencyMs,
            firstVisibleLatencyMs: latestEffectSwitchFirstVisibleLatencyMs,
            outputMode,
            outputFramesWritten,
            outputProbe,
            processingConfigId,
            modelProcessingConfigId,
          });
        }
      }
      latestFramePipelineStats = {
        id: currentFrameSequence,
        processingConfigId,
        source: frameSource.source,
        width: frameSource.width,
        height: frameSource.height,
        outputWidth: canvas.width,
        outputHeight: canvas.height,
        outputScale: Number(outputCanvasSize.scale.toFixed(3)),
        sourceVisible: sourceProbe.visible,
        outputVisible: outputProbe.visible,
        outputDelivered,
        renderLatencyMs: Math.round(Math.max(0, performance.now() - loopStartedAt)),
        segmentationMaskAgeMs:
          latestSegmentationMaskAt > 0
            ? Math.round(performance.now() - latestSegmentationMaskAt)
            : null,
        faceLandmarksAgeMs:
          latestFaceLandmarksAt > 0
            ? Math.round(performance.now() - latestFaceLandmarksAt)
            : null,
        firstFrame,
      };
      publishFrameMetadata(
        now,
        frameSource,
        videoFrameMetadata,
        currentEffects,
        latestAutoFrameStats,
      );

      const segmentationUsingLegacy =
        needsSegmentation && tasksSegmenterFailed && !legacySegmentationFailed;
      const faceUsingLegacy =
        needsFace && tasksFaceLandmarkerFailed && !legacyFaceMeshFailed;
      const segmentationUnavailable =
        needsSegmentation && legacySegmentationFailed;
      const faceUnavailable = needsFace && legacyFaceMeshFailed;
      const faceReady = !needsFace || latestFaceResultAt > 0 || faceUnavailable;

      if (
        (!needsSegmentation || latestSegmentationMask || segmentationUnavailable) &&
        faceReady
      ) {
        setRuntimeStatus(
          segmentationUsingLegacy ||
            faceUsingLegacy ||
            segmentationUnavailable ||
            faceUnavailable
            ? "degraded"
            : "running",
          segmentationUnavailable
            ? "Background segmentation is unavailable."
            : faceUnavailable
              ? "Face tracking is unavailable."
              : segmentationUsingLegacy || faceUsingLegacy
                ? "MediaPipe Tasks is unavailable; using MediaPipe solution fallback."
                : null,
        );
      }

      latestLoopProcessingDelayMs = Math.max(
        0,
        performance.now() - loopStartedAt,
      );
      latestLoopFullProcessingDelayMs = Math.max(
        latestLoopProcessingDelayMs,
        latestSegmentationProcessingMs,
        latestFaceProcessingMs,
      );
      const adaptationSampleNow = performance.now();
      recordRuntimePipelinePressure(adaptationSampleNow);
      recordVideoEffectsFrameProcessing(
        adaptationState,
        {
          processingDelayMs: latestLoopProcessingDelayMs,
          fullProcessingDelayMs: latestLoopFullProcessingDelayMs,
          frameIntervalMs: latestFrameIntervalMs,
        },
        adaptationSampleNow,
        getAdaptationRecordOptions(adaptationSampleNow),
      );

      if (now - lastStatsLogAt >= 1000) {
        const statsNow = performance.now();
        const latestSegmentationMaskAgeMs =
          latestSegmentationMaskAt > 0
            ? Math.round(statsNow - latestSegmentationMaskAt)
            : null;
        const latestFaceLandmarksAgeMs =
          latestFaceLandmarksAt > 0
            ? Math.round(statsNow - latestFaceLandmarksAt)
            : null;
        const latestFaceFilterLandmarksAgeMs =
          latestFaceFilterLandmarksAt > 0
            ? Math.round(statsNow - latestFaceFilterLandmarksAt)
            : null;
        const latestFaceResultAgeMs =
          latestFaceResultAt > 0
            ? Math.round(statsNow - latestFaceResultAt)
            : null;
        const latestOutputFrameAgeMs =
          latestOutputFrameAt > 0
            ? Math.round(statsNow - latestOutputFrameAt)
            : null;
        const oldestOutputWriterPendingAgeMs =
          getOldestOutputWriterPendingAgeMs(statsNow);
        const outputReady =
          visibleOutputFrameCount >= OUTPUT_READY_FRAMES &&
          (outputMode !== "track-generator" ||
            outputFramesWritten >= OUTPUT_READY_FRAMES);
        const temporalMask: TemporalMaskStats = {
          enabled:
            temporalMaskSource === "tasks-confidence" ||
            temporalMaskSource === "tasks-category",
          alpha: MASK_TEMPORAL_ALPHA,
          confidenceFloor: MASK_CONFIDENCE_FLOOR,
          confidenceCeiling: MASK_CONFIDENCE_CEILING,
          confidenceGamma: MASK_CONFIDENCE_GAMMA,
          frameCount: temporalMaskFrameCount,
          shapeFrameCount: temporalMaskShapeFrameCount,
          smoothedFrameCount: temporalMaskSmoothedFrameCount,
          resetCount: temporalMaskResetCount,
          source: temporalMaskSource,
          pixelCount: temporalMaskPixelCount,
          canvas: {
            width: maskCanvas.width,
            height: maskCanvas.height,
            scratchWidth: maskScratchCanvas.width,
            scratchHeight: maskScratchCanvas.height,
          },
          latestAgeMs: latestSegmentationMaskAgeMs,
          hasHistory: Boolean(maskAlphaHistory),
        };
        const framePipeline: FramePipelineStats = {
          processor:
            outputWriterMode === "worker"
              ? "main-thread-worker-renderer"
              : "main-thread",
          targetFps: TARGET_FPS,
          processingConfigId,
          modelProcessingConfigId,
          schedulerMode,
          framePoller: {
            mode:
              schedulerMode === "video-frame"
                ? "requestVideoFrameCallback"
                : schedulerMode === "track-processor"
                  ? "track-processor"
                  : "timer",
            callbackCount: videoFrameCallbackCount,
            timerPollCount,
            duplicateFrameSkipCount,
            watchdogFallbackCount: videoFrameWatchdogFallbackCount,
            scheduleFailureCount: videoFrameScheduleFailureCount,
            lastMetadata: getVideoFrameMetadataSnapshot(
              latestVideoFrameMetadata,
            ),
            lastFrameKey: latestVideoFrameKey,
            lastProcessedFrameKey: lastProcessedVideoFrameKey,
            lastDuplicateFrameKey: lastDuplicateVideoFrameKey,
            currentTime: Number.isFinite(video.currentTime)
              ? Number(video.currentTime.toFixed(6))
              : null,
          },
          outputWriter: {
            mode: outputWriterMode,
            workerSupported: outputWriterWorkerSupported,
            workerReady: outputWriterWorkerReady,
            workerHasVideoFrame: outputWriterWorkerHasVideoFrame,
            workerHasWritableStream: outputWriterWorkerHasWritableStream,
            workerHasOffscreenCanvas: outputWriterWorkerHasOffscreenCanvas,
            workerRenderer: outputWriterWorkerRenderer,
            workerInputMode: outputWriterInputMode,
            workerVideoFrameUnsupported: outputWriterVideoFrameUnsupported,
            workerPendingFrameCount: outputWriterPendingFrames.size,
            workerPendingFrameLimit: outputWriterPendingFrameLimit,
            workerOldestPendingFrameAgeMs:
              oldestOutputWriterPendingAgeMs === null
                ? null
                : Number(oldestOutputWriterPendingAgeMs.toFixed(2)),
            workerFramesSent: outputWriterFramesSent,
            workerFramesWritten: outputWriterFramesWritten,
            workerFramesDropped: outputWriterFramesDropped,
            workerFrameMetadataCount: outputWriterFrameMetadataCount,
            workerFirstFrameSeen: outputWriterFirstFrameSeen,
            workerSkipCount: outputWriterSkipCount,
            workerBackpressureSkipCount: outputWriterBackpressureSkipCount,
            workerCadenceSkipCount: outputWriterCadenceSkipCount,
            workerUnavailableSkipCount: outputWriterUnavailableSkipCount,
            workerWriteFailures: outputWriterWriteFailures,
            workerPostFailures: outputWriterPostFailures,
            latestSkipReason: latestOutputWriterSkipReason,
            latestWorkerWriteMs:
              latestOutputWriterWriteMs === null
                ? null
                : Number(latestOutputWriterWriteMs.toFixed(2)),
            latestWorkerBackpressureMs:
              latestOutputWriterBackpressureMs === null
                ? null
                : Number(latestOutputWriterBackpressureMs.toFixed(2)),
            latestWorkerRoundTripMs:
              latestOutputWriterRoundTripMs === null
                ? null
                : Number(latestOutputWriterRoundTripMs.toFixed(2)),
            latestWorkerFrameBuildMs:
              latestOutputWriterFrameBuildMs === null
                ? null
                : Number(latestOutputWriterFrameBuildMs.toFixed(2)),
            averageWorkerFrameBuildMs:
              outputWriterFrameBuildSampleCount <= 0
                ? null
                : Number(
                    (
                      totalOutputWriterFrameBuildMs /
                      outputWriterFrameBuildSampleCount
                    ).toFixed(2),
                  ),
            maxWorkerFrameBuildMs:
              outputWriterFrameBuildSampleCount <= 0
                ? null
                : Number(maxOutputWriterFrameBuildMs.toFixed(2)),
            workerFrameBuildSampleCount: outputWriterFrameBuildSampleCount,
            latestWorkerSequence: outputWriterSequence,
            latestWorkerAckSequence: outputWriterAckSequence,
            latestWorkerFrameMetadata: latestOutputWriterFrameMetadata,
            fallbackReason: outputWriterFallbackReason,
            lastError: outputWriterLastError,
          },
          segmentationProcessor: {
            mode: segmentationProcessorMode,
            workerSupported: segmentationProcessorWorkerSupported,
            workerReady: segmentationProcessorWorkerReady,
            workerDelegate: segmentationProcessorWorkerDelegate,
            workerPendingFrameCount: segmentationProcessorPendingFrames.size,
            workerFramesSent: segmentationProcessorWorkerFramesSent,
            workerResults: segmentationProcessorWorkerResults,
            workerStaleResults: segmentationProcessorWorkerStaleResults,
            workerFailures: segmentationProcessorWorkerFailures,
            workerFirstResultSeen: segmentationProcessorWorkerFirstResultSeen,
            latestWorkerSequence: segmentationProcessorWorkerSequence,
            latestWorkerAckSequence: segmentationProcessorWorkerAckSequence,
            latestWorkerProcessingMs:
              latestSegmentationProcessorWorkerProcessingMs === null
                ? null
                : Number(
                    latestSegmentationProcessorWorkerProcessingMs.toFixed(2),
                  ),
            latestWorkerRoundTripMs:
              latestSegmentationProcessorWorkerRoundTripMs === null
                ? null
                : Number(
                    latestSegmentationProcessorWorkerRoundTripMs.toFixed(2),
                  ),
            latestWorkerResult: latestSegmentationProcessorWorkerResult,
            fallbackReason: segmentationProcessorFallbackReason,
            lastError: segmentationProcessorLastError,
          },
          faceProcessor: {
            mode: faceProcessorMode,
            workerSupported: faceProcessorWorkerSupported,
            workerReady: faceProcessorWorkerReady,
            workerDelegate: faceProcessorWorkerDelegate,
            workerPendingFrameCount: faceProcessorPendingFrames.size,
            workerFramesSent: faceProcessorWorkerFramesSent,
            workerResults: faceProcessorWorkerResults,
            workerStaleResults: faceProcessorWorkerStaleResults,
            workerFailures: faceProcessorWorkerFailures,
            workerFirstResultSeen: faceProcessorWorkerFirstResultSeen,
            latestWorkerSequence: faceProcessorWorkerSequence,
            latestWorkerAckSequence: faceProcessorWorkerAckSequence,
            latestWorkerProcessingMs:
              latestFaceProcessorWorkerProcessingMs === null
                ? null
                : Number(latestFaceProcessorWorkerProcessingMs.toFixed(2)),
            latestWorkerRoundTripMs:
              latestFaceProcessorWorkerRoundTripMs === null
                ? null
                : Number(latestFaceProcessorWorkerRoundTripMs.toFixed(2)),
            latestWorkerResult: latestFaceProcessorWorkerResult,
            fallbackReason: faceProcessorFallbackReason,
            lastError: faceProcessorLastError,
          },
          outputMode,
          frameSequence,
          outputFrameSequence,
          outputFramesWritten,
          outputReady,
          outputTrackPublished,
          lastVisibleOutputFrameAgeMs:
            latestVisibleOutputFrameAt > 0
              ? Math.round(statsNow - latestVisibleOutputFrameAt)
              : null,
          lastVisibleOutputRecoveryCount,
          latestLastVisibleOutputRecoveryReason,
          firstSourceFrameAgeMs:
            firstSourceFrameAt > 0
              ? Math.round(statsNow - firstSourceFrameAt)
              : null,
          firstOutputFrameAgeMs:
            firstOutputFrameAt > 0
              ? Math.round(statsNow - firstOutputFrameAt)
              : null,
          firstVisibleOutputFrameAgeMs:
            firstVisibleOutputFrameAt > 0
              ? Math.round(statsNow - firstVisibleOutputFrameAt)
              : null,
          firstPublishedTrackAgeMs:
            firstPublishedTrackAt > 0
              ? Math.round(statsNow - firstPublishedTrackAt)
              : null,
          lastFrame: latestFramePipelineStats,
          sourceFrame: {
            selection: latestSourceFrameSelection,
            fallbackReason: latestSourceFrameFallbackReason,
            blackSourceVideoFrameCount,
            fallbackCount: sourceFrameFallbackCount,
            latestVideoProbe: latestVideoSourceProbe,
            trackProcessor: {
              started: trackProcessorStarted,
              unavailable: trackProcessorUnavailable,
              frameCount: trackProcessorFrameCount,
              restartCount: trackProcessorRestartCount,
              latestFrameAgeMs:
                latestTrackProcessorFrameAt > 0
                  ? Math.round(statsNow - latestTrackProcessorFrameAt)
                  : null,
            },
          },
        };
        const effectiveFaceIntervalMs =
          staticCropActive && currentEffects.filter === "none"
            ? Math.max(faceIntervalMs, STATIC_CROP_FACE_REVALIDATION_INTERVAL_MS)
            : faceIntervalMs;
        const adaptationStats = getVideoEffectsAdaptationStats(
          adaptationState,
          {
            targetSegmentationIntervalMs: segmentationIntervalMs,
            targetFaceIntervalMs: effectiveFaceIntervalMs,
            lastSegmentationProcessingMs: latestSegmentationProcessingMs,
            lastFaceProcessingMs: latestFaceProcessingMs,
            roomTilingPolicyContext,
            now: statsNow,
          },
        );
        const effectSwitchLatency: EffectSwitchLatencyStats = {
          sequence: latestEffectSwitchSequence,
          pending: latestEffectSwitchPending,
          reason: latestEffectSwitchReason,
          sinceMs:
            latestEffectSwitchAt > 0
              ? Math.round(Math.max(0, statsNow - latestEffectSwitchAt))
              : null,
          firstDeliveredLatencyMs: latestEffectSwitchFirstDeliveredLatencyMs,
          firstVisibleLatencyMs: latestEffectSwitchFirstVisibleLatencyMs,
        };
        const frameStats = {
          elapsedMs: Math.round(now - lastStatsLogAt),
          renderedFrames,
          taskSegmentationRuns,
          legacySegmentationRuns,
          taskFaceRuns,
          legacyFaceRuns,
          cooperativeSegmentationDispatches,
          cooperativeFaceDispatches,
          maskUpdates,
          maskMisses,
          closedSegmentationMasks,
          needsSegmentation,
          needsFace,
          hasSegmentationMask: Boolean(latestSegmentationMask),
          faceLandmarkCount: latestFaceLandmarks?.length ?? 0,
          faceFilterLandmarkCount: latestFaceFilterLandmarks?.length ?? 0,
          faceDetection: {
            consecutiveNoResultCount: consecutiveFaceNoResultCount,
            noResultBackoffActive: latestFaceNoResultBackoffActive,
            noResultBackoffReason: latestFaceNoResultBackoffReason,
            noResultBackoffIntervalMs: latestFaceNoResultBackoffIntervalMs,
            poseCandidateCount: latestFacePose?.candidates.length ?? 0,
            filterPoseCandidateCount:
              latestFaceFilterPose?.candidates.length ?? 0,
            landmarkSmoothing: latestFaceLandmarkSmoothingStats,
            filterLandmarkSmoothing: latestFaceFilterLandmarkSmoothingStats,
          },
          faceFilterRender: latestFaceFilterRenderStats,
          backgroundRender: latestBackgroundRenderStats,
          lowLightRender: latestLowLightRenderStats,
          visualTransition: latestVisualTransitionStats,
          effectSwitchLatency,
          autoFrame: latestAutoFrameStats,
          adaptation: adaptationStats,
          temporalMask,
          frameMetadata: latestFrameMetadata,
          framePipeline,
          latestSegmentationMaskAgeMs,
          latestFaceLandmarksAgeMs,
          latestFaceFilterLandmarksAgeMs,
          latestFaceResultAgeMs,
          nextModelDispatchKind,
          outputTrackPublished,
          visibleOutputFrameCount,
          blackOutputFrameCount,
          frameSource: frameSource.source,
          schedulerMode,
          outputMode,
          outputFramesWritten,
          outputGeneratorFailed,
          latestOutputFrameAgeMs,
          latestOutputFrameVisible,
          outputProbe,
          intervals: {
            segmentationIntervalMs,
            faceIntervalMs: effectiveFaceIntervalMs,
          },
          failures: {
            tasksSegmenterFailed,
            legacySegmentationFailed,
            tasksFaceLandmarkerFailed,
            legacyFaceMeshFailed,
          },
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          outputTrack: getTrackDebugSnapshot(track),
          video: {
            readyState: video.readyState,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            paused: video.paused,
            ended: video.ended,
          },
          canvas: { width: canvas.width, height: canvas.height },
          effects: getEffectsDebugSnapshot(currentEffects),
          meetVideoPipe: {
            active: meetVideoPipeActive,
            mode: "gate",
            gate: meetVideoPipeGate,
          },
        };
        const compactFramePipeline = {
          processor: framePipeline.processor,
          targetFps: framePipeline.targetFps,
          processingConfigId: framePipeline.processingConfigId,
          modelProcessingConfigId: framePipeline.modelProcessingConfigId,
          schedulerMode: framePipeline.schedulerMode,
          outputMode: framePipeline.outputMode,
          frameSequence: framePipeline.frameSequence,
          outputFrameSequence: framePipeline.outputFrameSequence,
          outputFramesWritten: framePipeline.outputFramesWritten,
          outputReady: framePipeline.outputReady,
          outputTrackPublished: framePipeline.outputTrackPublished,
          lastVisibleOutputFrameAgeMs: framePipeline.lastVisibleOutputFrameAgeMs,
          firstSourceFrameAgeMs: framePipeline.firstSourceFrameAgeMs,
          firstOutputFrameAgeMs: framePipeline.firstOutputFrameAgeMs,
          firstVisibleOutputFrameAgeMs:
            framePipeline.firstVisibleOutputFrameAgeMs,
          firstPublishedTrackAgeMs: framePipeline.firstPublishedTrackAgeMs,
          outputWriter: {
            mode: framePipeline.outputWriter.mode,
            workerSupported: framePipeline.outputWriter.workerSupported,
            workerReady: framePipeline.outputWriter.workerReady,
            workerInputMode: framePipeline.outputWriter.workerInputMode,
            workerPendingFrameCount:
              framePipeline.outputWriter.workerPendingFrameCount,
            workerPendingFrameLimit:
              framePipeline.outputWriter.workerPendingFrameLimit,
            workerOldestPendingFrameAgeMs:
              framePipeline.outputWriter.workerOldestPendingFrameAgeMs,
            workerFramesSent: framePipeline.outputWriter.workerFramesSent,
            workerFramesWritten: framePipeline.outputWriter.workerFramesWritten,
            workerFramesDropped: framePipeline.outputWriter.workerFramesDropped,
            workerSkipCount: framePipeline.outputWriter.workerSkipCount,
            workerBackpressureSkipCount:
              framePipeline.outputWriter.workerBackpressureSkipCount,
            workerCadenceSkipCount:
              framePipeline.outputWriter.workerCadenceSkipCount,
            workerUnavailableSkipCount:
              framePipeline.outputWriter.workerUnavailableSkipCount,
            workerWriteFailures:
              framePipeline.outputWriter.workerWriteFailures,
            workerPostFailures: framePipeline.outputWriter.workerPostFailures,
            latestSkipReason: framePipeline.outputWriter.latestSkipReason,
            latestWorkerWriteMs:
              framePipeline.outputWriter.latestWorkerWriteMs,
            latestWorkerBackpressureMs:
              framePipeline.outputWriter.latestWorkerBackpressureMs,
            latestWorkerRoundTripMs:
              framePipeline.outputWriter.latestWorkerRoundTripMs,
            latestWorkerFrameBuildMs:
              framePipeline.outputWriter.latestWorkerFrameBuildMs,
            averageWorkerFrameBuildMs:
              framePipeline.outputWriter.averageWorkerFrameBuildMs,
            maxWorkerFrameBuildMs:
              framePipeline.outputWriter.maxWorkerFrameBuildMs,
            latestWorkerSequence:
              framePipeline.outputWriter.latestWorkerSequence,
            latestWorkerAckSequence:
              framePipeline.outputWriter.latestWorkerAckSequence,
            fallbackReason: framePipeline.outputWriter.fallbackReason,
            lastError: framePipeline.outputWriter.lastError,
          },
          segmentationProcessor: {
            mode: framePipeline.segmentationProcessor.mode,
            workerSupported:
              framePipeline.segmentationProcessor.workerSupported,
            workerReady: framePipeline.segmentationProcessor.workerReady,
            workerDelegate: framePipeline.segmentationProcessor.workerDelegate,
            workerPendingFrameCount:
              framePipeline.segmentationProcessor.workerPendingFrameCount,
            workerFramesSent:
              framePipeline.segmentationProcessor.workerFramesSent,
            workerResults: framePipeline.segmentationProcessor.workerResults,
            workerStaleResults:
              framePipeline.segmentationProcessor.workerStaleResults,
            workerFailures: framePipeline.segmentationProcessor.workerFailures,
            workerFirstResultSeen:
              framePipeline.segmentationProcessor.workerFirstResultSeen,
            latestWorkerSequence:
              framePipeline.segmentationProcessor.latestWorkerSequence,
            latestWorkerAckSequence:
              framePipeline.segmentationProcessor.latestWorkerAckSequence,
            latestWorkerProcessingMs:
              framePipeline.segmentationProcessor.latestWorkerProcessingMs,
            latestWorkerRoundTripMs:
              framePipeline.segmentationProcessor.latestWorkerRoundTripMs,
            latestWorkerResult:
              framePipeline.segmentationProcessor.latestWorkerResult === null
                ? null
                : {
                    sequence:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .sequence,
                    processingConfigId:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .processingConfigId,
                    width:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .width,
                    height:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .height,
                    delegate:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .delegate,
                    inputSource:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .inputSource,
                    source:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .source,
                    hasCategoryMask:
                      framePipeline.segmentationProcessor.latestWorkerResult
                        .hasCategoryMask,
                  },
            fallbackReason:
              framePipeline.segmentationProcessor.fallbackReason,
            lastError: framePipeline.segmentationProcessor.lastError,
          },
          faceProcessor: {
            mode: framePipeline.faceProcessor.mode,
            workerSupported: framePipeline.faceProcessor.workerSupported,
            workerReady: framePipeline.faceProcessor.workerReady,
            workerDelegate: framePipeline.faceProcessor.workerDelegate,
            workerPendingFrameCount:
              framePipeline.faceProcessor.workerPendingFrameCount,
            workerFramesSent: framePipeline.faceProcessor.workerFramesSent,
            workerResults: framePipeline.faceProcessor.workerResults,
            workerStaleResults:
              framePipeline.faceProcessor.workerStaleResults,
            workerFailures: framePipeline.faceProcessor.workerFailures,
            workerFirstResultSeen:
              framePipeline.faceProcessor.workerFirstResultSeen,
            latestWorkerSequence:
              framePipeline.faceProcessor.latestWorkerSequence,
            latestWorkerAckSequence:
              framePipeline.faceProcessor.latestWorkerAckSequence,
            latestWorkerProcessingMs:
              framePipeline.faceProcessor.latestWorkerProcessingMs,
            latestWorkerRoundTripMs:
              framePipeline.faceProcessor.latestWorkerRoundTripMs,
            latestWorkerResult:
              framePipeline.faceProcessor.latestWorkerResult === null
                ? null
                : {
                    sequence:
                      framePipeline.faceProcessor.latestWorkerResult.sequence,
                    processingConfigId:
                      framePipeline.faceProcessor.latestWorkerResult
                        .processingConfigId,
                    faceCount:
                      framePipeline.faceProcessor.latestWorkerResult.faceCount,
                    landmarkCount:
                      framePipeline.faceProcessor.latestWorkerResult
                        .landmarkCount,
                    blendshapeCount:
                      framePipeline.faceProcessor.latestWorkerResult
                        .blendshapeCount,
                    matrixCount:
                      framePipeline.faceProcessor.latestWorkerResult
                        .matrixCount,
                    width: framePipeline.faceProcessor.latestWorkerResult.width,
                    height:
                      framePipeline.faceProcessor.latestWorkerResult.height,
                    delegate:
                      framePipeline.faceProcessor.latestWorkerResult.delegate,
                    inputSource:
                      framePipeline.faceProcessor.latestWorkerResult
                        .inputSource,
                  },
            fallbackReason: framePipeline.faceProcessor.fallbackReason,
            lastError: framePipeline.faceProcessor.lastError,
          },
          sourceFrame: framePipeline.sourceFrame,
          lastFrame: framePipeline.lastFrame,
        };
        const compactDebugStats: VideoEffectsDebugStats = {
          needsSegmentation,
          needsFace,
          frameSource: frameSource.source,
          schedulerMode,
          outputTrackPublished,
          outputMode,
          outputFramesWritten,
          renderedFrames,
          taskSegmentationRuns,
          taskFaceRuns,
          closedSegmentationMasks,
          faceLandmarkCount: latestFaceLandmarks?.length ?? 0,
          faceFilterLandmarkCount: latestFaceFilterLandmarks?.length ?? 0,
          faceDetection: {
            consecutiveNoResultCount: consecutiveFaceNoResultCount,
            noResultBackoffActive: latestFaceNoResultBackoffActive,
            noResultBackoffReason: latestFaceNoResultBackoffReason,
            noResultBackoffIntervalMs: latestFaceNoResultBackoffIntervalMs,
            poseCandidateCount: latestFacePose?.candidates.length ?? 0,
            filterPoseCandidateCount:
              latestFaceFilterPose?.candidates.length ?? 0,
            landmarkSmoothing: latestFaceLandmarkSmoothingStats,
            filterLandmarkSmoothing: latestFaceFilterLandmarkSmoothingStats,
          },
          faceFilterRender: latestFaceFilterRenderStats,
          backgroundRender: latestBackgroundRenderStats,
          lowLightRender: latestLowLightRenderStats,
          visualTransition: latestVisualTransitionStats,
          effectSwitchLatency,
          autoFrame: latestAutoFrameStats,
          adaptation: adaptationStats,
          temporalMask: {
            enabled: temporalMask.enabled,
            frameCount: temporalMask.frameCount,
            smoothedFrameCount: temporalMask.smoothedFrameCount,
            resetCount: temporalMask.resetCount,
            source: temporalMask.source,
            latestAgeMs: temporalMask.latestAgeMs,
            hasHistory: temporalMask.hasHistory,
          },
          frameMetadata: latestFrameMetadata,
          framePipeline: compactFramePipeline,
          effects: getEffectsDebugSnapshot(currentEffects),
          meetVideoPipe: {
            active: meetVideoPipeActive,
            mode: "gate",
            gate: meetVideoPipeGate,
          },
          latestSegmentationMaskAgeMs,
          latestFaceLandmarksAgeMs,
          latestFaceFilterLandmarksAgeMs,
          latestOutputFrameVisible,
          blackOutputFrameCount,
          intervals: {
            segmentationIntervalMs,
            faceIntervalMs: effectiveFaceIntervalMs,
          },
          failures: {
            tasksSegmenterFailed,
            legacySegmentationFailed,
            tasksFaceLandmarkerFailed,
            legacyFaceMeshFailed,
          },
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
          outputTrack: getTrackDebugSnapshot(track),
        };
        logVideoEffects(debugId, "frame_stats", frameStats);
        setDebugStats(
          isVideoEffectsDebugEnabled() ? frameStats : compactDebugStats,
        );
        type VideoEffectsStatsWindow = typeof window & {
          __conclaveVideoEffectsStats?: Record<number, typeof frameStats>;
        };
        const debugWindow = window as VideoEffectsStatsWindow;
        debugWindow.__conclaveVideoEffectsStats = {
          ...debugWindow.__conclaveVideoEffectsStats,
          [debugId]: frameStats,
        };
        renderedFrames = 0;
        taskSegmentationRuns = 0;
        legacySegmentationRuns = 0;
        taskFaceRuns = 0;
        legacyFaceRuns = 0;
        cooperativeSegmentationDispatches = 0;
        cooperativeFaceDispatches = 0;
        maskUpdates = 0;
        maskMisses = 0;
        closedSegmentationMasks = 0;
        lastStatsLogAt = now;
      }
      schedule();
    };

    const clearScheduledFramePoll = () => {
      const hadPendingLoopTimer = loopTimerId !== null;
      const hadPendingVideoFrame =
        videoFrameCallbackId !== null || videoFrameWatchdogTimerId !== null;

      if (loopTimerId !== null) {
        window.clearTimeout(loopTimerId);
        loopTimerId = null;
      }
      if (hadPendingVideoFrame) {
        scheduledVideoFrameToken += 1;
        if (
          videoFrameCallbackId !== null &&
          typeof video.cancelVideoFrameCallback === "function"
        ) {
          try {
            video.cancelVideoFrameCallback(videoFrameCallbackId);
          } catch {}
        }
        videoFrameCallbackId = null;
        clearVideoFrameWatchdog();
      }

      return {
        hadPendingLoopTimer,
        hadPendingVideoFrame,
      };
    };

    const scheduleEffectChangeFramePump = (
      reason: string,
      pumpNow = performance.now(),
      pendingPollState = {
        hadPendingLoopTimer: false,
        hadPendingVideoFrame: false,
      },
    ) => {
      if (effectChangeFramePumpTimerId !== null) return;

      logVideoEffects(debugId, "effect_change_frame_pump", {
        reason,
        hadPendingLoopTimer: pendingPollState.hadPendingLoopTimer,
        hadPendingVideoFrame: pendingPollState.hadPendingVideoFrame,
        drainFramesRemaining: effectChangeFramePumpDrainFramesRemaining,
        pumpWindowMs: Math.round(
          Math.max(0, externalEffectChangePumpUntilRef.current - pumpNow),
        ),
      });
      const scheduledGeneration = effectChangeFramePumpGeneration;
      effectChangeFramePumpTimerId = window.setTimeout(() => {
        effectChangeFramePumpTimerId = null;
        if (cancelled) return;
        schedulerMode = "timer";
        timerPollCount += 1;
        latestVideoFrameMetadata = null;
        void (async () => {
          try {
            await loop(performance.now());
          } catch (err) {
            warnVideoEffects(debugId, "effect_change_frame_pump_failed", {
              reason,
              error: getErrorDebugSnapshot(err),
            });
          } finally {
            if (cancelled || effectChangeFramePumpTimerId !== null) return;
            const followUpNeeded =
              effectChangeFramePumpGeneration !== scheduledGeneration ||
              latestEffectSwitchPending;
            if (
              !followUpNeeded ||
              effectChangeFramePumpDrainFramesRemaining <= 0
            ) {
              return;
            }

            effectChangeFramePumpDrainFramesRemaining -= 1;
            const followUpNow = performance.now();
            const followUpPendingPollState = clearScheduledFramePoll();
            logVideoEffects(debugId, "effect_change_frame_pump_follow_up", {
              reason,
              scheduledGeneration,
              currentGeneration: effectChangeFramePumpGeneration,
              latestEffectSwitchPending,
              drainFramesRemaining: effectChangeFramePumpDrainFramesRemaining,
            });
            scheduleEffectChangeFramePump(
              "effect-change-drain",
              followUpNow,
              followUpPendingPollState,
            );
          }
        })();
      }, 0);
    };

    const pumpEffectChangeFrame = (reason: string) => {
      if (cancelled || sourceVideoTrack.readyState !== "live") return;
      const pumpNow = performance.now();
      effectChangeFramePumpGeneration += 1;
      effectChangeFramePumpDrainFramesRemaining =
        VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_DRAIN_FRAMES;
      externalEffectChangePumpUntilRef.current = Math.max(
        externalEffectChangePumpUntilRef.current,
        pumpNow + VIDEO_FRAME_CALLBACK_EFFECT_CHANGE_PUMP_MS,
      );
      const processorNeeds = getRuntimeProcessorNeeds(effectsRef.current);
      if (processorNeeds.needsSegmentation && !segmentationInFlight) {
        lastSegmentationAt = 0;
      }
      if (processorNeeds.needsFace && !faceMeshInFlight) {
        lastFaceAt = 0;
      }

      const pendingPollState = clearScheduledFramePoll();
      if (effectChangeFramePumpTimerId !== null) {
        logVideoEffects(debugId, "effect_change_frame_pump_coalesced", {
          reason,
          generation: effectChangeFramePumpGeneration,
          drainFramesRemaining: effectChangeFramePumpDrainFramesRemaining,
        });
        return;
      }

      scheduleEffectChangeFramePump(reason, pumpNow, pendingPollState);
    };

    effectChangeFramePumpRef.current = pumpEffectChangeFrame;

    startTrackProcessor();
    schedule();

    video
      .play()
      .then(() => {
        if (!cancelled) {
          logVideoEffects(debugId, "hidden_video_play_started", {
            video: {
              readyState: video.readyState,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              paused: video.paused,
            },
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        warnVideoEffects(debugId, "hidden_video_play_failed", {
          error: getErrorDebugSnapshot(err),
          sourceTrack: getTrackDebugSnapshot(sourceVideoTrack),
        });
      });

    return () => {
      cancelled = true;
      activeVideoEffectsPipelineCount = Math.max(
        0,
        activeVideoEffectsPipelineCount - 1,
      );
      markVideoEffectsPipelineBusy();
      logVideoEffects(debugId, "processor_cleanup", {
        activePipelineCount: activeVideoEffectsPipelineCount,
        outputTrackPublished,
        outputMode,
        outputWriterMode,
        outputWriterFramesSent,
        outputWriterFramesWritten,
        outputWriterWriteFailures,
        outputFramesWritten,
        outputGeneratorFailed,
        sourceVideoTrack: getTrackDebugSnapshot(sourceVideoTrack),
        outputTrack: getTrackDebugSnapshot(track),
      });
      if (
        window.__conclaveGetVideoEffectsFrameMetadataDebug ===
        getFrameMetadataSnapshot
      ) {
        delete window.__conclaveGetVideoEffectsFrameMetadataDebug;
      }
      delete window.__conclaveVideoEffectsFrameMetadataDebug;
      if (effectChangeFramePumpRef.current === pumpEffectChangeFrame) {
        effectChangeFramePumpRef.current = null;
      }
      if (effectChangeFramePumpTimerId !== null) {
        window.clearTimeout(effectChangeFramePumpTimerId);
        effectChangeFramePumpTimerId = null;
      }
      if (loopTimerId !== null) {
        window.clearTimeout(loopTimerId);
        loopTimerId = null;
      }
      scheduledVideoFrameToken += 1;
      if (
        videoFrameCallbackId !== null &&
        typeof video.cancelVideoFrameCallback === "function"
      ) {
        try {
          video.cancelVideoFrameCallback(videoFrameCallbackId);
        } catch {}
      }
      videoFrameCallbackId = null;
      clearVideoFrameWatchdog();
      sourceVideoTrack.removeEventListener("mute", handleSourceMute);
      sourceVideoTrack.removeEventListener("unmute", handleSourceUnmute);
      sourceVideoTrack.removeEventListener("ended", handleSourceEnded);
      track.removeEventListener("mute", handleOutputMute);
      track.removeEventListener("unmute", handleOutputUnmute);
      track.removeEventListener("ended", handleOutputEnded);
      const retainOutputTrack =
        finalTrackOwnerRef.current === "local" &&
        shouldRetainProcessedTrackForTransition(track);
      const retainedOutputWriterWorker = retainOutputTrack
        ? outputWriterWorker
        : null;
      const retainedOutputGeneratorWriter = retainOutputTrack
        ? outputGeneratorWriter
        : null;
      const cleanupRetainedOutputWriterResources = () => {
        if (retainedOutputWriterWorker) {
          closeWorkerAfterGrace(
            retainedOutputWriterWorker,
            "retained-output-writer",
          );
        }
        if (retainedOutputGeneratorWriter) {
          void retainedOutputGeneratorWriter.close().catch(() => {});
          try {
            retainedOutputGeneratorWriter.releaseLock();
          } catch {}
        }
      };
      video.removeEventListener("loadedmetadata", handleHiddenVideoMediaEvent);
      video.removeEventListener("loadeddata", handleHiddenVideoMediaEvent);
      video.removeEventListener("canplay", handleHiddenVideoMediaEvent);
      video.removeEventListener("playing", handleHiddenVideoMediaEvent);
      video.pause();
      video.srcObject = null;
      video.remove();
      closeTrackProcessor("cleanup");
      if (outputWriterWorker) {
        if (retainOutputTrack) {
          detachWorkerCallbacks(outputWriterWorker);
        } else {
          closeWorkerAfterGrace(outputWriterWorker, "output-writer");
        }
        outputWriterWorker = null;
      }
      if (segmentationProcessorWorker) {
        closeWorkerAfterGrace(
          segmentationProcessorWorker,
          "segmentation-processor",
        );
        segmentationProcessorWorker = null;
      }
      if (faceProcessorWorker) {
        closeWorkerAfterGrace(faceProcessorWorker, "face-processor");
        faceProcessorWorker = null;
      }
      rejectPendingOutputWriterFrames(
        new Error(VIDEO_EFFECTS_PROCESSOR_CLEANUP_MESSAGE),
      );
      rejectPendingSegmentationProcessorFrames(
        new Error(VIDEO_EFFECTS_PROCESSOR_CLEANUP_MESSAGE),
      );
      rejectPendingFaceProcessorFrames(
        new Error(VIDEO_EFFECTS_PROCESSOR_CLEANUP_MESSAGE),
      );
      if (outputGeneratorWriter) {
        if (!retainOutputTrack) {
          void outputGeneratorWriter.close().catch(() => {});
          try {
            outputGeneratorWriter.releaseLock();
          } catch {}
        }
        outputGeneratorWriter = null;
      }
      tasksSegmenter?.close();
      tasksFaceLandmarker?.close();
      void legacySegmentation?.close().catch(() => {});
      void legacyFaceMesh?.close().catch(() => {});
      if (finalTrackOwnerRef.current === "local") {
        if (
          retainLocalProcessedTrackForTransition(
            track,
            "processor cleanup",
            cleanupRetainedOutputWriterResources,
          )
        ) {
          return;
        }
        finalTrackOwnerRef.current = "none";
        processedVideoTrackRef.current = null;
        setProcessedTrackReady(false);
        setProcessedTrack((current) => (current === track ? null : current));
      }
      stopProcessedTrackAfterGrace(debugId, track, "processor cleanup");
    };
  }, [
    active,
    debugId,
    localPipelineActive,
    meetVideoPipeActive,
    meetVideoPipeEffectGraph,
    meetVideoPipeGate,
    meetVideoPipeOutputReady,
    meetVideoPipeRequestKey,
    meetVideoPipeTrack,
    processedVideoTrackRef,
    rawSourceVideoTrack,
    sourceStream,
    sourceVideoTrack,
  ]);

  const effectiveStream = useMemo(() => {
    if (!sourceStream) return null;
    const tracks = sourceStream.getTracks().filter((track) => {
      return track.kind !== "video";
    });
    const videoTrack =
      active && processedTrackReady && processedTrack?.readyState === "live"
        ? processedTrack
        : rawSourceVideoTrack;
    if (videoTrack) {
      tracks.push(videoTrack);
    }
    return new MediaStream(tracks);
  }, [
    active,
    processedTrack,
    processedTrackReady,
    rawSourceVideoTrack,
    sourceStream,
  ]);

  return {
    effectiveStream,
    processedTrackVersion,
    processedTrackReady,
    status,
    error,
    debugStats,
  };
}
