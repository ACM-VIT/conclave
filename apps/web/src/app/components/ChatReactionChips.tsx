"use client";

import { memo, useRef, useState } from "react";
import AnchoredPopover from "./AnchoredPopover";
import {
  formatReactorSummary,
  type RenderableChatReaction,
} from "../lib/chat-reactions";

interface ChatReactionChipsProps {
  reactions: RenderableChatReaction[];
  onToggle?: (emoji: string) => void;
  isOwn: boolean;
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
  /** Reactions stay visible but become inert when the host disables them. */
  disabled?: boolean;
}

const ChipTooltip = ({
  anchorRef,
  open,
  label,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  label: string;
}) => (
  <AnchoredPopover
    anchorRef={anchorRef}
    open={open}
    onClose={() => {}}
    align="center"
    gap={6}
    role="tooltip"
    interactive={false}
  >
    <div className="max-w-[220px] rounded-md border border-white/10 bg-[#232327] px-2 py-1 text-[11.5px] leading-snug text-[#fafafa] shadow-xl shadow-black/50">
      {label}
    </div>
  </AnchoredPopover>
);

const ReactionChip = ({
  reaction,
  onToggle,
  disabled,
  currentUserId,
  resolveDisplayName,
}: {
  reaction: RenderableChatReaction;
  onToggle?: (emoji: string) => void;
  disabled: boolean;
  currentUserId: string;
  resolveDisplayName: (userId: string) => string;
}) => {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        disabled={disabled || !onToggle}
        onClick={() => onToggle?.(reaction.emoji)}
        onPointerEnter={() => setIsHovered(true)}
        onPointerLeave={() => setIsHovered(false)}
        onFocus={() => setIsHovered(true)}
        onBlur={() => setIsHovered(false)}
        aria-pressed={reaction.reactedByMe}
        aria-label={formatReactorSummary(
          reaction,
          currentUserId,
          resolveDisplayName,
        )}
        className={`web-chat-reaction-chip inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-default disabled:opacity-60 ${
          reaction.reactedByMe
            ? "border-[#F95F4A]/60 bg-[#F95F4A]/15 text-[#fafafa]"
            : "border-white/10 bg-white/[0.05] text-[#a1a1aa] enabled:hover:bg-white/[0.09] enabled:hover:text-[#fafafa]"
        }`}
      >
        <span className="text-[12px] leading-none">{reaction.emoji}</span>
        {/* Re-key on count so the number replays a small pop each time it
            changes, giving live updates a Discord-like tick. */}
        <span
          key={reaction.count}
          className="web-chat-reaction-count tabular-nums"
        >
          {reaction.count}
        </span>
      </button>
      <ChipTooltip
        anchorRef={chipRef}
        open={isHovered}
        label={formatReactorSummary(
          reaction,
          currentUserId,
          resolveDisplayName,
        )}
      />
    </>
  );
};

/**
 * Chip row under a message bubble: one pill per emoji.
 *
 * There is deliberately no trailing add-reaction chip here — the hover
 * quick-react toolbar already offers one-tap emoji and the full picker, so a
 * chip-row "+" only duplicated it while reserving an always-present empty slot
 * that left the chips visibly offset from the bubble edge when idle.
 *
 * Renders nothing when there are no reactions, so those messages cost no
 * vertical space and consecutive own-messages keep their tight grouping.
 */
const ChatReactionChipsImpl = ({
  reactions,
  onToggle,
  isOwn,
  currentUserId,
  resolveDisplayName,
  disabled = false,
}: ChatReactionChipsProps) => {
  if (reactions.length === 0) return null;

  return (
    <div
      className={`mt-1 flex w-full min-w-0 flex-wrap items-center gap-1 ${
        isOwn ? "justify-end" : "justify-start"
      }`}
    >
      {reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          reaction={reaction}
          onToggle={onToggle}
          disabled={disabled}
          currentUserId={currentUserId}
          resolveDisplayName={resolveDisplayName}
        />
      ))}
    </div>
  );
};

export default memo(ChatReactionChipsImpl);
