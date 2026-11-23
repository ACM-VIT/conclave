import { describe, expect, it } from "vitest";
import type {
  TranscriptSessionState,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import { TranscriptRoom } from "../transcript-worker/src/room";
import {
  TranscriptRecoveryAudioBuffer,
  isRetryableTranscriptionFailure,
  transcriptionRecoveryDelayMs,
} from "../transcript-worker/src/transcription-recovery";
import type {
  LiveTranscriptionSession,
} from "../transcript-worker/src/transcription/types";
import type { Env, Viewer } from "../transcript-worker/src/types";

const ada: TranscriptSpeaker = {
  userId: "u1",
  displayName: "Ada",
  source: "remote",
};

const activeSession = (
  status: TranscriptSessionState["status"] = "live",
): TranscriptSessionState => ({
  roomId: "room-a",
  status,
  controller: {
    userId: "u1",
    displayName: "Ada",
    connectionId: "viewer-a",
    startedAt: 1,
    lastSeenAt: 1,
  },
  transcriptModel: "gpt-live-transcribe",
  qaModel: "gpt-5.6-terra",
  transportMode: "sfu",
  keySource: "global",
  startedAt: 1,
  updatedAt: 1,
  error: null,
});

const relayViewer: Viewer = {
  id: "relay-a",
  socket: {} as WebSocket,
  userId: "sfu:room-a",
  displayName: "SFU relay",
  capabilities: {
    start: false,
    takeover: false,
    stop: false,
    ask: false,
    relayAudio: true,
  },
  connectedAt: 1,
  rateLimits: {},
};

type TestableTranscriptRoom = {
  session: TranscriptSessionState | null;
  transcriptionProviderOpeningGeneration: number | null;
  transcriptionRecoveryAudio: TranscriptRecoveryAudioBuffer;
  transcriptionSession: LiveTranscriptionSession | null;
  appendAudio: (
    viewer: Viewer,
    audio: string | undefined,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ) => void;
  appendNormalizedAudio: (
    audio: string,
    speaker: TranscriptSpeaker,
    sampleCount: number,
  ) => boolean;
  commitTranscriptionBuffer: (
    speaker: TranscriptSpeaker,
    failureMessage: string,
  ) => boolean;
};

const createTestRoom = (): TestableTranscriptRoom => {
  const state = {
    storage: {
      get: async () => undefined,
    },
    waitUntil: () => undefined,
  } as unknown as DurableObjectState;
  return new TranscriptRoom(state, {} as Env) as unknown as TestableTranscriptRoom;
};

describe("transcription provider recovery", () => {
  it("retries transient disconnects and timeouts but not invalid credentials", () => {
    expect(
      isRetryableTranscriptionFailure("Transcription model disconnected."),
    ).toBe(true);
    expect(
      isRetryableTranscriptionFailure("Upstream request timed out (504)."),
    ).toBe(true);
    expect(isRetryableTranscriptionFailure("Invalid API key.")).toBe(false);
    expect(
      isRetryableTranscriptionFailure(
        "Realtime transcription connection failed (401).",
      ),
    ).toBe(false);
    expect(
      isRetryableTranscriptionFailure(
        "Realtime transcription connection failed (429).",
      ),
    ).toBe(true);
  });

  it("uses immediate first recovery and caps exponential retry delay", () => {
    expect(transcriptionRecoveryDelayMs(0)).toBe(0);
    expect(transcriptionRecoveryDelayMs(3)).toBe(1_500);
    expect(transcriptionRecoveryDelayMs(999)).toBe(10_000);
  });


  it("keeps recovery audio ordered and drops stale buffered events", () => {
    const buffer = new TranscriptRecoveryAudioBuffer();
    buffer.enqueue(
      {
        type: "chunk",
        audio: "stale",
        speaker: ada,
        sampleCount: 1,
        createdAt: 1,
      },
      200_000,
    );
    expect(buffer.drain()).toEqual([]);
    expect(buffer.consumeDroppedEventCount()).toBe(1);

    buffer.enqueue(
      {
        type: "chunk",
        audio: "fresh",
        speaker: ada,
        sampleCount: 1,
        createdAt: 200_000,
      },
      200_000,
    );
    buffer.enqueue(
      { type: "commit", speaker: ada, createdAt: 200_001 },
      200_001,
    );
    expect(buffer.drain().map((event) => event.type)).toEqual([
      "chunk",
      "commit",
    ]);
  });

  it("buffers relay audio while a persisted provider is still opening", () => {
    const room = createTestRoom();
    room.session = activeSession("starting");
    room.transcriptionProviderOpeningGeneration = 1;

    room.appendAudio(relayViewer, "AAAA", ada);

    expect(room.transcriptionRecoveryAudio.drain()).toEqual([
      expect.objectContaining({
        type: "chunk",
        audio: "AAAA",
        speaker: ada,
        sampleCount: 1,
      }),
    ]);
  });

});
