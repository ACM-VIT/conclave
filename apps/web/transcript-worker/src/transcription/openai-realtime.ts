import {
  buildRealtimeTranscriptionConfig,
  realtimeEndpoint,
} from "../openai";
import { safeJsonParse } from "../utils";
import type {
  LiveTranscriptionCallbacks,
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "./types";

type OpenAiRealtimeEvent = {
  type?: string;
  item_id?: string;
  previous_item_id?: string;
  delta?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
};

class OpenAiRealtimeTranscriptionSession implements LiveTranscriptionSession {
  readonly provider = "openai" as const;

  private closed = false;

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
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const event = parsed as OpenAiRealtimeEvent;
    if (event.type === "error") {
      await this.callbacks.onFailure(
        event.error?.message || "Realtime transcription error.",
      );
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      await this.callbacks.onFailure(
        event.error?.message || "Realtime input audio transcription failed.",
      );
      return;
    }
    if (event.type === "input_audio_buffer.committed" && event.item_id) {
      this.callbacks.onCommitted(event.item_id);
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      event.item_id &&
      event.delta
    ) {
      this.callbacks.onDelta(event.item_id, event.delta);
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.item_id
    ) {
      await this.callbacks.onFinal(event.item_id, event.transcript || "");
    }
  }
}

export const connectOpenAiRealtimeTranscription = async (
  options: LiveTranscriptionConnectOptions,
): Promise<LiveTranscriptionSession> => {
  const response = await fetch(
    realtimeEndpoint(options.env),
    {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Upgrade: "websocket",
      },
      signal: options.signal,
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
