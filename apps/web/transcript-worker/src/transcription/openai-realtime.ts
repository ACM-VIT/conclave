import {
  buildRealtimeTranscriptionConfig,
  realtimeEndpoint,
} from "../openai";
import { safeJsonParse, trimText } from "../utils";
import type {
  LiveTranscriptionCallbacks,
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "./types";

const OPENAI_EVENT_LOG_INTERVAL_MS = 15_000;

type OpenAiRealtimeEvent = {
  type?: string;
  item_id?: string;
  previous_item_id?: string;
  delta?: string;
  transcript?: string;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
};

const summarizeOpenAiRealtimeEvent = (
  raw: string,
): Record<string, unknown> | null => {
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") {
    return { validJson: false };
  }
  const event = parsed as OpenAiRealtimeEvent;
  return {
    validJson: true,
    eventType: event.type ?? null,
    hasItemId: typeof event.item_id === "string" && event.item_id.length > 0,
    hasDelta: typeof event.delta === "string" && event.delta.length > 0,
    deltaLength: typeof event.delta === "string" ? event.delta.length : 0,
    hasTranscript:
      typeof event.transcript === "string" && event.transcript.length > 0,
    transcriptLength:
      typeof event.transcript === "string" ? event.transcript.length : 0,
    errorMessage:
      typeof event.error?.message === "string"
        ? trimText(event.error.message, 300)
        : null,
    errorCode:
      typeof event.error?.code === "string"
        ? trimText(event.error.code, 120)
        : null,
    errorType:
      typeof event.error?.type === "string"
        ? trimText(event.error.type, 120)
        : null,
  };
};

class OpenAiRealtimeTranscriptionSession implements LiveTranscriptionSession {
  readonly provider = "openai" as const;

  private closed = false;
  private receivedEvents = 0;
  private ignoredEvents = 0;
  private lastEventLogAt = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly callbacks: LiveTranscriptionCallbacks,
  ) {}

  appendAudio(audioBase64: string): void {
    this.socket.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: audioBase64 }),
    );
  }

  commitAudio(): void {
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  clearAudio(): void {
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {}
  }

  attach(): void {
    this.socket.addEventListener("message", (event) => {
      void this.handleEvent(String(event.data ?? ""));
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) {
        void this.callbacks.onFailure("Transcription model disconnected.");
      }
    });
    this.socket.addEventListener("error", () => {
      if (!this.closed) {
        void this.callbacks.onFailure("Transcription model connection errored.");
      }
    });
  }

  private async handleEvent(raw: string): Promise<void> {
    this.receivedEvents += 1;
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") {
      this.ignoredEvents += 1;
      this.logProviderEvent("invalid_json", raw, this.ignoredEvents === 1);
      return;
    }
    const event = parsed as OpenAiRealtimeEvent;
    if (event.type === "error") {
      this.logProviderEvent("error", raw, true);
      await this.callbacks.onFailure(
        event.error?.message || "Realtime transcription error.",
      );
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.logProviderEvent("failed", raw, true);
      await this.callbacks.onFailure(
        event.error?.message || "Realtime input audio transcription failed.",
      );
      return;
    }
    if (event.type === "input_audio_buffer.committed" && event.item_id) {
      this.logProviderEvent("committed", raw, this.receivedEvents === 1);
      this.callbacks.onCommitted(event.item_id);
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      event.item_id &&
      event.delta
    ) {
      this.logProviderEvent("delta", raw, this.receivedEvents === 1);
      this.callbacks.onDelta(event.item_id, event.delta);
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.item_id
    ) {
      this.logProviderEvent("completed", raw, this.receivedEvents === 1);
      await this.callbacks.onFinal(event.item_id, event.transcript || "");
      return;
    }
    this.ignoredEvents += 1;
    this.logProviderEvent("ignored", raw, this.ignoredEvents === 1);
  }

  private logProviderEvent(
    outcome: string,
    raw: string,
    force = false,
  ): void {
    const now = Date.now();
    if (!force && now - this.lastEventLogAt < OPENAI_EVENT_LOG_INTERVAL_MS) {
      return;
    }
    this.lastEventLogAt = now;
    console.info("[TranscriptWorker] openai realtime event", {
      outcome,
      receivedEvents: this.receivedEvents,
      ignoredEvents: this.ignoredEvents,
      ...summarizeOpenAiRealtimeEvent(raw),
    });
  }
}

export const connectOpenAiRealtimeTranscription = async (
  options: LiveTranscriptionConnectOptions,
): Promise<LiveTranscriptionSession> => {
  const response = await fetch(
    realtimeEndpoint(options.env, options.transcriptModel),
    {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Upgrade: "websocket",
      },
    },
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(
      `Realtime transcription connection failed (${response.status}).`,
    );
  }

  socket.accept();
  const session = new OpenAiRealtimeTranscriptionSession(
    socket,
    options.callbacks,
  );
  session.attach();

  const transcription = buildRealtimeTranscriptionConfig({
    model: options.transcriptModel,
    language: options.language,
    delay: options.delay,
    locale: options.locale,
    localizationPrompt: options.localizationPrompt,
  });

  socket.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            transcription,
            turn_detection: null,
          },
        },
      },
    }),
  );

  return session;
};
