"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Response". Renders
// streaming-safe markdown via Streamdown, themed for Conclave's dark panel.

import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "./utils";

export type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full text-[13px] leading-relaxed text-[#e4e4e7]",
        "[&_a]:text-[#ff9d8f] [&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
        "[&_strong]:text-[#fafafa]",
        "[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
