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
    className={cn("relative flex-1 overflow-y-auto", className)}
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
    className={cn("flex flex-col gap-4 px-4 py-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 px-8 py-12 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon ? (
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-[#a1a1aa]">
            {icon}
          </div>
        ) : null}
        <div className="max-w-[16rem] space-y-1.5">
          <p className="text-[14px] font-semibold text-[#fafafa]">{title}</p>
          {description ? (
            <p className="text-[12.5px] leading-relaxed text-[#a1a1aa]">
              {description}
            </p>
          ) : null}
        </div>
      </>
    )}
  </div>
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
