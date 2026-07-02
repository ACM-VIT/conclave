"use client";

import { useEffect, useRef, useState } from "react";
import { color } from "@conclave/ui-tokens";
import type { TaggedFindMatch } from "./types";
import { Tag } from "./ui";

/**
 * Header person search: ask every connected instance which room someone is
 * in. Debounced; picking a match jumps straight to that room.
 */
export function FindPerson({
  onSearch,
  onPick,
  inputRef,
}: {
  onSearch: (query: string) => Promise<TaggedFindMatch[]>;
  onPick: (match: TaggedFindMatch) => void;
  /** Lets the dashboard focus the box from the "/" shortcut. */
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TaggedFindMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const requestRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setMatches(null);
      setSearching(false);
      return;
    }
    const requestId = ++requestRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void onSearch(trimmed).then((results) => {
        if (requestRef.current !== requestId) return;
        setMatches(results);
        setSearching(false);
        setOpen(true);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [onSearch, query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative w-full max-w-[220px]">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => {
          if (matches) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && matches && matches.length > 0) {
            event.preventDefault();
            onPick(matches[0]);
            setOpen(false);
            setQuery("");
            setMatches(null);
          }
          if (event.key === "Escape") {
            setOpen(false);
            (event.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Find a person ( / )"
        className="h-7 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 text-[12px] text-[#fafafa] outline-none transition-colors placeholder:text-[#fafafa]/35 focus:border-[#F95F4A]/60"
      />
      {open && matches ? (
        <div
          className="absolute right-0 top-9 z-40 w-72 overflow-hidden rounded-xl border"
          style={{ borderColor: color.border, backgroundColor: color.bgAlt }}
        >
          {searching ? (
            <p className="px-3 py-3 text-[12px]" style={{ color: color.textFaint }}>
              Searching
            </p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-3 text-[12px]" style={{ color: color.textFaint }}>
              No matches
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {matches.map((match) => (
                <li key={`${match.instanceKey}-${match.channelId}-${match.userId}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(match);
                      setOpen(false);
                      setQuery("");
                      setMatches(null);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]" style={{ color: color.text }}>
                        {match.displayName}
                      </span>
                      <span className="block truncate text-[11px]" style={{ color: color.textFaint }}>
                        {match.userKey || match.userId}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {match.waiting ? <Tag tone="warn">waiting</Tag> : null}
                      <Tag>{match.roomId}</Tag>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
