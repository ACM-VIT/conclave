"use client";

import { useEffect, useRef, useState } from "react";
import { color, radius } from "@conclave/ui-tokens";

/**
 * Small flat primitives for the operator dashboard, composed straight from
 * @conclave/ui-tokens so the panel speaks the same language as the meeting
 * surface: one sans, hairline borders, a single coral accent, no shadows.
 */

export const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-[#fafafa] outline-none transition-colors placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/60";

export const btnAccent =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

export const btnSecondary =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-white/10 px-3 text-[12.5px] font-medium text-[#fafafa]/74 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40";

export const btnTiny =
  "inline-flex h-6.5 shrink-0 items-center justify-center rounded-md border border-white/10 px-2 py-1 text-[11.5px] font-medium text-[#fafafa]/74 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40";

export const btnTinyDanger =
  "inline-flex h-6.5 shrink-0 items-center justify-center rounded-md border border-[#ea4335]/35 px-2 py-1 text-[11.5px] font-medium text-[#ea4335] transition-colors hover:bg-[#ea4335]/10 disabled:cursor-not-allowed disabled:opacity-40";

export function Dot({ tone }: { tone: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: tone }}
      aria-hidden
    />
  );
}

export type TagTone = "neutral" | "ok" | "warn" | "danger" | "accent";

const TAG_COLOR: Record<TagTone, string> = {
  neutral: color.textFaint,
  ok: color.success,
  warn: color.warning,
  danger: color.danger,
  accent: color.accent,
};

export function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: TagTone;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ borderColor: color.border, color: TAG_COLOR[tone] }}
    >
      {children}
    </span>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-[13px]" style={{ color: color.textMuted }}>
        {label}
      </span>
      <span
        className="relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full transition-colors"
        style={{
          backgroundColor: checked ? color.accent : "rgba(250,250,250,0.14)",
        }}
      >
        <span
          className="absolute h-[13px] w-[13px] rounded-full bg-white transition-[left] duration-[120ms]"
          style={{ left: checked ? 16 : 3 }}
        />
      </span>
    </button>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="border-t pt-4"
      style={{ borderColor: "rgba(250,250,250,0.08)" }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-medium" style={{ color: color.textFaint }}>
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Flat one-hour trend line. Values are index-aligned samples; the line is a
 * plain polyline in the accent color over a hairline baseline, no fill and no
 * decoration. Callers should gate on enough samples to draw a real shape.
 */
export function Sparkline({
  values,
  width = 72,
  height = 20,
  title,
}: {
  values: number[];
  width?: number;
  height?: number;
  title?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = index * step;
      const y = height - 2 - (value / max) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <line
        x1="0"
        y1={height - 1}
        x2={width}
        y2={height - 1}
        stroke="rgba(250,250,250,0.14)"
        strokeWidth="1"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color.accent}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Flat popover anchored to a secondary button: opens on click, closes on outside
 * click or Escape. No portal needed while headers stay unclipped.
 */
export function Popover({
  label,
  active,
  width = 320,
  children,
}: {
  label: React.ReactNode;
  /** Tint the trigger, e.g. when something inside needs attention. */
  active?: boolean;
  width?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className={btnSecondary}
        style={active ? { color: color.warning, borderColor: "rgba(251,191,36,0.4)" } : undefined}
      >
        {label}
      </button>
      {open ? (
        <div
          className="absolute right-0 top-10 z-30 rounded-xl border p-3"
          style={{ width, borderColor: color.border, backgroundColor: color.bgAlt }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Destructive action with a built-in second step: the first click arms it,
 * the second within four seconds fires it. No modal needed.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  size = "normal",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  size?: "normal" | "tiny";
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  const base =
    size === "tiny"
      ? "inline-flex h-6.5 shrink-0 items-center justify-center rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      : "inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArmed(true)}
        className={`${base} border border-[#ea4335]/35 text-[#ea4335] hover:bg-[#ea4335]/10`}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
      className={`${base} text-white`}
      style={{ backgroundColor: color.danger, borderRadius: size === "tiny" ? 6 : radius.sm }}
    >
      {confirmLabel}
    </button>
  );
}
