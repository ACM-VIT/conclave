"use client";

import {
  Check,
  ImagePlus,
  LoaderCircle,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, Dispatch, ReactNode, SetStateAction } from "react";
import { color, font } from "@conclave/ui-tokens";
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
  getVideoEffectPreviewPath,
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
type BackgroundEffectGroup = [
  string,
  VideoEffectOption<BackgroundEffectId>[],
];
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
  onToggleCamera?: () => void;
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
const EFFECTS_ACCENT = color.accent;
const PANEL_FONT = font.sans;
const ICON_STROKE = 1.75;
const SECTION_LABEL = color.textFaint;
const EFFECT_TILE_BASE_CLASS =
  "group relative min-h-[82px] rounded-xl border p-2 text-left transition-[background-color,border-color,filter,transform] duration-[120ms] active:brightness-95";
const EFFECT_TILE_IDLE_CLASS =
  "border-white/[0.14] bg-[#131316] hover:border-white/[0.24] hover:bg-[#232327]";
const EFFECT_TILE_SELECTED_CLASS =
  "border-[#F95F4A] bg-[#232327] hover:border-[#F95F4A] hover:bg-[#232327]";
const EFFECT_TILE_DISABLED_CLASS =
  "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-white/[0.14] disabled:hover:bg-[#131316]";

const PANEL_STYLES = `
.effectspanel-scroll { scrollbar-width: thin; scrollbar-color: rgba(250,250,250,0.18) transparent; }
.effectspanel-scroll::-webkit-scrollbar { width: 4px; height: 0; }
.effectspanel-scroll::-webkit-scrollbar-track { background: transparent; }
.effectspanel-scroll::-webkit-scrollbar-thumb { background: rgba(250,250,250,0.18); border-radius: 2px; }
.effectspanel-tab[aria-selected="true"] { color: ${color.text}; border-color: ${color.accent}; }
.effectspanel-tab[aria-selected="false"] { color: ${color.textMuted}; border-color: transparent; }
.effectspanel-tab[aria-selected="false"]:hover { color: ${color.text}; background: ${color.surfaceRaised}; }
`;

const getEffectTileClassName = (selected: boolean, extraClassName = "") =>
  [
    EFFECT_TILE_BASE_CLASS,
    selected ? EFFECT_TILE_SELECTED_CLASS : EFFECT_TILE_IDLE_CLASS,
    EFFECT_TILE_DISABLED_CLASS,
    extraClassName,
  ]
    .filter(Boolean)
    .join(" ");

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
  busy = false,
  testId,
  onPrewarm,
  onSelect,
}: {
  option: VideoEffectOption<T>;
  selected: boolean;
  disabled?: boolean;
  busy?: boolean;
  testId?: string;
  onPrewarm?: () => void;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  const isMotionOption = option.motion === true;
  const previewPath = getVideoEffectPreviewPath(option);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onSelect}
      onFocus={disabled ? undefined : onPrewarm}
      onPointerEnter={disabled ? undefined : onPrewarm}
      onTouchStart={disabled ? undefined : onPrewarm}
      aria-pressed={selected}
      aria-label={option.ariaLabel ?? option.label}
      aria-busy={busy ? "true" : undefined}
      disabled={disabled}
      className={getEffectTileClassName(selected)}
    >
      <span
        className={`relative flex items-center justify-center overflow-hidden rounded-lg border border-white/[0.14] bg-[#0a0a0b] ${
          previewPath
            ? "h-14 w-full bg-cover bg-center"
            : "h-10 w-10"
        }`}
        style={
          previewPath
            ? {
                backgroundColor: option.tone,
                backgroundImage: `url("${previewPath}")`,
              }
            : { backgroundColor: option.tone }
        }
      >
        {previewPath ? (
          <span className="h-full w-full bg-gradient-to-t from-black/35 via-black/5 to-transparent" />
        ) : (
          <Icon size={18} strokeWidth={ICON_STROKE} className="text-white" />
        )}
        {isMotionOption ? (
          <span className="pointer-events-none absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-[#F95F4A]" />
        ) : null}
        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center bg-black/45">
            <LoaderCircle
              size={17}
              strokeWidth={ICON_STROKE}
              className="animate-spin text-white"
            />
          </span>
        ) : null}
      </span>
      <span className="mt-2 flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-[12px] font-medium leading-tight text-[#fafafa]">
            {option.label}
          </span>
          {option.description ? (
            <span className="mt-1 block text-[11px] leading-tight text-[#a1a1aa]">
              {option.description}
            </span>
          ) : null}
        </span>
        {selected ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F95F4A] text-white">
            <Check size={13} strokeWidth={2} />
          </span>
        ) : null}
      </span>
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
      className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-[120ms] hover:bg-[#232327] active:bg-[#2e2e33] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[#fafafa]">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-snug text-[#a1a1aa]">
            {description}
          </span>
        ) : null}
      </span>
      <span
        className={`relative h-6 w-10 rounded-full border transition-colors ${
          checked
            ? "border-[#F95F4A] bg-[#F95F4A]"
            : "border-white/[0.14] bg-[#131316]"
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
    <section className="border-t border-white/[0.14] px-4 py-3 first:border-t-0">
      <h3
        className="mb-2 text-[12px] font-medium"
        style={{ color: SECTION_LABEL }}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function VideoEffectsPreview({
  stream,
  isCameraOff,
  hasLiveVideo,
  isPreparing,
  preparingLabel,
  onToggleCamera,
  cameraToggleDisabled = false,
}: {
  stream: MediaStream | null;
  isCameraOff: boolean;
  hasLiveVideo: boolean;
  isPreparing: boolean;
  preparingLabel: string;
  onToggleCamera?: () => void;
  cameraToggleDisabled?: boolean;
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
    <div className="relative aspect-video overflow-hidden rounded-xl border border-white/[0.14] bg-[#0a0a0b]">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`h-full w-full scale-x-[-1] object-cover ${
          shouldShowVideo ? "" : "hidden"
        }`}
      />
      {!shouldShowVideo ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <span className="text-[15px] font-medium text-[#fafafa]">
            {isCameraOff ? "Camera is off" : "Camera unavailable"}
          </span>
          {onToggleCamera ? (
            <button
              type="button"
              onClick={onToggleCamera}
              disabled={cameraToggleDisabled}
              className="inline-flex items-center gap-2 rounded-full bg-[#F95F4A] px-4 py-2 text-[13px] font-medium text-white transition-[filter] duration-[120ms] hover:brightness-105 disabled:cursor-not-allowed disabled:bg-[#232327] disabled:text-[#fafafa]/40"
            >
              <Video size={16} strokeWidth={ICON_STROKE} />
              Turn on camera to preview
            </button>
          ) : null}
        </div>
      ) : null}
      {shouldShowVideo && onToggleCamera ? (
        <button
          type="button"
          onClick={onToggleCamera}
          aria-label="Turn off camera"
          title="Turn off camera"
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors duration-[120ms] hover:bg-black/70"
        >
          <VideoOff size={16} strokeWidth={ICON_STROKE} />
        </button>
      ) : null}
      {shouldShowVideo && isPreparing ? (
        <div className="absolute inset-0 flex items-end justify-center bg-black/[0.18] p-3">
          <div className="flex min-h-9 max-w-full items-center gap-2 rounded-full border border-white/[0.18] bg-[#111113]/90 px-3 text-[12px] font-medium text-[#fafafa] shadow-lg shadow-black/20">
            <LoaderCircle
              size={14}
              strokeWidth={ICON_STROKE}
              className="shrink-0 animate-spin text-[#F95F4A]"
            />
            <span className="truncate">{preparingLabel}</span>
          </div>
        </div>
      ) : null}
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
  onToggleCamera,
  onClose,
  variant = "dock",
  initialTab = "backgrounds",
  showFilters = true,
}: VideoEffectsPanelProps) {
  const isDialogVariant = variant === "dialog";
  const [activeTab, setActiveTab] = useState<EffectsTab>(initialTab);
  const [customBackgroundError, setCustomBackgroundError] = useState<string | null>(
    null,
  );
  const [customBackgrounds, setCustomBackgrounds] = useState<
    CustomVideoBackgroundSummary[]
  >([]);
  const customBackgroundInputRef = useRef<HTMLInputElement | null>(null);
  const appearanceStyleControlsVisible = !cameraPermissionBlocked;
  const studioLookControlVisible = !cameraPermissionBlocked;
  const backgroundGroups = useMemo(
    () =>
      groupOptions(
        BACKGROUND_EFFECTS.filter((option) => option.id !== "custom"),
      ),
    [],
  );
  const permissionBlockedBackgroundGroups = useMemo<BackgroundEffectGroup[]>(
    () => [
      [
        "Blur",
        BACKGROUND_EFFECTS.filter(
          (option) =>
            option.id === "blur-light" || option.id === "blur-strong",
        ),
      ],
    ],
    [],
  );
  const visibleBackgroundGroups = cameraPermissionBlocked
    ? permissionBlockedBackgroundGroups
    : backgroundGroups;
  const filterGroups = useMemo(() => groupOptions(FACE_FILTERS), []);
  const appearanceGroups = useMemo(() => groupOptions(APPEARANCE_STYLES), []);
  const availableTabs = useMemo(
    () => (!showFilters ? TABS.filter((tab) => tab.id !== "filters") : TABS),
    [showFilters],
  );
  const tabGridClassName =
    availableTabs.length === 2
      ? "grid grid-cols-2 border-b border-white/[0.14] px-4"
      : "grid grid-cols-3 border-b border-white/[0.14] px-4";
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
  const selectedBackgroundLabel =
    effects.background === "custom"
      ? effects.customBackgroundName || "uploaded image"
      : backgroundOptionById.get(effects.background)?.label ?? "background";
  const selectedFilterLabel =
    filterOptionById.get(effects.filter)?.label ?? "filter";
  const selectedStyleLabel =
    appearanceOptionById.get(effects.style)?.label ?? "appearance";
  const preparingLabel =
    effects.filter !== "none"
      ? `Applying ${selectedFilterLabel}`
      : effects.background !== "none"
        ? `Applying ${selectedBackgroundLabel}`
        : effects.style !== "none"
          ? `Applying ${selectedStyleLabel}`
          : effects.studioLook
            ? "Applying touch-up"
            : effects.studioLighting
              ? "Applying lighting"
              : effects.framing
                ? "Applying framing"
                : "Preparing effects";
  const isPreparingEffects = status === "loading" && activeCount > 0;

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
        faceFilter: filter,
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
      if (cameraPermissionBlocked && key === "studioLook") return;
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
    if (
      appearanceStyleControlsVisible &&
      appearanceOption &&
      effects.style !== "none"
    ) {
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
    if (studioLookControlVisible && effects.studioLook) {
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
    appearanceStyleControlsVisible,
    backgroundOptionById,
    effects,
    filterOptionById,
    onEffectsChange,
    showFilters,
    studioLookControlVisible,
  ]);

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

  useEffect(() => {
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: showFilters,
      faceFilter:
        showFilters && effects.filter !== "none" ? effects.filter : undefined,
      reason: "effects-panel-open",
    });
  }, [effects.filter, showFilters]);

  useEffect(() => {
    if (activeTab === "filters") {
      prewarmFace("effects-panel-filters-tab");
    } else if (activeTab === "appearance" && !cameraPermissionBlocked) {
      prewarmFace("effects-panel-appearance-tab");
    }
  }, [activeTab, cameraPermissionBlocked, prewarmFace]);

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
      faceFilterLandmarkCount: debugStats.faceFilterLandmarkCount,
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
      sourceTrack: debugStats.sourceTrack,
      outputTrack: debugStats.outputTrack,
      effects: debugStats.effects,
      meetVideoPipe: debugStats.meetVideoPipe,
      latestSegmentationMaskAgeMs: debugStats.latestSegmentationMaskAgeMs,
      latestFaceLandmarksAgeMs: debugStats.latestFaceLandmarksAgeMs,
      latestFaceFilterLandmarksAgeMs:
        debugStats.latestFaceFilterLandmarksAgeMs,
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
    isDialogVariant
      ? "video-effects-panel-dialog fixed z-50 flex flex-col overflow-hidden text-[#fafafa]"
      : "fixed right-0 top-0 bottom-0 z-40 flex w-[380px] flex-col overflow-hidden border-l border-white/[0.14] bg-[#18181b] text-[#fafafa] animate-[meet-panel-in_120ms_cubic-bezier(0.22,1,0.36,1)]";

  const panel = (
    <aside
      data-testid="video-effects-panel"
      data-video-effects-variant={variant}
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
      style={{
        backgroundColor: isDialogVariant ? undefined : color.surface,
        color: color.text,
        fontFamily: PANEL_FONT,
      }}
    >
      <style>{PANEL_STYLES}</style>
      {isDialogVariant ? (
        <div
          aria-hidden
          className="video-effects-panel-grabber-wrap sm:hidden"
        >
          <div className="mx-auto mobile-sheet-grabber" />
        </div>
      ) : null}
      <header className="flex items-center justify-between border-b border-white/[0.14] px-4 py-3.5">
        <h2 className="truncate text-[15px] font-semibold text-[#fafafa]">
          Backgrounds and effects
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close backgrounds and effects"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-[#232327] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={ICON_STROKE} />
        </button>
      </header>

      <div className="border-b border-white/[0.14] px-4 py-4">
        <VideoEffectsPreview
          stream={localStream}
          isCameraOff={isCameraOff}
          hasLiveVideo={hasLiveVideo}
          isPreparing={isPreparingEffects}
          preparingLabel={preparingLabel}
          onToggleCamera={onToggleCamera}
          cameraToggleDisabled={cameraPermissionBlocked}
        />
        {cameraUnavailable ? (
          <div className="mt-3 rounded-xl border border-white/[0.14] bg-[#131316] px-3 py-2 text-[12px] leading-snug text-[#fafafa]/74">
            {cameraPermissionBlocked
              ? "Camera blocked"
              : "Your camera is off. Effects apply once you turn it on."}
          </div>
        ) : null}
        {error ? (
          <div className="mt-2 rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 py-2 text-[12px] leading-snug text-[#fafafa]">
            {error}
          </div>
        ) : null}
        {customBackgroundError ? (
          <div className="mt-2 rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 py-2 text-[12px] leading-snug text-[#fafafa]">
            {customBackgroundError}
          </div>
        ) : null}
        {activeEffectStack.length > 0 ? (
          <div
            aria-label="Active visual effects"
            className="mt-3 flex flex-wrap items-center gap-1.5"
            data-video-effects-active-stack="true"
            data-video-effects-active-stack-open="true"
          >
            {activeEffectStack.map((item) => (
              <span
                key={item.key}
                data-video-effects-active-item={item.key}
                className="inline-flex items-center overflow-hidden rounded-full border border-white/[0.14] bg-[#131316]"
              >
                <button
                  type="button"
                  onClick={() => setActiveTab(item.tab)}
                  title={`Edit ${item.label}`}
                  className="max-w-[170px] truncate py-1.5 pl-3 pr-1 text-[12px] font-medium text-[#fafafa] transition-colors duration-[120ms] hover:text-white"
                >
                  {item.label}
                </button>
                <button
                  type="button"
                  onClick={item.remove}
                  aria-label={`Remove ${item.label}`}
                  title={`Remove ${item.label}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center text-[#a1a1aa] transition-colors duration-[120ms] hover:text-[#fafafa]"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </span>
            ))}
            <button
              type="button"
              aria-label="Remove all visual effects"
              onClick={() => onEffectsChange(DEFAULT_VIDEO_EFFECTS)}
              className="rounded-full px-2.5 py-1.5 text-[12px] font-medium text-[#F95F4A] transition-colors duration-[120ms] hover:bg-[#F95F4A]/[0.10]"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div className={tabGridClassName} role="tablist">
        {availableTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`video-effects-tabpanel-${tab.id}`}
            id={`video-effects-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className="effectspanel-tab border-b-2 px-2 py-3 text-[13px] font-medium transition-colors duration-[120ms]"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="effectspanel-scroll min-h-0 flex-1 overflow-y-auto pb-6">
        {activeTab === "backgrounds" ? (
          <div
            id="video-effects-tabpanel-backgrounds"
            role="tabpanel"
            aria-labelledby="video-effects-tab-backgrounds"
          >
            {!cameraPermissionBlocked ? (
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
                    className={getEffectTileClassName(
                      false,
                      "border-dashed border-white/[0.24] hover:border-[#F95F4A]",
                    )}
                  >
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-xl"
                      style={{ backgroundColor: EFFECTS_ACCENT }}
                    >
                      <ImagePlus
                        size={18}
                        strokeWidth={ICON_STROKE}
                        className="text-white"
                      />
                    </span>
                    <span className="mt-2 block text-[12px] font-medium leading-tight text-[#fafafa]">
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
                        onClick={() =>
                          void selectStoredCustomBackground(background)
                        }
                        className={getEffectTileClassName(selected)}
                      >
                        <span
                          className="flex h-14 w-full items-center justify-center overflow-hidden rounded-lg border border-white/[0.14] bg-cover bg-center"
                          style={{
                            backgroundColor: EFFECTS_ACCENT,
                            backgroundImage: `url("${background.thumbnailDataUrl}")`,
                          }}
                        >
                          <span className="h-full w-full bg-gradient-to-t from-black/35 via-black/5 to-transparent" />
                        </span>
                        <span className="mt-2 block truncate text-[12px] font-medium leading-tight text-[#fafafa]">
                          {background.name}
                        </span>
                        {selected ? (
                          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#F95F4A] text-white">
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
                        applyEffectsChange((current) => ({
                          ...current,
                          background: "custom",
                        }));
                      }}
                      className={getEffectTileClassName(
                        effects.background === "custom",
                      )}
                    >
                      <span
                        className="flex h-14 w-full items-center justify-center overflow-hidden rounded-lg border border-white/[0.14] bg-cover bg-center"
                        style={{
                          backgroundColor: EFFECTS_ACCENT,
                          backgroundImage: `url("${effects.customBackgroundDataUrl}")`,
                        }}
                      >
                        <span className="h-full w-full bg-gradient-to-t from-black/35 via-black/5 to-transparent" />
                      </span>
                      <span className="mt-2 block truncate text-[12px] font-medium leading-tight text-[#fafafa]">
                        {effects.customBackgroundName || "Uploaded image"}
                      </span>
                      {effects.background === "custom" ? (
                        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#F95F4A] text-white">
                          <Check size={13} strokeWidth={2} />
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                  {effects.customBackgroundDataUrl ||
                  effects.customBackgroundId ? (
                    <div className="grid gap-2">
                      <button
                        type="button"
                        data-testid="custom-background-change"
                        onClick={() => {
                          customBackgroundInputRef.current?.click();
                        }}
                        className="min-h-[38px] rounded-xl border border-white/[0.14] bg-[#131316] px-3 text-left text-[12px] font-medium text-[#fafafa] transition-colors duration-[120ms] hover:border-white/[0.24] hover:bg-[#232327] disabled:cursor-not-allowed disabled:text-[#71717a] disabled:hover:bg-transparent"
                      >
                        Change image
                      </button>
                      <button
                        type="button"
                        data-testid="custom-background-remove"
                        onClick={removeCustomBackground}
                        className="min-h-[38px] rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 text-left text-[12px] font-medium text-[#F95F4A] transition-colors duration-[120ms] hover:bg-[#F95F4A]/[0.20] disabled:cursor-not-allowed disabled:border-white/[0.14] disabled:bg-[#131316] disabled:text-[#71717a]"
                      >
                        Remove image
                      </button>
                    </div>
                  ) : null}
                </div>
              </Section>
            ) : null}
            {visibleBackgroundGroups.map(([label, options]) => (
              <Section key={label} label={label}>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <EffectOptionButton
                      key={option.id}
                      option={option}
                      selected={effects.background === option.id}
                      busy={
                        isPreparingEffects && effects.background === option.id
                      }
                      testId={`video-effects-background-${option.id}`}
                      onPrewarm={() => prewarmForBackground(option.id)}
                      onSelect={() => setBackground(option.id)}
                    />
                  ))}
                </div>
              </Section>
            ))}
          </div>
        ) : null}

        {activeTab === "filters" ? (
          <div
            id="video-effects-tabpanel-filters"
            role="tabpanel"
            aria-labelledby="video-effects-tab-filters"
          >
            {filterGroups.map(([label, options]) => (
              <Section key={label} label={label}>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <EffectOptionButton
                      key={option.id}
                      option={option}
                      selected={effects.filter === option.id}
                      busy={isPreparingEffects && effects.filter === option.id}
                      testId={`video-effects-filter-${option.id}`}
                      onPrewarm={() =>
                        option.id === "none"
                          ? undefined
                          : void prewarmVideoEffectsAssets({
                              faceFilter: option.id,
                              reason: `filter:${option.id}:hover`,
                            })
                      }
                      onSelect={() => setFilter(option.id)}
                    />
                  ))}
                </div>
              </Section>
            ))}
          </div>
        ) : null}

        {activeTab === "appearance" ? (
          <div
            id="video-effects-tabpanel-appearance"
            role="tabpanel"
            aria-labelledby="video-effects-tab-appearance"
          >
            {studioLookControlVisible ? (
              <Section label="Appearance">
                <div className="grid gap-1">
                  <ToggleRow
                    label="Touch-up appearance"
                    checked={effects.studioLook}
                    testId="video-effects-appearance-studio-look"
                    onChange={setToggle("studioLook")}
                  />
                </div>
              </Section>
            ) : null}

            <Section label="Lighting and framing">
              <div className="grid gap-1">
                <ToggleRow
                  label="Adjust video lighting"
                  description="Makes it easier to see you against a bright background"
                  checked={effects.studioLighting}
                  testId="video-effects-appearance-studio-lighting"
                  onChange={setToggle("studioLighting")}
                />
                <div className="h-px bg-white/[0.14]" />
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
                  className="ml-12 min-h-9 rounded-full border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-4 text-left text-[13px] font-medium text-[#fafafa] transition-colors duration-[120ms] hover:bg-[#F95F4A]/[0.20] disabled:cursor-not-allowed disabled:border-white/[0.14] disabled:bg-[#131316] disabled:text-[#71717a]"
                >
                  Recenter
                </button>
              </div>
            </Section>

            {appearanceStyleControlsVisible
              ? appearanceGroups.map(([label, options]) => (
                  <Section key={label} label={label}>
                    <div className="grid grid-cols-2 gap-2">
                      {options.map((option) => (
                        <EffectOptionButton
                          key={option.id}
                          option={option}
                          selected={effects.style === option.id}
                          busy={
                            isPreparingEffects && effects.style === option.id
                          }
                          testId={`video-effects-appearance-style-${option.id}`}
                          onSelect={() => setStyle(option.id)}
                        />
                      ))}
                    </div>
                  </Section>
                ))
              : null}
          </div>
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
          className="video-effects-panel-overlay fixed inset-0 z-40 cursor-default bg-black/65 backdrop-blur-sm"
          onClick={onClose}
        />
        {panel}
      </>
    );
  }

  return panel;
}
