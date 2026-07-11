"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Conversation" and themed
// for Conclave's meeting UI. Auto-scrolls to the latest message and exposes a
// scroll-to-bottom affordance when the user scrolls up.

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "./utils";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-auto overflow-x-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    // The library renders its own scroll element around this content; long
    // unbreakable strings must never widen it, only wrap or clip.
    scrollClassName="overflow-x-hidden"
    className={cn("flex min-w-0 max-w-full flex-col gap-4 px-4 py-4", className)}
    {...props}
  />
);

export type ConversationScrollButtonProps = ComponentProps<"button">;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <button
      aria-label="Scroll to latest"
      className={cn(
        "absolute bottom-4 left-1/2 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-white/10 bg-[#232327] text-[#d4d4d8] shadow-lg shadow-black/30 transition-colors hover:bg-[#2e2e33] hover:text-[#fafafa]",
        className,
      )}
      onClick={handleScrollToBottom}
      type="button"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </button>
  );
};
