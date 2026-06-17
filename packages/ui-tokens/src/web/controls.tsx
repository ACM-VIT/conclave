"use client";
import React from "react";
import type { LucideIcon } from "lucide-react";
import { color } from "../tokens";

/* ------------------------------------------------------------------ Switch ---
 * THE single toggle primitive for web. Flat pill + sliding knob, motion capped
 * at 120ms, no glow. Replaces the per-component switches that used to drift
 * (MeetSettingsPanel ToggleSwitch, MeetViewPanel custom switch, the bare text
 * "On/Off" toggles in DeviceCaretMenu / video-settings, and the mobile
 * "Webinar: On" text buttons). */

export type SwitchTone = "accent" | "success" | "warning" | "danger";

const TONE_FILL: Record<SwitchTone, string> = {
  accent: color.accent,
  success: color.success,
  warning: color.warning,
  danger: color.danger,
};

/** Visual-only pill (no semantics). Used inside an interactive row/button so we
 * never nest two interactive elements. */
function SwitchVisual({
  checked,
  tone = "accent",
}: {
  checked: boolean;
  tone?: SwitchTone;
}) {
  return (
    <span
      aria-hidden
      className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[120ms]"
      style={{ backgroundColor: checked ? TONE_FILL[tone] : "rgba(250,250,250,0.14)" }}
    >
      <span
        className="absolute h-[16px] w-[16px] rounded-full bg-white transition-transform duration-[120ms]"
        style={{ transform: checked ? "translateX(19px)" : "translateX(3px)" }}
      />
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  tone?: SwitchTone;
  disabled?: boolean;
  /** Accessible label (required — the switch is icon-only). */
  label: string;
  className?: string;
}

/** Standalone switch (when there is no row label wrapper). */
export function Switch({
  checked,
  onChange,
  tone = "accent",
  disabled,
  label,
  className = "",
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={
        "inline-flex rounded-full disabled:opacity-35 disabled:cursor-not-allowed " +
        className
      }
    >
      <SwitchVisual checked={checked} tone={tone} />
    </button>
  );
}

/* --------------------------------------------------------------- SwitchRow ---
 * A full settings row: optional leading icon, label + optional description, and
 * a trailing switch. The whole row is the toggle (one interactive element). */
export interface SwitchRowProps {
  icon?: LucideIcon;
  label: string;
  description?: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  tone?: SwitchTone;
  disabled?: boolean;
  className?: string;
}

export function SwitchRow({
  icon: Icon,
  label,
  description,
  checked,
  onChange,
  tone = "accent",
  disabled = false,
  className = "",
}: SwitchRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={
        "flex w-full items-center gap-3 px-4 py-2.5 text-left " +
        "transition-[background-color] duration-[120ms] hover:bg-surface-hover " +
        "disabled:opacity-40 disabled:cursor-not-allowed " +
        className
      }
    >
      {Icon ? (
        <Icon
          size={18}
          strokeWidth={1.75}
          className="shrink-0"
          style={{ color: checked ? TONE_FILL[tone] : color.textFaint }}
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]" style={{ color: color.text }}>
          {label}
        </span>
        {description ? (
          <span
            className="mt-0.5 block text-[12px] leading-snug"
            style={{ color: color.textFaint }}
          >
            {description}
          </span>
        ) : null}
      </span>
      <SwitchVisual checked={checked} tone={tone} />
    </button>
  );
}
