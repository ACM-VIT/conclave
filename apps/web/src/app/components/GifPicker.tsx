"use client";

import { Images, Loader2, Search, X } from "lucide-react";
import {
  Activity,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatGifAttachment } from "../lib/types";
import {
  klipyMediaResultToAttachment,
  type KlipyMediaKind,
  type KlipyMediaResult,
  type KlipyMediaSearchResponse,
} from "../lib/klipy-gifs";
import Coachmark from "./Coachmark";
import { useOneTimeHint } from "../hooks/useOneTimeHint";

interface GifPickerProps {
  disabled?: boolean;
  onSelect: (gif: ChatGifAttachment) => void;
  variant?: "desktop" | "mobile";
}

const SEARCH_DEBOUNCE_MS = 250;
const ITEMS_PER_PAGE = 16;

const MEDIA_TABS: ReadonlyArray<{
  kind: KlipyMediaKind;
  label: string;
  noun: string;
}> = [
  { kind: "gifs", label: "GIFs", noun: "GIFs" },
  { kind: "stickers", label: "Stickers", noun: "stickers" },
  { kind: "clips", label: "Clips", noun: "clips" },
];

function GifPicker({
  disabled = false,
  onSelect,
  variant = "desktop",
}: GifPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Latches true on first open. Drives data loading instead of `isOpen` so that
  // <Activity> can keep the closed panel mounted (preserving results + scroll)
  // without the load effect refetching page 1 every time it reopens.
  const [hasOpened, setHasOpened] = useState(false);
  const [mediaKind, setMediaKind] = useState<KlipyMediaKind>("gifs");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<KlipyMediaResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noun = useMemo(
    () => MEDIA_TABS.find((tab) => tab.kind === mediaKind)?.noun ?? "results",
    [mediaKind],
  );

  // Announce the newly added stickers + clips catalogs on the picker itself, so
  // even people who already dismissed the original "GIFs are here" tip see it.
  const stickersClipsTip = useOneTimeHint("chat-stickers-clips", {
    enabled: !disabled && !isOpen,
    delay: 900,
  });

  useEffect(() => {
    if (!disabled) return;
    setIsOpen(false);
  }, [disabled]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!hasOpened) return;

    const controller = new AbortController();
    const loadItems = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          media: mediaKind,
          page: "1",
          limit: String(ITEMS_PER_PAGE),
        });
        if (debouncedQuery) {
          params.set("q", debouncedQuery);
        }

        const response = await fetch(`/api/klipy/gifs?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`${noun} search failed.`);
        }
        const body = (await response.json()) as KlipyMediaSearchResponse;
        setItems(body.items);
        setPage(body.page);
        setHasNext(body.hasNext);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setItems([]);
        setHasNext(false);
        setError(
          loadError instanceof Error
            ? loadError.message
            : `${noun} search failed.`,
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadItems();
    return () => controller.abort();
  }, [debouncedQuery, hasOpened, mediaKind, noun]);

  const loadMore = useCallback(async () => {
    if (isLoading || isLoadingMore || !hasNext) return;

    setIsLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        media: mediaKind,
        page: String(page + 1),
        limit: String(ITEMS_PER_PAGE),
      });
      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      }

      const response = await fetch(`/api/klipy/gifs?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`More ${noun} failed to load.`);
      }
      const body = (await response.json()) as KlipyMediaSearchResponse;
      setItems((prev) => [...prev, ...body.items]);
      setPage(body.page);
      setHasNext(body.hasNext);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : `More ${noun} failed to load.`,
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    debouncedQuery,
    hasNext,
    isLoading,
    isLoadingMore,
    mediaKind,
    noun,
    page,
  ]);

  // Point the scroll observer at the freshest loadMore without rebuilding the
  // IntersectionObserver every time paging state changes. Writing the ref during
  // render is intentional: it only caches the latest closure, it renders nothing.
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Auto-load the next page when the bottom sentinel scrolls into view, so the
  // user never has to click "More". The callback ref owns the observer's whole
  // lifecycle: it (re)attaches when the sentinel mounts and disconnects on unmount.
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node?.parentElement) return;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreRef.current();
        }
      },
      { root: node.parentElement, rootMargin: "150px 0px" },
    );
    observerRef.current.observe(node);
  }, []);

  const panelClassName = useMemo(
    () =>
      variant === "mobile"
        ? "absolute bottom-full left-0 z-20 mb-2 w-[min(22rem,calc(100vw-2rem))]"
        : // Anchor to the composer wrapper so the panel spans the full input
          // width and aligns edge-to-edge with it instead of floating off the button.
          "absolute bottom-full left-0 right-0 z-20 mb-2",
    [variant],
  );

  const handleSelectMedia = (item: KlipyMediaResult) => {
    onSelect(klipyMediaResultToAttachment(item));
    setIsOpen(false);
    setQuery("");
  };

  const handleSelectTab = (kind: KlipyMediaKind) => {
    if (kind === mediaKind) return;
    setMediaKind(kind);
    setItems([]);
    setPage(1);
    setHasNext(false);
    setError(null);
  };

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!isOpen) {
            stickersClipsTip.dismiss();
            setHasOpened(true);
          }
          setIsOpen((prev) => !prev);
        }}
        aria-label="GIFs, stickers, and clips"
        aria-expanded={isOpen}
        title="GIFs, stickers, and clips"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,color,opacity] ${
          isOpen
            ? "bg-white/[0.12] text-[#fafafa]"
            : "text-[#a1a1aa] hover:bg-white/[0.07] hover:text-[#fafafa]"
        } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
      >
        <Images size={18} strokeWidth={1.75} />
      </button>

      {stickersClipsTip.visible && !isOpen ? (
        <Coachmark
          title="Stickers & clips, too"
          description="Browse Klipy stickers and short video clips right here."
          onDismiss={stickersClipsTip.dismiss}
          arrowLeft="1rem"
          className="!left-0 !translate-x-0"
        />
      ) : null}

      {/* Once opened, keep the panel mounted but hidden via <Activity> so its
          loaded media, search query, and scroll position survive close/reopen
          and the next open is instant. React skips rendering work while hidden. */}
      {hasOpened ? (
        <Activity mode={isOpen ? "visible" : "hidden"}>
          <div
            className={`${panelClassName} overflow-hidden rounded-xl border border-white/10 bg-[#232327] shadow-2xl shadow-black/40`}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
              <Search size={15} strokeWidth={1.75} className="text-[#a1a1aa]" />
              <div className="relative min-w-0 flex-1">
                {!query ? (
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1.5 whitespace-nowrap text-[13px] leading-none text-[#a1a1aa]">
                    <span>Search</span>
                    <img
                      src="/klipy.svg"
                      alt=""
                      aria-hidden="true"
                      className="h-[12px] w-auto opacity-60"
                    />
                  </div>
                ) : null}
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={`Search Klipy ${noun}`}
                  className="w-full bg-transparent text-[13px] text-[#fafafa] focus:outline-none"
                />
              </div>
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
                >
                  <X size={14} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>

            <div
              role="tablist"
              aria-label="Media type"
              className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5"
            >
              {MEDIA_TABS.map((tab) => {
                const isActive = tab.kind === mediaKind;
                return (
                  <button
                    key={tab.kind}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleSelectTab(tab.kind)}
                    className={`inline-flex h-7 flex-1 items-center justify-center rounded-md text-[12px] font-medium transition-colors ${
                      isActive
                        ? "bg-white/[0.12] text-[#fafafa]"
                        : "text-[#a1a1aa] hover:bg-white/[0.06] hover:text-[#fafafa]"
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="h-[18rem] overflow-y-auto p-2">
              {isLoading ? (
                <div className="flex h-full items-center justify-center text-[#a1a1aa]">
                  <Loader2
                    size={20}
                    strokeWidth={1.75}
                    className="animate-spin"
                  />
                </div>
              ) : error && items.length === 0 ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-[#a1a1aa]">
                  {error}
                </div>
              ) : items.length === 0 ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-[#a1a1aa]">
                  No {noun} found
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.map((item) => (
                      <button
                        key={`${item.id}-${item.url}`}
                        type="button"
                        onClick={() => handleSelectMedia(item)}
                        className="group relative aspect-[4/3] overflow-hidden rounded-lg bg-black/30 outline-none ring-1 ring-white/[0.06] transition-[filter,ring-color] hover:brightness-110 hover:ring-white/20 focus-visible:ring-2 focus-visible:ring-[#F95F4A]"
                        title={item.title}
                      >
                        {item.kind === "clip" && item.videoUrl ? (
                          <video
                            src={item.videoUrl}
                            poster={item.previewUrl}
                            muted
                            loop
                            autoPlay
                            playsInline
                            preload="metadata"
                            aria-label={item.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <img
                            src={item.previewUrl}
                            alt={item.title}
                            loading="lazy"
                            className={`h-full w-full ${
                              item.kind === "sticker"
                                ? "object-contain"
                                : "object-cover"
                            }`}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                  {hasNext ? (
                    <div
                      ref={sentinelRef}
                      className="flex h-10 items-center justify-center"
                    >
                      {error ? (
                        <button
                          type="button"
                          onClick={() => void loadMore()}
                          className="text-[12px] font-medium text-[#a1a1aa] transition-colors hover:text-[#fafafa]"
                        >
                          Couldn&apos;t load more. Retry
                        </button>
                      ) : (
                        <Loader2
                          size={16}
                          strokeWidth={1.75}
                          className="animate-spin text-[#a1a1aa]"
                        />
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex items-center border-t border-white/10 px-2.5 py-2">
              <a
                href="https://klipy.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-5 items-center opacity-75 transition-opacity hover:opacity-100"
                aria-label="Powered by Klipy"
              >
                <img
                  src="/pow-by-klipy.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-4 w-auto"
                />
              </a>
            </div>
          </div>
        </Activity>
      ) : null}
    </div>
  );
}

export default memo(GifPicker);
