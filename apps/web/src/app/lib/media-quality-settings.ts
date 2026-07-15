import type { VideoQuality } from "./types";

export const MEDIA_QUALITY_SETTINGS_STORAGE_KEY =
  "conclave:media-quality-settings:v1";

export const MEDIA_RESOLUTIONS = [
  { id: "360p", label: "360p", width: 640, height: 360 },
  { id: "720p", label: "720p HD", width: 1280, height: 720 },
  { id: "1080p", label: "1080p Full HD", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p QHD", width: 2560, height: 1440 },
  { id: "2160p", label: "2160p 4K", width: 3840, height: 2160 },
] as const;

export type MediaResolution = (typeof MEDIA_RESOLUTIONS)[number]["id"];
export type CameraQualityPreset =
  | "auto"
  | "data-saver"
  | "high-definition"
  | "studio"
  | "custom";
export type ScreenShareQualityPreset =
  | "auto"
  | "presentation"
  | "motion"
  | "custom";
export type CameraContentHint = "motion" | "detail";
export type ScreenShareContentHint = "detail" | "text" | "motion";
export type MediaDegradationPreference =
  | "balanced"
  | "maintain-framerate"
  | "maintain-resolution";
export type ScreenShareCursor = "always" | "motion" | "never";

export interface CameraQualitySettings {
  preset: CameraQualityPreset;
  resolution: MediaResolution;
  frameRate: number;
  maxBitrateKbps: number;
  contentHint: CameraContentHint;
  degradationPreference: MediaDegradationPreference;
}

export interface ScreenShareQualitySettings {
  preset: ScreenShareQualityPreset;
  resolution: MediaResolution;
  frameRate: number;
  maxBitrateKbps: number;
  contentHint: ScreenShareContentHint;
  degradationPreference: MediaDegradationPreference;
  cursor: ScreenShareCursor;
  includeAudio: boolean;
}

export interface MediaQualitySettings {
  camera: CameraQualitySettings;
  screenShare: ScreenShareQualitySettings;
}

export interface ResolvedCameraPublishSettings {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
  contentHint: CameraContentHint;
  degradationPreference: MediaDegradationPreference;
}

export interface ResolvedScreenSharePublishSettings {
  idealWidth: number;
  idealHeight: number;
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  maxBitrate: number;
  contentHint: ScreenShareContentHint;
  degradationPreference: MediaDegradationPreference;
  cursor: ScreenShareCursor;
  includeAudio: boolean;
}

export const CAMERA_FRAME_RATE_OPTIONS = [15, 20, 24, 30, 60] as const;
export const SCREEN_SHARE_FRAME_RATE_OPTIONS = [5, 10, 15, 24, 30, 60] as const;

// The current effects renderer deliberately caps its canvas output to keep
// segmentation and face tracking reliable on ordinary meeting hardware.
// Keep this policy shared with capture, sender, and settings UI code so the
// advertised effective quality can never exceed the produced track.
export const VIDEO_EFFECTS_OUTPUT_MAX_WIDTH = 1280;
export const VIDEO_EFFECTS_OUTPUT_MAX_HEIGHT = 720;
export const VIDEO_EFFECTS_OUTPUT_MAX_FRAME_RATE = 30;

type CameraPresetValues = Omit<CameraQualitySettings, "preset">;
type ScreenSharePresetValues = Omit<ScreenShareQualitySettings, "preset">;

export const CAMERA_QUALITY_PRESETS: Record<
  Exclude<CameraQualityPreset, "custom">,
  CameraPresetValues
> = {
  auto: {
    resolution: "720p",
    frameRate: 30,
    maxBitrateKbps: 1650,
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
  },
  "data-saver": {
    resolution: "360p",
    frameRate: 20,
    maxBitrateKbps: 260,
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
  },
  "high-definition": {
    resolution: "1080p",
    frameRate: 30,
    maxBitrateKbps: 3000,
    contentHint: "detail",
    degradationPreference: "balanced",
  },
  studio: {
    resolution: "1080p",
    frameRate: 60,
    maxBitrateKbps: 4000,
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
  },
};

export const SCREEN_SHARE_QUALITY_PRESETS: Record<
  Exclude<ScreenShareQualityPreset, "custom">,
  ScreenSharePresetValues
> = {
  auto: {
    resolution: "2160p",
    frameRate: 24,
    maxBitrateKbps: 2500,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
    cursor: "always",
    includeAudio: true,
  },
  presentation: {
    resolution: "2160p",
    frameRate: 15,
    maxBitrateKbps: 3500,
    contentHint: "text",
    degradationPreference: "maintain-resolution",
    cursor: "always",
    includeAudio: true,
  },
  motion: {
    resolution: "1440p",
    frameRate: 30,
    maxBitrateKbps: 4500,
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
    cursor: "motion",
    includeAudio: true,
  },
};

export const DEFAULT_MEDIA_QUALITY_SETTINGS: MediaQualitySettings = {
  camera: { preset: "auto", ...CAMERA_QUALITY_PRESETS.auto },
  screenShare: { preset: "auto", ...SCREEN_SHARE_QUALITY_PRESETS.auto },
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const getResolution = (value: unknown, fallback: MediaResolution) =>
  MEDIA_RESOLUTIONS.some((resolution) => resolution.id === value)
    ? (value as MediaResolution)
    : fallback;

const getEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T =>
  typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;

const getBoundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

export const normalizeMediaQualitySettings = (
  value: unknown,
): MediaQualitySettings => {
  const root = isRecord(value) ? value : {};
  const rawCamera = isRecord(root.camera) ? root.camera : {};
  const rawScreenShare = isRecord(root.screenShare) ? root.screenShare : {};
  const cameraFallback = DEFAULT_MEDIA_QUALITY_SETTINGS.camera;
  const screenFallback = DEFAULT_MEDIA_QUALITY_SETTINGS.screenShare;

  return {
    camera: {
      preset: getEnum(
        rawCamera.preset,
        ["auto", "data-saver", "high-definition", "studio", "custom"],
        cameraFallback.preset,
      ),
      resolution: getResolution(rawCamera.resolution, cameraFallback.resolution),
      frameRate: getBoundedInteger(
        rawCamera.frameRate,
        cameraFallback.frameRate,
        5,
        60,
      ),
      maxBitrateKbps: getBoundedInteger(
        rawCamera.maxBitrateKbps,
        cameraFallback.maxBitrateKbps,
        100,
        12000,
      ),
      contentHint: getEnum(
        rawCamera.contentHint,
        ["motion", "detail"],
        cameraFallback.contentHint,
      ),
      degradationPreference: getEnum(
        rawCamera.degradationPreference,
        ["balanced", "maintain-framerate", "maintain-resolution"],
        cameraFallback.degradationPreference,
      ),
    },
    screenShare: {
      preset: getEnum(
        rawScreenShare.preset,
        ["auto", "presentation", "motion", "custom"],
        screenFallback.preset,
      ),
      resolution: getResolution(
        rawScreenShare.resolution,
        screenFallback.resolution,
      ),
      frameRate: getBoundedInteger(
        rawScreenShare.frameRate,
        screenFallback.frameRate,
        1,
        60,
      ),
      maxBitrateKbps: getBoundedInteger(
        rawScreenShare.maxBitrateKbps,
        screenFallback.maxBitrateKbps,
        150,
        15000,
      ),
      contentHint: getEnum(
        rawScreenShare.contentHint,
        ["detail", "text", "motion"],
        screenFallback.contentHint,
      ),
      degradationPreference: getEnum(
        rawScreenShare.degradationPreference,
        ["balanced", "maintain-framerate", "maintain-resolution"],
        screenFallback.degradationPreference,
      ),
      cursor: getEnum(
        rawScreenShare.cursor,
        ["always", "motion", "never"],
        screenFallback.cursor,
      ),
      includeAudio:
        typeof rawScreenShare.includeAudio === "boolean"
          ? rawScreenShare.includeAudio
          : screenFallback.includeAudio,
    },
  };
};

const getBrowserStorage = (): StorageLike | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readStoredMediaQualitySettings = (
  storage: StorageLike | null = getBrowserStorage(),
): MediaQualitySettings => {
  if (!storage) return normalizeMediaQualitySettings(null);
  try {
    const stored = storage.getItem(MEDIA_QUALITY_SETTINGS_STORAGE_KEY);
    return normalizeMediaQualitySettings(stored ? JSON.parse(stored) : null);
  } catch {
    return normalizeMediaQualitySettings(null);
  }
};

export const writeStoredMediaQualitySettings = (
  settings: MediaQualitySettings,
  storage: StorageLike | null = getBrowserStorage(),
): void => {
  if (!storage) return;
  try {
    storage.setItem(
      MEDIA_QUALITY_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeMediaQualitySettings(settings)),
    );
  } catch {}
};

export const applyCameraQualityPreset = (
  current: CameraQualitySettings,
  preset: CameraQualityPreset,
): CameraQualitySettings =>
  preset === "custom"
    ? { ...current, preset }
    : { preset, ...CAMERA_QUALITY_PRESETS[preset] };

export const applyScreenShareQualityPreset = (
  current: ScreenShareQualitySettings,
  preset: ScreenShareQualityPreset,
): ScreenShareQualitySettings =>
  preset === "custom"
    ? { ...current, preset }
    : { preset, ...SCREEN_SHARE_QUALITY_PRESETS[preset] };

export const applyScreenSharePickerPreferences = (
  current: ScreenShareQualitySettings,
  update: Partial<
    Pick<ScreenShareQualitySettings, "cursor" | "includeAudio">
  >,
): ScreenShareQualitySettings => ({
  ...current,
  ...update,
});

const getResolutionDimensions = (resolution: MediaResolution) =>
  MEDIA_RESOLUTIONS.find((candidate) => candidate.id === resolution) ??
  MEDIA_RESOLUTIONS[1];

export const resolveCameraPublishSettings = (
  settings: CameraQualitySettings,
): ResolvedCameraPublishSettings => {
  const normalized = normalizeMediaQualitySettings({ camera: settings }).camera;
  const dimensions = getResolutionDimensions(normalized.resolution);
  return {
    width: dimensions.width,
    height: dimensions.height,
    frameRate: normalized.frameRate,
    maxBitrate: normalized.maxBitrateKbps * 1000,
    contentHint: normalized.contentHint,
    degradationPreference: normalized.degradationPreference,
  };
};

export const resolveEffectiveCameraPublishSettings = (
  settings: CameraQualitySettings,
  effectsActive: boolean,
): ResolvedCameraPublishSettings => {
  const configured = resolveCameraPublishSettings(settings);
  if (!effectsActive) return configured;
  return {
    ...configured,
    width: Math.min(configured.width, VIDEO_EFFECTS_OUTPUT_MAX_WIDTH),
    height: Math.min(configured.height, VIDEO_EFFECTS_OUTPUT_MAX_HEIGHT),
    frameRate: Math.min(
      configured.frameRate,
      VIDEO_EFFECTS_OUTPUT_MAX_FRAME_RATE,
    ),
  };
};

export const resolveScreenSharePublishSettings = (
  settings: ScreenShareQualitySettings,
): ResolvedScreenSharePublishSettings => {
  const normalized = normalizeMediaQualitySettings({
    screenShare: settings,
  }).screenShare;
  const dimensions = getResolutionDimensions(normalized.resolution);
  const autoVideoSettings = SCREEN_SHARE_QUALITY_PRESETS.auto;
  const matchesAutoVideoSettings =
    normalized.resolution === autoVideoSettings.resolution &&
    normalized.frameRate === autoVideoSettings.frameRate &&
    normalized.maxBitrateKbps === autoVideoSettings.maxBitrateKbps &&
    normalized.contentHint === autoVideoSettings.contentHint &&
    normalized.degradationPreference ===
      autoVideoSettings.degradationPreference;
  const useConservativeIdeal =
    normalized.preset === "auto" || matchesAutoVideoSettings;
  return {
    idealWidth: useConservativeIdeal
      ? Math.min(1920, dimensions.width)
      : dimensions.width,
    idealHeight: useConservativeIdeal
      ? Math.min(1080, dimensions.height)
      : dimensions.height,
    maxWidth: dimensions.width,
    maxHeight: dimensions.height,
    frameRate: normalized.frameRate,
    maxBitrate: normalized.maxBitrateKbps * 1000,
    contentHint: normalized.contentHint,
    degradationPreference: normalized.degradationPreference,
    cursor: normalized.cursor,
    includeAudio: normalized.includeAudio,
  };
};

export const getScreenShareLiveVideoSettingsSignature = (
  settings: ScreenShareQualitySettings,
): string => {
  const resolved = resolveScreenSharePublishSettings(settings);
  return JSON.stringify([
    resolved.idealWidth,
    resolved.idealHeight,
    resolved.maxWidth,
    resolved.maxHeight,
    resolved.frameRate,
    resolved.maxBitrate,
    resolved.contentHint,
    resolved.degradationPreference,
  ]);
};

export const getCameraBaseVideoQuality = (
  settings: CameraQualitySettings,
): VideoQuality => {
  const resolved = resolveCameraPublishSettings(settings);
  return resolved.width <= 640 && resolved.maxBitrate <= 500000
    ? "low"
    : "standard";
};
