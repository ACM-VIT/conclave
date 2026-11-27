import { describe, expect, it } from "vitest";
import {
  describeReconnectGiveUp,
  describeRecoveryCard,
  formatReconnectAttemptLabel,
  type RecoveryCardState,
} from "../src/app/lib/reconnect-recovery-status";
import type { ReconnectRecoveryStatus } from "../src/app/lib/types";

const status = (
  overrides: Partial<ReconnectRecoveryStatus>,
): ReconnectRecoveryStatus => ({
  phase: "waiting",
  attempt: 3,
  maxAttempts: 8,
  message: "Retrying automatically.",
  lastError: null,
  retryAt: null,
  updatedAt: 0,
  ...overrides,
});

const online = { waitingForNetwork: false };

describe("the attempt count on the recovery card", () => {
  it.each(["waiting", "connecting", "joining"] as const)(
    "shows the real count while automatic retries are %s",
    (phase) => {
      expect(formatReconnectAttemptLabel(status({ phase }), online)).toBe(
        "Attempt 3 of 8",
      );
    },
  );

  it("hides the count once the reconnect has stopped", () => {
    expect(
      formatReconnectAttemptLabel(status({ phase: "failed", attempt: 1 }), online),
    ).toBeNull();
    expect(
      formatReconnectAttemptLabel(status({ phase: "failed", attempt: 8 }), online),
    ).toBeNull();
  });

  it("hides the count while a retry is not using up attempts", () => {
    expect(formatReconnectAttemptLabel(status({ attempt: null }), online)).toBeNull();
  });

  it("hides the count while waiting for the network", () => {
    expect(
      formatReconnectAttemptLabel(status({}), { waitingForNetwork: true }),
    ).toBeNull();
  });

  it("hides the count on the invite code card", () => {
    expect(
      formatReconnectAttemptLabel(
        status({ phase: "failed", needsInviteCode: true }),
        online,
      ),
    ).toBeNull();
  });

  it("shows nothing without a status", () => {
    expect(formatReconnectAttemptLabel(null, online)).toBeNull();
  });
});

describe("what the card says after the reconnect gives up", () => {
  it("names how many attempts were made", () => {
    expect(describeReconnectGiveUp({ attempts: 8, roomWaitExpired: false })).toBe(
      "Could not reconnect after 8 attempts.",
    );
  });

  it("says the meeting stayed away when the room wait ran out", () => {
    expect(describeReconnectGiveUp({ attempts: 1, roomWaitExpired: true })).toBe(
      "The meeting was not available for 60 seconds.",
    );
  });
});

describe("the recovery card's words", () => {
  const card = (overrides: Partial<RecoveryCardState>) =>
    describeRecoveryCard({
      isOffline: false,
      isRestoring: false,
      terminalMessage: null,
      needsInviteCode: false,
      status: null,
      countdownSeconds: null,
      canRetry: true,
      errorMessage: null,
      ...overrides,
    });

  it("says it is reconnecting while the call is being restored", () => {
    expect(card({ isRestoring: true, status: status({ phase: "joining" }) })).toMatchObject({
      title: "Reconnecting",
      detail: "Connection is back. Restoring media, participants, and room state.",
    });
  });

  it("does not repeat a refusal under Last error", () => {
    expect(
      card({
        terminalMessage: "This meeting has ended.",
        status: status({ phase: "failed", lastError: "This meeting has ended." }),
      }),
    ).toEqual({
      title: "Meeting unavailable",
      detail: "This meeting has ended.",
      lastError: null,
    });
  });

  it("keeps Last error when it adds something", () => {
    expect(
      card({
        status: status({
          phase: "failed",
          message: "Could not reconnect after 8 attempts.",
          lastError: "The meeting server did not respond before the timeout.",
        }),
      }),
    ).toEqual({
      title: "Reconnect failed",
      detail: "Could not reconnect after 8 attempts.",
      lastError: "The meeting server did not respond before the timeout.",
    });
  });

  it("shows a countdown while an automatic retry is scheduled", () => {
    expect(
      card({ status: status({ retryAt: 1 }), countdownSeconds: 4 }),
    ).toMatchObject({ title: "Connection interrupted", detail: "Retrying automatically in 4s." });
  });
});
