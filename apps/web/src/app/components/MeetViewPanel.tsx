"use client";

import {
  Check,
  Grid3X3,
  Minimize2,
  PanelRight,
  PictureInPicture2,
  Scan,
  Square,
  UserRound,
  X,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { Switch } from "@conclave/ui-tokens/web";
import {
  clampMeetViewTiles,
  MEET_VIEW_MAX_TILES,
  MEET_VIEW_MIN_TILES,
  type MeetSelfViewMode,
  type MeetViewMode,
  type MeetViewSettings,
} from "../lib/meet-view";

interface MeetViewPanelProps {
  settings: MeetViewSettings;
  onSettingsChange: Dispatch<SetStateAction<MeetViewSettings>>;
  participantCount: number;
  onClose: () => void;
}

const MODE_OPTIONS: {
  id: MeetViewMode;
  label: string;
  icon: typeof Grid3X3;
}[] = [
  { id: "auto", label: "Auto", icon: Scan },
  { id: "tiled", label: "Tiled", icon: Grid3X3 },
  { id: "spotlight", label: "Spotlight", icon: Square },
  { id: "sidebar", label: "Sidebar", icon: PanelRight },
];

const SELF_VIEW_OPTIONS: {
  id: MeetSelfViewMode;
  label: string;
  icon: typeof Grid3X3;
}[] = [
  { id: "auto", label: "Auto", icon: Scan },
  { id: "tile", label: "Tile", icon: UserRound },
  { id: "floating", label: "Floating", icon: PictureInPicture2 },
  { id: "minimized", label: "Minimized", icon: Minimize2 },
];

function ViewOptionButton<T extends string>({
  id,
  label,
  icon: Icon,
  selected,
  testId,
  dataAttribute,
  onClick,
}: {
  id: T;
  label: string;
  icon: typeof Grid3X3;
  selected: boolean;
  testId?: string;
  dataAttribute?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testId}
      {...(dataAttribute ? { [dataAttribute]: id } : {})}
      className={`relative flex min-h-[72px] flex-col items-start justify-between rounded-[14px] border p-3 text-left transition-[background-color,border-color,box-shadow] duration-[120ms] ${
        selected
          ? ""
          : "border-white/[0.10] bg-[#131316] hover:border-white/[0.18] hover:bg-[#1f1f23]"
      }`}
      style={
        selected
          ? {
              backgroundColor: "#211817",
              borderColor: "rgba(249, 95, 74, 0.7)",
            }
          : undefined
      }
    >
      <Icon
        size={19}
        strokeWidth={1.75}
        className={selected ? "text-[#F95F4A]" : "text-[#a1a1aa]"}
      />
      <span className="text-[13px] font-medium text-[#fafafa]">{label}</span>
      {selected ? (
        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#F95F4A] text-white">
          <Check size={13} strokeWidth={2} />
        </span>
      ) : null}
    </button>
  );
}

export default function MeetViewPanel({
  settings,
  onSettingsChange,
  participantCount,
  onClose,
}: MeetViewPanelProps) {
  const setMode = (mode: MeetViewMode) => {
    onSettingsChange((current) => ({ ...current, mode }));
  };

  const setMaxTiles = (value: number) => {
    onSettingsChange((current) => ({
      ...current,
      maxTiles: clampMeetViewTiles(value),
    }));
  };
  const commitMaxTilesValue = (value: string) => {
    setMaxTiles(Number(value));
  };

  const setHideTilesWithoutVideo = (hideTilesWithoutVideo: boolean) => {
    onSettingsChange((current) => ({ ...current, hideTilesWithoutVideo }));
  };

  const setSelfViewMode = (selfViewMode: MeetSelfViewMode) => {
    onSettingsChange((current) => ({ ...current, selfViewMode }));
  };

  return (
    <aside
      data-testid="meet-view-panel"
      className="fixed bottom-24 right-4 top-4 z-40 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#18181b] text-[#fafafa] animate-[meet-panel-in_180ms_cubic-bezier(0.22,1,0.36,1)]"
      aria-label="Adjust view"
    >
      <header className="flex items-center justify-between border-b border-white/[0.08] px-4 py-4">
        <div>
          <h2 className="text-[16px] font-semibold leading-tight">
            Adjust view
          </h2>
          <p className="mt-0.5 text-[12px] text-[#a1a1aa]">
            {participantCount} participant{participantCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close adjust view"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
        >
          <X size={18} strokeWidth={1.75} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4 [scrollbar-width:thin] [scrollbar-color:rgba(250,250,250,0.24)_transparent]">
        <section className="px-4 py-4">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#a1a1aa]">
            Layout
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {MODE_OPTIONS.map((option) => {
              const selected = settings.mode === option.id;
              return (
                <ViewOptionButton
                  key={option.id}
                  id={option.id}
                  label={option.label}
                  icon={option.icon}
                  selected={selected}
                  testId={`meet-view-mode-${option.id}`}
                  dataAttribute="data-meet-view-option"
                  onClick={() => setMode(option.id)}
                />
              );
            })}
          </div>
        </section>

        <section className="border-t border-white/[0.08] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="meet-max-tiles"
              className="text-[13px] font-medium text-[#fafafa]"
            >
              Maximum tiles
            </label>
            <span className="rounded-full border border-white/[0.10] bg-white/[0.06] px-2.5 py-1 text-[12px] font-medium text-[#fafafa]">
              {settings.maxTiles}
            </span>
          </div>
          <input
            id="meet-max-tiles"
            type="range"
            min={MEET_VIEW_MIN_TILES}
            max={MEET_VIEW_MAX_TILES}
            step={1}
            value={settings.maxTiles}
            onChange={(event) => commitMaxTilesValue(event.currentTarget.value)}
            onInput={(event) => commitMaxTilesValue(event.currentTarget.value)}
            onBlur={(event) => commitMaxTilesValue(event.currentTarget.value)}
            onPointerUp={(event) =>
              commitMaxTilesValue(event.currentTarget.value)
            }
            onKeyUp={(event) => commitMaxTilesValue(event.currentTarget.value)}
            className="mt-3 w-full accent-[#F95F4A]"
          />
        </section>

        <section className="border-t border-white/[0.08] px-4 py-3">
          <div className="flex w-full items-center justify-between gap-3 px-1 py-1.5">
            <span className="text-[13px] font-medium text-[#fafafa]">
              Hide tiles without video
            </span>
            <Switch
              label="Hide tiles without video"
              checked={settings.hideTilesWithoutVideo}
              onChange={setHideTilesWithoutVideo}
            />
          </div>
        </section>

        <section className="border-t border-white/[0.08] px-4 py-4">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#a1a1aa]">
            Self view
          </h3>
          <div
            className="grid grid-cols-2 gap-2"
            data-meet-self-view-options="true"
          >
            {SELF_VIEW_OPTIONS.map((option) => {
              const selected = settings.selfViewMode === option.id;
              return (
                <ViewOptionButton
                  key={option.id}
                  id={option.id}
                  label={option.label}
                  icon={option.icon}
                  selected={selected}
                  testId={`meet-self-view-${option.id}`}
                  dataAttribute="data-meet-self-view-option"
                  onClick={() => setSelfViewMode(option.id)}
                />
              );
            })}
          </div>
        </section>
      </div>
    </aside>
  );
}
