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
  /** Jump this item to the screen right now. */
  onPlayNow: (itemId: string) => void;
  /** Move this item one slot up (-1) or down (1). */
  onMove: (itemId: string, direction: -1 | 1) => void;
  /** Right side of the header row (host pill, collapse control). */
  headerAccessory?: React.ReactNode;
  /** Pending queue requests, rendered between the header and the add box. */
  requestsSection?: React.ReactNode;
};

/**
 * The side rail: a Now playing card, the up-next list with real thumbnails, and
 * an add-to-queue input. Titles are backfilled from metadata when available and
 * fall back to the video id.
 */
/**
 * The rail's add box: a link enqueues immediately; anything else searches on
 * submit and shows a compact result list to tap into the queue.
 */
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
        <p className="mt-2 text-[11.5px] text-[#71717a]">Searching</p>
      ) : null}
      {results !== null && !searching ? (
        results.length === 0 ? (
          <p className="mt-2 text-[11.5px] text-[#71717a]">
            {searchUnavailable
              ? "Search is off on this server. Paste a YouTube link instead."
              : "Nothing found. Try a different search."}
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
}: WatchQueueProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {nowPlaying ? (
        <div className="border-b border-white/[0.06] px-3 pb-3 pt-3">
          <div
            className="overflow-hidden rounded-lg border border-white/10"
            style={{ backgroundColor: "#0a0a0b" }}
          >
            <img
              src={thumbnailUrl(nowPlaying.videoId)}
              alt=""
              className="aspect-video w-full object-cover"
              draggable={false}
            />
          </div>
          <p
            className="mt-2 text-[12.5px] font-medium leading-snug text-[#fafafa]"
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

      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="whitespace-nowrap text-[12px] font-medium text-[#fafafa]">
            Up next
          </h3>
          {items.length > 0 ? (
            <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-[#a1a1aa]">
              {items.length}
            </span>
          ) : null}
        </div>
        {headerAccessory ? (
          <div className="flex shrink-0 items-center gap-1">{headerAccessory}</div>
        ) : null}
      </div>

      {requestsSection}

      {!readOnly ? (
        <div className="px-3 pb-2.5">
          <QueueAddBox onAdd={onAdd} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {items.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-[#71717a]">
            {readOnly
              ? "Nothing queued yet."
              : "Add links to build a queue. When a video ends, the next one plays for everyone."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-white/[0.05]"
              >
                <div
                  className="relative h-10 w-[71px] shrink-0 overflow-hidden rounded-md border border-white/[0.06]"
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
                      className="absolute inset-0 flex cursor-pointer items-center justify-center opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      style={{ backgroundColor: "rgba(0, 0, 0, 0.55)" }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true">
                        <polygon points="6 4 20 12 6 20 6 4" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-[#e4e4e7]">
                    {item.title ?? item.videoId}
                  </p>
                  {item.addedByName ? (
                    <p className="mt-0.5 truncate text-[10.5px] text-[#71717a]">
                      {item.addedByName}
                    </p>
                  ) : null}
                </div>
                {!readOnly ? (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => onMove(item.id, -1)}
                      disabled={index === 0}
                      aria-label="Move up"
                      className="flex h-6 w-5 cursor-pointer items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] disabled:cursor-default disabled:opacity-30"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(item.id, 1)}
                      disabled={index === items.length - 1}
                      aria-label="Move down"
                      className="flex h-6 w-5 cursor-pointer items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa] disabled:cursor-default disabled:opacity-30"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      aria-label="Remove from queue"
                      className="flex h-6 w-5 cursor-pointer items-center justify-center rounded-md text-[#71717a] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
