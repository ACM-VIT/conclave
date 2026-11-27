import { describe, expect, it } from "vitest";
import type {
  TranscriptSessionState,
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import { TranscriptRoom } from "../transcript-worker/src/room";
import {
  isRetryableTranscriptionFailure,
  transcriptionRecoveryDelayMs,
} from "../transcript-worker/src/transcription-recovery";
import { AudioStore, type HeldChunk } from "../transcript-worker/src/audio-store";
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
  audio: AudioStore;
  transcriptionSession: LiveTranscriptionSession | null;
  appendAudio: (
    viewer: Viewer,
    audio: string | undefined,
    speaker: Partial<TranscriptSpeaker> | undefined,
  ) => void;
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


  it("holds audio in arrival order and lets the oldest go first at the byte limit, whoever holds it", () => {
    const store = new AudioStore();
    const chunk = (sequence: number, owner: HeldChunk["owner"]): HeldChunk => ({
      audio: `chunk-${sequence}`,
      sampleCount: 1,
      speaker: ada,
      sequence,
      order: sequence,
      createdAt: sequence,
      voice: "speech",
      turn: 0,
      sentAt: owner.kind === "queued" ? null : sequence,
      owner,
    });
    store.add(chunk(2, { kind: "line", lineId: "a" }));
    store.add(chunk(0, { kind: "queued" }));
    store.add(chunk(1, { kind: "unowned" }));
    store.add(chunk(3, { kind: "queued" }));
    store.queueMarker({ type: "commit", speaker: ada, after: 1 });
    expect(store.all().map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(store.queuedEvents().map((event) => (event.type === "chunk" ? event.chunk.sequence : event.type))).toEqual([
      0,
      "commit",
      3,
    ]);

    const evicted = store.enforceBudget("chunk-0".length * 2);
    expect(evicted.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(store.bytes).toBe("chunk-0".length * 2);
    store.releaseOwner("a");
    expect(store.all().map(({ sequence }) => sequence)).toEqual([3]);
  });

  it("buffers relay audio while a persisted provider is still opening", () => {
    const room = createTestRoom();
    room.session = activeSession("starting");
    room.transcriptionProviderOpeningGeneration = 1;

    room.appendAudio(relayViewer, "AAAA", ada);

    expect(room.audio.queued()).toEqual([
      expect.objectContaining({
        audio: "AAAA",
        speaker: ada,
        sampleCount: 1,
        owner: { kind: "queued" },
      }),
    ]);
  });

});
