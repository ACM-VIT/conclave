"use client";

import {
  Check,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  Download,
  FileText,
  HelpCircle,
  ListChecks,
  ListTodo,
  Loader2,
  Lock,
  MessageSquareText,
  RefreshCw,
  Square,
  Tag,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  MeetingTranscriptController,
  TranscriptQaMessage,
} from "../hooks/useMeetingTranscript";
import {
  LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS,
  TRANSCRIPT_QA_MODELS,
} from "../lib/transcript-models";
import type {
  TranscriptMinutesEntry,
  TranscriptSegment,
} from "../lib/types";
import { formatTranscriptTimestamp } from "../lib/transcript-reducer";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { Loader } from "./ai-elements/loader";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "./ai-elements/message";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "./ai-elements/prompt-input";
import { Response } from "./ai-elements/response";
import { Shimmer } from "./ai-elements/shimmer";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "./ai-elements/task";

interface TranscriptPanelProps {
  transcript: MeetingTranscriptController;
  onClose: () => void;
}

type TranscriptTab = "transcript" | "ask" | "minutes";

type TranscriptGroup = {
  key: string;
  speakerUserId: string;
  speakerDisplayName: string;
  segments: TranscriptSegment[];
};

const groupSegments = (segments: TranscriptSegment[]): TranscriptGroup[] => {
  const groups: TranscriptGroup[] = [];
  for (const segment of segments) {
    const previous = groups[groups.length - 1];
    const previousSegment = previous?.segments.at(-1);
    const previousEndMs =
      previousSegment?.endMs ??
      previousSegment?.updatedAt ??
      previousSegment?.startMs ??
      0;
    if (
      previous &&
      previous.speakerUserId === segment.speakerUserId &&
      segment.startMs - previousEndMs < 90_000
    ) {
      previous.segments.push(segment);
      continue;
    }
    groups.push({
      key: `${segment.speakerUserId}-${segment.sequence}`,
      speakerUserId: segment.speakerUserId,
      speakerDisplayName: segment.speakerDisplayName,
      segments: [segment],
    });
  }
  return groups;
};

const downloadMarkdown = (filename: string, markdown: string) => {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const copyMarkdown = async (markdown: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(markdown);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = markdown;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
};

const hasMinutesContent = (
  minutes: MeetingTranscriptController["minutes"],
): boolean =>
  Boolean(minutes.summary.trim()) ||
  minutes.topics.length > 0 ||
  minutes.decisions.length > 0 ||
  minutes.actionItems.length > 0 ||
  minutes.openQuestions.length > 0 ||
  minutes.followUps.length > 0;

// Calm blue spotlight tint for the start stage, distinct from the brand orange.
const START_ACCENT = "#4F9CF9";

function StartStage({
  transcript,
}: {
  transcript: MeetingTranscriptController;
}) {
  const [apiKey, setApiKey] = useState("");
  const [transcriptModel, setTranscriptModel] = useState(
    transcript.session.transcriptModel,
  );
  const [qaModel, setQaModel] = useState(transcript.session.qaModel);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const needsTakeover = transcript.session.status === "takeover_needed";

  useEffect(() => {
    setTranscriptModel(transcript.session.transcriptModel);
    setQaModel(transcript.session.qaModel);
  }, [transcript.session.qaModel, transcript.session.transcriptModel]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim() || isSubmitting) return;
    setIsSubmitting(true);
    const ok = needsTakeover
      ? await transcript.takeover({ apiKey, transcriptModel, qaModel })
      : await transcript.start({ apiKey, transcriptModel, qaModel });
    if (ok) {
      setApiKey("");
    }
    setIsSubmitting(false);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col justify-center overflow-y-auto px-5 py-6">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[6%] h-72 w-72 -translate-x-1/2 rounded-full opacity-20 blur-[72px]"
        style={{ background: START_ACCENT }}
      />
      <div className="relative z-10 flex flex-col items-center text-center">
        <span
          className="text-[13px] font-medium"
          style={{ color: START_ACCENT }}
        >
          Live notes
        </span>
        <p className="mt-2.5 max-w-[280px] text-[26px] font-medium leading-[1.12] text-[#fafafa]">
          {needsTakeover ? "Pick up the live notes" : "Turn on live notes"}
        </p>
        <p className="mt-3 max-w-[280px] text-[13.5px] leading-relaxed text-[#a1a1aa]">
          {needsTakeover
            ? "The last host stepped away. Bring your key to keep the room transcribed."
            : "Transcribe the room, ask it questions, and get minutes as the meeting happens."}
        </p>

        <form onSubmit={submit} className="mt-7 w-full max-w-[300px] space-y-2.5">
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            placeholder="OpenAI API key"
            autoComplete="off"
            autoFocus
            disabled={isSubmitting}
            className="h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3.5 text-center text-[13px] text-[#fafafa] outline-none transition-colors placeholder:text-[#71717a] focus:border-[#4F9CF9]/60 disabled:opacity-60"
          />
          <div className="grid grid-cols-2 gap-2 text-left">
            <label className="space-y-1">
              <span className="block px-0.5 text-[11px] text-[#a1a1aa]">
                Transcription
              </span>
              <select
                value={transcriptModel}
                onChange={(event) => setTranscriptModel(event.target.value)}
                disabled={isSubmitting}
                className="h-9 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-[12px] text-[#fafafa] outline-none focus:border-[#4F9CF9]/60 disabled:opacity-60"
              >
              {LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block px-0.5 text-[11px] text-[#a1a1aa]">
                Assistant
              </span>
              <select
                value={qaModel}
                onChange={(event) => setQaModel(event.target.value)}
                disabled={isSubmitting}
                className="h-9 w-full rounded-lg border border-white/10 bg-black/20 px-2 text-[12px] text-[#fafafa] outline-none focus:border-[#4F9CF9]/60 disabled:opacity-60"
              >
                {TRANSCRIPT_QA_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            disabled={!apiKey.trim() || isSubmitting}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] px-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#ff735f] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-[#71717a]"
          >
            {isSubmitting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : null}
            {isSubmitting
              ? "Starting"
              : needsTakeover
                ? "Resume notes"
                : "Start notes"}
          </button>
          <p className="flex items-center justify-center gap-1.5 pt-0.5 text-[11px] text-[#71717a]">
            <Lock size={11} strokeWidth={2} />
            Used only for this session, never stored.
          </p>
        </form>
      </div>
    </div>
  );
}

// Shared empty/fallback shell, modeled on the chat panel: a faded, ghosted
// preview of the real content this tab will produce (hinting at where things
// land), above a short title and description.
function FallbackState({
  preview,
  title,
  description,
  rootClassName = "h-full",
}: {
  preview: React.ReactNode;
  title: string;
  description: string;
  rootClassName?: string;
}) {
  return (
    <div
      className={`flex min-h-0 flex-col items-center justify-center gap-5 px-8 text-center ${rootClassName}`}
    >
      <div
        aria-hidden="true"
        className="w-full max-w-[15rem] [mask-image:linear-gradient(to_bottom,transparent,#000_58%)]"
      >
        {preview}
      </div>
      <div className="max-w-[15rem] space-y-1.5">
        <p className="text-[14px] font-semibold text-[#fafafa]">{title}</p>
        <p className="text-[12.5px] leading-relaxed text-[#a1a1aa]">
          {description}
        </p>
      </div>
    </div>
  );
}

// Live equalizer bars reusing the room's voice-activity keyframe, tinted with
// the transcript accent so the empty state reads as "actively listening".
function Waveform({ bars = 7, height = 14 }: { bars?: number; height?: number }) {
  return (
    <span
      className="flex items-end gap-[3px]"
      style={{ color: START_ACCENT, height }}
    >
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-full"
          style={{
            height: "100%",
            background: "currentColor",
            opacity: 0.8,
            transformOrigin: "center bottom",
            animation: `acm-voice-activity 820ms ease-in-out ${i * 90}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

const Bar = ({ className }: { className: string }) => (
  <div className={`rounded-full bg-white/[0.07] ${className}`} />
);

function TranscriptFallback() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 px-8 text-center">
      <div
        className="inline-flex items-center justify-center rounded-full border px-6 py-3.5"
        style={{
          background: `${START_ACCENT}0f`,
          borderColor: `${START_ACCENT}33`,
        }}
      >
        <Waveform bars={11} height={22} />
      </div>
      <div className="max-w-[15rem] space-y-1.5">
        <p className="text-[14px] font-semibold text-[#fafafa]">
          Listening for the room
        </p>
        <p className="text-[12.5px] leading-relaxed text-[#a1a1aa]">
          As people speak, their words appear here live, captioned for everyone.
        </p>
      </div>
    </div>
  );
}

function AskFallback() {
  return (
    <FallbackState
      rootClassName="min-h-0 flex-1"
      title="Ask the meeting"
      description="Get a private answer drawn from everything that's been said. Only you see it."
      preview={
        <div className="flex flex-col gap-2.5">
          <div className="flex justify-end">
            <div className="h-7 w-32 rounded-2xl rounded-br-md bg-[#F95F4A]/25" />
          </div>
          <div className="space-y-1.5 rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.04] px-3 py-2.5 text-left">
            <Bar className="h-2 w-full bg-white/[0.07]" />
            <Bar className="h-2 w-5/6 bg-white/[0.07]" />
            <div className="flex gap-1 pt-0.5">
              <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
              <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
              <span className="web-chat-typing-dot h-1.5 w-1.5 rounded-full bg-[#a1a1aa]/70" />
            </div>
          </div>
        </div>
      }
    />
  );
}

function MinutesFallback() {
  return (
    <FallbackState
      title="Minutes build as you talk"
      description="Topics, decisions, action items, and open questions fill in on their own."
      preview={
        <div className="space-y-3.5 text-left">
          {[
            { label: "w-16", lines: ["w-full", "w-3/4"] },
            { label: "w-20", lines: ["w-5/6"] },
          ].map((section, index) => (
            <div key={index} className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-3.5 w-3.5 rounded bg-white/[0.07]" />
                <Bar className={`h-2.5 ${section.label}`} />
                <div className="ml-auto h-4 w-5 rounded-full bg-white/[0.05]" />
              </div>
              <div className="space-y-1.5 border-l-2 border-white/10 pl-3">
                {section.lines.map((line, lineIndex) => (
                  <Bar
                    key={lineIndex}
                    className={`h-2 ${line} bg-white/[0.06]`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      }
    />
  );
}

function TranscriptView({ segments }: { segments: TranscriptSegment[] }) {
  const groups = useMemo(() => groupSegments(segments), [segments]);

  if (segments.length === 0) {
    return <TranscriptFallback />;
  }

  return (
    <Conversation>
      <ConversationContent className="gap-4">
        {groups.map((group) => {
          const isLive = group.segments.some((segment) => !segment.isFinal);
          return (
            <Message key={group.key} from="assistant" className="max-w-full gap-1.5">
              <div className="flex w-full items-baseline justify-between gap-3">
                <span className="truncate text-[12px] font-semibold text-[#fafafa]">
                  {group.speakerDisplayName}
                </span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-[#71717a]">
                  {formatTranscriptTimestamp(group.segments[0].startMs)}
                </span>
              </div>
              <MessageContent
                className={[
                  "w-full gap-1 transition-colors",
                  isLive ? "border-[#4F9CF9]/35 bg-[#4F9CF9]/[0.06]" : "",
                ].join(" ")}
              >
                {group.segments.map((segment) => (
                  <p
                    key={segment.itemId}
                    className={
                      segment.isFinal ? "text-[#e4e4e7]" : "text-[#a1a1aa]"
                    }
                  >
                    {segment.text}
                    {!segment.isFinal ? (
                      <span className="ml-1 inline-block h-3 w-0.5 animate-pulse rounded-full bg-[#4F9CF9] align-middle" />
                    ) : null}
                  </p>
                ))}
              </MessageContent>
            </Message>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

const ASK_SUGGESTIONS = [
  "Summarize the discussion so far",
  "What decisions were made?",
  "List the action items",
  "What's still unresolved?",
];

function AnswerActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyMarkdown(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <MessageActions>
      <MessageAction label={copied ? "Copied" : "Copy answer"} onClick={copy}>
        {copied ? (
          <Check size={14} strokeWidth={2} />
        ) : (
          <Copy size={14} strokeWidth={1.8} />
        )}
      </MessageAction>
    </MessageActions>
  );
}

function AskView({
  messages,
  onAsk,
}: {
  messages: TranscriptQaMessage[];
  onAsk: (question: string) => boolean | Promise<boolean>;
}) {
  const [input, setInput] = useState("");
  const isStreaming = messages.some(
    (message) => message.role === "assistant" && message.status === "streaming",
  );

  const sendQuestion = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || isStreaming) return;
    const ok = await onAsk(trimmed);
    if (ok) setInput("");
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void sendQuestion(input);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {messages.length === 0 ? (
        <AskFallback />
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="gap-3">
            {messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.role === "assistant" && !message.content ? (
                    message.error ? (
                      <span className="text-[#ffb4ad]">{message.error}</span>
                    ) : (
                      <Shimmer className="text-[13px]">Thinking</Shimmer>
                    )
                  ) : message.role === "assistant" ? (
                    <Response>{message.content || message.error || ""}</Response>
                  ) : (
                    message.content
                  )}
                </MessageContent>
                {message.role === "assistant" &&
                message.content &&
                message.status === "done" ? (
                  <AnswerActions content={message.content} />
                ) : null}
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}
      <div className="shrink-0 space-y-2 border-t border-white/10 bg-[#18181b] p-3">
        {messages.length === 0 ? (
          <Suggestions>
            {ASK_SUGGESTIONS.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                onClick={sendQuestion}
              />
            ))}
          </Suggestions>
        ) : null}
        <PromptInput onSubmit={submit}>
          <PromptInputTextarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about the meeting"
          />
          <PromptInputToolbar>
            <PromptInputTools />
            <PromptInputSubmit
              status={isStreaming ? "submitted" : "ready"}
              disabled={!input.trim() || isStreaming}
              aria-label="Ask transcript"
            />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
}

function MinutesTask({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: TranscriptMinutesEntry[];
}) {
  if (items.length === 0) return null;
  return (
    <Task>
      <TaskTrigger title={title} icon={icon} count={items.length} />
      <TaskContent>
        {items.map((item) => (
          <TaskItem key={item.id}>
            <span className="text-[#e4e4e7]">{item.text}</span>
            {item.owner || item.due ? (
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {item.owner ? <TaskItemFile>{item.owner}</TaskItemFile> : null}
                {item.due ? <TaskItemFile>{item.due}</TaskItemFile> : null}
              </span>
            ) : null}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

function MinutesView({
  transcript,
}: {
  transcript: MeetingTranscriptController;
}) {
  const minutes = transcript.minutes;
  const hasMinutes = hasMinutesContent(minutes);

  if (!hasMinutes) {
    return <MinutesFallback />;
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {minutes.summary.trim() ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-[#e4e4e7]">
            <FileText size={14} strokeWidth={1.8} className="text-[#71717a]" />
            Summary
          </div>
          <Response>{minutes.summary}</Response>
        </div>
      ) : null}
      <MinutesTask
        title="Topics"
        icon={<Tag size={14} strokeWidth={1.8} />}
        items={minutes.topics}
      />
      <MinutesTask
        title="Decisions"
        icon={<CheckCircle2 size={14} strokeWidth={1.8} />}
        items={minutes.decisions}
      />
      <MinutesTask
        title="Action items"
        icon={<ListTodo size={14} strokeWidth={1.8} />}
        items={minutes.actionItems}
      />
      <MinutesTask
        title="Open questions"
        icon={<HelpCircle size={14} strokeWidth={1.8} />}
        items={minutes.openQuestions}
      />
      <MinutesTask
        title="Follow-ups"
        icon={<ListChecks size={14} strokeWidth={1.8} />}
        items={minutes.followUps}
      />
    </div>
  );
}

export default function TranscriptPanel({
  transcript,
  onClose,
}: TranscriptPanelProps) {
  const [activeTab, setActiveTab] = useState<TranscriptTab>("transcript");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const session = transcript.session;
  const canStop =
    transcript.isControllerUser || transcript.tokenInfo?.capabilities.stop;
  const hasExportContent =
    transcript.allSegments.length > 0 || hasMinutesContent(transcript.minutes);
  const isRunning =
    session.status === "starting" ||
    session.status === "live" ||
    session.status === "stopping";

  const handleCopy = async () => {
    const markdown = transcript.exportMarkdown();
    try {
      await copyMarkdown(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1200);
  };

  const handleDownload = () => {
    downloadMarkdown(`conclave-${session.roomId}-transcript.md`, transcript.exportMarkdown());
  };

  return (
    <div
      className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full flex-col border-l border-white/10 bg-[#18181b] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)] sm:w-[360px]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="shrink-0 border-b border-white/10 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[#fafafa]">
              Transcript
            </h2>
            {isRunning && session.controller ? (
              <p className="mt-0.5 truncate text-[11.5px] text-[#a1a1aa]">
                Hosted by {session.controller.displayName}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close transcript"
            title="Close transcript"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {isRunning ? (
          <div className="mt-3 flex items-center gap-2">
            {(["transcript", "ask", "minutes"] as const).map((tab) => {
              const Icon =
                tab === "transcript"
                  ? FileText
                  : tab === "ask"
                    ? MessageSquareText
                    : ListChecks;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={[
                    "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold capitalize transition-colors",
                    activeTab === tab
                      ? "bg-white/[0.10] text-[#fafafa]"
                      : "text-[#a1a1aa] hover:bg-white/[0.05] hover:text-[#fafafa]",
                  ].join(" ")}
                >
                  <Icon size={14} strokeWidth={1.8} />
                  {tab}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {(transcript.error || session.error) && (
        <div className="shrink-0 border-b border-[#f97066]/20 bg-[#f97066]/10 px-4 py-2 text-[12px] leading-relaxed text-[#ffb4ad]">
          {transcript.error || session.error}
        </div>
      )}

      {isRunning ? (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-[#a1a1aa]">
              {session.status === "live" ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#32d583]" />
              ) : (
                <Loader size={12} />
              )}
              <span className="truncate">
                {session.status !== "live"
                  ? "Connecting"
                  : transcript.isController
                    ? transcript.isStreamingAudio
                      ? "Listening to the room"
                      : "Connecting audio"
                    : "Following live"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={transcript.refreshMinutes}
                aria-label="Refresh minutes"
                title="Refresh minutes"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
              >
                <RefreshCw size={14} strokeWidth={1.8} />
              </button>
              {canStop ? (
                <button
                  onClick={transcript.stop}
                  aria-label="Stop transcript"
                  title="Stop transcript"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[#ffb4ad] transition-colors hover:bg-[#f97066]/10 hover:text-[#ffd2cf]"
                >
                  <Square size={13} strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === "transcript" ? (
              <TranscriptView segments={transcript.allSegments} />
            ) : activeTab === "ask" ? (
              <AskView messages={transcript.qaMessages} onAsk={transcript.ask} />
            ) : (
              <MinutesView transcript={transcript} />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#18181b] px-3 py-3">
            <button
              onClick={handleCopy}
              disabled={!hasExportContent}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-semibold text-[#d4d4d8] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:bg-white/[0.02] disabled:text-[#71717a]"
            >
              <ClipboardCopy size={14} strokeWidth={1.8} />
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Failed"
                  : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              disabled={!hasExportContent}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-semibold text-[#d4d4d8] transition-colors hover:bg-white/[0.08] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:bg-white/[0.02] disabled:text-[#71717a]"
            >
              <Download size={14} strokeWidth={1.8} />
              Export
            </button>
          </div>
        </>
      ) : (
        <StartStage transcript={transcript} />
      )}
    </div>
  );
}
