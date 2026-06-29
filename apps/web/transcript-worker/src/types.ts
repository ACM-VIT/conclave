import type {
  TranscriptMinutesSnapshot,
  TranscriptSegment,
  TranscriptServiceVersion,
  TranscriptSpeaker,
  TranscriptSessionState,
  TranscriptTokenCapabilities,
} from "@conclave/meeting-core/transcript-types";
import type { TranscriptRateLimitState } from "./rate-limit";

export interface Env {
  TRANSCRIPT_ROOM: DurableObjectNamespace;
  CF_VERSION_METADATA?: Partial<TranscriptServiceVersion>;
  TRANSCRIPT_TOKEN_SECRET: string;
  TRANSCRIPT_ALLOWED_ORIGIN?: string;
  TRANSCRIPT_IDLE_TTL_MS?: string;
  TRANSCRIPT_MAX_SEGMENTS?: string;
  TRANSCRIPT_TRANSCRIPTION_LANGUAGE?: string;
  TRANSCRIPT_TRANSCRIPTION_LOCALE?: string;
  TRANSCRIPT_TRANSCRIPTION_PROMPT?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_REALTIME_URL?: string;
  OPENAI_RESPONSES_URL?: string;
  CLOUDFLARE_AI_GATEWAY_OPENAI_URL?: string;
}

export type TranscriptTokenPayload = {
  aud?: string;
  exp?: number;
  sub?: string;
  userId?: string;
  displayName?: string;
  roomId?: string;
  clientId?: string;
  channelId?: string;
  isAdmin?: boolean;
  isHost?: boolean;
  isGhost?: boolean;
  capabilities?: Partial<TranscriptTokenCapabilities>;
};

export type Viewer = {
  id: string;
  socket: WebSocket;
  userId: string;
  displayName: string;
  capabilities: TranscriptTokenCapabilities;
  connectedAt: number;
  rateLimits: TranscriptRateLimitState;
};

export type PersistedSnapshot = {
  session: TranscriptSessionState;
  segments: TranscriptSegment[];
  minutes: TranscriptMinutesSnapshot;
  sequence: number;
};

export type ClientEnvelope =
  | {
      type: "session.start" | "session.takeover";
      apiKey?: string;
      transcriptModel?: string;
      qaModel?: string;
      language?: string;
      delay?: string;
    }
  | { type: "session.stop" }
  | {
      type: "audio.chunk";
      audio?: string;
      speaker?: Partial<TranscriptSpeaker>;
    }
  | { type: "audio.commit"; speaker?: Partial<TranscriptSpeaker> }
  | { type: "audio.clear"; speaker?: Partial<TranscriptSpeaker> }
  | { type: "qa.ask"; id?: string; question?: string; model?: string }
  | { type: "minutes.refresh" }
  | { type: "export.snapshot" };

export type SessionStartEnvelope = Extract<
  ClientEnvelope,
  { type: "session.start" | "session.takeover" }
>;

export type QaAskEnvelope = Extract<ClientEnvelope, { type: "qa.ask" }>;

export type OpenAiRealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
};
