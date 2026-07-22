"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal, Reply, SmilePlus } from "lucide-react";
import AnchoredPopover from "./AnchoredPopover";
import ChatReactionPicker from "./ChatReactionPicker";
import { CHAT_REACTION_EMOJIS } from "../lib/types";
import type { RenderableChatReaction } from "../lib/chat-reactions";

/**
 * The one-tap emoji shown inline on the hover bar. A curated subset of the
 * canonical allowlist so a click here never hits a server-side rejection; the
 * `+` button opens the full picker for the rest.
 */
const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮"].filter((emoji) =>
  (CHAT_REACTION_EMOJIS as readonly string[]).includes(emoji),
);

interface ChatMessageActionsProps {
  reactions: RenderableChatReaction[];
  onToggleReaction?: (emoji: string) => void;
  onReply?: () => void;
  onViewReactions?: () => void;
  /** Anchors the toolbar to the message's outer corner. */
  isOwn: boolean;
}

/**
 * Shared shape for every message action, so Reply, Add Reaction and More read
 * as one set: same hit target, same lucide sizing, same hover treatment as the
 * composer's icon buttons (see ChatPanel's Paperclip / GifPicker's Images).
 */
const ACTION_BUTTON_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#a1a1aa] transition-colors duration-[120ms] hover:bg-white/[0.08] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30";
const ACTION_ICON_SIZE = 15;
const ACTION_ICON_STROKE = 1.75;

/**
 * Floating hover toolbar for a chat message.
 *
 * Absolutely positioned and therefore costs zero layout. Earlier revisions put
 * these controls in normal flow, which pushed the reaction chips off the
 * bubble's edge (opacity-0 still occupies space) and broke the tight stacking
 * of consecutive own-messages. Nothing here may participate in flow.
 */
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

  // Reactions can go away while the picker is open — the host locks chat or
  // flips the kill-switch, and onToggleReaction drops to undefined. The picker
  // button and panel then unmount, but isPickerOpen would stay true: that pins
  // the toolbar open and pointer-active with only Reply/More left, and silently
  // reopens the picker if reactions come back. Reset so the toolbar returns to
  // its idle, hover-gated state.
  useEffect(() => {
    if (!onToggleReaction) setIsPickerOpen(false);
  }, [onToggleReaction]);

  // Keep the toolbar up while the picker is open, otherwise moving the pointer
  // onto the panel would dismiss the thing you are aiming at. Guarded on the
  // handler so a stale isPickerOpen can never pin an un-dismissable toolbar.
  const isPinned = isPickerOpen && Boolean(onToggleReaction);

  const ownEmojis = new Set(
    reactions.filter((r) => r.reactedByMe).map((r) => r.emoji),
  );

  return (
    <div
      // bottom-full clears the bubble rather than sitting on its first line of
      // text, and stays inside the scroll container so it can't be clipped.
      //
      // pointer-events are gated on visibility: when idle the toolbar is
      // opacity-0 but still laid out directly over the *previous* message's
      // chip row, and an opacity-0 element still captures the pointer — which
      // silently ate hovers meant for those chips. It only accepts the pointer
      // while actually shown.
      // Visibility uses group-hover for the mouse and has-[:focus-visible] for
      // the keyboard — deliberately NOT focus-within. A mouse click focuses the
      // button it hit (:focus) but not :focus-visible, so focus-within would
      // leave the toolbar stuck open and pointer-capturing after you react and
      // move away — which read as both "it won't dismiss" and a dead touch
      // zone over nearby messages. :focus-visible only latches for real
      // keyboard focus, so mouse users are released the moment they leave.
      className={`absolute bottom-full z-10 mb-1.5 flex items-center gap-0.5 rounded-full border border-white/10 bg-[#232327] p-1 shadow-xl shadow-black/50 transition-opacity duration-[120ms] group-hover:opacity-100 has-[:focus-visible]:opacity-100 ${
        isPinned
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto has-[:focus-visible]:pointer-events-auto"
      } ${isOwn ? "right-0" : "left-0"}`}
    >
      {/* Transparent bridge spanning the gap down to the bubble, so moving the
          cursor from the message onto the toolbar never crosses a dead zone
          that would drop the hover and hide the toolbar mid-reach. */}
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
