"use client";

import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { color } from "@conclave/ui-tokens";
import { HOTKEYS } from "../lib/hotkeys";
import { useEnumeratedDevices } from "./DeviceCaretMenu";
import type { ControlsBarProps } from "./controls-config";
import {
  buildPaletteActions,
  buildQueryFallbackActions,
  filterPaletteActions,
  PALETTE_SECTIONS,
  type PaletteAction,
} from "./command-palette-actions";

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard access can be denied; the palette has no error surface for
    // this, and the meeting tag still offers click-to-copy as a fallback.
  }
}

/**
 * Figma-style quick-actions palette for the meeting: Mod+K opens a searchable
 * list of everything the participant can do (bar controls, More-menu tools,
 * device switching, host toggles, reactions, leaving). Every meeting control
 * stays reachable from the keyboard without memorizing where it lives.
 */
export default function CommandPalette({
  controls,
  onSendChatMessage,
}: {
  controls: ControlsBarProps;
  /** Chat send handler; enables the send-to-chat / ask-AI query fallbacks. */
  onSendChatMessage?: (content: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Device enumeration only runs while the palette is open, mirroring how the
  // caret menus and drawers avoid idle permission/device churn.
  const { audioInput, audioOutput, videoInput } = useEnumeratedDevices(open);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        // Always claim Mod+K so the browser's own search-bar binding never
        // fires, even when the palette is closing.
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    // The input mounts in the same commit; focus once it exists.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const copyMeetingCode = useCallback(() => {
    if (controls.roomId) void copyText(controls.roomId);
  }, [controls.roomId]);
  const copyMeetingLink = useCallback(() => {
    if (controls.roomId)
      void copyText(`${window.location.origin}/${controls.roomId}`);
  }, [controls.roomId]);

  const actions = useMemo(
    () =>
      open
        ? buildPaletteActions(
            controls,
            { audioInput, audioOutput, videoInput },
            {
              onCopyMeetingCode: copyMeetingCode,
              onCopyMeetingLink: copyMeetingLink,
            },
          )
        : [],
    [
      open,
      controls,
      audioInput,
      audioOutput,
      videoInput,
      copyMeetingCode,
      copyMeetingLink,
    ],
  );

  const filtered = useMemo(
    () => filterPaletteActions(actions, query),
    [actions, query],
  );
  // A query that matches nothing becomes input for chat / the assistant /
  // shared-browser search instead of a dead end.
  const visible = useMemo(
    () =>
      filtered.length > 0
        ? filtered
        : buildQueryFallbackActions(query, controls, { onSendChatMessage }),
    [filtered, query, controls, onSendChatMessage],
  );
  // Arrow keys walk only the runnable rows; disabled rows stay visible but
  // are skipped so Enter can never fire a dead action.
  const selectable = useMemo(
    () => visible.filter((action) => !action.disabled),
    [visible],
  );
  const selected = selectable[selectedIndex] ?? null;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const runAction = useCallback(
    (action: PaletteAction) => {
      if (action.disabled) return;
      setOpen(false);
      action.run();
    },
    [],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (selectable.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => (i + 1) % selectable.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((i) => (i - 1 + selectable.length) % selectable.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selected) runAction(selected);
    }
  };

  if (!open) return null;

  const sections = PALETTE_SECTIONS.map((section) => ({
    section,
    items: visible.filter((action) => action.section === section),
  })).filter(({ items }) => items.length > 0);

  return (
    <div
      className="fixed inset-0 z-[92] flex flex-col items-center px-4 pt-[14vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div aria-hidden className="absolute inset-0 -z-10 bg-black/50" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick actions"
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.55)] origin-top will-change-transform animate-[meet-popover-in_150ms_cubic-bezier(0.22,1,0.36,1)]"
        style={{
          backgroundColor: color.surfaceRaised,
          borderColor: color.border,
        }}
      >
        <div
          className="flex items-center gap-2.5 border-b px-4 py-3"
          style={{ borderColor: color.border }}
        >
          <Search
            size={16}
            strokeWidth={2}
            className="shrink-0"
            style={{ color: color.textFaint }}
          />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={
              selected ? `palette-option-${selected.id}` : undefined
            }
            aria-label="Search actions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search actions…"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[#fafafa]/35"
            style={{ color: color.text }}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd
            className="rounded border px-1.5 py-px text-[10px]"
            style={{ borderColor: color.border, color: color.textFaint }}
          >
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="Actions"
          className="max-h-[min(50vh,420px)] overflow-y-auto p-1.5"
        >
          {sections.length === 0 ? (
            <p
              className="px-3 py-6 text-center text-[13px]"
              style={{ color: color.textFaint }}
            >
              No actions match “{query}”
            </p>
          ) : (
            sections.map(({ section, items }) => (
              <div key={section} role="group" aria-label={section}>
                <p
                  className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                  style={{ color: color.textFaint }}
                >
                  {section}
                </p>
                {items.map((action) => {
                  const Icon = action.icon;
                  const isSelected = selected?.id === action.id;
                  return (
                    <button
                      key={action.id}
                      id={`palette-option-${action.id}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-selected={isSelected || undefined}
                      disabled={action.disabled}
                      onClick={() => runAction(action)}
                      onMouseMove={() => {
                        if (action.disabled) return;
                        const index = selectable.indexOf(action);
                        if (index >= 0 && index !== selectedIndex) {
                          setSelectedIndex(index);
                        }
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] disabled:opacity-40"
                      style={{
                        backgroundColor: isSelected
                          ? "rgba(255,255,255,0.08)"
                          : "transparent",
                        color: action.danger
                          ? "#ff7a6e"
                          : action.active
                            ? color.accent
                            : color.text,
                      }}
                    >
                      {action.reaction ? (
                        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[15px] leading-none">
                          {action.reaction.kind === "emoji" ? (
                            action.reaction.value
                          ) : (
                            <img
                              src={action.reaction.value}
                              alt=""
                              className="h-[18px] w-[18px] object-contain"
                              loading="lazy"
                            />
                          )}
                        </span>
                      ) : Icon ? (
                        <Icon
                          size={18}
                          strokeWidth={1.75}
                          className="shrink-0"
                          style={{
                            color: action.danger
                              ? "#ff7a6e"
                              : action.active
                                ? color.accent
                                : color.textMuted,
                          }}
                        />
                      ) : (
                        <span className="w-[18px] shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {action.label}
                      </span>
                      {action.active ? (
                        <span
                          className="text-[10px] font-semibold uppercase tracking-wide"
                          style={{ color: color.accent }}
                        >
                          On
                        </span>
                      ) : null}
                      {action.hotkey ? (
                        <kbd
                          className="rounded border px-1.5 py-px text-[10px]"
                          style={{
                            borderColor: color.border,
                            color: color.textFaint,
                          }}
                        >
                          {formatForDisplay(action.hotkey)}
                        </kbd>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          className="flex items-center justify-between border-t px-4 py-2 text-[11px]"
          style={{ borderColor: color.border, color: color.textFaint }}
        >
          <span>↑↓ navigate · ↵ run · esc close</span>
          <span className="flex items-center gap-1.5">
            Quick actions
            <kbd
              className="rounded border px-1.5 py-px text-[10px]"
              style={{ borderColor: color.border }}
            >
              {formatForDisplay(HOTKEYS.commandPalette.keys)}
            </kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
