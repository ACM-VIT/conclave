import React, { useEffect, useState } from "react";
import type { WheelEntry, WheelResult } from "../../core/doc/index";
import { MAX_WHEEL_ENTRIES } from "../../core/doc/index";
import {
  LockIcon,
  PlusIcon,
  ShuffleIcon,
  SortIcon,
  TrashIcon,
  UsersIcon,
  VolumeIcon,
  VolumeOffIcon,
  XIcon,
} from "../icons";
import { GHOST_BUTTON, ICON_BUTTON, SECONDARY_BUTTON } from "./buttons";

export type WheelPanelProps = {
  entries: WheelEntry[];
  history: WheelResult[];
  canEdit: boolean;
  locked: boolean;
  isAdmin: boolean;
  isSpinning: boolean;
  soundOn: boolean;
  removeWinnerOnDone: boolean;
  missingParticipantCount: number;
  onToggleSound: () => void;
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

const CLEAR_CONFIRM_MS = 4000;

const formatTime = (value: number): string =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const splitPastedNames = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex h-9 w-full cursor-pointer items-center justify-between gap-3 text-left"
    >
      <span className="text-[13px] text-[#fafafa]/75">{label}</span>
      <span
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-100 ${
          checked ? "bg-[#fafafa]" : "bg-[#2e2e33]"
        }`}
      >
        <span
          className={`absolute top-[3px] h-3 w-3 rounded-full transition-transform duration-100 ease-out ${
            checked ? "bg-[#0a0a0b]" : "bg-[#fafafa]/70"
          }`}
          style={{ transform: `translateX(${checked ? 17 : 3}px)` }}
        />
      </span>
    </button>
  );
}

function TabButton({
  active,
  label,
  count,
  action,
  onSelect,
}: {
  active: boolean;
  label: string;
  count: number;
  action: PanelTab;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-wheel-action={action}
      aria-pressed={active}
      onClick={onSelect}
      className={`h-8 cursor-pointer rounded-md px-3 text-[13px] font-medium transition-colors duration-100 ${
        active ? "bg-[#232327] text-[#fafafa]" : "text-[#fafafa]/55 hover:text-[#fafafa]/85"
      }`}
    >
      {label}
      {count > 0 && <span className="ml-1.5 tabular-nums text-[#fafafa]/45">{count}</span>}
    </button>
  );
}

export function WheelPanel({
  entries,
  history,
  canEdit,
  locked,
  isAdmin,
  isSpinning,
  soundOn,
  removeWinnerOnDone,
  missingParticipantCount,
  onToggleSound,
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
  const [confirmClear, setConfirmClear] = useState(false);

  const blocked = !canEdit || isSpinning;
  const full = entries.length >= MAX_WHEEL_ENTRIES;

  useEffect(() => {
    if (!confirmClear) return;
    if (blocked) {
      setConfirmClear(false);
      return;
    }
    const timer = setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmClear, blocked]);

  const submitDraft = () => {
    const value = draft.trim();
    if (!value) return;
    onAddEntries([value]);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-white/[0.08] px-3">
        <TabButton
          active={tab === "names"}
          label="Names"
          count={entries.length}
          action="names"
          onSelect={() => setTab("names")}
        />
        <TabButton
          active={tab === "results"}
          label="Results"
          count={history.length}
          action="results"
          onSelect={() => setTab("results")}
        />
        <span className="flex-1" />
        {locked && (
          <span
            className="mr-1 inline-flex items-center gap-1.5 text-[12px] text-[#fafafa]/55"
            title={isAdmin ? "Participants can watch but not edit" : "The host locked editing"}
          >
            <LockIcon />
            {isAdmin ? "Locked" : "View only"}
          </span>
        )}
        <button
          type="button"
          onClick={onToggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? "Mute wheel sounds" : "Unmute wheel sounds"}
          title={soundOn ? "Mute wheel sounds" : "Unmute wheel sounds"}
          className={ICON_BUTTON}
        >
          {soundOn ? <VolumeIcon /> : <VolumeOffIcon />}
        </button>
      </div>

      {tab === "names" ? (
        <>
          {canEdit && (
            <div className="shrink-0 px-3 pt-3">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  submitDraft();
                }}
                className="relative"
              >
                <input
                  data-wheel-add
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onPaste={(event) => {
                    const names = splitPastedNames(event.clipboardData.getData("text"));
                    if (names.length <= 1) return;
                    event.preventDefault();
                    onAddEntries(names);
                    setDraft("");
                  }}
                  disabled={isSpinning || full}
                  maxLength={48}
                  placeholder={full ? "The wheel is full" : "Add a name or paste a list"}
                  aria-label="Add a name"
                  className="h-9 w-full rounded-lg border border-white/[0.14] bg-transparent pl-3 pr-10 text-[13px] text-[#fafafa] outline-none transition-colors duration-100 placeholder:text-[#fafafa]/40 disabled:opacity-50"
                />
                <button
                  type="submit"
                  aria-label="Add name"
                  title="Add name"
                  disabled={blocked || full || !draft.trim()}
                  className={`${ICON_BUTTON} absolute right-0.5 top-0.5`}
                >
                  <PlusIcon />
                </button>
              </form>

              {entries.length > 0 && (
                <div className="mt-2 flex h-8 items-center gap-1">
                  {confirmClear ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[#fafafa]/75">
                        Clear all {entries.length} names?
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmClear(false)}
                        className={`${GHOST_BUTTON} h-8`}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-wheel-action="clear-confirm"
                        disabled={blocked}
                        onClick={() => {
                          setConfirmClear(false);
                          if (!blocked) onClearEntries();
                        }}
                        className={`${SECONDARY_BUTTON} h-8`}
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <>
                      {missingParticipantCount > 0 && (
                        <button
                          type="button"
                          data-wheel-action="everyone"
                          onClick={onAddParticipants}
                          disabled={blocked || full}
                          title="Add everyone in the meeting"
                          className={`${GHOST_BUTTON} -ml-2 h-8 px-2`}
                        >
                          <UsersIcon />
                          Add everyone
                          <span className="tabular-nums text-[#fafafa]/45">
                            {missingParticipantCount}
                          </span>
                        </button>
                      )}
                      <span className="flex-1" />
                      <button
                        type="button"
                        data-wheel-action="shuffle"
                        onClick={onShuffle}
                        disabled={blocked || entries.length < 2}
                        aria-label="Shuffle"
                        title="Shuffle"
                        className={ICON_BUTTON}
                      >
                        <ShuffleIcon />
                      </button>
                      <button
                        type="button"
                        data-wheel-action="sort"
                        onClick={onSort}
                        disabled={blocked || entries.length < 2}
                        aria-label="Sort A to Z"
                        title="Sort A to Z"
                        className={ICON_BUTTON}
                      >
                        <SortIcon />
                      </button>
                      <button
                        type="button"
                        data-wheel-action="clear"
                        onClick={() => setConfirmClear(true)}
                        disabled={blocked}
                        aria-label="Clear all names"
                        title="Clear all names"
                        className={ICON_BUTTON}
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-2 text-center">
                <p className="text-[13px] text-[#fafafa]/55">
                  {canEdit ? "Add at least two names to spin." : "The host is adding names."}
                </p>
                {canEdit && missingParticipantCount > 0 && (
                  <button
                    type="button"
                    data-wheel-action="everyone"
                    onClick={onAddParticipants}
                    disabled={blocked}
                    className={SECONDARY_BUTTON}
                  >
                    <UsersIcon />
                    Add everyone in the meeting
                  </button>
                )}
              </div>
            ) : (
              <ol>
                {entries.map((entry, index) => (
                  <li key={entry.id} className="group flex h-9 items-center gap-3">
                    <span className="w-6 shrink-0 text-right text-[12px] tabular-nums text-[#fafafa]/40">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#fafafa]/90">
                      {entry.label}
                    </span>
                    {canEdit && !isSpinning && (
                      <button
                        type="button"
                        onClick={() => onRemoveEntry(entry.id)}
                        aria-label={`Remove ${entry.label}`}
                        title="Remove"
                        className={`${ICON_BUTTON} [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100`}
                      >
                        <XIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {full && canEdit && (
              <p className="pt-2 text-[12px] text-[#fafafa]/45">
                The wheel holds up to {MAX_WHEEL_ENTRIES} names.
              </p>
            )}
          </div>

          {canEdit && (
            <div className="shrink-0 border-t border-white/[0.08] px-3 py-1.5">
              <Switch
                checked={removeWinnerOnDone}
                onChange={onToggleRemoveWinner}
                label="Remove the winner after each spin"
              />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {history.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center">
                <p className="text-[13px] text-[#fafafa]/55">
                  Winners show up here after each spin.
                </p>
              </div>
            ) : (
              <ol>
                {history.map((result, index) => (
                  <li key={result.spinId} className="flex h-9 items-center gap-3">
                    <span className="w-6 shrink-0 text-right text-[12px] tabular-nums text-[#fafafa]/40">
                      {history.length - index}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#fafafa]/90">
                      {result.label}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-[#fafafa]/40">
                      {formatTime(result.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {canEdit && history.length > 0 && (
            <div className="shrink-0 border-t border-white/[0.08] px-3 py-1.5">
              <button type="button" onClick={onClearHistory} className={`${GHOST_BUTTON} -ml-2 px-2`}>
                <TrashIcon />
                Clear results
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
