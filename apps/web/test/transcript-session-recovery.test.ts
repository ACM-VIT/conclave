import { describe, expect, it } from "vitest";
import type {
  TranscriptServiceVersion,
  TranscriptSessionState,
} from "@conclave/meeting-core/transcript-types";
import {
  recoverPersistedTranscriptSession,
  TRANSCRIPT_RELAY_RECOVERED_MESSAGE,
  TRANSCRIPT_WORKER_UPDATED_MESSAGE,
} from "../transcript-worker/src/session-recovery";

const version = (id: string): TranscriptServiceVersion => ({
  id,
  tag: null,
  timestamp: null,
});

const session = (
  overrides: Partial<TranscriptSessionState> = {},
): TranscriptSessionState => ({
  roomId: "room-a",
  status: "live",
  controller: {
    userId: "u1",
    displayName: "Ada",
    connectionId: "conn-a",
    startedAt: 1,
    lastSeenAt: 2,
  },
  transcriptModel: "gpt-realtime-whisper",
  qaModel: "gpt-5.5",
  transportMode: "browser",
  keySource: "global",
  startedAt: 1,
  updatedAt: 2,
  error: null,
  ...overrides,
});

describe("recoverPersistedTranscriptSession", () => {
  it("turns active sessions from older worker versions into service-update takeover", () => {
    const recovered = recoverPersistedTranscriptSession(
      session(),
      version("old"),
      version("new"),
    );

    expect(recovered.status).toBe("takeover_needed");
    expect(recovered.error).toBe(TRANSCRIPT_WORKER_UPDATED_MESSAGE);
  });

  it("preserves a same-version recovered relay message for active sessions", () => {
    const recovered = recoverPersistedTranscriptSession(
      session(),
      version("same"),
      version("same"),
    );

    expect(recovered.status).toBe("takeover_needed");
    expect(recovered.error).toBe(TRANSCRIPT_RELAY_RECOVERED_MESSAGE);
  });

  it("rewrites legacy controller-disconnected snapshots when version metadata is missing", () => {
    const recovered = recoverPersistedTranscriptSession(
      session({
        status: "takeover_needed",
        error: "Transcript controller disconnected.",
      }),
      undefined,
      version("new"),
    );

    expect(recovered.status).toBe("takeover_needed");
    expect(recovered.error).toBe(TRANSCRIPT_WORKER_UPDATED_MESSAGE);
  });
});
