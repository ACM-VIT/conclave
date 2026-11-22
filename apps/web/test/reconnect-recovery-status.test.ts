import { describe, expect, it } from "vitest";
import {
  describeReconnectGiveUp,
  formatReconnectAttemptLabel,
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
