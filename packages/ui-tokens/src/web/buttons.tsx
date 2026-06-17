"use client";
import React from "react";
import type { LucideIcon } from "lucide-react";
import {
  controlButtonColors,
  type ControlButtonVariant,
  type AppButtonVariant,
} from "../core";
import { color } from "../tokens";

/* --------------------------------------------------------- ControlButton ---
 * Circular icon-only control. Used in the mobile pill and the web center zone.
 * Flat: state is fill / tint / border only — NO glow. */
export interface ControlButtonProps {
  icon: LucideIcon;
  variant?: ControlButtonVariant;
  size?: number;
  iconSize?: number;
  badge?: number;
  /** Accessible label (also used as tooltip when `title` is unset). */
  label?: string;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function ControlButton({
  icon: Icon,
  variant = "default",
  size = 48,
  iconSize,
  badge,
  label,
  title,
  disabled,
  onClick,
  className = "",
}: ControlButtonProps) {
  const c = controlButtonColors(variant);
  const dim = iconSize ?? Math.round(size * 0.42);
  return (
    <button
      type="button"
      aria-label={label ?? title}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={
        "relative inline-flex items-center justify-center rounded-full border " +
        "transition-[background-color,border-color,filter,transform] duration-[120ms] " +
        "hover:brightness-110 active:brightness-95 active:scale-[0.94] " +
        "disabled:opacity-35 disabled:cursor-not-allowed " +
        className
      }
      style={{
        width: size,
        height: size,
        backgroundColor: c.bg,
        color: c.fg,
        borderColor: c.border,
      }}
    >
      <Icon size={dim} strokeWidth={1.75} />
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
}

/* ------------------------------------------------------------- IconButton ---
 * Utility button for the left/right zones and overflow rows: an icon with an
 * optional label beneath (Dialpad/Teams style). Ghost styling, flat. */
export interface IconButtonProps {
  icon: LucideIcon;
  label?: string;
  showLabel?: boolean;
  active?: boolean;
  badge?: number;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function IconButton({
  icon: Icon,
  label,
  showLabel = false,
  active = false,
  badge,
  disabled,
  onClick,
  title,
  className = "",
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label ?? title}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={
        "relative inline-flex flex-col items-center justify-center gap-1 rounded-xl px-3 py-1.5 " +
        "transition-[background-color,color] duration-[120ms] hover:bg-surface-hover " +
        "disabled:opacity-35 disabled:cursor-not-allowed " +
        (active ? "text-accent " : "text-text/70 ") +
        className
      }
    >
      <span className="relative inline-flex">
        <Icon size={20} strokeWidth={1.75} />
        {typeof badge === "number" && badge > 0 ? (
          <span
            className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
            style={{ backgroundColor: color.accent }}
          >
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </span>
      {showLabel && label ? (
        <span className="text-[11px] font-medium leading-none">{label}</span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------- AppButton ---
 * Text button for CTAs (pre-join Join, dialogs). primary = solid accent. */
export interface AppButtonProps {
  children: React.ReactNode;
  variant?: AppButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}

export function AppButton({
  children,
  variant = "primary",
  onClick,
  disabled,
  type = "button",
  className = "",
}: AppButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-medium " +
    "transition-[background-color,border-color,filter] duration-[120ms] hover:brightness-110 active:brightness-95 " +
    "disabled:opacity-35 disabled:cursor-not-allowed ";
  if (variant === "ghost") {
    return (
      <button
        type={type}
        onClick={onClick}
        disabled={disabled}
        className={base + "border border-text/30 bg-transparent text-text hover:bg-text/10 " + className}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={base + "border-0 text-white " + className}
      style={{ backgroundColor: color.accent }}
    >
      {children}
    </button>
  );
}
