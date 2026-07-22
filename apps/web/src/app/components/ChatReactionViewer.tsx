"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Avatar } from "@conclave/ui-tokens/web";
import type { RenderableChatReaction } from "../lib/chat-reactions";

interface ChatReactionViewerProps {
  reactions: RenderableChatReaction[];
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
  onClose: () => void;
}

const ALL_TAB = "__all__";

/** One reactor row's worth of data; emoji is set only on the "All" tab. */
interface ReactorRow {
  userId: string;
  emoji?: string;
}

/**
 * Discord-style reaction roster: an "All" tab plus one tab per emoji.
 *
 * Reactor identities already travel on the wire (ChatMessageReaction carries
 * userIds, not a bare count), so this only joins them against
 * resolveDisplayName, which also covers people who have since left the room.
 */
export default function ChatReactionViewer({
  reactions,
  currentUserId,
  resolveDisplayName,
  onClose,
}: ChatReactionViewerProps) {
  const [activeTab, setActiveTab] = useState(ALL_TAB);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const baseId = useId();

  const totalCount = reactions.reduce((sum, r) => sum + r.count, 0);
  const tabs = [ALL_TAB, ...reactions.map((r) => r.emoji)];

  // The set shrinks live as people un-react; fall back to All rather than a
  // tab for an emoji that no longer exists.
  const active = tabs.includes(activeTab) ? activeTab : ALL_TAB;

  const rows: ReactorRow[] =
    active === ALL_TAB
      ? reactions.flatMap((r) =>
          r.reactorIds.map((userId) => ({ userId, emoji: r.emoji })),
        )
      : (reactions
          .find((r) => r.emoji === active)
          ?.reactorIds.map((userId) => ({ userId })) ?? []);

  useEffect(() => {
    if (reactions.length === 0) onClose();
  }, [onClose, reactions.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (reactions.length === 0) return null;

  const activeIndex = tabs.indexOf(active);

  // Roving arrow-key navigation across the tabs.
  const handleTabKeyDown = (event: React.KeyboardEvent) => {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (activeIndex + delta + tabs.length) % tabs.length;
    const nextTab = tabs[next];
    setActiveTab(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  };

  const tabId = (tab: string) => `${baseId}-tab-${tab}`;
  const panelId = `${baseId}-panel`;

  const tabLabel = (tab: string) =>
    tab === ALL_TAB ? (
      <>
        <span>All</span>
        <span className="tabular-nums text-[#a1a1aa]">{totalCount}</span>
      </>
    ) : (
      <>
        <span className="text-[15px] leading-none">{tab}</span>
        <span className="tabular-nums">
          {reactions.find((r) => r.emoji === tab)?.count ?? 0}
        </span>
      </>
    );

  return (
    <div className="flex max-h-[340px] w-[268px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#232327] shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
        <span className="text-[13px] font-semibold text-[#fafafa]">
          Reactions
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reactions"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-white/[0.08] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Reactions by emoji"
        onKeyDown={handleTabKeyDown}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 px-2 pb-2"
      >
        {tabs.map((tab) => {
          const selected = tab === active;
          return (
            <button
              key={tab}
              ref={(el) => {
                if (el) tabRefs.current.set(tab, el);
                else tabRefs.current.delete(tab);
              }}
              type="button"
              role="tab"
              id={tabId(tab)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab)}
              className={`inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
                selected
                  ? "bg-[#F95F4A]/15 text-[#fafafa] ring-1 ring-inset ring-[#F95F4A]/50"
                  : "text-[#a1a1aa] hover:bg-white/[0.06] hover:text-[#fafafa]"
              }`}
            >
              {tabLabel(tab)}
            </button>
          );
        })}
      </div>

      <ul
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto p-1.5 focus-visible:outline-none"
      >
        {rows.map((row, index) => {
          const displayName =
            row.userId === currentUserId
              ? "You"
              : resolveDisplayName(row.userId);
          return (
            <li
              key={`${row.userId}-${row.emoji ?? ""}-${index}`}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-[120ms] hover:bg-white/[0.05]"
            >
              <Avatar name={displayName} id={row.userId} size={26} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[#fafafa]">
                {displayName}
              </span>
              {row.emoji ? (
                <span className="shrink-0 text-[15px] leading-none">
                  {row.emoji}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
