"use client";
import React from "react";
import { X } from "lucide-react";
import { color } from "../tokens";

/* --------------------------------------------------------------- SidePanel ---
 * Right-docked panel for chat / participants. Rendered as a flex SIBLING of the
 * stage (the stage shrinks) — NOT a fixed floating overlay. Flat surface, no
 * shadow-glow. Parent controls mount/unmount; width is fixed. */
export interface SidePanelProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  headerAccessory?: React.ReactNode;
  className?: string;
}

export function SidePanel({
  title,
  onClose,
  children,
  width = 320,
  headerAccessory,
  className = "",
}: SidePanelProps) {
  return (
    <aside
      className={"flex h-full shrink-0 flex-col " + className}
      style={{
        width,
        backgroundColor: color.surface,
        borderLeft: `1px solid ${color.border}`,
      }}
    >
      <header
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: `1px solid ${color.border}` }}
      >
        <h2 className="text-[15px] font-bold" style={{ color: color.text, fontFamily: "var(--font-sans)" }}>
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {headerAccessory}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full transition-[background-color] duration-[120ms] hover:bg-surface-hover"
            style={{ color: color.textMuted }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

/* -------------------------------------------------------------- BottomSheet ---
 * Web bottom sheet (overlay + bottom panel). Open/close animation clamped to
 * 120ms. Used where a sheet UX is wanted on web; mobile has its own native one. */
export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0"
        style={{ backgroundColor: color.scrimSoft }}
      />
      <div
        className="relative w-full rounded-t-3xl px-4 pb-6 pt-3"
        style={{
          backgroundColor: color.surface,
          borderTop: `1px solid ${color.border}`,
          transition: "transform 120ms ease-out",
        }}
      >
        <div className="mx-auto mb-3 h-1.5 w-9 rounded-full" style={{ backgroundColor: color.borderStrong }} />
        {title ? (
          <h2 className="mb-3 text-[15px] font-bold" style={{ color: color.text, fontFamily: "var(--font-sans)" }}>
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </div>
  );
}
