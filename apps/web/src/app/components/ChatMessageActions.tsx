"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal, Reply, SmilePlus } from "lucide-react";
import AnchoredPopover from "./AnchoredPopover";
import ChatReactionPicker from "./ChatReactionPicker";
import { CHAT_REACTION_EMOJIS } from "../lib/types";
import type { RenderableChatReaction } from "../lib/chat-reactions";

const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮"].filter((emoji) =>
  (CHAT_REACTION_EMOJIS as readonly string[]).includes(emoji),
);

interface ChatMessageActionsProps {
  reactions: RenderableChatReaction[];
  onToggleReaction?: (emoji: string) => void;
  onReply?: () => void;
  onViewReactions?: () => void;
  isOwn: boolean;
}

const ACTION_BUTTON_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-white/[0.08] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30";
const ACTION_ICON_SIZE = 15;
const ACTION_ICON_STROKE = 1.75;

const ChatMessageActionsImpl = ({
  reactions,
  onToggleReaction,
  onReply,
  onViewReactions,
  isOwn,
}: ChatMessageActionsProps) => {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLButtonElement | null>(null);

  const closePicker = useCallback(() => setIsPickerOpen(false), []);

  useEffect(() => {
    if (!onToggleReaction) setIsPickerOpen(false);
  }, [onToggleReaction]);

  const isPinned = isPickerOpen && Boolean(onToggleReaction);

  const ownEmojis = new Set(
    reactions.filter((r) => r.reactedByMe).map((r) => r.emoji),
  );

  return (
    <div
      className={`absolute bottom-full z-10 mb-1.5 flex items-center gap-0.5 rounded-full border border-white/10 bg-[#232327] p-1 shadow-xl shadow-black/50 transition-opacity duration-[120ms] group-hover:opacity-100 has-[:focus-visible]:opacity-100 ${
        isPinned
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto has-[:focus-visible]:pointer-events-auto"
      } ${isOwn ? "right-0" : "left-0"}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-full h-2"
      />

      {onToggleReaction
        ? QUICK_REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onToggleReaction(emoji)}
              aria-label={`React with ${emoji}`}
              aria-pressed={ownEmojis.has(emoji)}
              title={`React with ${emoji}`}
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] leading-none transition-colors duration-[120ms] hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
                ownEmojis.has(emoji) ? "bg-[#F95F4A]/20" : ""
              }`}
            >
              {emoji}
            </button>
          ))
        : null}

      {onToggleReaction ? (
        <span
          aria-hidden="true"
          className="mx-0.5 h-4 w-px shrink-0 bg-white/10"
        />
      ) : null}

      {onToggleReaction ? (
        <button
          ref={pickerAnchorRef}
          type="button"
          onClick={() => setIsPickerOpen((open) => !open)}
          aria-label="More reactions"
          aria-expanded={isPickerOpen}
          aria-haspopup="dialog"
          title="More reactions"
          className={`${ACTION_BUTTON_CLASS} ${
            isPickerOpen ? "bg-white/[0.08] text-[#fafafa]" : ""
          }`}
        >
          <SmilePlus size={ACTION_ICON_SIZE} strokeWidth={ACTION_ICON_STROKE} />
        </button>
      ) : null}

      {onReply ? (
        <button
          type="button"
          onClick={onReply}
          aria-label="Reply"
          title="Reply"
          className={ACTION_BUTTON_CLASS}
        >
          <Reply size={ACTION_ICON_SIZE} strokeWidth={ACTION_ICON_STROKE} />
        </button>
      ) : null}

      {onViewReactions ? (
        <button
          type="button"
          onClick={() => {
            setIsPickerOpen(false);
            onViewReactions();
          }}
          aria-label="View who reacted"
          aria-haspopup="dialog"
          title="View who reacted"
          className={ACTION_BUTTON_CLASS}
        >
          <MoreHorizontal
            size={ACTION_ICON_SIZE}
            strokeWidth={ACTION_ICON_STROKE}
          />
        </button>
      ) : null}

      {onToggleReaction ? (
        <AnchoredPopover
          anchorRef={pickerAnchorRef}
          open={isPickerOpen}
          onClose={closePicker}
          align={isOwn ? "end" : "start"}
          ariaLabel="Add reaction"
          dismissOnPointerLeave
        >
          <ChatReactionPicker
            reactions={reactions}
            onSelect={(emoji) => {
              onToggleReaction(emoji);
              closePicker();
            }}
          />
        </AnchoredPopover>
      ) : null}
    </div>
  );
};

export default memo(ChatMessageActionsImpl);
