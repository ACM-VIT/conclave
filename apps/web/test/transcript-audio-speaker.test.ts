import { describe, expect, it } from "vitest";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import {
  canCommitPendingAudioForSpeaker,
  isSameTranscriptAudioSpeaker,
} from "../transcript-worker/src/audio-speaker";

const speaker = (
  userId: string,
  displayName: string,
  source: TranscriptSpeaker["source"] = "remote",
): TranscriptSpeaker => ({
  userId,
  displayName,
  source,
});

describe("transcript audio speaker policy", () => {
  it("rejects stale commits after a different speaker became pending", () => {
    const ada = speaker("u1", "Ada");
    const grace = speaker("u2", "Grace");

    expect(canCommitPendingAudioForSpeaker(grace, ada)).toBe(false);
    expect(canCommitPendingAudioForSpeaker(grace, grace)).toBe(true);
  });

  it("keeps speaker identity stable through display name changes", () => {
    expect(
      isSameTranscriptAudioSpeaker(
        speaker("u1", "Ada Lovelace"),
        speaker("u1", "Ada"),
      ),
    ).toBe(true);
  });

  it("treats the same user screen audio and mic audio as separate sources", () => {
    expect(
      isSameTranscriptAudioSpeaker(
        speaker("u1", "Ada", "remote"),
        speaker("u1", "Ada", "screen"),
      ),
    ).toBe(false);
  });
});
