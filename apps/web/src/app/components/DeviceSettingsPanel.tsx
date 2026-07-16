"use client";

import {
  AudioLines,
  Camera,
  ChevronDown,
  FlipHorizontal2,
  LoaderCircle,
  Mic,
  Play,
  ScanFace,
  Square,
  Video,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { color, font } from "@conclave/ui-tokens";
import { SwitchRow } from "@conclave/ui-tokens/web";
import type {
  ConnectionQuality,
  ConnectionQualityStats,
  MediaTrackQualityStats,
} from "../hooks/useConnectionQuality";
import { useMicTest, playSpeakerTestSound } from "../hooks/useMicTest";
import type {
  ClonedTtsVoice,
  TtsSystemVoiceOption,
} from "../hooks/useMeetTts";
import { useEnumeratedDevices } from "./DeviceCaretMenu";
import TtsVoiceSettings from "./TtsVoiceSettings";

type SettingsTab = "video" | "audio" | "connection";

interface DeviceSettingsPanelProps {
  /** Video source for the preview tile: the published stream when the camera
   * is on, otherwise the private local-only preview. */
  localStream: MediaStream | null;
  /** True when the real meeting camera is live (preview shows what others see). */
  isLocalVideoLive: boolean;
  /** True when the preview tile is showing the private local-only capture. */
  isPreviewOnly: boolean;
  mirrorLocalPreview: boolean;
  isMirrorCamera?: boolean;
  onToggleMirror?: () => void;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  ttsSystemVoices?: TtsSystemVoiceOption[];
  selectedTtsSystemVoiceUri?: string | null;
  onTtsSystemVoiceChange?: (voiceUri: string | null) => void;
  clonedTtsVoice?: ClonedTtsVoice | null;
  onClonedTtsVoiceChange?: (voice: ClonedTtsVoice) => void;
  onClonedTtsVoiceClear?: () => void;
  canCloneTtsVoice?: boolean;
  ttsVoiceOwnerName?: string;
  selectedVideoInputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onVideoInputDeviceChange?: (deviceId: string) => void;
  isNoiseCancellationEnabled?: boolean;
  onToggleNoiseCancellation?: () => void;
  isCameraPreviewStarting?: boolean;
  cameraPreviewError?: string | null;
  onStartCameraPreview?: () => void;
  onStopCameraPreview?: () => void;
  connectionStats?: ConnectionQualityStats;
  isCameraPermissionBlocked?: boolean;
  onOpenEffects?: () => void;
  initialTab?: SettingsTab;
  onClose: () => void;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "connection", label: "Connection" },
];

const ICON_STROKE = 1.75;
const METER_SEGMENTS = 14;

const PANEL_STYLES = `
.devicesettings-scroll { scrollbar-width: thin; scrollbar-color: rgba(250,250,250,0.18) transparent; }
.devicesettings-scroll::-webkit-scrollbar { width: 4px; height: 0; }
.devicesettings-scroll::-webkit-scrollbar-track { background: transparent; }
.devicesettings-scroll::-webkit-scrollbar-thumb { background: rgba(250,250,250,0.18); border-radius: 2px; }
.devicesettings-tab[aria-selected="true"] { color: ${color.text}; border-color: ${color.accent}; }
.devicesettings-tab[aria-selected="false"] { color: ${color.textMuted}; border-color: transparent; }
.devicesettings-tab[aria-selected="false"]:hover { color: ${color.text}; background: ${color.surfaceRaised}; }
`;

const QUALITY_META: Record<
  ConnectionQuality,
  { label: string; tone: string }
> = {
  good: { label: "Good", tone: "#32d583" },
  fair: { label: "Fair", tone: color.warning },
  poor: { label: "Poor", tone: "#f97066" },
  unknown: { label: "Measuring", tone: color.textFaint },
};

const formatMs = (value: number) => `${Math.round(value)} ms`;

const formatLossFraction = (value: number) => {
  const percent = value * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
};

const formatBitrate = (bps: number) => {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.max(1, Math.round(bps / 1000))} kbps`;
};

const formatVideoDetail = (stats: MediaTrackQualityStats) => {
  if (!stats.frameWidth || !stats.frameHeight) return null;
  const fps = stats.framesPerSecond;
  return `${stats.frameWidth}×${stats.frameHeight}${
    fps ? ` · ${Math.round(fps)} fps` : ""
  }`;
};

const formatCodec = (mimeType: string | null) => {
  if (!mimeType) return null;
  if (mimeType === "mixed") return "mixed";
  return mimeType.split("/").pop()?.toUpperCase() ?? mimeType;
};

function QualityPill({ quality }: { quality: ConnectionQuality }) {
  const meta = QUALITY_META[quality];
  return (
    <span
      className="text-[12px] font-semibold"
      style={{ color: meta.tone }}
    >
      {meta.label}
    </span>
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
    <section
      className="border-t px-4 py-3.5 first:border-t-0"
      style={{ borderColor: color.border }}
    >
      <h3
        className="mb-2.5 text-[12px] font-medium"
        style={{ color: color.textFaint }}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

/** Native select styled to match the prejoin device pickers. */
function DeviceSelect({
  icon: Icon,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  emptyLabel,
}: {
  icon: LucideIcon;
  value?: string;
  options: { deviceId: string; label: string }[];
  onChange?: (deviceId: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  emptyLabel: string;
}) {
  if (!options.length || !onChange) {
    return (
      <div
        className="flex h-10 items-center gap-2.5 rounded-xl border px-3 text-[12.5px]"
        style={{ borderColor: color.border, color: color.textFaint }}
      >
        <Icon size={15} strokeWidth={ICON_STROKE} className="shrink-0" />
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="relative">
      <Icon
        size={15}
        strokeWidth={ICON_STROKE}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
      />
      <select
        aria-label={ariaLabel}
        value={value || options[0]?.deviceId || ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-9 text-[13px] text-[#fafafa] transition-colors duration-[120ms] hover:bg-white/[0.05] focus:border-[#F95F4A]/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        {options.map((option) => (
          <option
            key={option.deviceId}
            value={option.deviceId}
            className="bg-[#18181b] text-[#fafafa]"
          >
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
      />
    </div>
  );
}

/** Segmented input-level meter driven off levelRef via rAF — no re-renders. */
function MicLevelMeter({
  levelRef,
  active,
}: {
  levelRef: React.MutableRefObject<number>;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    let rafId: number | null = null;
    const segments = Array.from(container.children) as HTMLElement[];
    const paint = () => {
      const level = levelRef.current;
      const lit = Math.round(level * METER_SEGMENTS);
      segments.forEach((segment, index) => {
        const isLit = index < lit;
        const isHot = index >= METER_SEGMENTS - 2;
        segment.style.backgroundColor = isLit
          ? isHot
            ? "#f97066"
            : "#32d583"
          : "rgba(250, 250, 250, 0.12)";
      });
      rafId = window.requestAnimationFrame(paint);
    };
    rafId = window.requestAnimationFrame(paint);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      segments.forEach((segment) => {
        segment.style.backgroundColor = "rgba(250, 250, 250, 0.12)";
      });
    };
  }, [levelRef, active]);

  return (
    <div
      ref={containerRef}
      data-testid="mic-level-meter"
      aria-hidden
      className="flex h-2.5 items-stretch gap-[3px]"
    >
      {Array.from({ length: METER_SEGMENTS }, (_, index) => (
        <span
          key={index}
          className="min-w-0 flex-1 rounded-[2px]"
          style={{ backgroundColor: "rgba(250, 250, 250, 0.12)" }}
        />
      ))}
    </div>
  );
}

function PreviewVideo({
  stream,
  mirrored,
}: {
  stream: MediaStream | null;
  mirrored: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      if (video?.srcObject) video.srcObject = null;
      return;
    }
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.play().catch(() => {});
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className={`h-full w-full object-cover ${mirrored ? "scale-x-[-1]" : ""}`}
    />
  );
}

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[12px]" style={{ color: color.textMuted }}>
        {label}
      </span>
      <span
        className="text-[12.5px] font-medium tabular-nums"
        style={{ color: color.text }}
      >
        {value}
      </span>
    </div>
  );
}

function DirectionCard({
  title,
  quality,
  rttMs,
  packetLoss,
  jitterMs,
  availableBitrate,
  availableLabel,
  media,
}: {
  title: string;
  quality: ConnectionQuality;
  rttMs: number | null;
  packetLoss: number | null;
  jitterMs: number | null;
  availableBitrate: number | null;
  availableLabel: string;
  media: { audio: MediaTrackQualityStats; video: MediaTrackQualityStats };
}) {
  const videoDetail = formatVideoDetail(media.video);
  const videoCodec = formatCodec(media.video.codecMimeType);
  const limitation = media.video.bandwidthLimited
    ? "Limited by bandwidth"
    : media.video.cpuLimited
      ? "Limited by CPU"
      : null;
  const hasAnyStat =
    rttMs != null ||
    packetLoss != null ||
    jitterMs != null ||
    media.video.bitrateBps != null ||
    media.audio.bitrateBps != null ||
    availableBitrate != null;
  return (
    <div
      className="rounded-xl border p-3"
      style={{ borderColor: color.border, backgroundColor: color.bgAlt }}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className="text-[12.5px] font-semibold"
          style={{ color: color.text }}
        >
          {title}
        </span>
        <QualityPill quality={quality} />
      </div>
      {!hasAnyStat ? (
        <p className="py-1 text-[12px]" style={{ color: color.textFaint }}>
          No data yet
        </p>
      ) : null}
      {rttMs != null ? (
        <StatRow label="Latency" value={formatMs(rttMs)} />
      ) : null}
      {packetLoss != null ? (
        <StatRow label="Packet loss" value={formatLossFraction(packetLoss)} />
      ) : null}
      {jitterMs != null ? (
        <StatRow label="Jitter" value={formatMs(jitterMs)} />
      ) : null}
      {media.video.bitrateBps != null ? (
        <StatRow
          label="Video bitrate"
          value={formatBitrate(media.video.bitrateBps)}
        />
      ) : null}
      {videoDetail ? <StatRow label="Video" value={videoDetail} /> : null}
      {videoCodec ? <StatRow label="Video codec" value={videoCodec} /> : null}
      {media.audio.bitrateBps != null ? (
        <StatRow
          label="Audio bitrate"
          value={formatBitrate(media.audio.bitrateBps)}
        />
      ) : null}
      {availableBitrate != null ? (
        <StatRow label={availableLabel} value={formatBitrate(availableBitrate)} />
      ) : null}
      {limitation ? (
        <p className="mt-1.5 text-[11.5px]" style={{ color: color.warning }}>
          {limitation}
        </p>
      ) : null}
    </div>
  );
}

export default function DeviceSettingsPanel({
  localStream,
  isLocalVideoLive,
  isPreviewOnly,
  mirrorLocalPreview,
  isMirrorCamera,
  onToggleMirror,
  selectedAudioInputDeviceId,
  selectedAudioOutputDeviceId,
  ttsSystemVoices = [],
  selectedTtsSystemVoiceUri,
  onTtsSystemVoiceChange,
  clonedTtsVoice,
  onClonedTtsVoiceChange,
  onClonedTtsVoiceClear,
  canCloneTtsVoice = false,
  ttsVoiceOwnerName = "My voice",
  selectedVideoInputDeviceId,
  onAudioInputDeviceChange,
  onAudioOutputDeviceChange,
  onVideoInputDeviceChange,
  isNoiseCancellationEnabled,
  onToggleNoiseCancellation,
  isCameraPreviewStarting = false,
  cameraPreviewError = null,
  onStartCameraPreview,
  onStopCameraPreview,
  connectionStats,
  isCameraPermissionBlocked = false,
  onOpenEffects,
  initialTab = "video",
  onClose,
}: DeviceSettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [isPlayingTestSound, setIsPlayingTestSound] = useState(false);
  const hasLiveVideo = Boolean(
    localStream
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  );

  const micTest = useMicTest({
    active: activeTab === "audio",
    deviceId: selectedAudioInputDeviceId,
    noiseCancellation: isNoiseCancellationEnabled ?? true,
    outputDeviceId: selectedAudioOutputDeviceId,
  });

  // Device labels only become readable after a capture permission is granted;
  // refetch once the mic test or camera preview comes up.
  const devices = useEnumeratedDevices(
    true,
    `${micTest.isRunning}:${hasLiveVideo}`,
  );

  // The video tab is the camera test: bring up the private preview on entry
  // (unless the real camera already covers it) and drop it when leaving.
  useEffect(() => {
    if (activeTab !== "video") return;
    if (isLocalVideoLive || isPreviewOnly) return;
    if (isCameraPermissionBlocked || isCameraPreviewStarting) return;
    if (cameraPreviewError) return;
    onStartCameraPreview?.();
  }, [
    activeTab,
    isLocalVideoLive,
    isPreviewOnly,
    isCameraPermissionBlocked,
    isCameraPreviewStarting,
    cameraPreviewError,
    onStartCameraPreview,
  ]);

  useEffect(() => {
    if (activeTab === "video") return;
    // Unconditional: also cancels an in-flight preview start, so switching
    // tabs mid-acquisition can't leave a hidden capture running. Stopping is
    // a no-op for the real camera — it only ends the private preview.
    onStopCameraPreview?.();
  }, [activeTab, onStopCameraPreview]);

  const handlePlayTestSound = useCallback(() => {
    if (isPlayingTestSound) return;
    setIsPlayingTestSound(true);
    void playSpeakerTestSound(selectedAudioOutputDeviceId).finally(() => {
      setIsPlayingTestSound(false);
    });
  }, [isPlayingTestSound, selectedAudioOutputDeviceId]);

  const loopbackLabel =
    micTest.loopbackPhase === "recording"
      ? `Recording ${micTest.loopbackSecondsLeft}s, click to replay`
      : micTest.loopbackPhase === "playing"
        ? "Stop playback"
        : "Record and replay";

  const overallQuality = connectionStats?.quality ?? "unknown";
  const connectionSummary =
    overallQuality === "good"
      ? "Your connection looks good."
      : overallQuality === "fair"
        ? "Your connection is a little unstable."
        : overallQuality === "poor"
          ? "Your connection is struggling. Quality is reduced automatically."
          : "Measuring your connection";

  return (
    <aside
      data-testid="device-settings-panel"
      aria-label="Settings"
      className="safe-area-pt safe-area-pb fixed bottom-0 right-0 top-0 z-40 flex w-full flex-col overflow-hidden border-l text-[#fafafa] animate-[meet-panel-in_120ms_cubic-bezier(0.22,1,0.36,1)] sm:w-[380px]"
      style={{
        backgroundColor: color.surface,
        borderColor: color.border,
        color: color.text,
        fontFamily: font.sans,
      }}
    >
      <style>{PANEL_STYLES}</style>
      <header
        className="flex items-center justify-between border-b px-4 py-3.5"
        style={{ borderColor: color.border }}
      >
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">Settings</h2>
          {/* <p className="mt-0.5 text-[11.5px]" style={{ color: color.textFaint }}>
            Device choices stay local. Voice clones are shared only with /tts.
          </p> */}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-[#232327] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={ICON_STROKE} />
        </button>
      </header>

      <div
        className="grid grid-cols-3 border-b px-4"
        style={{ borderColor: color.border }}
        role="tablist"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`device-settings-tabpanel-${tab.id}`}
            id={`device-settings-tab-${tab.id}`}
            data-testid={`device-settings-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className="devicesettings-tab border-b-2 px-2 py-3 text-[13px] font-medium transition-colors duration-[120ms]"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="devicesettings-scroll min-h-0 flex-1 overflow-y-auto pb-6">
        {activeTab === "video" ? (
          <div
            id="device-settings-tabpanel-video"
            role="tabpanel"
            aria-labelledby="device-settings-tab-video"
          >
            <Section label="Camera">
              <div className="relative aspect-video overflow-hidden rounded-xl border border-white/[0.14] bg-[#0a0a0b]">
                {hasLiveVideo ? (
                  <PreviewVideo
                    stream={localStream}
                    mirrored={mirrorLocalPreview}
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
                    {isCameraPreviewStarting ? (
                      <LoaderCircle
                        size={20}
                        strokeWidth={ICON_STROKE}
                        className="animate-spin text-[#F95F4A]"
                      />
                    ) : (
                      <>
                        <span className="text-[14px] font-medium">
                          {isCameraPermissionBlocked
                            ? "Camera access is blocked"
                            : "Camera is off"}
                        </span>
                        {isCameraPermissionBlocked ? (
                          <span
                            className="text-[12px] leading-snug"
                            style={{ color: color.textMuted }}
                          >
                            Allow camera access in your browser.
                          </span>
                        ) : onStartCameraPreview ? (
                          <button
                            type="button"
                            data-testid="device-settings-start-preview"
                            onClick={onStartCameraPreview}
                            className="inline-flex items-center gap-2 rounded-full bg-[#F95F4A] px-4 py-2 text-[13px] font-medium text-white transition-[filter] duration-[120ms] hover:brightness-105"
                          >
                            <Video size={16} strokeWidth={ICON_STROKE} />
                            Start preview
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
                {hasLiveVideo ? (
                  <span
                    data-testid="device-settings-preview-badge"
                    className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-[#fafafa] backdrop-blur-sm"
                  >
                    {isPreviewOnly ? "Only visible to you" : "Visible to everyone"}
                  </span>
                ) : null}
              </div>
              {cameraPreviewError ? (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 py-2">
                  <span className="text-[12px] leading-snug">
                    {cameraPreviewError}
                  </span>
                  {onStartCameraPreview ? (
                    <button
                      type="button"
                      onClick={onStartCameraPreview}
                      className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#F95F4A] transition-colors duration-[120ms] hover:bg-[#F95F4A]/[0.14]"
                    >
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-2.5">
                <DeviceSelect
                  icon={Camera}
                  ariaLabel="Camera"
                  value={selectedVideoInputDeviceId}
                  options={devices.videoInput}
                  onChange={onVideoInputDeviceChange}
                  emptyLabel="No cameras found"
                />
              </div>
              {onToggleMirror ? (
                <div className="mt-1.5">
                  <SwitchRow
                    icon={FlipHorizontal2}
                    label="Mirror my video"
                    checked={Boolean(isMirrorCamera)}
                    onChange={() => onToggleMirror()}
                    className="rounded-lg"
                  />
                </div>
              ) : null}
            </Section>

            {onOpenEffects ? (
              <Section label="Effects">
                <button
                  type="button"
                  data-testid="device-settings-open-effects"
                  onClick={onOpenEffects}
                  className="flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors duration-[120ms] hover:bg-white/[0.05]"
                  style={{ borderColor: color.border }}
                >
                  <ScanFace
                    size={17}
                    strokeWidth={ICON_STROKE}
                    className="shrink-0 text-[#F95F4A]"
                  />
                  <span className="min-w-0 flex-1 text-[13px] font-medium">
                    Backgrounds and effects
                  </span>
                </button>
              </Section>
            ) : null}
          </div>
        ) : null}

        {activeTab === "audio" ? (
          <div
            id="device-settings-tabpanel-audio"
            role="tabpanel"
            aria-labelledby="device-settings-tab-audio"
          >
            <Section label="Microphone">
              <DeviceSelect
                icon={Mic}
                ariaLabel="Microphone"
                value={selectedAudioInputDeviceId}
                options={devices.audioInput}
                onChange={onAudioInputDeviceChange}
                emptyLabel="No microphones found"
              />
              <div
                className="mt-2.5 rounded-xl border p-3"
                style={{ borderColor: color.border, backgroundColor: color.bgAlt }}
              >
                <p
                  className="mb-2 text-[12px]"
                  style={{ color: color.textMuted }}
                >
                  {micTest.isRunning
                    ? "Speak to test"
                    : micTest.error
                      ? "Microphone unavailable"
                      : "Starting microphone"}
                </p>
                <MicLevelMeter
                  levelRef={micTest.levelRef}
                  active={micTest.isRunning}
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <label
                    htmlFor="device-settings-test-gain"
                    className="text-[12px]"
                    style={{ color: color.textMuted }}
                  >
                    Test gain
                  </label>
                  <span
                    className="text-[11.5px] tabular-nums"
                    style={{ color: color.textFaint }}
                  >
                    {Math.round(micTest.gain * 100)}%
                  </span>
                </div>
                <input
                  id="device-settings-test-gain"
                  type="range"
                  min={0}
                  max={200}
                  step={5}
                  value={Math.round(micTest.gain * 100)}
                  onChange={(event) =>
                    micTest.setGain(Number(event.currentTarget.value) / 100)
                  }
                  aria-label="Microphone test gain"
                  className="mt-1 h-2 w-full accent-[#F95F4A]"
                  disabled={!micTest.isRunning}
                />
                <p
                  className="mt-1 text-[11px] leading-snug"
                  style={{ color: color.textFaint }}
                >
                  Affects this test only.
                </p>
                <button
                  type="button"
                  data-testid="device-settings-mic-loopback"
                  onClick={micTest.toggleLoopback}
                  disabled={!micTest.isRunning}
                  className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-[12.5px] font-medium transition-colors duration-[120ms] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: color.borderStrong, color: color.text }}
                >
                  {micTest.loopbackPhase === "idle" ? (
                    <Play size={14} strokeWidth={ICON_STROKE} />
                  ) : (
                    <Square size={13} strokeWidth={ICON_STROKE} />
                  )}
                  {loopbackLabel}
                </button>
              </div>
              {micTest.error ? (
                <div className="mt-2 rounded-xl border border-[#F95F4A]/30 bg-[#F95F4A]/[0.14] px-3 py-2 text-[12px] leading-snug">
                  {micTest.error}
                </div>
              ) : null}
              {onToggleNoiseCancellation ? (
                <div className="mt-1.5">
                  <SwitchRow
                    icon={AudioLines}
                    label="Noise cancellation"
                    checked={isNoiseCancellationEnabled ?? true}
                    onChange={() => onToggleNoiseCancellation()}
                    className="rounded-lg"
                  />
                  <p
                    className="px-1 text-[11px] leading-snug"
                    style={{ color: color.textFaint }}
                  >
                    Applies to your mic in the meeting. The test follows it.
                  </p>
                </div>
              ) : null}
            </Section>

            <Section label="Speaker">
              <DeviceSelect
                icon={Volume2}
                ariaLabel="Speaker"
                value={selectedAudioOutputDeviceId}
                options={devices.audioOutput}
                onChange={onAudioOutputDeviceChange}
                emptyLabel="Speaker selection is not available in this browser"
              />
              <button
                type="button"
                data-testid="device-settings-speaker-test"
                onClick={handlePlayTestSound}
                disabled={isPlayingTestSound}
                className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-[12.5px] font-medium transition-colors duration-[120ms] hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                style={{ borderColor: color.borderStrong, color: color.text }}
              >
                {isPlayingTestSound ? (
                  <LoaderCircle
                    size={14}
                    strokeWidth={ICON_STROKE}
                    className="animate-spin text-[#F95F4A]"
                  />
                ) : (
                  <Volume2 size={15} strokeWidth={ICON_STROKE} />
                )}
                {isPlayingTestSound ? "Playing" : "Play test sound"}
              </button>
            </Section>

            <Section label="Voice messages">
              <TtsVoiceSettings
                systemVoices={ttsSystemVoices}
                selectedSystemVoiceUri={selectedTtsSystemVoiceUri}
                onSystemVoiceChange={onTtsSystemVoiceChange}
                clonedVoice={clonedTtsVoice}
                onClonedVoiceChange={onClonedTtsVoiceChange}
                onClonedVoiceClear={onClonedTtsVoiceClear}
                getRecordingStream={micTest.getRecordingStream}
                canCloneVoice={canCloneTtsVoice}
                ownerName={ttsVoiceOwnerName}
                audioOutputDeviceId={selectedAudioOutputDeviceId}
              />
            </Section>
          </div>
        ) : null}

        {activeTab === "connection" ? (
          <div
            id="device-settings-tabpanel-connection"
            role="tabpanel"
            aria-labelledby="device-settings-tab-connection"
          >
            <Section label="Connection quality">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px]" style={{ color: color.text }}>
                  {connectionSummary}
                </span>
                <QualityPill quality={overallQuality} />
              </div>
              {connectionStats?.emergencyMode ? (
                <div className="mt-2 rounded-xl border px-3 py-2 text-[12px] leading-snug"
                  style={{
                    borderColor: "rgba(251, 191, 36, 0.35)",
                    backgroundColor: "rgba(251, 191, 36, 0.12)",
                    color: color.text,
                  }}
                >
                  Low bandwidth. Audio is being prioritized.
                </div>
              ) : null}
            </Section>

            {connectionStats ? (
              <Section label="Details">
                <div className="grid gap-2.5">
                  <DirectionCard
                    title="Upload"
                    quality={connectionStats.publishQuality}
                    rttMs={connectionStats.publishRttMs}
                    packetLoss={connectionStats.publishPacketLoss}
                    jitterMs={connectionStats.publishJitterMs}
                    availableBitrate={connectionStats.availableOutgoingBitrate}
                    availableLabel="Available bandwidth"
                    media={connectionStats.publishMedia}
                  />
                  <DirectionCard
                    title="Download"
                    quality={connectionStats.receiveQuality}
                    rttMs={connectionStats.receiveRttMs}
                    packetLoss={connectionStats.receivePacketLoss}
                    jitterMs={connectionStats.receiveJitterMs}
                    availableBitrate={connectionStats.availableIncomingBitrate}
                    availableLabel="Available bandwidth"
                    media={connectionStats.receiveMedia}
                  />
                </div>
              </Section>
            ) : (
              <Section label="Details">
                <p className="text-[12.5px]" style={{ color: color.textMuted }}>
                  Available once you are in the meeting.
                </p>
              </Section>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
