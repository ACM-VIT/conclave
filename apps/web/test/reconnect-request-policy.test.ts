import { describe, expect, it } from "vitest";
import {
  ROOM_UNAVAILABLE_RETRY_WINDOW_MS,
  canReuseSocketAfterFailure,
  classifyReconnectFailure,
  planRoomUnavailableRetry,
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

describe("reconnect failures", () => {
  const classify = (message: string, responseStatus: number | null = null) =>
    classifyReconnectFailure({ message, responseStatus });

  it.each([
    "No room found.",
    "Shared room registry unavailable during room claim",
    "Shared room registry unavailable during confirmed lease expiry for conclave:room",
  ])("waits for the room when the server says %s", (message) => {
    expect(classify(message)).toBe("room-unavailable");
  });

  it.each(["Meeting join was cancelled", "Meeting connection was cancelled"])(
    "keeps retrying when a dropped socket cut a join short: %s",
    (message) => {
      expect(classify(message)).toBe("transient");
    },
  );

  it("tells a draining server apart from a missing room", () => {
    expect(classify("Meeting server is draining. Try again shortly.")).toBe(
      "server-draining",
    );
  });

  it.each([
    "Connection timeout",
    "xhr poll error",
    "websocket error",
    "Failed to fetch",
    "",
  ])("keeps retrying when the server cannot be reached: %s", (message) => {
    expect(classify(message)).toBe("transient");
  });

  it("keeps retrying a join route that answers with a server error", () => {
    expect(classify("Meeting placement is temporarily unavailable.", 503)).toBe(
      "transient",
    );
  });

  it.each([
    ["Guests are not allowed in this meeting.", null],
    ["This meeting has ended.", null],
    ["Forbidden", 403],
    ["No room found.", 404],
  ] as const)("stops on an answer that will not change: %s", (message, status) => {
    expect(classify(message, status)).toBe("final");
  });
});

describe("waiting for a room to come back", () => {
  const plan = (elapsedMs: number, retries: number) =>
    planRoomUnavailableRetry({
      unavailableSince: 1_000,
      now: 1_000 + elapsedMs,
      retries,
    });

  it("backs off quickly and then retries every few seconds", () => {
    expect([0, 1, 2, 3, 4].map((retries) => plan(0, retries))).toEqual([
      { retry: true, delayMs: 1_000 },
      { retry: true, delayMs: 2_000 },
      { retry: true, delayMs: 4_000 },
      { retry: true, delayMs: 4_000 },
      { retry: true, delayMs: 4_000 },
    ]);
  });

  it("gives up once the room has been missing for the whole window", () => {
    expect(plan(ROOM_UNAVAILABLE_RETRY_WINDOW_MS - 1, 12)).toEqual({
      retry: true,
      delayMs: 4_000,
    });
    expect(plan(ROOM_UNAVAILABLE_RETRY_WINDOW_MS, 12)).toEqual({ retry: false });
  });
});

describe("the socket a failed reconnect attempt leaves open", () => {
  it("is kept while a room the join route sent us to comes back", () => {
    expect(
      canReuseSocketAfterFailure({
        failureKind: "room-unavailable",
        usedHeldJoinInfo: false,
      }),
    ).toBe(true);
  });

  it.each(["room-unavailable", "final"] as const)(
    "is replaced through the join route after a %s refusal of the held answer",
    (failureKind) => {
      expect(
        canReuseSocketAfterFailure({ failureKind, usedHeldJoinInfo: true }),
      ).toBe(false);
    },
  );

  it.each([true, false])(
    "is replaced when the server is draining (held answer: %s)",
    (usedHeldJoinInfo) => {
      expect(
        canReuseSocketAfterFailure({
          failureKind: "server-draining",
          usedHeldJoinInfo,
        }),
      ).toBe(false);
    },
  );
});
