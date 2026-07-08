"use client";

import { Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import type { RegisterableHotkey } from "@tanstack/hotkeys";
import { color } from "@conclave/ui-tokens";
import { HOTKEYS, getDisplayableHotkeys } from "../lib/hotkeys";
import {
  announceOverlayOpen,
  subscribeOtherOverlayOpen,
} from "./meet-overlay-bus";

const SHOW_SHORTCUTS_EVENT = "conclave:show-shortcuts";

/**
 * Lets other surfaces (the Mod+K quick-actions palette) open the shortcuts
 * dialog without holding a ref to it.
 */
export function requestShortcutsHelp(): void {
  window.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT));
}

/**
 * Mod+/ reference sheet listing every meeting hotkey, straight from the
 * HOTKEYS map so a newly declared binding shows up here automatically.
 * Self-contained: mount once anywhere in the meeting UI.
 */
export default function ShortcutsHelpDialog() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Register Mod+/ through the app's hotkey system, like every other meeting
  // shortcut (the library preventDefaults Ctrl/Meta shortcuts by default).
  useHotkey(HOTKEYS.shortcutsHelp.keys as RegisterableHotkey, () =>
    setOpen((v) => !v),
  );

  useEffect(() => {
    // Escape closes while open (callback form = no-op when closed). Kept as a
    // window listener rather than a second useHotkey("Escape") so it does not
    // collide with the palette's own Escape registration.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen((wasOpen) => (wasOpen ? false : wasOpen));
      }
    };
    // Let other surfaces (the palette's "View keyboard shortcuts" row) open it.
    const onShowRequest = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SHOW_SHORTCUTS_EVENT, onShowRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SHOW_SHORTCUTS_EVENT, onShowRequest);
    };
  }, []);

  // Overlays are mutually exclusive: opening this sheet closes the Mod+K
  // palette, and the palette opening closes this sheet.
  useEffect(() => {
    if (open) announceOverlayOpen("shortcuts-help");
  }, [open]);

  useEffect(
    () => subscribeOtherOverlayOpen("shortcuts-help", () => setOpen(false)),
    [],
  );

  // Accessible-modal focus: move focus into the dialog on open and return it to
  // the trigger on close. The app has no focus-trap dependency, so this is the
  // minimal correct behavior for an aria-modal element (matches how the palette
  // focuses its input on open).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  if (!open) return null;

  const hotkeys = getDisplayableHotkeys();

  return (
    <div
      className="fixed inset-0 z-[92] flex flex-col items-center px-4 pt-[14vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div aria-hidden className="absolute inset-0 -z-10 bg-black/50" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="flex w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.55)] origin-top outline-none will-change-transform animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
        style={{
          backgroundColor: color.surfaceRaised,
          borderColor: color.border,
        }}
      >
        <div
          className="flex items-center gap-2.5 border-b px-4 py-3"
          style={{ borderColor: color.border }}
        >
          <Keyboard
            size={16}
            strokeWidth={2}
            className="shrink-0"
            style={{ color: color.textFaint }}
          />
          <h2
            className="flex-1 text-[14px] font-semibold"
            style={{ color: color.text }}
          >
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close keyboard shortcuts"
            className="rounded border px-1.5 py-px text-[10px]"
            style={{ borderColor: color.border, color: color.textFaint }}
          >
            esc
          </button>
        </div>

        <ul className="max-h-[min(56vh,460px)] overflow-y-auto p-1.5">
          {hotkeys.map((hotkey) => (
            <li
              key={hotkey.action}
              className="flex items-center gap-3 rounded-lg px-2.5 py-2"
            >
              <span className="min-w-0 flex-1">
                <span
                  className="block text-[13.5px] leading-tight"
                  style={{ color: color.text }}
                >
                  {hotkey.label}
                </span>
                <span
                  className="block truncate text-[11.5px] leading-snug"
                  style={{ color: color.textFaint }}
                >
                  {hotkey.description}
                </span>
              </span>
              <kbd
                className="shrink-0 rounded border px-1.5 py-px text-[11px]"
                style={{ borderColor: color.border, color: color.textMuted }}
              >
                {formatForDisplay(hotkey.keys)}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
