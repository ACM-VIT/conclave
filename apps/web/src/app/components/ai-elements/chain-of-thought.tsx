"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Chain of Thought" and themed
// for Conclave's dark chat. A collapsible surface that lays out an agent's steps
// (tool calls, searches, reasoning) as a connected vertical timeline so the work
// reads as a sequence without dominating the message.

import { ChevronDownIcon, DotIcon } from "lucide-react";
import { type ComponentProps, memo, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { cn } from "./utils";

export type ChainOfThoughtProps = ComponentProps<typeof Collapsible>;

export const ChainOfThought = memo(
  ({ className, ...props }: ChainOfThoughtProps) => (
    <Collapsible className={cn("not-prose", className)} {...props} />
  ),
);
ChainOfThought.displayName = "ChainOfThought";

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  icon?: ReactNode;
};

export const ChainOfThoughtHeader = memo(
  ({ className, children, icon, ...props }: ChainOfThoughtHeaderProps) => (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-1.5 text-left text-[12px] font-medium text-[#a1a1aa] transition-colors hover:text-[#d4d4d8]",
        className,
      )}
      {...props}
    >
      {icon ? <span className="text-[#71717a]">{icon}</span> : null}
      <span className="flex-1">{children ?? "Chain of thought"}</span>
      <ChevronDownIcon className="size-3.5 text-[#71717a] transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  ),
);
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => (
    <CollapsibleContent
      className={cn("overflow-hidden outline-none", className)}
      {...props}
    >
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </CollapsibleContent>
  ),
);
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";

export type ChainOfThoughtStepStatus = "complete" | "active" | "pending";

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  status?: ChainOfThoughtStepStatus;
};

const STEP_STATUS_DOT: Record<ChainOfThoughtStepStatus, string> = {
  complete: "text-[#22c55e]",
  active: "text-[#F95F4A]",
  pending: "text-[#52525b]",
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon,
    label,
    description,
    status = "complete",
    children,
    ...props
  }: ChainOfThoughtStepProps) => (
    <div
      className={cn(
        "relative flex gap-2.5 pl-1 text-[12.5px]",
        // Connector line between steps.
        "before:absolute before:left-[8px] before:top-5 before:h-[calc(100%-4px)] before:w-px before:bg-white/10 last:before:hidden",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "relative z-10 mt-0.5 flex size-3.5 shrink-0 items-center justify-center",
          STEP_STATUS_DOT[status],
        )}
      >
        {icon ?? (
          <DotIcon
            className={cn(
              "size-5",
              status === "active" && "animate-pulse",
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1 pb-0.5">
        <div className="font-medium text-[#d4d4d8]">{label}</div>
        {description ? (
          <div className="text-[12px] text-[#a1a1aa]">{description}</div>
        ) : null}
        {children}
      </div>
    </div>
  ),
);
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div className={cn("flex flex-wrap gap-1.5", className)} {...props}>
      {children}
    </div>
  ),
);
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";

export type ChainOfThoughtSearchResultProps = {
  href?: string;
  className?: string;
  children: ReactNode;
};

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, href }: ChainOfThoughtSearchResultProps) => {
    const classes = cn(
      "inline-flex max-w-full items-center gap-1 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[11px] leading-snug text-[#d4d4d8] break-words transition-colors",
      href && "hover:bg-white/[0.09]",
      className,
    );
    if (href) {
      return (
        <a
          className={classes}
          href={href}
          rel="noopener noreferrer"
          target="_blank"
        >
          {children}
        </a>
      );
    }
    return <span className={classes}>{children}</span>;
  },
);
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
