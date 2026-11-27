import { describe, expect, it } from "vitest";
import { reconnectHold, shouldRetainMeetingSurface } from "../src/app/lib/meeting-surface-policy";
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

describe("holding what panels show through a reconnect", () => {
  const coming: ConnectionState[] = ["connecting", "connected", "joining", "joined", "reconnecting"];
  const ended: ConnectionState[] = ["error", "disconnected", "waiting"];

  it.each(coming)("holds through %s until the server answers", (connectionState) => {
    expect(reconnectHold({ isJoined: true, connectionState, authorityRuntime: "unknown" })).toEqual({
      connectionLive: true,
      holdingThroughReconnect: true,
    });
    expect(reconnectHold({ isJoined: true, connectionState, authorityRuntime: "ready" })).toEqual({
      connectionLive: true,
      holdingThroughReconnect: false,
    });
  });

  it.each(ended)("holds nothing in %s, which no reconnect follows", (connectionState) => {
    expect(reconnectHold({ isJoined: true, connectionState, authorityRuntime: "unknown" })).toEqual({
      connectionLive: false,
      holdingThroughReconnect: false,
    });
  });

  it("holds nothing for someone out of the meeting, whatever the connection says", () => {
    expect(reconnectHold({ isJoined: false, connectionState: "joined", authorityRuntime: "unknown" })).toEqual({
      connectionLive: false,
      holdingThroughReconnect: false,
    });
  });
});
