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

// Omit Radix's method-style onOpenChange declaration and re-declare it as a
// plain function type so destructuring it doesn't trip unbound-method.
export type ReasoningProps = Omit<
  ComponentProps<typeof Collapsible>,
  "onOpenChange"
> & {
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
    const isControlled = open !== undefined;
    const [internalOpen, setInternalOpen] = useState(open ?? defaultOpen);
    const isOpen = isControlled ? (open) : internalOpen;
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
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    };

    // When uncontrolled, auto-open while thinking then collapse once it's done.
    // A controlled parent owns the open state instead — e.g. to keep the trace
    // visible until the whole message finishes streaming before collapsing.
    useEffect(() => {
      if (isControlled) return;
      if (isStreaming && !internalOpen) {
        setInternalOpen(true);
      } else if (!isStreaming && internalOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setInternalOpen(false);
          setHasAutoClosed(true);
        }, 600);
        return () => clearTimeout(timer);
      }
    }, [isControlled, isStreaming, internalOpen, hasAutoClosed]);

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={setIsOpen}
          open={isOpen}
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
        "web-collapsible overflow-hidden text-[12.5px] text-[#a1a1aa] outline-none",
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
