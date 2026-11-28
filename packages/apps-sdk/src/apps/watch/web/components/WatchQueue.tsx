import React, { useRef, useState } from "react";
import type { QueueItem } from "../../core/model/types";
import { parseVideoId } from "../../core/youtube/id";
import {
  searchVideos,
  thumbnailUrl,
  type WatchSearchResult,
} from "../youtubeMeta";

type NowPlaying = {
  videoId: string;
  title: string | null;
};

type WatchQueueProps = {
  items: QueueItem[];
  nowPlaying: NowPlaying | null;
  readOnly: boolean;
  onAdd: (videoId: string, title?: string | null) => void;
  onRemove: (itemId: string) => void;
  onPlayNow: (itemId: string) => void;
  onMove: (itemId: string, direction: -1 | 1) => void;
  headerAccessory?: React.ReactNode;
  requestsSection?: React.ReactNode;
  addSection?: React.ReactNode;
};

function QueueAddBox({
  onAdd,
}: {
  onAdd: (videoId: string, title?: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [results, setResults] = useState<WatchSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const requestRef = useRef(0);

  const reset = () => {
    setValue("");
    setResults(null);
    setSearching(false);
    setSearchUnavailable(false);
    requestRef.current += 1;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    const id = parseVideoId(raw);
    if (id) {
      onAdd(id);
      reset();
      return;
    }
    const requestId = ++requestRef.current;
    setSearching(true);
    void searchVideos(raw).then((outcome) => {
      if (requestRef.current !== requestId) return;
      setResults(outcome.items.slice(0, 5));
      setSearchUnavailable(outcome.unavailable);
      setSearching(false);
    });
  };

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex items-stretch gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (results) setResults(null);
          }}
          placeholder="Search or paste a link"
          aria-label="Add a video to Up next"
          className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12.5px] text-[#fafafa] outline-none transition-colors placeholder:text-[#71717a] focus:border-[#F95F4A]/50"
        />
        <button
          type="submit"
          disabled={!value.trim() || searching}
          className="h-9 shrink-0 cursor-pointer rounded-lg px-3 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed"
          style={
            !value.trim() || searching
              ? { backgroundColor: "#26262d", color: "#71717a" }
              : { backgroundColor: "#F95F4A", color: "#ffffff" }
          }
        >
          Add
        </button>
      </form>
      {searching ? (
        <p className="mt-2 text-[12px] text-[#71717a]" role="status">Searching</p>
      ) : null}
      {results !== null && !searching ? (
        results.length === 0 ? (
          <p className="mt-2 text-[12px] text-[#71717a]" role="status">
            {searchUnavailable
              ? "Search is off here. Paste a YouTube link."
              : "No results. Try other words or paste a link."}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-0.5 rounded-lg border border-white/[0.06] p-1" style={{ backgroundColor: "#0c0c10" }}>
            {results.map((item) => (
              <li key={item.videoId}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(item.videoId, item.title);
                    reset();
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/[0.06]"
                >
                  <div
                    className="h-8 w-14 shrink-0 overflow-hidden rounded border border-white/[0.06]"
                    style={{ backgroundColor: "#0a0a0b" }}
                  >
                    <img
                      src={item.thumbnail ?? thumbnailUrl(item.videoId)}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                      draggable={false}
                    />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium text-[#e4e4e7]">
                      {item.title}
                    </span>
                    {item.channel ? (
                      <span className="block truncate text-[10px] text-[#71717a]">
                        {item.channel}
                      </span>
                    ) : null}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

const ROW_ACTION =
  "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F95F4A]/60 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";

export function WatchQueue({
  items,
  nowPlaying,
  readOnly,
  onAdd,
  onRemove,
  onPlayNow,
  onMove,
  headerAccessory,
  requestsSection,
  addSection,
}: WatchQueueProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden">
      <div className="border-b border-white/[0.06] px-3 pb-3 pt-2.5">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <h3 className="text-[12px] font-medium text-[#a1a1aa]">Now playing</h3>
          {headerAccessory ? (
            <div className="flex shrink-0 items-center gap-1">{headerAccessory}</div>
          ) : null}
        </div>
        {nowPlaying ? (
          <div className="mt-2 flex items-center gap-2.5">
            <div
              className="h-9 w-16 shrink-0 overflow-hidden rounded-md border border-white/10"
              style={{ backgroundColor: "#0a0a0b" }}
            >
              <img
                src={thumbnailUrl(nowPlaying.videoId)}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            </div>
            <p
              className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-[#fafafa]"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {nowPlaying.title ?? nowPlaying.videoId}
            </p>
          </div>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="border-b border-white/[0.06] px-3 py-2.5">
          <QueueAddBox onAdd={onAdd} />
        </div>
      ) : addSection ? (
        <div className="border-b border-white/[0.06] px-3 py-2.5">{addSection}</div>
      ) : null}

      {requestsSection}

      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3">
        <h3 className="whitespace-nowrap text-[12px] font-medium text-[#fafafa]">
          Up next
        </h3>
        {items.length > 0 ? (
          <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10.5px] tabular-nums text-[#a1a1aa]">
            {items.length}
          </span>
        ) : null}
      </div>

      <div className="px-1.5 pb-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-1.5 py-1.5 text-[12px] leading-relaxed text-[#71717a]">
            {readOnly
              ? "Nothing up next."
              : "Nothing up next. Add a video and it plays for everyone when this one ends."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-white/[0.05]"
              >
                <div
                  className="relative h-9 w-16 shrink-0 overflow-hidden rounded-md border border-white/[0.06]"
                  style={{ backgroundColor: "#0a0a0b" }}
                >
                  <img
                    src={thumbnailUrl(item.videoId)}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                  />
                  {!readOnly ? (
                    <button
                      type="button"
                      onClick={() => onPlayNow(item.id)}
                      aria-label="Play now"
                      title="Play now"
                      className="absolute inset-0 flex cursor-pointer items-center justify-center opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                      style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true">
                        <polygon points="6 4 20 12 6 20 6 4" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className="text-[12px] font-medium leading-snug text-[#e4e4e7]"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {item.title ?? item.videoId}
                  </p>
                  {item.addedByName ? (
                    <p className="mt-0.5 truncate text-[11px] text-[#71717a]">
                      {item.addedByName}
                    </p>
                  ) : null}
                </div>
                {!readOnly ? (
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <button
                      type="button"
                      onClick={() => onMove(item.id, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                      title="Move up"
                      className={ROW_ACTION}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(item.id, 1)}
                      disabled={index === items.length - 1}
                      aria-label="Move down"
                      title="Move down"
                      className={ROW_ACTION}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      aria-label="Remove from queue"
                      title="Remove"
                      className={ROW_ACTION}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
