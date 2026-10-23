import { describe, expect, it } from "vitest";
import {
  clampMeetVolume,
  clampParticipantVolume,
  DEFAULT_MEET_VOLUME,
  DEFAULT_PARTICIPANT_VOLUME,
  MAX_PARTICIPANT_VOLUME,
} from "../src/app/lib/meet-volume";

describe("meet volume", () => {
  it("keeps global meeting volume between silence and unity", () => {
    expect(clampMeetVolume(-1)).toBe(0);
    expect(clampMeetVolume(0.45)).toBe(0.45);
    expect(clampMeetVolume(4)).toBe(1);
    expect(clampMeetVolume(Number.NaN)).toBe(DEFAULT_MEET_VOLUME);
  });

  it("keeps participant volume between silence and unity", () => {
    expect(clampParticipantVolume(-1)).toBe(0);
    expect(clampParticipantVolume(0.65)).toBe(0.65);
    expect(clampParticipantVolume(1.35)).toBe(MAX_PARTICIPANT_VOLUME);
    expect(clampParticipantVolume(8)).toBe(MAX_PARTICIPANT_VOLUME);
    expect(clampParticipantVolume(Number.NaN)).toBe(
      DEFAULT_PARTICIPANT_VOLUME,
    );
  });
});
