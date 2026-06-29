"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Suggestion" and themed for
// Conclave. Horizontally scrollable pills used to seed the Ask experience.

import type { ComponentProps } from "react";
import { cn } from "./utils";

export type SuggestionsProps = ComponentProps<"div">;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <div
    className={cn(
      "flex w-full flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type SuggestionProps = Omit<ComponentProps<"button">, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  children,
  ...props
}: SuggestionProps) => (
  <button
    className={cn(
      "shrink-0 cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-medium text-[#d4d4d8] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]",
      className,
    )}
    onClick={() => onClick?.(suggestion)}
    type="button"
    {...props}
  >
    {children || suggestion}
  </button>
);
