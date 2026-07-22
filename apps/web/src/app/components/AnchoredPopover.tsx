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
  /** Preferred side. Flips to the other side when there isn't room. */
  placement?: Placement;
  align?: Align;
  /** Gap between anchor and panel, px. */
  gap?: number;
  /** Minimum distance to keep from the viewport edges, px. */
  margin?: number;
  className?: string;
  role?: "dialog" | "menu" | "tooltip";
  ariaLabel?: string;
  /** Tooltips must not swallow pointer events or trap focus. */
  interactive?: boolean;
  /**
   * Close shortly after the pointer leaves both the anchor and the panel, so
   * moving away dismisses it without a click (Discord-style). A short grace
   * delay bridges the gap between anchor and panel.
   */
  dismissOnPointerLeave?: boolean;
}

interface Position {
  top: number;
  left: number;
  placement: Placement;
}

/**
 * Anchored popover that renders in a portal on document.body.
 *
 * The chat panel's message list is a scroll container, so any popover nested
 * inside it is clipped by that container - which is what cut the emoji picker
 * off against the panel header. Portalling to the body escapes the clip, and
 * because the panel is then no longer the containing block, the panel has to
 * position itself: it flips to the other side when the preferred side lacks
 * room, and shifts along the cross axis to stay inside the viewport.
 *
 * There is no popover primitive in this codebase (only @radix-ui/react-
 * collapsible, and the two existing createPortal call sites are full-screen
 * modals), so this is hand-rolled rather than delegated to floating-ui.
 */
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
  // Portals only exist on the client, so gate the first paint on mount to keep
  // SSR and hydration in sync. The positioning effect depends on isMounted too
  // (not just open), so a popover mounted already-open re-measures once the
  // panel actually exists rather than staying visibility:hidden forever.
  const [isMounted, setIsMounted] = useState(false);
  // The element focused when the popover opened, so focus can return there on
  // close instead of falling to <body>.
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

  // Pointer-leave dismissal. Leaving the anchor or the panel starts a short
  // timer; entering either cancels it, so crossing the gap between them (or a
  // brief overshoot) doesn't flicker the popover shut.
  //
  // Mouse only: a touch tap fires pointerleave on finger-lift right after the
  // tap that opened the popover, which would auto-dismiss it before the user
  // could pick. Touch users dismiss by tapping outside or selecting.
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

    // Flip only when the preferred side cannot fit and the other side can do
    // better, so the panel stays put during small scrolls.
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

    // Shift along the cross axis so a panel wider than the space beside its
    // anchor stays fully on screen instead of running past the edge.
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
    // isMounted is a dep so the panel measures on the render where it first
    // exists — mounting already-open renders null once before isMounted flips.
    if (!isMounted) return;
    updatePosition();
  }, [isMounted, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    // Capture phase so scrolling of any ancestor container repositions the
    // panel, not just the window.
    const handleScroll = () => updatePosition();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);

    // Scroll/resize miss the case where the anchor moves because content above
    // it grew — e.g. a new chat message arrives while the picker is open. A
    // ResizeObserver on the anchor and panel catches those layout shifts.
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
    // isMounted is a dep so a popover mounted already-open re-runs this once the
    // portalled panel exists and gets observed, not just the anchor.
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
    // Remember where focus was so it can return to the trigger on close, then
    // move focus into the panel so it is keyboard-operable immediately.
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : anchorRef.current;
    const focusable = panel.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    return () => {
      // Only pull focus back if it is still inside the panel; if the user has
      // since clicked elsewhere, respect that.
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
        // Avoid a first-paint flash at 0,0 before measurement lands.
        visibility: position ? "visible" : "hidden",
      }}
      className={`z-[60] ${interactive ? "" : "pointer-events-none"} ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
