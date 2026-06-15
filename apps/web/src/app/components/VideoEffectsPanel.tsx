"use client";

import {
  Check,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, Dispatch, ReactNode, SetStateAction } from "react";
import {
  prewarmVideoEffectsAssets,
  type VideoEffectsDebugStats,
  type VideoEffectsRuntimeStatus,
} from "../hooks/useVideoEffects";
import {
  APPEARANCE_STYLES,
  BACKGROUND_EFFECTS,
  CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS,
  DEFAULT_VIDEO_EFFECTS,
  FACE_FILTERS,
  type AppearanceStyleId,
  type BackgroundEffectId,
  type FaceFilterId,
  type VideoEffectOption,
  type VideoEffectsState,
} from "../lib/video-effects";
import {
  deleteCustomVideoBackground,
  getCustomVideoBackground,
  listCustomVideoBackgrounds,
  saveCustomVideoBackground,
  touchCustomVideoBackground,
  type CustomVideoBackground,
  type CustomVideoBackgroundSummary,
} from "../lib/video-effects-custom-backgrounds";

type EffectsTab = "backgrounds" | "filters" | "appearance";
type ActiveEffectStackItem = {
  key: keyof VideoEffectsState;
  label: string;
  tab: EffectsTab;
  icon?: VideoEffectOption<string>["icon"];
  tone?: string;
  remove: () => void;
};

interface VideoEffectsPanelProps {
  effects: VideoEffectsState;
  onEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  localStream: MediaStream | null;
  isCameraOff: boolean;
  status: VideoEffectsRuntimeStatus;
  error: string | null;
  debugStats?: VideoEffectsDebugStats | null;
  activeCount: number;
  cameraPermissionBlocked?: boolean;
  onRecenterFraming?: () => void;
  onClose: () => void;
  variant?: "dock" | "dialog";
  initialTab?: EffectsTab;
  showFilters?: boolean;
}

const TABS: { id: EffectsTab; label: string }[] = [
  { id: "backgrounds", label: "Backgrounds" },
  { id: "filters", label: "Filters" },
  { id: "appearance", label: "Appearance" },
];

const getDebugTrackId = (
  debugStats: VideoEffectsDebugStats | null | undefined,
  key: "outputTrack" | "sourceTrack",
) => {
  const track = debugStats?.[key];
  if (typeof track !== "object" || track === null) return null;
  const id = (track as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
};

const groupOptions = <T extends string>(options: VideoEffectOption<T>[]) => {
  const groups = new Map<string, VideoEffectOption<T>[]>();
  options.forEach((option) => {
    const category = option.category ?? "Styles";
    const current = groups.get(category) ?? [];
    current.push(option);
    groups.set(category, current);
  });
  return Array.from(groups.entries());
};

const CUSTOM_BACKGROUND_MAX_FILE_BYTES = 12 * 1024 * 1024;
const CUSTOM_BACKGROUND_MAX_DIMENSION = 1600;
const CUSTOM_BACKGROUND_OUTPUT_TYPE = "image/jpeg";
const CUSTOM_BACKGROUND_OUTPUT_ATTEMPTS = [
  { maxDimension: CUSTOM_BACKGROUND_MAX_DIMENSION, quality: 0.86 },
  { maxDimension: 1400, quality: 0.82 },
  { maxDimension: 1200, quality: 0.78 },
  { maxDimension: 960, quality: 0.72 },
] as const;

const loadImageForCustomBackground = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image could not be decoded."));
    };
    image.src = url;
  });

const createCustomBackgroundDataUrl = async (file: File) => {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > CUSTOM_BACKGROUND_MAX_FILE_BYTES) {
    throw new Error("Choose an image under 12 MB.");
  }

  const bitmap =
    typeof createImageBitmap === "function"
      ? await createImageBitmap(file)
      : null;
  const width = bitmap?.width ?? 0;
  const height = bitmap?.height ?? 0;
  const fallbackImage = bitmap ? null : await loadImageForCustomBackground(file);
  const sourceWidth = bitmap?.width ?? fallbackImage?.naturalWidth ?? 0;
  const sourceHeight = bitmap?.height ?? fallbackImage?.naturalHeight ?? 0;
  const sourceImage = bitmap ?? fallbackImage;
  if (!sourceImage || sourceWidth <= 0 || sourceHeight <= 0) {
    bitmap?.close?.();
    throw new Error("Image dimensions could not be read.");
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    bitmap?.close?.();
    throw new Error("Image processing is unavailable.");
  }
  try {
    for (const attempt of CUSTOM_BACKGROUND_OUTPUT_ATTEMPTS) {
      const scale = Math.min(
        1,
        attempt.maxDimension / Math.max(sourceWidth, sourceHeight),
      );
      const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
      const outputHeight = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      ctx.fillStyle = "#111111";
      ctx.fillRect(0, 0, outputWidth, outputHeight);
      ctx.drawImage(
        sourceImage,
        0,
        0,
        sourceWidth || width,
        sourceHeight || height,
        0,
        0,
        outputWidth,
        outputHeight,
      );
      const dataUrl = canvas.toDataURL(
        CUSTOM_BACKGROUND_OUTPUT_TYPE,
        attempt.quality,
      );
      if (dataUrl.length <= CUSTOM_BACKGROUND_MAX_DATA_URL_CHARS) {
        return dataUrl;
      }
    }
  } finally {
    bitmap?.close?.();
  }
  throw new Error("Choose a less detailed image.");
};

function EffectOptionButton<T extends string>({
  option,
  selected,
  disabled = false,
  testId,
  onPrewarm,
  onSelect,
}: {
  option: VideoEffectOption<T>;
  selected: boolean;
  disabled?: boolean;
  testId?: string;
  onPrewarm?: () => void;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  const isMotionOption = option.motion === true;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onSelect}
      onFocus={disabled ? undefined : onPrewarm}
      onPointerEnter={disabled ? undefined : onPrewarm}
      onTouchStart={disabled ? undefined : onPrewarm}
      aria-pressed={selected}
      disabled={disabled}
      className={`group relative min-h-[84px] rounded-[14px] border p-2 text-left transition-colors ${
        selected
          ? "border-[#1a73e8] bg-white"
          : "border-transparent bg-[#dfe8ff] hover:bg-[#d6e3ff]"
      } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#dfe8ff]`}
    >
      <span
        className={`relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-[12px] ${
          option.assetPath ? "bg-cover bg-center" : ""
        }`}
        style={
          option.assetPath
            ? {
                backgroundColor: option.tone,
                backgroundImage: `url("${option.assetPath}")`,
              }
            : { backgroundColor: option.tone }
        }
      >
        {option.assetPath ? (
          <span className="h-full w-full bg-black/10" />
        ) : (
          <Icon size={18} strokeWidth={1.75} className="text-white" />
        )}
        {isMotionOption ? (
          <span className="pointer-events-none absolute inset-0 overflow-hidden">
            <span className="absolute -left-3 top-2 h-2 w-12 rotate-[-18deg] rounded-full bg-white/25 animate-pulse" />
            <span className="absolute -right-4 bottom-2 h-1.5 w-12 rotate-[-18deg] rounded-full bg-white/20 animate-pulse" />
          </span>
        ) : null}
      </span>
      <span className="mt-2 block text-[12px] font-medium leading-tight text-[#202124]">
        {option.label}
      </span>
      {option.description ? (
        <span className="mt-1 block text-[11px] leading-tight text-[#5f6368]">
          {option.description}
        </span>
      ) : null}
      {selected ? (
        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#1a73e8] text-white">
          <Check size={13} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  testId,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={disabled ? undefined : () => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[#202124]">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-snug text-[#5f6368]">
            {description}
          </span>
        ) : null}
      </span>
      <span
        className={`relative h-6 w-10 rounded-full border transition-colors ${
          checked
            ? "border-[#1a73e8] bg-[#1a73e8]"
            : "border-[#dadce0] bg-[#f1f3f4]"
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-1"
          }`}
        />
      </span>
    </button>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="px-4 py-3">
      <div className="rounded-[18px] bg-[#f3f6fb] p-3">
        <h3 className="mb-2 text-[13px] font-medium text-[#202124]">
          {label}
        </h3>
        {children}
      </div>
    </section>
  );
}

function VideoEffectsPreview({
  stream,
  isCameraOff,
  hasLiveVideo,
}: {
  stream: MediaStream | null;
  isCameraOff: boolean;
  hasLiveVideo: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shouldShowVideo = hasLiveVideo;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream || !shouldShowVideo) {
      if (video?.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(() => {});

    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [shouldShowVideo, stream]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-[14px] bg-[#202124]">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`h-full w-full object-cover ${
          shouldShowVideo ? "" : "hidden"
        }`}
      />
      {!shouldShowVideo ? (
        <div className="absolute inset-0 flex items-center justify-center text-[18px] font-medium text-white">
          {isCameraOff ? "Camera is off" : "Camera unavailable"}
        </div>
      ) : null}
      <div className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-[#d7e3f0] text-[#202124]">
        <SlidersHorizontal size={22} strokeWidth={1.75} />
      </div>
    </div>
  );
}

export default function VideoEffectsPanel({
  effects,
  onEffectsChange,
  localStream,
  isCameraOff,
  status,
  error,
  debugStats = null,
  activeCount,
  cameraPermissionBlocked = false,
  onRecenterFraming,
  onClose,
  variant = "dock",
  initialTab = "backgrounds",
  showFilters = true,
}: VideoEffectsPanelProps) {
  const [activeTab, setActiveTab] = useState<EffectsTab>(initialTab);
  const [showActiveEffectStack, setShowActiveEffectStack] = useState(false);
  const [customBackgroundError, setCustomBackgroundError] = useState<string | null>(
    null,
  );
  const [customBackgrounds, setCustomBackgrounds] = useState<
    CustomVideoBackgroundSummary[]
  >([]);
  const customBackgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundGroups = useMemo(
    () =>
      groupOptions(
        BACKGROUND_EFFECTS.filter((option) => option.id !== "custom"),
      ),
    [],
  );
  const filterGroups = useMemo(() => groupOptions(FACE_FILTERS), []);
  const appearanceGroups = useMemo(() => groupOptions(APPEARANCE_STYLES), []);
  const availableTabs = useMemo(
    () => (!showFilters ? TABS.filter((tab) => tab.id !== "filters") : TABS),
    [showFilters],
  );
  const backgroundOptionById = useMemo(
    () => new Map(BACKGROUND_EFFECTS.map((option) => [option.id, option])),
    [],
  );
  const filterOptionById = useMemo(
    () => new Map(FACE_FILTERS.map((option) => [option.id, option])),
    [],
  );
  const appearanceOptionById = useMemo(
    () => new Map(APPEARANCE_STYLES.map((option) => [option.id, option])),
    [],
  );
  const hasLiveVideo = Boolean(
    localStream
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  );
  const previewVideoTrack =
    localStream
      ?.getVideoTracks()
      .find((track) => track.readyState === "live" && track.enabled) ?? null;
  const outputTrackId = getDebugTrackId(debugStats, "outputTrack");
  const previewMatchesPublishedOutput =
    debugStats?.outputTrackPublished === true &&
    Boolean(outputTrackId) &&
    previewVideoTrack?.id === outputTrackId;
  const cameraUnavailable = !hasLiveVideo;
  const displayedActiveCount = activeCount;

  const applyEffectsChange = (updater: SetStateAction<VideoEffectsState>) => {
    onEffectsChange(updater);
  };

  const setBackground = (background: BackgroundEffectId) => {
    if (background !== "none" && background !== "gradient") {
      void prewarmVideoEffectsAssets({
        segmentation: true,
        backgrounds: [background],
        reason: `background:${background}:select`,
      });
    }
    applyEffectsChange((current) => ({ ...current, background }));
  };

  const refreshCustomBackgrounds = useCallback(() => {
    let cancelled = false;
    void listCustomVideoBackgrounds()
      .then((backgrounds) => {
        if (!cancelled) setCustomBackgrounds(backgrounds);
      })
      .catch(() => {
        if (!cancelled) setCustomBackgrounds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refreshCustomBackgrounds(), [refreshCustomBackgrounds]);

  const selectCustomBackgroundUpload = () => {
    if (!cameraPermissionBlocked) {
      void prewarmVideoEffectsAssets({
        segmentation: true,
        reason: "background:custom:upload-picker",
      });
    }
    customBackgroundInputRef.current?.click();
  };

  const selectStoredCustomBackground = async (
    background: CustomVideoBackgroundSummary,
  ) => {
    setCustomBackgroundError(null);
    const asset =
      (await touchCustomVideoBackground(background.id)) ??
      (await getCustomVideoBackground(background.id));
    if (!asset) {
      setCustomBackgroundError("Uploaded image is no longer available.");
      refreshCustomBackgrounds();
      return;
    }
    void prewarmVideoEffectsAssets({
      segmentation: true,
      reason: `background:custom:${asset.id}:select`,
    });
    refreshCustomBackgrounds();
    applyEffectsChange(
      (current) => ({
        ...current,
        background: "custom",
        customBackgroundId: asset.id,
        customBackgroundDataUrl: asset.dataUrl,
        customBackgroundName: asset.name,
      }),
    );
  };

  const handleCustomBackgroundUpload = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const [file] = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!file) return;
    setCustomBackgroundError(null);
    try {
      const dataUrl = await createCustomBackgroundDataUrl(file);
      let savedBackground: CustomVideoBackground | null = null;
      try {
        savedBackground = await saveCustomVideoBackground({
          name: file.name,
          dataUrl,
          thumbnailDataUrl: dataUrl,
        });
        refreshCustomBackgrounds();
      } catch {
        savedBackground = null;
      }
      void prewarmVideoEffectsAssets({
        segmentation: true,
        reason: savedBackground?.id
          ? `background:custom:${savedBackground.id}:upload`
          : "background:custom:upload",
      });
      applyEffectsChange(
        (current) => ({
          ...current,
          background: "custom",
          customBackgroundId: savedBackground?.id ?? null,
          customBackgroundDataUrl: savedBackground?.dataUrl ?? dataUrl,
          customBackgroundName: savedBackground?.name ?? file.name,
        }),
      );
    } catch (err) {
      setCustomBackgroundError(
        err instanceof Error ? err.message : "Image upload failed.",
      );
    }
  };

  const removeCustomBackground = () => {
    setCustomBackgroundError(null);
    const customBackgroundId = effects.customBackgroundId;
    if (customBackgroundId) {
      void deleteCustomVideoBackground(customBackgroundId)
        .then(refreshCustomBackgrounds)
        .catch(() => setCustomBackgroundError("Image could not be removed."));
    }
    onEffectsChange((current) => ({
      ...current,
      background: current.background === "custom" ? "none" : current.background,
      customBackgroundId: null,
      customBackgroundDataUrl: null,
      customBackgroundName: null,
    }));
  };

  const setFilter = (filter: FaceFilterId) => {
    if (filter !== "none") {
      void prewarmVideoEffectsAssets({
        face: true,
        reason: `filter:${filter}:select`,
      });
    }
    applyEffectsChange((current) => ({ ...current, filter }));
  };

  const setStyle = (style: AppearanceStyleId) => {
    applyEffectsChange((current) => ({ ...current, style }));
  };

  const setToggle =
    (key: "studioLighting" | "studioLook" | "framing") =>
    (checked: boolean) => {
      if (key === "framing" && checked) {
        void prewarmVideoEffectsAssets({
          face: true,
          reason: "appearance:framing:select",
        });
      }
      applyEffectsChange((current) => ({ ...current, [key]: checked }));
    };
  const activeEffectStack = useMemo<ActiveEffectStackItem[]>(() => {
    const stack: ActiveEffectStackItem[] = [];
    const backgroundOption = backgroundOptionById.get(effects.background);
    if (backgroundOption && effects.background !== "none") {
      stack.push({
        key: "background",
        label:
          effects.background === "custom"
            ? effects.customBackgroundName || "Uploaded image"
            : backgroundOption.label,
        tab: "backgrounds",
        icon: backgroundOption.icon,
        tone: backgroundOption.tone,
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            background: DEFAULT_VIDEO_EFFECTS.background,
            customBackgroundId:
              current.background === "custom"
                ? DEFAULT_VIDEO_EFFECTS.customBackgroundId
                : current.customBackgroundId,
            customBackgroundDataUrl:
              current.background === "custom"
                ? DEFAULT_VIDEO_EFFECTS.customBackgroundDataUrl
                : current.customBackgroundDataUrl,
            customBackgroundName:
              current.background === "custom"
                ? DEFAULT_VIDEO_EFFECTS.customBackgroundName
                : current.customBackgroundName,
          })),
      });
    }

    const filterOption = filterOptionById.get(effects.filter);
    if (showFilters && filterOption && effects.filter !== "none") {
      stack.push({
        key: "filter",
        label: filterOption.label,
        tab: "filters",
        icon: filterOption.icon,
        tone: filterOption.tone,
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            filter: DEFAULT_VIDEO_EFFECTS.filter,
          })),
      });
    }

    if (effects.studioLighting) {
      stack.push({
        key: "studioLighting",
        label: "Adjust video lighting",
        tab: "appearance",
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            studioLighting: DEFAULT_VIDEO_EFFECTS.studioLighting,
          })),
      });
    }
    const appearanceOption = appearanceOptionById.get(effects.style);
    if (appearanceOption && effects.style !== "none") {
      stack.push({
        key: "style",
        label: appearanceOption.label,
        tab: "appearance",
        icon: appearanceOption.icon,
        tone: appearanceOption.tone,
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            style: DEFAULT_VIDEO_EFFECTS.style,
          })),
      });
    }
    if (effects.studioLook) {
      stack.push({
        key: "studioLook",
        label: "Touch-up appearance",
        tab: "appearance",
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            studioLook: DEFAULT_VIDEO_EFFECTS.studioLook,
          })),
      });
    }
    if (effects.framing) {
      stack.push({
        key: "framing",
        label: "Framing",
        tab: "appearance",
        remove: () =>
          onEffectsChange((current) => ({
            ...current,
            framing: DEFAULT_VIDEO_EFFECTS.framing,
          })),
      });
    }

    return stack;
  }, [
    appearanceOptionById,
    backgroundOptionById,
    effects,
    filterOptionById,
    onEffectsChange,
    showFilters,
  ]);

  useEffect(() => {
    if (activeEffectStack.length === 0) {
      setShowActiveEffectStack(false);
    }
  }, [activeEffectStack.length]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("backgrounds");
    }
  }, [activeTab, availableTabs]);

  const prewarmForBackground = useCallback(
    (background: BackgroundEffectId) => {
      if (
        background === "none" ||
        background === "gradient"
      ) {
        return;
      }
      void prewarmVideoEffectsAssets({
        segmentation: true,
        backgrounds: [background],
        reason: `background:${background}`,
      });
    },
    [],
  );

  const prewarmFace = useCallback((reason: string) => {
    void prewarmVideoEffectsAssets({ face: true, reason });
  }, []);

  const imageBackgroundIds = useMemo(
    () =>
      BACKGROUND_EFFECTS.filter(
        (option) =>
          option.id !== "custom" &&
          option.id !== "none" &&
          option.id !== "gradient" &&
          Boolean(option.assetPath),
      ).map((option) => option.id),
    [],
  );

  useEffect(() => {
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: showFilters,
      backgrounds: imageBackgroundIds,
      reason: "effects-panel-open",
    });
  }, [imageBackgroundIds, showFilters]);

  useEffect(() => {
    if (activeTab === "filters") {
      prewarmFace("effects-panel-filters-tab");
    } else if (activeTab === "appearance") {
      prewarmFace("effects-panel-appearance-tab");
    }
  }, [activeTab, prewarmFace]);

  const statusLabel =
    cameraPermissionBlocked
      ? "Camera is blocked"
      : cameraUnavailable && activeCount > 0
        ? "Will apply when camera turns on"
        : status === "loading"
          ? "Preparing effects"
          : status === "running"
            ? "Effects are live"
            : status === "degraded"
              ? "Effects degraded"
              : activeCount > 0
                ? "Waiting for camera"
                : "No effects applied";

  const compactDebugStats = useMemo(() => {
    if (!debugStats) return undefined;
    const stats = {
      needsSegmentation: debugStats.needsSegmentation,
      needsFace: debugStats.needsFace,
      frameSource: debugStats.frameSource,
      schedulerMode: debugStats.schedulerMode,
      outputTrackPublished: debugStats.outputTrackPublished,
      outputMode: debugStats.outputMode,
      renderedFrames: debugStats.renderedFrames,
      taskSegmentationRuns: debugStats.taskSegmentationRuns,
      taskFaceRuns: debugStats.taskFaceRuns,
      closedSegmentationMasks: debugStats.closedSegmentationMasks,
      faceLandmarkCount: debugStats.faceLandmarkCount,
      faceDetection: debugStats.faceDetection,
      faceFilterRender: debugStats.faceFilterRender,
      backgroundRender: debugStats.backgroundRender,
      lowLightRender: debugStats.lowLightRender,
      visualTransition: debugStats.visualTransition,
      effectSwitchLatency: debugStats.effectSwitchLatency,
      autoFrame: debugStats.autoFrame,
      adaptation: debugStats.adaptation,
      intervals: debugStats.intervals,
      temporalMask: debugStats.temporalMask,
      frameMetadata: debugStats.frameMetadata,
      framePipeline: debugStats.framePipeline,
      effects: debugStats.effects,
      latestSegmentationMaskAgeMs: debugStats.latestSegmentationMaskAgeMs,
      latestFaceLandmarksAgeMs: debugStats.latestFaceLandmarksAgeMs,
      latestOutputFrameVisible: debugStats.latestOutputFrameVisible,
      blackOutputFrameCount: debugStats.blackOutputFrameCount,
      failures: debugStats.failures,
    };
    try {
      return JSON.stringify(stats);
    } catch {
      return undefined;
    }
  }, [debugStats]);

  const panelClassName =
    variant === "dialog"
      ? "fixed left-1/2 top-1/2 z-50 flex h-[min(780px,calc(100dvh-48px))] w-[min(500px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_24px_80px_rgba(60,64,67,0.32)]"
      : "fixed right-0 top-0 bottom-0 z-40 flex w-[360px] flex-col overflow-hidden border-l border-black/10 bg-white shadow-[0_8px_30px_rgba(60,64,67,0.18)] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)]";

  const panel = (
    <aside
      data-testid="video-effects-panel"
      data-video-effects-status={status}
      data-video-effects-active-count={displayedActiveCount}
      data-video-effects-output-published={
        debugStats?.outputTrackPublished === true ? "true" : "false"
      }
      data-video-effects-frame-source={
        typeof debugStats?.frameSource === "string"
          ? debugStats.frameSource
          : "none"
      }
      data-video-effects-black-output-count={
        typeof debugStats?.blackOutputFrameCount === "number"
          ? debugStats.blackOutputFrameCount
          : 0
      }
      data-video-effects-preview-track-id={previewVideoTrack?.id ?? ""}
      data-video-effects-output-track-id={outputTrackId ?? ""}
      data-video-effects-preview-track-state={
        previewVideoTrack?.readyState ?? "none"
      }
      data-video-effects-preview-matches-output={
        previewMatchesPublishedOutput ? "true" : "false"
      }
      data-video-effects-camera-off={isCameraOff ? "true" : "false"}
      data-video-effects-has-live-video={hasLiveVideo ? "true" : "false"}
      data-video-effects-camera-unavailable={
        cameraUnavailable ? "true" : "false"
      }
      data-video-effects-filters-visible={showFilters ? "true" : "false"}
      data-video-effects-permission-locked={
        cameraPermissionBlocked ? "true" : "false"
      }
      data-video-effects-stats={compactDebugStats}
      className={panelClassName}
      style={{ fontFamily: "Google Sans, Roboto, Arial, sans-serif" }}
    >
      <header className="flex items-center justify-between px-6 pb-4 pt-6">
        <div className="min-w-0">
          <h2 className="truncate text-[24px] font-normal text-[#202124]">
            Backgrounds and effects
          </h2>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-[#5f6368]">
            {status === "loading" ? (
              <LoaderCircle
                size={13}
                strokeWidth={1.75}
                className="animate-spin"
              />
            ) : (
              <Sparkles size={13} strokeWidth={1.75} />
            )}
            <span>{statusLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close backgrounds and effects"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#5f6368] transition-colors hover:bg-[#f1f3f4] hover:text-[#202124]"
        >
          <X size={18} strokeWidth={1.75} />
        </button>
      </header>

      <div className="border-b border-[#dadce0] px-6 pb-4">
        <VideoEffectsPreview
          stream={localStream}
          isCameraOff={isCameraOff}
          hasLiveVideo={hasLiveVideo}
        />
        {cameraUnavailable ? (
          <div className="mt-3 rounded-[12px] bg-[#fef7e0] px-3 py-2 text-[12px] leading-snug text-[#5f6368]">
            {cameraPermissionBlocked
              ? "Camera is blocked"
              : "Your camera is turned off. Effects will apply when you turn it on."}
          </div>
        ) : null}
        {error ? (
          <div className="mt-2 rounded-[12px] bg-[#fce8e6] px-3 py-2 text-[12px] leading-snug text-[#5f6368]">
            {error}
          </div>
        ) : null}
        {customBackgroundError ? (
          <div className="mt-2 rounded-[12px] bg-[#fce8e6] px-3 py-2 text-[12px] leading-snug text-[#5f6368]">
            {customBackgroundError}
          </div>
        ) : null}
        <button
          type="button"
          disabled={displayedActiveCount === 0}
          title={
            displayedActiveCount === 0
              ? "No effects applied"
              : undefined
          }
          aria-expanded={showActiveEffectStack}
          onClick={() => {
            if (activeEffectStack.length === 0) return;
            setShowActiveEffectStack((current) => !current);
          }}
          className="mt-3 flex w-full items-center justify-between rounded-[12px] bg-[#f1f3f4] px-3 py-2 text-[13px] font-medium text-[#202124] transition-colors hover:bg-[#e8eaed] disabled:cursor-not-allowed disabled:text-[#9aa0a6]"
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal size={16} strokeWidth={1.75} />
            Turn off visual effects
          </span>
          {displayedActiveCount > 0 ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#1a73e8] px-1.5 text-[11px] font-semibold text-white">
              {displayedActiveCount}
            </span>
          ) : null}
        </button>
        {showActiveEffectStack &&
        activeEffectStack.length > 0 ? (
          <div
            aria-label="Active visual effects"
            className="mt-2 grid gap-1.5 rounded-[12px] bg-[#f8fafd] p-2"
            data-video-effects-active-stack="true"
            data-video-effects-active-stack-open="true"
          >
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <span className="text-[12px] font-medium text-[#5f6368]">
                Applied effects
              </span>
              <button
                type="button"
                aria-label="Remove all visual effects"
                onClick={() => onEffectsChange(DEFAULT_VIDEO_EFFECTS)}
                className="rounded-full px-2 py-1 text-[12px] font-medium text-[#1a73e8] transition-colors hover:bg-[#e8f0fe]"
              >
                Remove all
              </button>
            </div>
            {activeEffectStack.map((item) => {
              const Icon = item.icon ?? Sparkles;
              return (
                <div
                  key={item.key}
                  className="flex min-h-9 items-center gap-2 rounded-[12px] border border-[#dadce0] bg-white px-2.5 py-1.5 text-[13px] text-[#202124]"
                  data-video-effects-active-item={item.key}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setActiveTab(item.tab)}
                  >
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
                      style={{ backgroundColor: item.tone ?? "#1a73e8" }}
                    >
                      <Icon size={14} strokeWidth={1.85} />
                    </span>
                    <span className="truncate">{item.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={item.remove}
                    aria-label={`Remove ${item.label}`}
                    title={`Remove ${item.label}`}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#5f6368] transition-colors hover:bg-[#f1f3f4] hover:text-[#202124]"
                  >
                    <X size={15} strokeWidth={1.85} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-3 border-b border-[#dadce0] px-6">
        {availableTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-2 py-3 text-[13px] font-medium transition-colors ${
              activeTab === tab.id
                ? "border-[#1a73e8] text-[#1a73e8]"
                : "border-transparent text-[#3c4043] hover:bg-[#f8fafd]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-width:thin] [scrollbar-color:rgba(60,64,67,0.28)_transparent]">
        {activeTab === "backgrounds" ? (
          <>
            <Section label="Personal">
              <input
                ref={customBackgroundInputRef}
                data-testid="custom-background-input"
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleCustomBackgroundUpload}
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-label="Upload a background image"
                  data-testid="custom-background-tile"
                  onClick={selectCustomBackgroundUpload}
                  className="group relative min-h-[84px] rounded-[14px] border border-transparent bg-[#dfe8ff] p-2 text-left transition-colors hover:bg-[#d6e3ff] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#dfe8ff]"
                >
                  <span
                    className="flex h-10 w-10 items-center justify-center rounded-[12px]"
                    style={{ backgroundColor: "#1a73e8" }}
                  >
                    <ImagePlus
                      size={18}
                      strokeWidth={1.75}
                      className="text-white"
                    />
                  </span>
                  <span className="mt-2 block text-[12px] font-medium leading-tight text-[#202124]">
                    Upload image
                  </span>
                </button>
                {customBackgrounds.map((background) => {
                  const selected =
                    effects.background === "custom" &&
                    effects.customBackgroundId === background.id;
                  return (
                    <button
                      key={background.id}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`Use ${background.name}`}
                      data-testid="custom-background-saved-tile"
                      onClick={() => void selectStoredCustomBackground(background)}
                      className={`group relative min-h-[84px] rounded-[14px] border p-2 text-left transition-colors ${
                        selected
                          ? "border-[#1a73e8] bg-white"
                          : "border-transparent bg-[#dfe8ff] hover:bg-[#d6e3ff]"
                      } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#dfe8ff]`}
                    >
                      <span
                        className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[12px] bg-cover bg-center"
                        style={{
                          backgroundColor: "#1a73e8",
                          backgroundImage: `url("${background.thumbnailDataUrl}")`,
                        }}
                      >
                        <span className="h-full w-full bg-black/10" />
                      </span>
                      <span className="mt-2 block text-[12px] font-medium leading-tight text-[#202124]">
                        {background.name}
                      </span>
                      {selected ? (
                        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#1a73e8] text-white">
                          <Check size={13} strokeWidth={2} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {effects.customBackgroundDataUrl &&
                !effects.customBackgroundId ? (
                  <button
                    type="button"
                    aria-pressed={effects.background === "custom"}
                    aria-label="Use uploaded background"
                    data-testid="custom-background-session-tile"
                    onClick={() => {
                      void prewarmVideoEffectsAssets({
                        segmentation: true,
                        reason: "background:custom:session-select",
                      });
                      applyEffectsChange(
                        (current) => ({ ...current, background: "custom" }),
                      );
                    }}
                    className={`group relative min-h-[84px] rounded-[14px] border p-2 text-left transition-colors ${
                      effects.background === "custom"
                        ? "border-[#1a73e8] bg-white"
                        : "border-transparent bg-[#dfe8ff] hover:bg-[#d6e3ff]"
                    } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#dfe8ff]`}
                  >
                    <span
                      className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[12px] bg-cover bg-center"
                      style={{
                        backgroundColor: "#1a73e8",
                        backgroundImage: `url("${effects.customBackgroundDataUrl}")`,
                      }}
                    >
                      <span className="h-full w-full bg-black/10" />
                    </span>
                    <span className="mt-2 block text-[12px] font-medium leading-tight text-[#202124]">
                      {effects.customBackgroundName || "Uploaded image"}
                    </span>
                    {effects.background === "custom" ? (
                      <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#1a73e8] text-white">
                        <Check size={13} strokeWidth={2} />
                      </span>
                    ) : null}
                  </button>
                ) : null}
                {effects.customBackgroundDataUrl || effects.customBackgroundId ? (
                  <div className="grid gap-2">
                    <button
                      type="button"
                      data-testid="custom-background-change"
                      onClick={() => {
                        customBackgroundInputRef.current?.click();
                      }}
                      className="min-h-[38px] rounded-[12px] bg-[#f1f3f4] px-3 text-left text-[12px] font-medium text-[#202124] transition-colors hover:bg-[#e8eaed] disabled:cursor-not-allowed disabled:text-[#9aa0a6] disabled:hover:bg-[#f1f3f4]"
                    >
                      Change image
                    </button>
                    <button
                      type="button"
                      data-testid="custom-background-remove"
                      onClick={removeCustomBackground}
                      className="min-h-[38px] rounded-[12px] bg-[#fce8e6] px-3 text-left text-[12px] font-medium text-[#b3261e] transition-colors hover:bg-[#fad2cf] disabled:cursor-not-allowed disabled:bg-[#f1f3f4] disabled:text-[#9aa0a6]"
                    >
                      Remove image
                    </button>
                  </div>
                ) : null}
              </div>
            </Section>
            {backgroundGroups.map(([label, options]) => (
              <Section key={label} label={label}>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <EffectOptionButton
                      key={option.id}
                      option={option}
                      selected={effects.background === option.id}
                      testId={`video-effects-background-${option.id}`}
                      onPrewarm={() => prewarmForBackground(option.id)}
                      onSelect={() => setBackground(option.id)}
                    />
                  ))}
                </div>
              </Section>
            ))}
          </>
        ) : null}

        {activeTab === "filters"
          ? filterGroups.map(([label, options]) => (
              <Section key={label} label={label}>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <EffectOptionButton
                      key={option.id}
                      option={option}
                      selected={effects.filter === option.id}
                      testId={`video-effects-filter-${option.id}`}
                      onPrewarm={() =>
                        option.id === "none"
                          ? undefined
                          : prewarmFace(`filter:${option.id}`)
                      }
                      onSelect={() => setFilter(option.id)}
                    />
                  ))}
                </div>
              </Section>
            ))
          : null}

        {activeTab === "appearance" ? (
          <>
            <Section label="Touch-up appearance">
              <div className="grid gap-1">
                <ToggleRow
                  label="Touch-up appearance"
                  description="Smooths skin tone and balances contrast"
                  checked={effects.studioLook}
                  testId="video-effects-appearance-studio-look"
                  onChange={setToggle("studioLook")}
                />
              </div>
            </Section>

            <Section label="Lighting and framing">
              <div className="grid gap-1">
                <ToggleRow
                  label="Adjust video lighting"
                  description="Makes it easier to see you against a bright background"
                  checked={effects.studioLighting}
                  testId="video-effects-appearance-studio-lighting"
                  onChange={setToggle("studioLighting")}
                />
                <div className="h-px bg-[#e8eaed]" />
                <ToggleRow
                  label="Framing"
                  description="Puts you in the center of the screen"
                  checked={effects.framing}
                  testId="video-effects-appearance-framing"
                  onChange={setToggle("framing")}
                />
                <button
                  type="button"
                  data-testid="video-effects-recenter-framing"
                  disabled={
                    cameraUnavailable ||
                    !effects.framing ||
                    !onRecenterFraming
                  }
                  onClick={onRecenterFraming}
                  className="ml-12 min-h-9 rounded-full bg-[#e8f0fe] px-4 text-left text-[13px] font-medium text-[#1a73e8] transition-colors hover:bg-[#d2e3fc] disabled:cursor-not-allowed disabled:bg-[#f1f3f4] disabled:text-[#9aa0a6]"
                >
                  Recenter
                </button>
              </div>
            </Section>

            {appearanceGroups.map(([label, options]) => (
              <Section key={label} label={label}>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <EffectOptionButton
                      key={option.id}
                      option={option}
                      selected={effects.style === option.id}
                      testId={`video-effects-appearance-style-${option.id}`}
                      onSelect={() => setStyle(option.id)}
                    />
                  ))}
                </div>
              </Section>
            ))}
          </>
        ) : null}
      </div>
    </aside>
  );

  if (variant === "dialog") {
    return (
      <>
        <button
          type="button"
          aria-label="Close backgrounds and effects"
          className="fixed inset-0 z-40 cursor-default bg-black/35"
          onClick={onClose}
        />
        {panel}
      </>
    );
  }

  return panel;
}
