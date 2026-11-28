import React, { useEffect, useRef, useState } from "react";
import { parseVideoId } from "../../core/youtube/id";
import { CROWD_PICKS } from "../crowdPicks";
import {
  fetchTrending,
  fetchVideoTitle,
  formatAge,
  formatDuration,
  formatViews,
  searchVideos,
  thumbnailUrl,
  type WatchSearchResult,
} from "../youtubeMeta";

type WatchEmptyStateProps = {
  onStart: (videoId: string, title?: string | null) => void;
  readOnly: boolean;
  mode?: "start" | "add" | "request";
};

const PICK_LABEL: Record<"start" | "add" | "request", string> = {
  start: "Play",
  add: "Add",
  request: "Request",
};

const PREVIEW_HINT: Record<"start" | "add" | "request", string> = {
  start: "Plays in sync for everyone",
  add: "Adds to Up next",
  request: "Sends a request to the host",
};

const HEADING: Record<"start" | "add" | "request", { title: string; hint: string }> = {
  start: {
    title: "Watch together",
    hint: "Search YouTube or paste a link. It plays in sync for everyone.",
  },
  add: { title: "Add to Up next", hint: "Pick a video or paste a link." },
  request: { title: "Request a video", hint: "The host approves requests." },
};

export function WatchEmptyState({
  onStart,
  readOnly,
  mode = "start",
}: WatchEmptyStateProps) {
  const [value, setValue] = useState("");
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [trending, setTrending] = useState<WatchSearchResult[]>([]);
  const [trendingToken, setTrendingToken] = useState<string | null>(null);
  const [trendingLoaded, setTrendingLoaded] = useState(false);
  const [browseUnavailable, setBrowseUnavailable] = useState(false);
  const [results, setResults] = useState<WatchSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [searchUnavailable, setSearchUnavailable] = useState(false);
  const requestRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  const previewId = parseVideoId(value);

  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    void fetchTrending().then((page) => {
      if (cancelled) return;
      setTrending(page.items);
      setTrendingToken(page.nextPageToken);
      setBrowseUnavailable(page.unavailable);
      setTrendingLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [readOnly]);

  useEffect(() => {
    if (readOnly || !trendingToken) return;
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (loadingMoreRef.current) return;
        loadingMoreRef.current = true;
        void fetchTrending(trendingToken).then((page) => {
          loadingMoreRef.current = false;
          setTrendingToken(page.nextPageToken);
          if (page.items.length === 0) return;
          setTrending((previous) => {
            const seen = new Set(previous.map((item) => item.videoId));
            return [
              ...previous,
              ...page.items.filter((item) => !seen.has(item.videoId)),
            ];
          });
        });
      },
      { root, rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [readOnly, trendingToken, results, previewId]);

  useEffect(() => {
    if (!previewId) {
      setPreviewTitle(null);
      return;
    }
    const requestId = ++requestRef.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchVideoTitle(previewId).then((title) => {
        if (cancelled || requestRef.current !== requestId) return;
        setPreviewTitle(title);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewId]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (readOnly) return;
    if (previewId) {
      onStart(previewId, previewTitle);
      return;
    }
    const query = value.trim();
    if (!query) return;
    const requestId = ++requestRef.current;
    setSearching(true);
    setSearchedFor(query);
    void searchVideos(query).then((outcome) => {
      if (requestRef.current !== requestId) return;
      setResults(outcome.items);
      setSearchUnavailable(outcome.unavailable);
      setSearching(false);
    });
  };

  if (readOnly) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div
            aria-hidden="true"
            className="mx-auto flex aspect-video w-full items-center justify-center rounded-2xl border border-white/10"
            style={{ backgroundColor: "#101014" }}
          >
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{ backgroundColor: "#F95F4A" }}
            >
              <PlayGlyph />
            </span>
          </div>
          <p className="mt-5 text-center text-[15px] font-medium text-[#fafafa]">
            Waiting for the host to pick a video
          </p>
          <p className="mt-1.5 text-center text-[12.5px] text-[#a1a1aa]">
            It plays in sync for everyone.
          </p>
        </div>
      </div>
    );
  }

  const showResults = results !== null || searching;
  const fallbackMode = !showResults && trendingLoaded && trending.length === 0;
  const showSkeletons = searching || (!showResults && !trendingLoaded);
  const gridItems = showResults
    ? (results ?? [])
    : trending.length > 0
      ? trending
      : fallbackMode
        ? CROWD_PICKS
        : [];

  return (
    <div ref={scrollRef} className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pb-8 pt-6 sm:px-6">
        <div className="mx-auto mb-4 max-w-xl text-center">
          <h2 className="text-[16px] font-medium text-[#fafafa]">
            {HEADING[mode].title}
          </h2>
          <p className="mt-1 text-[12.5px] text-[#a1a1aa]">{HEADING[mode].hint}</p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="relative mx-auto w-full max-w-xl"
        >
          <input
            type="text"
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search YouTube or paste a link"
            aria-label="Search YouTube or paste a link"
            className="h-11 w-full rounded-full border border-white/10 bg-white/[0.04] pl-4 pr-24 text-sm text-[#fafafa] outline-none transition-colors placeholder:text-[#71717a] focus:border-[#F95F4A]/50"
          />
          <button
            type="submit"
            disabled={!value.trim()}
            aria-label={
              previewId
                ? mode === "start"
                  ? "Play for everyone"
                  : PICK_LABEL[mode]
                : "Search"
            }
            className="absolute right-1.5 top-1/2 flex h-8 -translate-y-1/2 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ backgroundColor: "#F95F4A" }}
          >
            {previewId ? (
              <>
                {mode === "start" ? <PlayGlyph size={11} /> : <PlusGlyph size={12} />}
                {PICK_LABEL[mode]}
              </>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            )}
          </button>
        </form>

        {previewId ? (
          <button
            type="button"
            onClick={() => onStart(previewId, previewTitle)}
            className="group mx-auto mt-8 block w-full max-w-md cursor-pointer text-left"
          >
            <div
              className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 transition-colors group-hover:border-white/25"
              style={{ backgroundColor: "#101014" }}
            >
              <img
                src={thumbnailUrl(previewId)}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
              <div
                className="absolute inset-0"
                style={{ backgroundColor: "rgba(0, 0, 0, 0.35)" }}
              />
              <span
                className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                style={{ backgroundColor: "#F95F4A" }}
              >
                <PlayGlyph />
              </span>
            </div>
            <p className="mt-2.5 text-center text-[13px] font-medium text-[#fafafa]">
              {previewTitle ??
                (mode === "start" ? "Play this link" : "Pick this link")}
            </p>
            <p className="mt-1 text-center text-[11.5px] text-[#71717a]">
              {PREVIEW_HINT[mode]}
            </p>
          </button>
        ) : (
          <>
            {fallbackMode ? (
              <div className="mx-auto mt-12 max-w-sm text-center">
                <h3 className="text-[15px] font-medium text-[#fafafa]">
                  Paste a link to start
                </h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[#a1a1aa]">
                  {browseUnavailable
                    ? "Search is off here. Any YouTube link still plays in sync."
                    : "Nothing trending right now. Any YouTube link plays in sync."}
                </p>
              </div>
            ) : null}

            <div className="mt-8 flex items-center gap-2">
              {showResults ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F95F4A" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <h3 className="text-[13px] font-medium text-[#fafafa]">
                    {searching
                      ? "Searching"
                      : `Results for "${searchedFor ?? ""}"`}
                  </h3>
                  {!searching ? (
                    <button
                      type="button"
                      onClick={() => {
                        setResults(null);
                        setSearchedFor(null);
                        setSearchUnavailable(false);
                        setValue("");
                      }}
                      className="ml-0.5 inline-flex h-7 cursor-pointer items-center rounded-full px-2 text-[12px] text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                    >
                      Clear
                    </button>
                  ) : null}
                </>
              ) : trending.length > 0 ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F95F4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                  </svg>
                  <h3 className="text-[13px] font-medium text-[#fafafa]">
                    Trending
                  </h3>
                </>
              ) : fallbackMode ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F95F4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l1.9 5.8a2 2 0 001.3 1.3L21 12l-5.8 1.9a2 2 0 00-1.3 1.3L12 21l-1.9-5.8a2 2 0 00-1.3-1.3L3 12l5.8-1.9a2 2 0 001.3-1.3L12 3z" />
                  </svg>
                  <h3 className="text-[13px] font-medium text-[#fafafa]">
                    Classics
                  </h3>
                </>
              ) : null}
            </div>

            {showResults && !searching && gridItems.length === 0 ? (
              <p className="mt-3 text-[12.5px] text-[#a1a1aa]" role="status">
                {searchUnavailable
                  ? "Search is off here. Paste a YouTube link."
                  : "No results. Try other words or paste a link."}
              </p>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 xl:grid-cols-4">
              {showSkeletons
                ? Array.from({ length: 8 }).map((_, index) => (
                    <div key={index} aria-hidden="true">
                      <div
                        className="aspect-video w-full rounded-xl border border-white/[0.06]"
                        style={{ backgroundColor: "#101014" }}
                      />
                      <div
                        className="mt-2 h-3 w-4/5 rounded"
                        style={{ backgroundColor: "#17171c" }}
                      />
                      <div
                        className="mt-1.5 h-2.5 w-2/5 rounded"
                        style={{ backgroundColor: "#131318" }}
                      />
                    </div>
                  ))
                : gridItems.map((item) => {
                    const duration = formatDuration(item.durationSeconds);
                    const views = formatViews(item.views);
                    const age = formatAge(item.publishedAt);
                    const meta = [views, age].filter(Boolean).join(" · ");
                    return (
                      <button
                        key={item.videoId}
                        type="button"
                        onClick={() => onStart(item.videoId, item.title)}
                        className="group flex cursor-pointer flex-col rounded-xl text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#F95F4A]/60"
                      >
                        <div
                          className="relative aspect-video w-full overflow-hidden rounded-xl border border-white/[0.08] transition-colors group-hover:border-white/25"
                          style={{ backgroundColor: "#101014" }}
                        >
                          <img
                            src={item.thumbnail ?? thumbnailUrl(item.videoId)}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                            draggable={false}
                          />
                          {duration ? (
                            <span
                              className="absolute bottom-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-white"
                              style={{ backgroundColor: "rgba(0, 0, 0, 0.85)" }}
                            >
                              {duration}
                            </span>
                          ) : null}
                          <span
                            className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            style={{ backgroundColor: "#F95F4A" }}
                          >
                            {mode === "start" ? (
                              <PlayGlyph size={12} />
                            ) : (
                              <PlusGlyph size={14} />
                            )}
                          </span>
                        </div>
                        <p
                          className="mt-2 text-[13px] font-medium leading-snug text-[#f4f4f5]"
                          style={{
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {item.title}
                        </p>
                        {item.channel ? (
                          <p className="mt-1 truncate text-[11.5px] text-[#a1a1aa]">
                            {item.channel}
                          </p>
                        ) : null}
                        {meta ? (
                          <p className="mt-0.5 truncate text-[11px] text-[#71717a]">
                            {meta}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
            </div>
            {!showResults && trendingToken ? (
              <div ref={sentinelRef} aria-hidden="true" className="h-px" />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PlayGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="#ffffff"
      aria-hidden="true"
      style={{ marginLeft: 2 }}
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function PlusGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#ffffff"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
