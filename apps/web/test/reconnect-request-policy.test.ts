import { describe, expect, it } from "vitest";
import {
  resolveInFlightReconnectRequest,
  resolveReconnectStartAttempts,
} from "../src/app/lib/reconnect-request-policy";

const waiting = { isWaitingForBackoff: true, canCancelBackoff: true };
const connecting = { isWaitingForBackoff: false, canCancelBackoff: false };

describe("reconnect requests while a loop is running", () => {
  it.each([
    ["a socket or transport nudge", undefined],
    ["a foreground or online nudge", {}],
    ["an immediate background nudge", { immediate: true }],
  ])("ignores %s: no attempt reset and no skipped backoff", (_label, request) => {
    for (const context of [waiting, connecting]) {
      expect(resolveInFlightReconnectRequest(request, context)).toEqual({
        markUserRetry: false,
        cancelBackoff: false,
        announceQueuedRetry: false,
      });
    }
  });

  it("lets the user's Retry cut a backoff wait short and restart the count", () => {
    expect(
      resolveInFlightReconnectRequest({ immediate: true, userInitiated: true }, waiting),
    ).toEqual({ markUserRetry: true, cancelBackoff: true, announceQueuedRetry: false });
  });

  it("queues the user's Retry behind a connect or join step in progress", () => {
    expect(
      resolveInFlightReconnectRequest({ immediate: true, userInitiated: true }, connecting),
    ).toEqual({ markUserRetry: true, cancelBackoff: false, announceQueuedRetry: true });
  });
});

describe("reconnect loop start", () => {
  it("starts a fresh cycle after an earlier loop gave up at the cap", () => {
    expect(resolveReconnectStartAttempts(8, 8)).toBe(0);
    expect(resolveReconnectStartAttempts(9, 8)).toBe(0);
  });

  it("keeps the count of a cycle that has not used up its attempts", () => {
    expect(resolveReconnectStartAttempts(0, 8)).toBe(0);
    expect(resolveReconnectStartAttempts(3, 8)).toBe(3);
  });
});
