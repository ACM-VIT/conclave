"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Message" and themed for
// Conclave. User turns sit in a filled bubble; assistant turns render flush so
// the Response markdown reads like part of the panel.

import type { ComponentProps, HTMLAttributes } from "react";
import { cn } from "./utils";

export type MessageRole = "user" | "assistant" | "system";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[92%] flex-col gap-2",
      from === "user" ? "is-user ml-auto items-end" : "is-assistant items-start",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-[13px] leading-relaxed",
      "group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-[#F95F4A] group-[.is-user]:px-3 group-[.is-user]:py-2 group-[.is-user]:text-white",
      "group-[.is-assistant]:rounded-2xl group-[.is-assistant]:rounded-bl-md group-[.is-assistant]:border group-[.is-assistant]:border-white/10 group-[.is-assistant]:bg-white/[0.04] group-[.is-assistant]:px-3 group-[.is-assistant]:py-2 group-[.is-assistant]:text-[#e4e4e7]",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<"button"> & {
  label?: string;
};

export const MessageAction = ({
  className,
  children,
  label,
  title,
  ...props
}: MessageActionProps) => (
  <button
    className={cn(
      "inline-flex h-7 w-7 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]",
      className,
    )}
    title={title ?? label}
    type="button"
    {...props}
  >
    {children}
    <span className="sr-only">{label ?? title}</span>
  </button>
);
