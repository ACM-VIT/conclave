"use client";

import {
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  ListTreeIcon,
  PencilLineIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import {
  type AssistantChatMessage,
  type AssistantTask,
  CONCLAVE_ASSISTANT_NAME,
} from "../lib/conclave-assistant";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "./ai-elements/chain-of-thought";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import { Response } from "./ai-elements/response";
import { Shimmer } from "./ai-elements/shimmer";

const TASK_META: Record<
  AssistantTask["kind"],
  { icon: LucideIcon; running: string; done: string }
> = {
  reasoning: {
    icon: BrainIcon,
    running: "Thinking through the request",
    done: "Thought through the request",
  },
  web_search: {
    icon: GlobeIcon,
    running: "Searching the web",
    done: "Searched the web",
  },
  transcript: {
    icon: FileTextIcon,
    running: "Reading the transcript",
    done: "Read the meeting transcript",
  },
  answer: {
    icon: PencilLineIcon,
    running: "Writing the answer",
    done: "Wrote the answer",
  },
};

const TaskStep = ({ task }: { task: AssistantTask }) => {
  const meta = TASK_META[task.kind];
  const Icon = meta.icon;
  return (
    <ChainOfThoughtStep
      icon={<Icon className="size-3.5" />}
      label={task.status === "done" ? meta.done : meta.running}
      status={task.status === "done" ? "complete" : "active"}
    >
      {task.query ? (
        <ChainOfThoughtSearchResults>
          <ChainOfThoughtSearchResult>{task.query}</ChainOfThoughtSearchResult>
        </ChainOfThoughtSearchResults>
      ) : null}
    </ChainOfThoughtStep>
  );
};

interface ConclaveMessageProps {
  message: AssistantChatMessage;
  isNew: boolean;
}

// Renders a Conclave AI chat message: a collapsible "chain of thought" surface
// (reasoning trace + tool steps) above the streamed markdown answer. The whole
// thought process can be collapsed so the assistant stays unobtrusive.
function ConclaveMessage({ message, isNew }: ConclaveMessageProps) {
  const status = message.assistantStatus ?? "done";
  const isStreaming = status === "streaming";
  const isError = status === "error";

  const tasks = message.tasks ?? [];
  const visibleTasks = tasks.filter(
    (task) => task.kind === "web_search" || task.kind === "transcript",
  );
  const reasoning = message.reasoning?.trim() ?? "";
  const answer = message.content.trim();
  const hasAnswer = answer.length > 0;
  const hasReasoning = reasoning.length > 0;
  const reasoningStreaming =
    isStreaming &&
    hasReasoning &&
    (message.reasoningStatus ?? "streaming") === "streaming";
  const hasRunningTask = visibleTasks.some((task) => task.status !== "done");
  const isProcessRunning = reasoningStreaming || hasRunningTask;
  const hasProcess = !isError && (visibleTasks.length > 0 || hasReasoning);
  const shouldKeepProcessOpen =
    isProcessRunning || (isStreaming && !hasAnswer && hasProcess);

  // Keep the thought process expanded while the agent works, then quietly
  // collapse it once the answer is finished so it isn't intrusive.
  const [processOpen, setProcessOpen] = useState(shouldKeepProcessOpen);
  const wasProcessOpenForWorkRef = useRef(shouldKeepProcessOpen);
  useEffect(() => {
    if (shouldKeepProcessOpen) {
      setProcessOpen(true);
    } else if (wasProcessOpenForWorkRef.current) {
      const timer = setTimeout(() => setProcessOpen(false), 900);
      wasProcessOpenForWorkRef.current = false;
      return () => clearTimeout(timer);
    }
    wasProcessOpenForWorkRef.current = shouldKeepProcessOpen;
  }, [shouldKeepProcessOpen]);

  return (
    <div
      className={`group mt-4 flex justify-start gap-3 first:mt-0 ${
        isNew ? "web-chat-message-new-peer" : ""
      }`}
    >
      <div className="w-9 shrink-0">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#F95F4A] text-[13px] font-semibold text-white">
          C
        </span>
      </div>
      <div className="min-w-0 max-w-[84%] flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-[#fafafa]">
            {CONCLAVE_ASSISTANT_NAME}
          </span>
          <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-[#a1a1aa]">
            AI
          </span>
        </div>
        <div
          className={`inline-block min-w-0 max-w-full overflow-hidden rounded-[18px] rounded-tl-md px-3.5 py-2.5 ${
            isError
              ? "bg-red-500/[0.08] ring-1 ring-red-500/20"
              : "bg-white/[0.05] ring-1 ring-[#F95F4A]/20"
          }`}
        >
          {hasReasoning ? (
            <Reasoning
              className={visibleTasks.length > 0 || hasAnswer ? "mb-2.5" : ""}
              isStreaming={reasoningStreaming}
            >
              <ReasoningTrigger />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}

          {visibleTasks.length > 0 ? (
            <ChainOfThought
              className="mb-2.5"
              open={processOpen}
              onOpenChange={setProcessOpen}
            >
              <ChainOfThoughtHeader icon={<ListTreeIcon className="size-3.5" />}>
                {isProcessRunning ? (
                  <Shimmer as="span">Working</Shimmer>
                ) : (
                  "Actions"
                )}
              </ChainOfThoughtHeader>
              <ChainOfThoughtContent>
                {visibleTasks.map((task) => (
                  <TaskStep key={task.id} task={task} />
                ))}
              </ChainOfThoughtContent>
            </ChainOfThought>
          ) : null}

          {isStreaming && !hasAnswer && !hasProcess ? (
            <Shimmer className="text-[13px]">Thinking</Shimmer>
          ) : isError ? (
            <p className="text-[13px] leading-relaxed text-red-300">
              {message.content}
            </p>
          ) : hasAnswer ? (
            <Response>{message.content}</Response>
          ) : null}
          {isStreaming && hasAnswer ? (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-[#F95F4A] align-text-bottom" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default memo(ConclaveMessage);
