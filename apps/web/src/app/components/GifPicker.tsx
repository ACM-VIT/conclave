"use client";

import { Images, Loader2, Search, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatGifAttachment } from "../lib/types";
import {
  klipyGifResultToAttachment,
  type KlipyGifResult,
  type KlipyGifSearchResponse,
} from "../lib/klipy-gifs";

interface GifPickerProps {
  disabled?: boolean;
  onSelect: (gif: ChatGifAttachment) => void;
  variant?: "desktop" | "mobile";
}

const SEARCH_DEBOUNCE_MS = 250;
const GIFS_PER_PAGE = 16;

function GifPicker({
  disabled = false,
  onSelect,
  variant = "desktop",
}: GifPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [gifs, setGifs] = useState<KlipyGifResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!isOpen) return;

    const controller = new AbortController();
    const loadGifs = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: "1",
          limit: String(GIFS_PER_PAGE),
        });
        if (debouncedQuery) {
          params.set("q", debouncedQuery);
        }

        const response = await fetch(`/api/klipy/gifs?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("GIF search failed.");
        }
        const body = (await response.json()) as KlipyGifSearchResponse;
        setGifs(body.gifs);
        setPage(body.page);
        setHasNext(body.hasNext);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setGifs([]);
        setHasNext(false);
        setError(
          loadError instanceof Error ? loadError.message : "GIF search failed.",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void loadGifs();
    return () => controller.abort();
  }, [debouncedQuery, isOpen]);

  const loadMore = useCallback(async () => {
    if (isLoading || isLoadingMore || !hasNext) return;

    setIsLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page + 1),
        limit: String(GIFS_PER_PAGE),
      });
      if (debouncedQuery) {
        params.set("q", debouncedQuery);
      }

      const response = await fetch(`/api/klipy/gifs?${params.toString()}`);
      if (!response.ok) {
        throw new Error("More GIFs failed to load.");
      }
      const body = (await response.json()) as KlipyGifSearchResponse;
      setGifs((prev) => [...prev, ...body.gifs]);
      setPage(body.page);
      setHasNext(body.hasNext);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "More GIFs failed to load.",
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [debouncedQuery, hasNext, isLoading, isLoadingMore, page]);

  const panelClassName = useMemo(
    () =>
      variant === "mobile"
        ? "absolute bottom-full left-0 z-20 mb-2 w-[min(22rem,calc(100vw-2rem))]"
        : "absolute bottom-full left-0 z-20 mb-2 w-[20rem]",
    [variant],
  );

  const handleSelect = (gif: KlipyGifResult) => {
    onSelect(klipyGifResultToAttachment(gif));
    setIsOpen(false);
    setQuery("");
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Search GIFs"
        aria-expanded={isOpen}
        title="Search GIFs"
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-[background-color,color,opacity] ${
          isOpen
            ? "bg-white/[0.12] text-[#fafafa]"
            : "text-[#a1a1aa] hover:bg-white/[0.07] hover:text-[#fafafa]"
        } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
      >
        <Images size={18} strokeWidth={1.75} />
      </button>

      {isOpen ? (
        <div
          className={`${panelClassName} overflow-hidden rounded-xl border border-white/10 bg-[#232327] shadow-2xl shadow-black/40`}
        >
          <div className="flex items-center gap-2 border-b border-white/10 px-2.5 py-2">
            <Search size={15} strokeWidth={1.75} className="text-[#a1a1aa]" />
            <div className="relative min-w-0 flex-1">
              {!query ? (
                <div className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 whitespace-nowrap text-[13px] leading-none text-[#a1a1aa]">
                  <span>Search</span>
                  <span aria-hidden="true"> </span>
                  <img
                    src="/klipy.svg"
                    alt=""
                    aria-hidden="true"
                    className="inline h-[0.92em] w-auto opacity-60"
                    style={{ verticalAlign: "-0.18em" }}
                  />
                </div>
              ) : null}
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search Klipy GIFs"
                className="w-full bg-transparent text-[13px] text-[#fafafa] focus:outline-none"
              />
            </div>
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear GIF search"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>

          <div className="max-h-[18rem] overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex h-32 items-center justify-center text-[#a1a1aa]">
                <Loader2 size={20} strokeWidth={1.75} className="animate-spin" />
              </div>
            ) : error ? (
              <div className="flex h-32 items-center justify-center px-4 text-center text-[13px] text-[#a1a1aa]">
                {error}
              </div>
            ) : gifs.length === 0 ? (
              <div className="flex h-32 items-center justify-center px-4 text-center text-[13px] text-[#a1a1aa]">
                No GIFs found
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {gifs.map((gif) => (
                  <button
                    key={`${gif.id}-${gif.url}`}
                    type="button"
                    onClick={() => handleSelect(gif)}
                    className="group relative aspect-[4/3] overflow-hidden rounded-lg bg-black/30 outline-none ring-1 ring-white/[0.06] transition-[filter,ring-color] hover:brightness-110 hover:ring-white/20 focus-visible:ring-2 focus-visible:ring-[#F95F4A]"
                    title={gif.title}
                  >
                    <img
                      src={gif.previewUrl}
                      alt={gif.title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-white/10 px-2.5 py-2">
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
            {hasNext && !isLoading ? (
              <button
                type="button"
                onClick={loadMore}
                disabled={isLoadingMore}
                className="inline-flex h-7 items-center justify-center rounded-md bg-white/[0.07] px-2.5 text-[12px] font-medium text-[#fafafa] transition-colors hover:bg-white/[0.12] disabled:opacity-50"
              >
                {isLoadingMore ? (
                  <Loader2
                    size={14}
                    strokeWidth={1.75}
                    className="animate-spin"
                  />
                ) : (
                  "More"
                )}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default memo(GifPicker);
