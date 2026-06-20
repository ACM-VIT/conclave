"use client";

import {
  Check,
  ChevronUp,
  FlipHorizontal2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  color,
  controlButtonColors,
  type ControlButtonVariant,
} from "@conclave/ui-tokens";
import { SwitchRow } from "@conclave/ui-tokens/web";
import HotkeyTooltip from "./HotkeyTooltip";

const ICON_SIZE = 20;
const CLUSTER_W = 104;
const SIDE_ZONE_W = 64;
const MAIN_ZONE_W = 72;
const CARET_CLICK_W = 40;

const IN_USE_TOGGLE = "#4F86F7";

type DeviceOption = { deviceId: string; label: string };

function useEnumeratedDevices(active: boolean) {
  const [audioInput, setAudioInput] = useState<DeviceOption[]>([]);
  const [audioOutput, setAudioOutput] = useState<DeviceOption[]>([]);
  const [videoInput, setVideoInput] = useState<DeviceOption[]>([]);

  const fetchDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setAudioInput([]);
      setAudioOutput([]);
      setVideoInput([]);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInput(
        devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      );
      setAudioOutput(
        devices
          .filter((d) => d.kind === "audiooutput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${i + 1}` })),
      );
      setVideoInput(
        devices
          .filter((d) => d.kind === "videoinput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` })),
      );
    } catch {
      // enumeration can fail before permission — silently ignore.
    }
  }, []);

  useEffect(() => {
    if (active) void fetchDevices();
  }, [active, fetchDevices]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    navigator.mediaDevices.addEventListener("devicechange", fetchDevices);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", fetchDevices);
  }, [fetchDevices]);

  return { audioInput, audioOutput, videoInput };
}

function DeviceList({
  heading,
  devices,
  selectedId,
  onSelect,
}: {
  heading: string;
  devices: DeviceOption[];
  selectedId?: string;
  onSelect?: (deviceId: string) => void;
}) {
  if (!devices.length || !onSelect) return null;
  const activeId = selectedId || devices[0]?.deviceId;
  return (
    <div className="px-1.5 pb-1 pt-1">
      <p
        className="px-2.5 pb-1 pt-1 text-[11.5px] font-medium"
        style={{ color: color.textFaint }}
      >
        {heading}
      </p>
      {devices.map((device) => {
        const isActive = device.deviceId === activeId;
        return (
          <button
            key={device.deviceId}
            type="button"
            onClick={() => onSelect(device.deviceId)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-[background-color] duration-[120ms] hover:bg-white/[0.06]"
            style={{ color: color.text }}
          >
            <span className="flex w-4 shrink-0 items-center justify-center">
              {isActive && <Check size={15} strokeWidth={2} className="text-[#F95F4A]" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{device.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyDevices({ kind }: { kind: "mic" | "video" }) {
  return (
    <p
      className="px-3 py-3 text-[13px]"
      style={{ color: color.textFaint }}
    >
      {kind === "mic"
        ? "No microphones or speakers found. Allow microphone access, then reopen this menu."
        : "No cameras found. Allow camera access, then reopen this menu."}
    </p>
  );
}

export interface MediaControlClusterProps {
  kind: "mic" | "video";
  icon: LucideIcon;
  variant: ControlButtonVariant;
  label: string;
  onPress?: () => void;
  badge?: number;
  hotkey?: string;
  disabled?: boolean;
  loading?: boolean;
  selectedAudioInputDeviceId?: string;
  selectedAudioOutputDeviceId?: string;
  selectedVideoInputDeviceId?: string;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioOutputDeviceChange?: (deviceId: string) => void;
  onVideoInputDeviceChange?: (deviceId: string) => void;
  isMirrorCamera?: boolean;
  onToggleMirror?: () => void;
}

/** Mic/camera toggle + device caret as one unified pill control. */
export function MediaControlCluster(props: MediaControlClusterProps) {
  const {
    kind,
    icon: Icon,
    variant,
    label,
    onPress,
    badge,
    hotkey,
    disabled = false,
    loading = false,
    selectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    selectedVideoInputDeviceId,
    onAudioInputDeviceChange,
    onAudioOutputDeviceChange,
    onVideoInputDeviceChange,
    isMirrorCamera,
    onToggleMirror,
  } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { audioInput, audioOutput, videoInput } = useEnumeratedDevices(open);
  const colors = controlButtonColors(variant);
  const sideColors = controlButtonColors("default");
  const isDefaultVariant = variant === "default";
  
  const mainStyle = {
    backgroundColor: isDefaultVariant ? IN_USE_TOGGLE : colors.bg,
    borderColor: "transparent",
  };
  const sideStyle = {
    backgroundColor: sideColors.bg,
    borderColor: "transparent",
  };
  const caretColor = open ? color.accent : "rgba(250, 250, 250, 0.72)";
  const sideHoverClass = "hover:bg-white/[0.06] active:bg-white/[0.04]";
  const mainHoverClass = "hover:brightness-110 active:brightness-95";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect =
    (cb?: (id: string) => void) => (id: string) => {
      cb?.(id);
      setOpen(false);
    };
  const mainButton = (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-busy={loading || undefined}
      onClick={onPress}
      className={
        "relative inline-flex h-12 w-full shrink-0 items-center justify-center rounded-full border " +
        "transition-[background-color,filter,transform] duration-[120ms] active:scale-[0.96] " +
        "disabled:cursor-not-allowed disabled:hover:brightness-100 " +
        mainHoverClass
      }
      style={{ ...mainStyle, color: colors.fg }}
    >
      {loading ? (
        <Loader2
          size={ICON_SIZE}
          strokeWidth={1.75}
          className="animate-spin"
        />
      ) : (
        <Icon size={ICON_SIZE} strokeWidth={1.75} />
      )}
      {typeof badge === "number" && badge > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
          style={{ backgroundColor: color.accent }}
        >
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div ref={ref} className="group/cluster relative inline-block">
      <div
        className={"relative h-12 shrink-0 " + (disabled ? "opacity-35" : "")}
        style={{ width: CLUSTER_W }}
      >
        <button
          type="button"
          disabled={disabled}
          aria-label={kind === "mic" ? "Audio settings" : "Camera settings"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={
            "absolute left-0 top-0 z-0 inline-flex h-12 items-center justify-start rounded-full border " +
            "transition-[background-color,filter] duration-[120ms] disabled:cursor-not-allowed " +
            "disabled:hover:brightness-100 " +
            sideHoverClass
          }
          style={{ ...sideStyle, width: SIDE_ZONE_W, color: caretColor }}
        >
          <span
            className="inline-flex h-12 -translate-x-1 items-center justify-center"
            style={{ width: CARET_CLICK_W }}
          >
            <ChevronUp
              size={15}
              strokeWidth={2.25}
              className={`transition-transform duration-[150ms] ${open ? "rotate-180" : ""}`}
            />
          </span>
        </button>

        <div
          className="absolute right-0 top-0 z-[1] h-12"
          style={{ width: MAIN_ZONE_W }}
        >
          {hotkey ? (
            <HotkeyTooltip label={label} hotkey={hotkey} className="h-full w-full">
              {mainButton}
            </HotkeyTooltip>
          ) : (
            mainButton
          )}
        </div>
      </div>

      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-3 w-64 -translate-x-1/2">
          <div
            className="origin-bottom rounded-2xl border p-1 will-change-transform animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
            style={{
              backgroundColor: color.surfaceRaised,
              borderColor: color.border,
            }}
          >
            {kind === "mic" ? (
              audioInput.length === 0 && audioOutput.length === 0 ? (
                <EmptyDevices kind="mic" />
              ) : (
                <>
                  <DeviceList
                    heading="Microphone"
                    devices={audioInput}
                    selectedId={selectedAudioInputDeviceId}
                    onSelect={handleSelect(onAudioInputDeviceChange)}
                  />
                  <DeviceList
                    heading="Speaker"
                    devices={audioOutput}
                    selectedId={selectedAudioOutputDeviceId}
                    onSelect={handleSelect(onAudioOutputDeviceChange)}
                  />
                </>
              )
            ) : (
              <>
                {videoInput.length === 0 ? (
                  <EmptyDevices kind="video" />
                ) : (
                  <DeviceList
                    heading="Camera"
                    devices={videoInput}
                    selectedId={selectedVideoInputDeviceId}
                    onSelect={handleSelect(onVideoInputDeviceChange)}
                  />
                )}
                {onToggleMirror && (
                  <SwitchRow
                    icon={FlipHorizontal2}
                    label="Mirror my video"
                    checked={Boolean(isMirrorCamera)}
                    onChange={() => onToggleMirror?.()}
                    className="rounded-lg"
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
