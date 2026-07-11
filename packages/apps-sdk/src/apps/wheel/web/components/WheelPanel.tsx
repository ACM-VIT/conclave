import React, { useMemo, useState } from "react";
import type { WheelEntry, WheelResult } from "../../core/doc/index";
import { MAX_WHEEL_ENTRIES } from "../../core/doc/index";
import { segmentColor } from "../palette";

export type WheelPanelProps = {
  entries: WheelEntry[];
  history: WheelResult[];
  canEdit: boolean;
  locked: boolean;
  isAdmin: boolean;
  isSpinning: boolean;
  removeWinnerOnDone: boolean;
  /** Roster names not on the wheel yet; 0 means nothing to add. */
  missingParticipantCount: number;
  onAddEntry: (label: string) => void;
  onAddEntries: (labels: string[]) => void;
  onAddParticipants: () => void;
  onRemoveEntry: (entryId: string) => void;
  onShuffle: () => void;
  onSort: () => void;
  onClearEntries: () => void;
  onClearHistory: () => void;
  onToggleRemoveWinner: (value: boolean) => void;
};

type PanelTab = "names" | "results";

const iconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const UsersIcon = () => (
  <svg {...iconProps}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const ShuffleIcon = () => (
  <svg {...iconProps}>
    <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
    <path d="M22 18h-5.9c-1.4 0-2.6-.7-3.3-1.8l-.5-.8" />
    <path d="m18 14 4 4-4 4" />
  </svg>
);

const SortIcon = () => (
  <svg {...iconProps}>
    <path d="m3 8 4-4 4 4" />
    <path d="M7 4v16" />
    <path d="M15 5h6" />
    <path d="M15 9h4" />
    <path d="M15 13h2" />
  </svg>
);

const TrashIcon = () => (
  <svg {...iconProps}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const MiniWheelIcon = () => (
  <svg
    width={26}
    height={26}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v6.5" />
    <path d="m19.8 16.5-5.6-3.25" />
    <path d="m4.2 16.5 5.6-3.25" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

const formatTime = (value: number): string =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

const splitPastedNames = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function WheelPanel({
  entries,
  history,
  canEdit,
  locked,
  isAdmin,
  isSpinning,
  removeWinnerOnDone,
  missingParticipantCount,
  onAddEntry,
  onAddEntries,
  onAddParticipants,
  onRemoveEntry,
  onShuffle,
  onSort,
  onClearEntries,
  onClearHistory,
  onToggleRemoveWinner,
}: WheelPanelProps) {
  const [tab, setTab] = useState<PanelTab>("names");
  const [draft, setDraft] = useState("");

  const editingBlocked = !canEdit || isSpinning;
  const atCapacity = entries.length >= MAX_WHEEL_ENTRIES;

  const entryColors = useMemo(
    () =>
      entries.map((_, index) => segmentColor(index, Math.max(entries.length, 1))),
    [entries]
  );

  const submitDraft = () => {
    const value = draft.trim();
    if (!value) return;
    onAddEntry(value);
    setDraft("");
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const names = splitPastedNames(text);
    if (names.length <= 1) return;
    event.preventDefault();
    onAddEntries(names);
    setDraft("");
  };

  const chipClass =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-[5px] text-[11px] font-medium text-[#c4c4cc] transition-colors hover:border-white/20 hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Identity + status */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 pb-3 pt-3.5">
        <span className="text-[#f95f4a]">
          <MiniWheelIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-[#fafafa]">
            Spin the wheel
          </h2>
          <p className="truncate text-[11px] text-[#71717a]">
            {entries.length === 0
              ? "Add names, then spin"
              : `${entries.length} name${entries.length === 1 ? "" : "s"} on the wheel`}
          </p>
        </div>
        {locked && (
          <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
            {isAdmin ? "Locked" : "View only"}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="px-3 pt-3">
        <div className="flex rounded-full border border-white/[0.08] bg-white/[0.03] p-[3px]">
          {(
            [
              ["names", `Names${entries.length > 0 ? ` · ${entries.length}` : ""}`],
              ["results", `Results${history.length > 0 ? ` · ${history.length}` : ""}`],
            ] as const
          ).map(([key, labelText]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex-1 cursor-pointer rounded-full px-3 py-[5px] text-[11.5px] font-medium transition-colors ${
                tab === key
                  ? "bg-white/10 text-[#fafafa]"
                  : "text-[#71717a] hover:text-[#c4c4cc]"
              }`}
            >
              {labelText}
            </button>
          ))}
        </div>
      </div>

      {tab === "names" ? (
        <>
          {canEdit && (
            <div className="px-3 pt-3">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submitDraft();
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={handlePaste}
                  disabled={isSpinning || atCapacity}
                  placeholder={
                    atCapacity ? "Wheel is full" : "Add a name — paste a list works"
                  }
                  className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12.5px] text-[#fafafa] outline-none transition-colors placeholder:text-[#fafafa]/28 focus:border-[#f95f4a]/50 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={editingBlocked || atCapacity || !draft.trim()}
                  className="h-9 cursor-pointer rounded-lg bg-[#f95f4a] px-3.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Add
                </button>
              </form>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={chipClass}
                  onClick={onAddParticipants}
                  disabled={editingBlocked || missingParticipantCount === 0}
                  title="Add every meeting participant"
                >
                  <UsersIcon />
                  Everyone here
                  {missingParticipantCount > 0 && ` · ${missingParticipantCount}`}
                </button>
                <button
                  type="button"
                  className={chipClass}
                  onClick={onShuffle}
                  disabled={editingBlocked || entries.length < 2}
                  title="Shuffle the order"
                >
                  <ShuffleIcon />
                  Shuffle
                </button>
                <button
                  type="button"
                  className={chipClass}
                  onClick={onSort}
                  disabled={editingBlocked || entries.length < 2}
                  title="Sort alphabetically"
                >
                  <SortIcon />
                  A–Z
                </button>
                <button
                  type="button"
                  className={chipClass}
                  onClick={onClearEntries}
                  disabled={editingBlocked || entries.length === 0}
                  title="Remove every name"
                >
                  <TrashIcon />
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {entries.length === 0 ? (
              <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center">
                <span className="text-[#3f3f46]">
                  <MiniWheelIcon />
                </span>
                <p className="text-[12px] leading-relaxed text-[#71717a]">
                  {canEdit
                    ? "No names yet. Type one above, paste a whole list, or pull in everyone from the meeting."
                    : "No names yet. The host is setting up the wheel."}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {entries.map((entry, index) => (
                  <li
                    key={entry.id}
                    className="group flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-[7px] transition-colors hover:border-white/[0.12]"
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-[4px]"
                      style={{ backgroundColor: entryColors[index] }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#fafafa]/90">
                      {entry.label}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => onRemoveEntry(entry.id)}
                        disabled={isSpinning}
                        aria-label={`Remove ${entry.label}`}
                        className="cursor-pointer rounded p-0.5 text-[#fafafa]/25 opacity-0 transition-opacity hover:text-[#fafafa]/80 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                      >
                        <svg {...iconProps} width={12} height={12}>
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {atCapacity && canEdit && (
              <p className="px-1 pt-2 text-[11px] text-[#71717a]">
                Wheel is full ({MAX_WHEEL_ENTRIES} names max).
              </p>
            )}
          </div>

          {canEdit && (
            <div className="border-t border-white/[0.06] px-3 py-2.5">
              <label
                className="flex cursor-pointer items-center justify-between gap-3"
                title="Winners come off the wheel automatically, so nobody gets picked twice"
              >
                <span className="text-[11.5px] text-[#c4c4cc]">
                  Remove winner after each spin
                </span>
                <input
                  type="checkbox"
                  checked={removeWinnerOnDone}
                  onChange={(event) => onToggleRemoveWinner(event.target.checked)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#f95f4a]"
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {history.length === 0 ? (
              <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center">
                <p className="text-[12px] leading-relaxed text-[#71717a]">
                  No results yet. Winners land here after each spin.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {history.map((result, index) => (
                  <li
                    key={result.spinId}
                    className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-[7px] ${
                      index === 0
                        ? "border-[#f95f4a]/35 bg-[#f95f4a]/[0.07]"
                        : "border-white/[0.06] bg-white/[0.03]"
                    }`}
                  >
                    <span
                      className={`w-6 shrink-0 text-center text-[10.5px] font-semibold tabular-nums ${
                        index === 0 ? "text-[#f95f4a]" : "text-[#52525b]"
                      }`}
                    >
                      #{history.length - index}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#fafafa]/90">
                      {result.label}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-[#52525b]">
                      {formatTime(result.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {canEdit && history.length > 0 && (
            <div className="border-t border-white/[0.06] px-3 py-2.5">
              <button type="button" className={chipClass} onClick={onClearHistory}>
                <TrashIcon />
                Clear results
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
