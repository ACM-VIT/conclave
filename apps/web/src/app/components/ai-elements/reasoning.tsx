"use client";

// Ported from AI SDK Elements (elements.ai-sdk.dev) "Reasoning" and themed for
// Conclave's dark chat. A collapsible block that shows the model's thinking: it
// auto-opens while streaming, tracks how long it thought, and auto-closes once
// the answer starts so it stays out of the way.

import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { Response } from "./response";
import { cn } from "./utils";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within <Reasoning>");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpenInternal] = useState(open ?? defaultOpen);
    const [duration, setDuration] = useState(durationProp ?? 0);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startedAtRef = useRef<number | null>(null);

    // Measure how long the model streamed reasoning so the trigger can read
    // "Thought for N seconds" once it settles.
    useEffect(() => {
      if (isStreaming) {
        if (startedAtRef.current === null) startedAtRef.current = Date.now();
        return;
      }
      if (startedAtRef.current !== null) {
        setDuration(Math.round((Date.now() - startedAtRef.current) / 1000));
        startedAtRef.current = null;
      }
    }, [isStreaming]);

    const setIsOpen = (next: boolean) => {
      setIsOpenInternal(next);
      onOpenChange?.(next);
    };

    // Auto-open while thinking, then collapse once it's done so the finished
    // answer is what stays in view.
    useEffect(() => {
      if (isStreaming && !isOpen) {
        setIsOpenInternal(true);
      } else if (!isStreaming && isOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setIsOpenInternal(false);
          setHasAutoClosed(true);
        }, 600);
        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, hasAutoClosed]);

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={setIsOpen}
          open={open ?? isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);
Reasoning.displayName = "Reasoning";

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

export const ReasoningTrigger = memo(
  ({ className, children, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    return (
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 text-left text-[12px] text-[#a1a1aa] transition-colors hover:text-[#d4d4d8]",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-3.5 text-[#71717a]" />
            {isStreaming ? (
              <span className="font-medium">Thinking…</span>
            ) : duration > 0 ? (
              <span className="font-medium">Thought for {duration}s</span>
            ) : (
              <span className="font-medium">Thought process</span>
            )}
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-[#71717a] transition-transform",
                isOpen && "rotate-180",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);
ReasoningTrigger.displayName = "ReasoningTrigger";

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "overflow-hidden text-[12.5px] text-[#a1a1aa] outline-none",
        className,
      )}
      {...props}
    >
      <div className="mt-2 border-l-2 border-white/10 pl-3 [&_*]:text-[#a1a1aa]">
        <Response className="text-[12.5px]">{children}</Response>
      </div>
    </CollapsibleContent>
  ),
);
ReasoningContent.displayName = "ReasoningContent";
