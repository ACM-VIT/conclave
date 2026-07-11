"use client";

import {
  BrainIcon,
  CheckIcon,
  FileTextIcon,
  GithubIcon,
  GlobeIcon,
  ListTreeIcon,
  PencilLineIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import {
  type AssistantChatMessage,
  type AssistantTask,
  type AssistantToolApprovalDecision,
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
  github_issue: {
    icon: GithubIcon,
    running: "Preparing a GitHub issue",
    done: "Finished the GitHub issue request",
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
  onToolApproval?: (
    answerId: string,
    decision: AssistantToolApprovalDecision,
  ) => void;
}

// Renders a Conclave AI chat message: a collapsible "chain of thought" surface
// (reasoning trace + tool steps) above the streamed markdown answer. The whole
// thought process can be collapsed so the assistant stays unobtrusive.
function ConclaveMessage({
  message,
  isNew,
  onToolApproval,
}: ConclaveMessageProps) {
  const status = message.assistantStatus ?? "done";
  const isStreaming = status === "streaming";
  const isError = status === "error";
  const approval = message.toolApproval;
  const [approvalChecked, setApprovalChecked] = useState(false);

  useEffect(() => {
    setApprovalChecked(false);
  }, [approval?.id]);

  const tasks = message.tasks ?? [];
  const visibleTasks = tasks.filter(
    (task) =>
      task.kind === "web_search" ||
      task.kind === "transcript" ||
      task.kind === "github_issue",
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

  // Keep the reasoning + chain-of-thought expanded for the ENTIRE stream. Only
  // once the full message has finished streaming do we let them ease closed, so
  // the finished answer is what's left in view. Each panel keeps its own open
  // state so manual toggles stay independent, but they share one auto-collapse.
  const keepProcessOpen = isStreaming || isProcessRunning;
  const [reasoningOpen, setReasoningOpen] = useState(keepProcessOpen);
  const [actionsOpen, setActionsOpen] = useState(keepProcessOpen);
  const wasOpenForWorkRef = useRef(keepProcessOpen);
  useEffect(() => {
    if (keepProcessOpen) {
      setReasoningOpen(true);
      setActionsOpen(true);
      wasOpenForWorkRef.current = true;
      return;
    }
    if (wasOpenForWorkRef.current) {
      wasOpenForWorkRef.current = false;
      // Linger on the finished trace for a beat, then collapse it nicely.
      const timer = setTimeout(() => {
        setReasoningOpen(false);
        setActionsOpen(false);
      }, 700);
      return () => clearTimeout(timer);
    }
  }, [keepProcessOpen]);

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
              open={reasoningOpen}
              onOpenChange={setReasoningOpen}
            >
              <ReasoningTrigger />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}

          {visibleTasks.length > 0 ? (
            <ChainOfThought
              className="mb-2.5"
              open={actionsOpen}
              onOpenChange={setActionsOpen}
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

          {status === "approval_required" && approval ? (
            <div className="mb-1 overflow-hidden rounded-xl border border-[#F95F4A]/30 bg-black/25">
              <div className="border-b border-white/10 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-[#fafafa]">
                  <GithubIcon className="size-3.5 text-[#F95F4A]" />
                  Approve GitHub issue
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[#a1a1aa]">
                  Review the exact write before Conclave sends it to GitHub.
                </p>
              </div>
              <div className="space-y-2.5 px-3 py-3">
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#71717a]">
                    Title
                  </p>
                  <p className="mt-1 text-[12px] font-medium leading-snug text-[#f4f4f5]">
                    {approval.title}
                  </p>
                </div>
                <details className="group rounded-lg border border-white/10 bg-white/[0.025]">
                  <summary className="cursor-pointer list-none px-2.5 py-2 text-[11px] font-medium text-[#a1a1aa]">
                    Review issue body
                  </summary>
                  <div className="max-h-44 overflow-y-auto border-t border-white/10 px-2.5 py-2 text-[11px] text-[#d4d4d8]">
                    <Response>{approval.body}</Response>
                  </div>
                </details>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 px-2.5 py-2 text-[11px] leading-relaxed text-[#d4d4d8] transition hover:bg-white/[0.035]">
                  <input
                    type="checkbox"
                    checked={approvalChecked}
                    onChange={(event) =>
                      setApprovalChecked(event.currentTarget.checked)
                    }
                    className="mt-0.5 size-3.5 accent-[#F95F4A]"
                  />
                  I reviewed this issue and approve creating it in the configured
                  repository.
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onToolApproval?.(message.id, "deny")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-[11px] font-medium text-[#d4d4d8] transition hover:bg-white/[0.06]"
                  >
                    <XIcon className="size-3" />
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!approvalChecked}
                    onClick={() => onToolApproval?.(message.id, "approve")}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#F95F4A]/50 bg-[#F95F4A]/20 px-3 text-[11px] font-semibold text-[#fafafa] transition hover:bg-[#F95F4A]/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <CheckIcon className="size-3" />
                    Create issue
                  </button>
                </div>
              </div>
            </div>
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
