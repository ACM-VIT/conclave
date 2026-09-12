import { describe, expect, it } from "vitest";
import { shouldRetainMeetingSurface } from "../src/app/lib/meeting-surface-policy";
import type { ConnectionState } from "../src/app/lib/types";

const recoveryStates: ConnectionState[] = [
  "disconnected", "connecting", "connected", "joining", "reconnecting", "error",
];

describe("meeting surface continuity", () => {
  it.each(recoveryStates)("retains an interrupted meeting in %s", (connectionState) => {
    expect(shouldRetainMeetingSurface({ connectionState, hasEnteredMeetingSurface: true, intentionalDisconnect: false })).toBe(true);
  });

  it.each(recoveryStates)("does not turn a host ending, kick, or explicit leave into %s recovery", (connectionState) => {
    expect(shouldRetainMeetingSurface({ connectionState, hasEnteredMeetingSurface: true, intentionalDisconnect: true })).toBe(false);
  });

  it("keeps the lobby and waiting room outside recovery", () => {
    expect(shouldRetainMeetingSurface({ connectionState: "connecting", hasEnteredMeetingSurface: false, intentionalDisconnect: false })).toBe(false);
    expect(shouldRetainMeetingSurface({ connectionState: "waiting", hasEnteredMeetingSurface: true, intentionalDisconnect: false })).toBe(false);
    expect(shouldRetainMeetingSurface({ connectionState: "joined", hasEnteredMeetingSurface: false, intentionalDisconnect: false })).toBe(true);
  });
});
