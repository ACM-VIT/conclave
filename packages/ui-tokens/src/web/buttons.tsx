"use client";

import type { LucideIcon } from "lucide-react";
import {
  controlButtonColors,
  type ControlButtonVariant,
} from "../core";
import { color } from "../tokens";

export interface ControlButtonProps {
  icon: LucideIcon;
  variant?: ControlButtonVariant;
  size?: number;
  iconSize?: number;
  badge?: number;
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
  const colors = controlButtonColors(variant);
  const resolvedIconSize = iconSize ?? Math.round(size * 0.42);

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
        "hover:brightness-110 active:scale-[0.94] active:brightness-95 " +
        "disabled:cursor-not-allowed disabled:opacity-35 " +
        className
      }
      style={{
        width: size,
        height: size,
        backgroundColor: colors.bg,
        color: colors.fg,
        borderColor: colors.border,
      }}
    >
      <Icon size={resolvedIconSize} strokeWidth={1.75} />
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
