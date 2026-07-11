"use client";

// Ported (and trimmed) from AI SDK Elements (elements.ai-sdk.dev) "PromptInput"
// and themed for Conclave. Keeps the framed form + auto-growing textarea +
// toolbar + status-aware submit button; drops the attachment / model-picker
// machinery the transcript Ask box doesn't need.

import { Loader2, Send, Square, X } from "lucide-react";
import type { ComponentProps, KeyboardEventHandler } from "react";
import { useEffect, useRef } from "react";
import { cn } from "./utils";

export type PromptInputProps = ComponentProps<"form">;

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <form
    className={cn(
      "flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-2 transition-colors focus-within:border-[#F95F4A]/50",
      className,
    )}
    {...props}
  />
);

export type PromptInputTextareaProps = ComponentProps<"textarea"> & {
  minHeight?: number;
  maxHeight?: number;
};

export const PromptInputTextarea = ({
  className,
  onKeyDown,
  minHeight = 32,
  maxHeight = 120,
  ...props
}: PromptInputTextareaProps) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [maxHeight, props.value]);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
    onKeyDown?.(event);
  };

  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed text-[#fafafa] outline-none placeholder:text-[#71717a]",
        className,
      )}
      onKeyDown={handleKeyDown}
      rows={1}
      style={{ minHeight, maxHeight }}
      {...props}
    />
  );
};

export type PromptInputToolbarProps = ComponentProps<"div">;

export const PromptInputToolbar = ({
  className,
  ...props
}: PromptInputToolbarProps) => (
  <div
    className={cn("flex items-center justify-between gap-2", className)}
    {...props}
  />
);

export type PromptInputToolsProps = ComponentProps<"div">;

export const PromptInputTools = ({
  className,
  ...props
}: PromptInputToolsProps) => (
  <div
    className={cn("flex items-center gap-1 text-[#a1a1aa]", className)}
    {...props}
  />
);

type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export type PromptInputSubmitProps = ComponentProps<"button"> & {
  status?: PromptInputStatus;
};

export const PromptInputSubmit = ({
  className,
  status = "ready",
  children,
  ...props
}: PromptInputSubmitProps) => {
  let icon = <Send size={15} strokeWidth={1.8} />;
  if (status === "submitted" || status === "streaming") {
    icon =
      status === "streaming" ? (
        <Square size={13} strokeWidth={1.8} />
      ) : (
        <Loader2 size={15} className="animate-spin" />
      );
  } else if (status === "error") {
    icon = <X size={15} strokeWidth={1.8} />;
  }

  return (
    <button
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F95F4A] text-white transition-colors hover:bg-[#ff735f] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-[#71717a]",
        className,
      )}
      type="submit"
      {...props}
    >
      {children ?? icon}
    </button>
  );
};
