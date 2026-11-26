import { describe, expect, it } from "vitest";
import {
  ROOM_UNAVAILABLE_RETRY_WINDOW_MS,
  canReuseSocketAfterFailure,
  classifyReconnectFailure,
  planMediaRebuildScope,
  planReconnectSettlement,
  FRESH_ROOM_WAIT,
  USER_RETRY_REQUEST,
  freshReconnectAttemptState,
  noteRoomUnavailable,
  restartForUserRetry,
  type ReconnectAttemptState,
  planRoomUnavailableRetry,
  resolveInFlightReconnectRequest,
  resolveReconnectStartAttempts,
  nextStepAfterScopedRebuild,
  planScopedRebuild,
  type PathProbe,
} from "../src/app/lib/reconnect-request-policy";
import {
  INITIAL_MEDIA_PATH_RECOVERY,
  advanceMediaPathRecovery,
  planMediaPathFailure,
  type MediaPathFailure,
} from "../src/app/lib/media-path-recovery";

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

  it.each([
    "Meeting invite code required.",
    "Invalid meeting invite code.",
    "Webinar invite code required.",
    "Invalid webinar invite code.",
  ])("asks the user for the code when the server says %s", (message) => {
    expect(classify(message)).toBe("invite-code-required");
  });

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

describe("the room wait of one reconnect run", () => {
  const T0 = 1_000;
  const waitedFor = (elapsedMs: number) => {
    let wait = FRESH_ROOM_WAIT;
    for (let at = 0; at <= elapsedMs; at += 4_000) {
      wait = noteRoomUnavailable(wait, T0 + at).wait;
    }
    return wait;
  };

  it("gives up once the room has been missing for the whole window", () => {
    const wait = waitedFor(56_000);
    const next = noteRoomUnavailable(wait, T0 + ROOM_UNAVAILABLE_RETRY_WINDOW_MS);

    expect(next.plan).toEqual({ retry: false });
    expect(next.wait.expired).toBe(true);
  });

  it("starts a whole new window when the user retries near the deadline", () => {
    waitedFor(56_000);
    const retriedAt = T0 + 57_000;
    const afterRetry = noteRoomUnavailable(FRESH_ROOM_WAIT, retriedAt);

    expect(afterRetry.plan).toEqual({ retry: true, delayMs: 1_000 });
    expect(
      noteRoomUnavailable(afterRetry.wait, retriedAt + ROOM_UNAVAILABLE_RETRY_WINDOW_MS - 1).plan
        .retry,
    ).toBe(true);
  });

  it("counts its retries for the backoff", () => {
    let wait = FRESH_ROOM_WAIT;
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = noteRoomUnavailable(wait, T0 + i * 1_000);
      if (next.plan.retry) delays.push(next.plan.delayMs);
      wait = next.wait;
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 4_000]);
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

describe("how much a media failure rebuilds", () => {
  it("rebuilds only the failed direction while signaling is up", () => {
    expect(
      planMediaRebuildScope({ failedDirections: ["consumer"] }, { socketConnected: true }),
    ).toBe("consumer");
    expect(
      planMediaRebuildScope({ failedDirections: ["producer"] }, { socketConnected: true }),
    ).toBe("producer");
  });

  it("rejoins when both directions failed", () => {
    expect(
      planMediaRebuildScope(
        { failedDirections: ["producer", "consumer"] },
        { socketConnected: true },
      ),
    ).toBeNull();
  });

  it("rejoins when signaling is down or the request is not about one direction", () => {
    expect(
      planMediaRebuildScope({ failedDirections: ["consumer"] }, { socketConnected: false }),
    ).toBeNull();
    expect(planMediaRebuildScope({ refreshIceServers: true }, { socketConnected: true })).toBeNull();
    expect(planMediaRebuildScope(undefined, { socketConnected: true })).toBeNull();
  });
});

describe("a reconnect run that is ending", () => {
  it("runs a Try again that was queued behind a one-direction rebuild that worked", () => {
    expect(
      planReconnectSettlement({ rejoined: true, userRetryQueued: true, leaving: false }),
    ).toEqual({ runUserRetry: true, replayDeferredRebuilds: false });
  });

  it("runs a queued Try again after a run that stopped without rejoining", () => {
    expect(
      planReconnectSettlement({ rejoined: false, userRetryQueued: true, leaving: false }),
    ).toEqual({ runUserRetry: true, replayDeferredRebuilds: false });
  });

  it("replays rebuilds held for the rejoin when nothing was queued", () => {
    expect(
      planReconnectSettlement({ rejoined: true, userRetryQueued: false, leaving: false }),
    ).toEqual({ runUserRetry: false, replayDeferredRebuilds: true });
  });

  it("drops everything when the user is leaving", () => {
    expect(
      planReconnectSettlement({ rejoined: true, userRetryQueued: true, leaving: true }),
    ).toEqual({ runUserRetry: false, replayDeferredRebuilds: false });
  });
});

describe("the recovery a Retry starts fresh", () => {
  const userRetry = freshReconnectAttemptState(USER_RETRY_REQUEST);
  const dirty: ReconnectAttemptState = {
    roomWait: { since: 5_000, retries: 7, expired: true },
    retryingForRoom: true,
    skipNextDelay: false,
    nextDelayOverrideMs: 4_000,
    refreshIceServers: false,
    heldJoinInfoTried: false,
    mayReuseSocket: false,
    lastError: new Error("joinRoom acknowledgement timeout"),
    relayOnlyRequest: { reason: "Consumer transport carried no media" },
  };
  const receiveFailure = (transportId: string, relayOnly: boolean): MediaPathFailure => ({
    direction: "consumer",
    transportId,
    reason: "Consumer transport carried no media",
    failingProducers: [],
    silentWhileConnected: true,
    relayOnly,
    reconnectInFlight: false,
  });
  const asked = planMediaPathFailure(INITIAL_MEDIA_PATH_RECOVERY, receiveFailure("t1", false));
  const rebuiltOnce = {
    step: asked.step,
    recovery: advanceMediaPathRecovery(asked.recovery, {
      type: "rebuild-started",
      direction: "consumer",
      transportId: "t1",
    }),
  };

  it("uses a fixture that differs from a fresh Retry in every per-attempt field", () => {
    expect(Object.keys(dirty).sort()).toEqual(Object.keys(userRetry).sort());
    for (const key of Object.keys(userRetry) as Array<keyof ReconnectAttemptState>) {
      expect(dirty[key], key).not.toEqual(userRetry[key]);
    }
  });

  it("keeps nothing of the run it interrupts", () => {
    const restarted = restartForUserRetry({
      attempt: dirty,
      attempts: 6,
      relayOnly: true,
      mediaPaths: rebuiltOnce.recovery,
    });

    expect(restarted).toEqual({
      attempt: userRetry,
      attempts: 0,
      relayOnly: false,
      mediaPaths: advanceMediaPathRecovery(rebuiltOnce.recovery, { type: "user-retry" }),
    });
  });

  it("starts what Try again starts when nothing is running", () => {
    expect(
      restartForUserRetry({
        attempt: freshReconnectAttemptState(),
        attempts: 0,
        relayOnly: false,
        mediaPaths: INITIAL_MEDIA_PATH_RECOVERY,
      }).attempt,
    ).toEqual(userRetry);
  });

  it("gives the next transport failure the relay ladder after a Retry queued behind a failed rebuild and a room wait", () => {
    expect(rebuiltOnce.step).toBe("reconnect-relay-only");
    const scoped = freshReconnectAttemptState({
      refreshIceServers: true,
      failedDirections: ["consumer"],
      relayOnly: { reason: "Consumer transport carried no media" },
    });
    const waitingForRoom: ReconnectAttemptState = {
      ...scoped,
      refreshIceServers: false,
      roomWait: noteRoomUnavailable(scoped.roomWait, 1_000).wait,
      retryingForRoom: true,
    };

    const queuedRetry = restartForUserRetry({
      attempt: waitingForRoom,
      attempts: 2,
      relayOnly: true,
      mediaPaths: rebuiltOnce.recovery,
    });

    expect(
      planMediaPathFailure(queuedRetry.mediaPaths, receiveFailure("t3", queuedRetry.relayOnly)).step,
    ).toBe("reconnect-relay-only");
    expect(planMediaPathFailure(rebuiltOnce.recovery, receiveFailure("t3", true)).step).toBe(
      "report-blocked",
    );
  });
});

describe("what a reconnect run does once its check of the failed path ends", () => {
  it.each<[PathProbe, boolean, string]>([
    ["cancelled", false, "rejoin-after-cancelled-check"],
    ["cancelled", true, "rejoin-after-cancelled-check"],
    ["carrying", false, "keep-proven-path"],
    ["carrying", true, "keep-replaced-path"],
    ["not-carrying", true, "keep-replaced-path"],
    ["not-carrying", false, "rebuild"],
  ])("after a %s check with the failed path replaced %s it will %s", (probe, failedPathChanged, plan) => {
    expect(planScopedRebuild({ probe, failedPathChanged })).toBe(plan);
  });
});

describe("what a reconnect run does after a one-direction rebuild step", () => {
  it.each<["rebuilt" | "stale" | "failed", boolean, string]>([
    ["rebuilt", true, "settle-recovered"],
    ["rebuilt", false, "settle-recovered"],
    ["stale", true, "settle-unchanged"],
    ["stale", false, "rejoin"],
    ["failed", true, "rejoin"],
    ["failed", false, "rejoin"],
  ])("after %s with signaling connected %s it will %s", (outcome, socketConnected, next) => {
    expect(nextStepAfterScopedRebuild(outcome, { socketConnected })).toBe(next);
  });
});
