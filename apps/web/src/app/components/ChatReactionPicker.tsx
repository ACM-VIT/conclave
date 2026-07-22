"use client";

import { memo } from "react";
import { CHAT_REACTION_EMOJIS } from "../lib/types";
import type { RenderableChatReaction } from "../lib/chat-reactions";

interface ChatReactionPickerProps {
  reactions: RenderableChatReaction[];
  onSelect: (emoji: string) => void;
}

/**
 * The emoji grid itself. Positioning is the caller's job (AnchoredPopover), so
 * this only has to size itself predictably.
 *
 * Explicit width with shrink-0 cells: an intrinsically-sized grid collapses
 * here, because Tailwind's grid-cols-N floors each column at 0 and the cells
 * then overlap inside a shrink-to-fit box.
 */
const ChatReactionPickerImpl = ({
  reactions,
  onSelect,
}: ChatReactionPickerProps) => (
  // Same surface family as the quick-react bar: #232327 fill, hairline border,
  // round cells, tight padding — just a rounded-xl card instead of a pill
  // because a grid can't be a pill. w-[156px] gives four 32px cells per row.
  <div className="flex w-[156px] flex-wrap gap-0.5 rounded-2xl border border-white/10 bg-[#232327] p-1 shadow-xl shadow-black/50">
    {CHAT_REACTION_EMOJIS.map((emoji) => {
      const active = reactions.some(
        (reaction) => reaction.emoji === emoji && reaction.reactedByMe,
      );
      return (
        <button
          key={emoji}
          type="button"
          onClick={() => onSelect(emoji)}
          aria-label={`React with ${emoji}`}
          aria-pressed={active}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[16px] leading-none transition-colors duration-[120ms] hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
            active ? "bg-[#F95F4A]/20" : ""
          }`}
        >
          {emoji}
        </button>
      );
    })}
  </div>
);

export default memo(ChatReactionPickerImpl);
