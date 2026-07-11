import type { ChatMessage, TranscriptSegment } from "./types";
import {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  TRANSCRIPT_QA_MODELS,
} from "@conclave/meeting-core/transcript-models";

// Identity of the in-meeting "@Conclave" AI assistant. The SFU validates signed
// assistant packets before broadcasting them with this stable bot identity.
export const CONCLAVE_ASSISTANT_USER_ID = "conclave-assistant";
export const CONCLAVE_ASSISTANT_NAME = "Conclave";
export const CONCLAVE_MENTION_TOKEN = "Conclave";

export type ConclaveAssistantStatus = "streaming" | "done" | "error";
type ConclaveAssistantPartStatus = "streaming" | "done";

export const CONCLAVE_ASSISTANT_GLOBAL_MODEL = DEFAULT_TRANSCRIPT_QA_MODEL;
export const CONCLAVE_ASSISTANT_BYOK_MODELS = TRANSCRIPT_QA_MODELS;

export type ConclaveAssistantModel =
  (typeof TRANSCRIPT_QA_MODELS)[number]["id"];

export const isConclaveAssistantModel = (
  value: string,
): value is ConclaveAssistantModel =>
  CONCLAVE_ASSISTANT_BYOK_MODELS.some((model) => model.id === value);

export interface ConclaveAssistantRelayPacket {
  id: string;
  roomId: string;
  channelId: string;
  requesterUserId: string;
  questionMessageId: string;
  content: string;
  done: boolean;
  timestamp: number;
  expiresAt: number;
  signature: string;
}

export class ConclaveAssistantApiKeyRequiredError extends Error {
  constructor(message = "OpenAI API key required.") {
    super(message);
    this.name = "ConclaveAssistantApiKeyRequiredError";
  }
}

// A single streamed assistant step shown in the process timeline.
type AssistantTaskKind =
  | "reasoning"
  | "web_search"
  | "transcript"
  | "github_issue"
  | "answer";

export interface AssistantTask {
  id: string;
  kind: AssistantTaskKind;
  status: "running" | "done";
  query?: string;
}

// Client-only fields layered onto a ChatMessage for assistant rendering.
export interface AssistantChatMessage extends ChatMessage {
  isAssistant?: boolean;
  assistantStatus?: ConclaveAssistantStatus;
  reasoningStatus?: ConclaveAssistantPartStatus;
  // The model's streamed reasoning summary, rendered as a collapsible trace.
  reasoning?: string;
  // Tool activity (web search, transcript lookup, issue creation) shown as a
  // compact action timeline.
  tasks?: AssistantTask[];
}

// Merge a streamed task into an existing list, upserting by id and keeping a
// "done" status sticky so a late "running" event can't reopen a finished step.
export const mergeAssistantTask = (
  tasks: AssistantTask[] | undefined,
  next: AssistantTask,
): AssistantTask[] => {
  const list = tasks ? [...tasks] : [];
  const index = list.findIndex((task) => task.id === next.id);
  if (index === -1) {
    list.push(next);
    return list;
  }
  const previous = list[index];
  list[index] = {
    ...previous,
    ...next,
    status: previous.status === "done" ? "done" : next.status,
    query: next.query ?? previous.query,
  };
  return list;
};

export const completeAssistantTasks = (
  tasks: AssistantTask[] | undefined,
): AssistantTask[] | undefined =>
  tasks?.map((task) =>
    task.status === "done" ? task : { ...task, status: "done" },
  );

export interface ConclaveAssistantHistoryItem {
  name?: string;
  isAssistant?: boolean;
  content: string;
}

// Matches an "@Conclave" mention anywhere in a message — at the start, or
// mid-sentence like "Hey @Conclave, what's up". The (^|\s) boundary keeps it
// from firing inside emails or handles such as "foo@conclave.ai".
const MENTION_PATTERN = new RegExp(
  `(^|\\s)@${CONCLAVE_MENTION_TOKEN}\\b[\\s,:]*`,
  "i",
);

// Returns the trimmed question when a message mentions "@Conclave" anywhere,
// or null when the message is a normal chat line. The mention token is stripped
// out and the surrounding words become the question ("Hey @Conclave do X" ->
// "Hey do X").
export const parseConclaveMention = (content: string): string | null => {
  if (!MENTION_PATTERN.test(content)) return null;
  return content
    .replace(MENTION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// Renders transcript segments as `[HH:MM:SS] Speaker: text` lines for the
// assistant's context, matching the format the transcript Q&A uses.
export const formatTranscriptForAssistant = (
  segments: TranscriptSegment[],
): string =>
  segments
    .map((segment) => {
      const timestamp = new Date(segment.startMs).toISOString().slice(11, 19);
      return `[${timestamp}] ${segment.speakerDisplayName}: ${segment.text}`;
    })
    .join("\n");

interface StreamConclaveAssistantOptions {
  answerId: string;
  question: string;
  relayToken: string;
  apiKey?: string;
  model?: ConclaveAssistantModel;
  history: ConclaveAssistantHistoryItem[];
  transcript: string;
  transcriptActive: boolean;
  signal?: AbortSignal;
  onDelta: (fullText: string) => void;
  onReasoning: (fullReasoning: string) => void;
  onReasoningDone?: () => void;
  onTask: (task: AssistantTask) => void;
  onRelay: (packet: ConclaveAssistantRelayPacket) => void;
  onDone?: (finalText: string) => void;
}

const CONCLAVE_RELAY_MIN_INTERVAL_MS = 350;
const CONCLAVE_RELAY_MIN_CONTENT_DELTA = 160;

type AssistantStreamEvent =
  | {
      type: "delta";
      delta?: string;
      relay?: ConclaveAssistantRelayPacket;
    }
  | {
      type: "reasoning";
      delta?: string;
      done?: boolean;
    }
  | {
      type: "task";
      task: AssistantTask;
    }
  | {
      type: "done";
      relay?: ConclaveAssistantRelayPacket;
    }
  | {
      type: "error";
      error?: string;
      relay?: ConclaveAssistantRelayPacket;
    };

const parseAssistantStreamEvent = (line: string): AssistantStreamEvent | null => {
  try {
    const parsed = JSON.parse(line) as AssistantStreamEvent;
    if (!parsed || typeof parsed !== "object") return null;
    if (
      parsed.type !== "delta" &&
      parsed.type !== "reasoning" &&
      parsed.type !== "task" &&
      parsed.type !== "done" &&
      parsed.type !== "error"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const parseAssistantStreamFrame = (
  frame: string,
): AssistantStreamEvent | null => {
  const trimmed = frame.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(":")) {
    return null;
  }

  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  return parseAssistantStreamEvent(data || trimmed);
};

// Streams the assistant answer from the API route, invoking onDelta with the
// accumulated text on each chunk. Resolves with the final text or throws.
export const streamConclaveAssistant = async ({
  answerId,
  question,
  relayToken,
  apiKey,
  model,
  history,
  transcript,
  transcriptActive,
  signal,
  onDelta,
  onReasoning,
  onReasoningDone,
  onTask,
  onRelay,
  onDone,
}: StreamConclaveAssistantOptions): Promise<string> => {
  const response = await fetch("/api/conclave/assistant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${relayToken}`,
    },
    body: JSON.stringify({
      answerId,
      question,
      history,
      transcript,
      transcriptActive,
      ...(apiKey ? { apiKey } : {}),
      ...(apiKey && model ? { model } : {}),
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = "Conclave could not answer right now.";
    let code = "";
    try {
      const data = (await response.json()) as { error?: string; code?: string };
      if (data?.error) message = data.error;
      if (data?.code) code = data.code;
    } catch {
      // Non-JSON error body; keep the default message.
    }
    if (response.status === 428 || code === "api_key_required") {
      throw new ConclaveAssistantApiKeyRequiredError(message);
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const isSseStream = (response.headers.get("content-type") || "")
    .toLowerCase()
    .includes("text/event-stream");
  let text = "";
  let reasoning = "";
  let pending = "";
  let streamError: string | null = null;
  let completed = false;
  let lastRelayedAt = 0;
  let lastRelayedContentLength = 0;

  const maybeRelay = (packet: ConclaveAssistantRelayPacket) => {
    if (packet.done) {
      onRelay(packet);
      lastRelayedAt = Date.now();
      lastRelayedContentLength = packet.content.length;
      return;
    }

    const now = Date.now();
    const contentDelta = Math.abs(
      packet.content.length - lastRelayedContentLength,
    );
    if (
      now - lastRelayedAt < CONCLAVE_RELAY_MIN_INTERVAL_MS &&
      contentDelta < CONCLAVE_RELAY_MIN_CONTENT_DELTA
    ) {
      return;
    }

    onRelay(packet);
    lastRelayedAt = now;
    lastRelayedContentLength = packet.content.length;
  };

  const handleLine = (line: string) => {
    const event = parseAssistantStreamEvent(line);
    if (!event) return;
    if ("relay" in event && event.relay) {
      maybeRelay(event.relay);
    }
    if (event.type === "delta") {
      text += event.delta ?? "";
      onDelta(text);
      return;
    }
    if (event.type === "reasoning") {
      reasoning += event.delta ?? "";
      if (event.delta) {
        onReasoning(reasoning);
      }
      if (event.done) {
        onReasoningDone?.();
      }
      return;
    }
    if (event.type === "task") {
      onTask(event.task);
      return;
    }
    if (event.type === "error") {
      streamError = event.error || "Conclave could not answer right now.";
      return;
    }
    if (event.type === "done") {
      completed = true;
      if (event.relay?.content) {
        text = event.relay.content;
      }
      onReasoningDone?.();
      onDone?.(text);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const frames = isSseStream ? pending.split(/\r?\n\r?\n/) : pending.split("\n");
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseAssistantStreamFrame(frame);
      if (event) handleLine(JSON.stringify(event));
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const event = parseAssistantStreamFrame(pending);
    if (event) handleLine(JSON.stringify(event));
  }
  if (streamError) {
    throw new Error(streamError);
  }
  if (!completed) {
    onReasoningDone?.();
    onDone?.(text);
  }
  return text;
};
