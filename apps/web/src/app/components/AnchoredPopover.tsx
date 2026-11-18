"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom";
type Align = "start" | "center" | "end";

interface AnchoredPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: Placement;
  align?: Align;
  gap?: number;
  margin?: number;
  className?: string;
  role?: "dialog" | "menu" | "tooltip";
  ariaLabel?: string;
  interactive?: boolean;
  dismissOnPointerLeave?: boolean;
}

interface Position {
  top: number;
  left: number;
  placement: Placement;
}

export default function AnchoredPopover({
  anchorRef,
  open,
  onClose,
  children,
  placement = "top",
  align = "end",
  gap = 6,
  margin = 8,
  className = "",
  role = "dialog",
  ariaLabel,
  interactive = true,
  dismissOnPointerLeave = false,
}: AnchoredPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMounted) setIsMounted(true);
  }, [isMounted]);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open || !interactive || !dismissOnPointerLeave) return;
    const anchor = anchorRef.current;
    const scheduleClose = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      cancelScheduledClose();
      closeTimerRef.current = setTimeout(onClose, 160);
    };
    anchor?.addEventListener("pointerenter", cancelScheduledClose);
    anchor?.addEventListener("pointerleave", scheduleClose);
    return () => {
      cancelScheduledClose();
      anchor?.removeEventListener("pointerenter", cancelScheduledClose);
      anchor?.removeEventListener("pointerleave", scheduleClose);
    };
  }, [
    anchorRef,
    cancelScheduledClose,
    dismissOnPointerLeave,
    interactive,
    onClose,
    open,
  ]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    const roomAbove = anchorRect.top - margin;
    const roomBelow = viewportHeight - anchorRect.bottom - margin;
    const needed = panelRect.height + gap;

    let resolved: Placement = placement;
    if (placement === "top" && roomAbove < needed && roomBelow > roomAbove) {
      resolved = "bottom";
    } else if (
      placement === "bottom" &&
      roomBelow < needed &&
      roomAbove > roomBelow
    ) {
      resolved = "top";
    }

    const top =
      resolved === "top"
        ? anchorRect.top - panelRect.height - gap
        : anchorRect.bottom + gap;

    let left: number;
    if (align === "start") left = anchorRect.left;
    else if (align === "center")
      left = anchorRect.left + anchorRect.width / 2 - panelRect.width / 2;
    else left = anchorRect.right - panelRect.width;

    const maxLeft = viewportWidth - panelRect.width - margin;
    left = Math.min(Math.max(left, margin), Math.max(margin, maxLeft));

    const clampedTop = Math.min(
      Math.max(top, margin),
      Math.max(margin, viewportHeight - panelRect.height - margin),
    );

    setPosition((previous) =>
      previous &&
      previous.top === clampedTop &&
      previous.left === left &&
      previous.placement === resolved
        ? previous
        : { top: clampedTop, left, placement: resolved },
    );
  }, [align, anchorRef, gap, margin, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    if (!isMounted) return;
    updatePosition();
  }, [isMounted, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => updatePosition();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updatePosition())
        : null;
    if (observer) {
      if (anchorRef.current) observer.observe(anchorRef.current);
      if (panelRef.current) observer.observe(panelRef.current);
    }

    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
      observer?.disconnect();
    };
  }, [anchorRef, isMounted, open, updatePosition]);

  useEffect(() => {
    if (!open || !interactive) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorRef, interactive, onClose, open]);

  useEffect(() => {
    if (!open || !interactive) return;
    const panel = panelRef.current;
    if (!panel) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : anchorRef.current;
    const focusable = panel.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    return () => {
      const active = document.activeElement;
      if (!active || panel.contains(active) || active === document.body) {
        returnFocusRef.current?.focus();
      }
    };
  }, [anchorRef, interactive, open]);

  if (!isMounted || !open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      onPointerEnter={
        dismissOnPointerLeave ? cancelScheduledClose : undefined
      }
      onPointerLeave={
        dismissOnPointerLeave
          ? (event) => {
              if (event.pointerType === "touch") return;
              cancelScheduledClose();
              closeTimerRef.current = setTimeout(onClose, 160);
            }
          : undefined
      }
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      className={`z-[60] ${interactive ? "" : "pointer-events-none"} ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
