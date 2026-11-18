"use client";

import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import type { RegisterableHotkey } from "@tanstack/hotkeys";
import { color } from "@conclave/ui-tokens";
import { HOTKEYS } from "../lib/hotkeys";
import { requestShortcutsHelp } from "./ShortcutsHelpDialog";
import {
  announceOverlayOpen,
  subscribeOtherOverlayOpen,
} from "./meet-overlay-bus";
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
  }
}

function useShallowStable<T extends object>(value: T): T {
  const ref = useRef(value);
  const previous = ref.current;
  const keys = Object.keys(value) as (keyof T)[];
  const unchanged =
    keys.length === Object.keys(previous).length &&
    keys.every((key) => Object.is(previous[key], value[key]));
  if (!unchanged) ref.current = value;
  return ref.current;
}

export default function CommandPalette({
  controls: controlsProp,
  onSendChatMessage,
}: {
  controls: ControlsBarProps;
  onSendChatMessage?: (content: string) => void;
}) {
  const controls = useShallowStable(controlsProp);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const { audioInput, audioOutput, videoInput } = useEnumeratedDevices(open);

  useHotkey(HOTKEYS.commandPalette.keys as RegisterableHotkey, () =>
    setOpen((v) => !v),
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen((wasOpen) => (wasOpen ? false : wasOpen));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    announceOverlayOpen("command-palette");
    setQuery("");
    setSelectedId(null);
    lastPointerRef.current = null;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(
    () => subscribeOtherOverlayOpen("command-palette", () => setOpen(false)),
    [],
  );

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
              onShowShortcuts: requestShortcutsHelp,
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

  const searching = query.trim().length > 0;
  const results = useMemo(
    () => filterPaletteActions(actions, query),
    [actions, query],
  );
  const visible = useMemo(
    () =>
      results.length > 0
        ? results
        : buildQueryFallbackActions(query, controls, { onSendChatMessage }),
    [results, query, controls, onSendChatMessage],
  );
  const selectable = useMemo(
    () => visible.filter((action) => !action.disabled),
    [visible],
  );
  const selected =
    (selectedId != null &&
      selectable.find((action) => action.id === selectedId)) ||
    selectable[0] ||
    null;

  useEffect(() => {
    setSelectedId(null);
    listRef.current?.scrollTo({ top: 0 });
  }, [query]);

  useEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const runAction = useCallback((action: PaletteAction) => {
    if (action.disabled) return;
    setOpen(false);
    action.run();
  }, []);

  const selectByKeyboard = (target: PaletteAction | undefined) => {
    if (!target || target.id === selected?.id) return;
    keyboardNavRef.current = true;
    setSelectedId(target.id);
  };

  const moveSelection = (delta: number) => {
    if (selectable.length === 0) return;
    const current = selected
      ? selectable.findIndex((action) => action.id === selected.id)
      : -1;
    selectByKeyboard(
      selectable[(current + delta + selectable.length * 2) % selectable.length],
    );
  };

  const jumpSelection = (index: number) => {
    selectByKeyboard(selectable.at(index));
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        return;
      case "Home":
        if (query.length === 0) {
          event.preventDefault();
          jumpSelection(0);
        }
        return;
      case "End":
        if (query.length === 0) {
          event.preventDefault();
          jumpSelection(-1);
        }
        return;
      case "Enter":
        event.preventDefault();
        if (selected) runAction(selected);
        return;
    }
  };

  const onRowMouseMove = (
    event: ReactMouseEvent<HTMLButtonElement>,
    action: PaletteAction,
  ) => {
    const last = lastPointerRef.current;
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    if (last && last.x === event.clientX && last.y === event.clientY) return;
    if (!action.disabled && selected?.id !== action.id) {
      setSelectedId(action.id);
    }
  };

  if (!open) return null;

  const groups: { section: string | null; items: PaletteAction[] }[] =
    searching
      ? [{ section: null, items: visible }]
      : PALETTE_SECTIONS.map((section) => ({
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
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
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
          className="max-h-[min(50vh,420px)] overflow-y-auto overscroll-contain p-1.5"
        >
          {visible.length === 0 ? (
            <p
              className="px-3 py-6 text-center text-[13px]"
              style={{ color: color.textFaint }}
            >
              No actions match “{query}”
            </p>
          ) : (
            groups.map(({ section, items }) => (
              <div
                key={section ?? "results"}
                role="group"
                aria-label={section ?? "Results"}
              >
                {section ? (
                  <p
                    className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium"
                    style={{ color: color.textFaint }}
                  >
                    {section}
                  </p>
                ) : null}
                {items.map((action) => {
                  const Icon = action.icon;
                  const isSelected = selected?.id === action.id;
                  return (
                    <button
                      key={action.id}
                      id={`palette-option-${action.id}`}
                      type="button"
                      tabIndex={-1}
                      role="option"
                      aria-selected={isSelected}
                      data-selected={isSelected || undefined}
                      disabled={action.disabled}
                      onClick={() => runAction(action)}
                      onMouseMove={(event) => onRowMouseMove(event, action)}
                      className={
                        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] disabled:opacity-40 " +
                        (isSelected ? "bg-white/[0.08]" : "")
                      }
                      style={{
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
                      {searching && action.section ? (
                        <span
                          className="truncate text-[11px]"
                          style={{ color: color.textFaint }}
                        >
                          {action.section}
                        </span>
                      ) : null}
                      {action.active ? (
                        <>
                          <span className="sr-only">(on)</span>
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: color.accent }}
                          />
                        </>
                      ) : null}
                      {action.hotkey ? (
                        <kbd
                          className="shrink-0 rounded border px-1.5 py-px text-[10px]"
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
