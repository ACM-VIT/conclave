"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Task" and themed for
// Conclave. Collapsible, labelled groups with a count — used to present meeting
// minutes (topics, decisions, action items, ...) like a real summary surface.

import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { cn } from "./utils";

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({
  children,
  className,
  ...props
}: TaskItemFileProps) => (
  <div
    className={cn(
      "inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-[#e4e4e7]",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div
    className={cn("text-[13px] leading-relaxed text-[#d4d4d8]", className)}
    {...props}
  >
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  icon?: ReactNode;
  count?: number;
};

export const TaskTrigger = ({
  children,
  className,
  title,
  icon,
  count,
  ...props
}: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
    {children ?? (
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 text-left text-[12.5px] font-semibold text-[#e4e4e7] transition-colors hover:text-[#fafafa]"
      >
        {icon ? <span className="text-[#71717a]">{icon}</span> : null}
        <span className="flex-1">{title}</span>
        {typeof count === "number" ? (
          <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[#d4d4d8]">
            {count}
          </span>
        ) : null}
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </button>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({
  children,
  className,
  ...props
}: TaskContentProps) => (
  <CollapsibleContent className={cn("outline-none", className)} {...props}>
    <div className="mt-2.5 space-y-2 border-l-2 border-white/10 pl-3">
      {children}
    </div>
  </CollapsibleContent>
);
