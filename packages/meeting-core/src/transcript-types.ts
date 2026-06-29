export type TranscriptSessionStatus =
  | "idle"
  | "starting"
  | "live"
  | "takeover_needed"
  | "stopping"
  | "error";

export interface TranscriptController {
  userId: string;
  displayName: string;
  connectionId: string;
  startedAt: number;
  lastSeenAt: number;
}

export type TranscriptOpenAiKeySource = "controller" | "global";

export interface TranscriptSessionState {
  roomId: string;
  status: TranscriptSessionStatus;
  controller: TranscriptController | null;
  transcriptModel: string;
  qaModel: string;
  keySource?: TranscriptOpenAiKeySource | null;
  startedAt: number | null;
  updatedAt: number;
  error?: string | null;
}

export type TranscriptAudioSource =
  | "local"
  | "remote"
  | "screen"
  | "mixed"
  | "unknown";

export interface TranscriptSpeaker {
  userId: string;
  displayName: string;
  source: TranscriptAudioSource;
}

export interface TranscriptSegment {
  id: string;
  itemId: string;
  sequence: number;
  speakerUserId: string;
  speakerDisplayName: string;
  source: TranscriptAudioSource;
  text: string;
  startMs: number;
  endMs: number | null;
  isFinal: boolean;
  updatedAt: number;
}

export interface TranscriptSegmentDelta {
  id: string;
  itemId: string;
  sequence: number;
  speaker: TranscriptSpeaker;
  text: string;
  delta: string;
  startMs: number;
  updatedAt: number;
}

export interface TranscriptMinutesEntry {
  id: string;
  text: string;
  speakerUserId?: string;
  speakerDisplayName?: string;
  owner?: string;
  due?: string;
}

export interface TranscriptMinutesSnapshot {
  summary: string;
  topics: TranscriptMinutesEntry[];
  decisions: TranscriptMinutesEntry[];
  actionItems: TranscriptMinutesEntry[];
  openQuestions: TranscriptMinutesEntry[];
  followUps: TranscriptMinutesEntry[];
  updatedAt: number;
  model: string;
}

export interface TranscriptQuestionRequest {
  id: string;
  question: string;
  model?: string;
}

export interface TranscriptQuestionResponse {
  id: string;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface TranscriptTokenCapabilities {
  start: boolean;
  takeover: boolean;
  stop: boolean;
  ask: boolean;
}

export interface TranscriptServiceVersion {
  id: string;
  tag: string | null;
  timestamp: string | null;
}

export interface TranscriptTokenResponse {
  roomId: string;
  workerUrl: string;
  token: string;
  expiresAt: number;
  capabilities: TranscriptTokenCapabilities;
}
