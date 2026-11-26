import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_PATH_RECOVERY,
  advanceMediaPathRecovery,
  planMediaPathFailure,
  readMediaPathHealth,
  takeDeferredRebuilds,
  type FailedPath,
  type MediaDirection,
  type MediaPathRecovery,
  type MediaPathRecoveryEvent,
} from "../src/app/lib/media-path-recovery";
import {
  nextStepAfterScopedRebuild,
  planReconnectSettlement,
  planScopedRebuild,
  type PathProbe,
} from "../src/app/lib/reconnect-request-policy";

const DIRECTIONS = ["producer", "consumer"] as const;
const PRODUCERS = ["mic", "camera", "screen"];
const SETTLE_ROUNDS = 30;

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

type Served = { direction: MediaDirection; transportId: string };

type Run = {
  serves: Served | null;
  countsAsRebuild: boolean;
  phase: "credentials" | "check" | "rejoin";
  userRetryQueued: boolean;
};

type Weather = {
  cancelsChecks: boolean;
  failsRebuilds: boolean;
};

class Call {
  recovery: MediaPathRecovery = INITIAL_MEDIA_PATH_RECOVERY;
  transport: Record<MediaDirection, string> = { producer: "send-1", consumer: "recv-1" };
  works: Record<MediaDirection, boolean> = { producer: true, consumer: true };
  socketUp = true;
  relayOnly = false;
  run: Run | null = null;
  abandoned: Served[] = [];
  rebuildStarted: Record<MediaDirection, boolean> = { producer: false, consumer: false };
  reported: Record<MediaDirection, { transportId: string; producers: Set<string> } | null> = {
    producer: null,
    consumer: null,
  };
  trace: string[] = [];
  problems: string[] = [];
  private nextTransport = 2;

  constructor(
    private readonly random: () => number,
    private weather: Weather,
  ) {}

  private chance(odds: number) {
    return this.random() < odds;
  }

  private forget(direction: MediaDirection) {
    this.rebuildStarted[direction] = false;
    this.reported[direction] = null;
    if (this.run?.serves?.direction === direction) this.run.countsAsRebuild = false;
  }

  private apply(event: MediaPathRecoveryEvent) {
    this.recovery = advanceMediaPathRecovery(this.recovery, event);
    if (event.type === "media-flowing") this.forget(event.direction);
    if (event.type === "user-retry" || event.type === "reset") DIRECTIONS.forEach((d) => this.forget(d));
  }

  private replace(direction: MediaDirection) {
    this.transport[direction] = `${direction === "producer" ? "send" : "recv"}-${this.nextTransport++}`;
    this.reported[direction] = null;
  }

  private note(direction: MediaDirection, path: FailedPath) {
    const known = this.reported[direction];
    const producers = known?.transportId === path.transportId ? known.producers : new Set<string>();
    path.failingProducers.forEach((producerId) => producers.add(producerId));
    this.reported[direction] = { transportId: path.transportId, producers };
  }

  private owes(direction: MediaDirection, transportId: string, path: FailedPath | null, at: string) {
    const known = this.reported[direction];
    if (known?.transportId !== transportId) return;
    const kept = path?.transportId === transportId ? path.failingProducers : [];
    const missing = [...known.producers].filter((id) => !kept.includes(id));
    if (missing.length > 0) this.problems.push(`${at} forgot ${direction} producers ${missing.join(",")}`);
  }

  report(direction: MediaDirection, silentWhileConnected: boolean) {
    this.escalate(direction, {
      transportId: this.transport[direction],
      reason: silentWhileConnected ? "carried no media" : "could not connect",
      failingProducers:
        silentWhileConnected && direction === "producer"
          ? PRODUCERS.filter(() => this.chance(0.4))
          : [],
      silentWhileConnected,
    });
  }

  private escalate(direction: MediaDirection, path: FailedPath) {
    const wasBlocked = readMediaPathHealth(this.recovery)[direction] === "blocked";
    const { step, recovery } = planMediaPathFailure(this.recovery, {
      ...path,
      direction,
      relayOnly: this.relayOnly,
      reconnectInFlight: this.run !== null,
    });
    this.recovery = recovery;
    this.trace.push(`${direction}:${step}`);
    if (step === "report-blocked") {
      if (!wasBlocked && !this.rebuildStarted[direction]) {
        this.problems.push(`${direction} reported blocked before any rebuild started`);
      }
      return;
    }
    this.note(direction, path);
    if (step === "already-escalated" || step === "wait-for-reconnect") return;
    if (this.run) {
      this.problems.push(`${direction} asked for a rebuild while a run was in flight`);
      return;
    }
    if (step === "reconnect-relay-only") this.relayOnly = true;
    this.run = {
      serves: { direction, transportId: path.transportId },
      countsAsRebuild: true,
      phase: "credentials",
      userRetryQueued: false,
    };
  }

  watch(direction: MediaDirection) {
    if (this.recovery[direction].escalation !== null) return;
    if (this.works[direction]) {
      this.apply({ type: "media-flowing", direction });
      return;
    }
    if (this.run) return;
    this.apply({ type: "trouble", direction });
    this.report(direction, true);
  }

  startRejoin({ userRetry }: { userRetry: boolean }) {
    if (this.run) {
      if (userRetry) this.run.userRetryQueued = true;
      return;
    }
    if (userRetry) this.retryNow();
    this.run = { serves: null, countsAsRebuild: false, phase: "rejoin", userRetryQueued: false };
  }

  private retryNow() {
    this.apply({ type: "user-retry" });
    this.relayOnly = false;
  }

  private startRebuild(run: Run) {
    if (!run.serves) return;
    if (run.countsAsRebuild) this.rebuildStarted[run.serves.direction] = true;
    this.apply({ type: "rebuild-started", ...run.serves });
  }

  private finish(run: Run, { rejoined }: { rejoined: boolean }) {
    if (run.serves) this.apply({ type: "escalation-settled", ...run.serves });
    this.run = null;
    const taken = takeDeferredRebuilds(this.recovery);
    this.recovery = taken.recovery;
    const settlement = planReconnectSettlement({
      rejoined,
      userRetryQueued: run.userRetryQueued,
      leaving: false,
    });
    if (settlement.runUserRetry) {
      this.startRejoin({ userRetry: true });
      return;
    }
    if (!settlement.replayDeferredRebuilds) return;
    for (const { direction, ...path } of taken.deferred) {
      if (path.transportId !== this.transport[direction]) continue;
      this.owes(direction, path.transportId, path, "a replayed rebuild");
      this.escalate(direction, path);
    }
  }

  step() {
    const run = this.run;
    if (!run) return;
    this.trace.push(`run:${run.phase}`);
    if (run.phase === "credentials") {
      run.phase = run.serves && this.socketUp ? "check" : "rejoin";
      return;
    }
    if (run.phase === "check" && run.serves) {
      const { direction, transportId } = run.serves;
      const failedPathChanged = this.transport[direction] !== transportId;
      const held = this.recovery[direction].escalation;
      const probe: PathProbe = failedPathChanged
        ? "not-carrying"
        : this.weather.cancelsChecks && this.chance(0.2)
          ? "cancelled"
          : this.works[direction]
            ? "carrying"
            : "not-carrying";
      this.owes(direction, transportId, held, "the check before a rebuild");
      const plan = planScopedRebuild({ probe, failedPathChanged });
      if (plan === "rejoin-after-cancelled-check") {
        run.phase = "rejoin";
        return;
      }
      if (plan === "rebuild") {
        if (!this.socketUp) {
          run.phase = "rejoin";
          return;
        }
        this.startRebuild(run);
        this.replace(direction);
        if (this.weather.failsRebuilds && this.chance(0.3)) {
          run.phase = "rejoin";
          return;
        }
        this.finish(run, { rejoined: true });
        return;
      }
      if (plan === "keep-proven-path") this.apply({ type: "media-flowing", direction });
      if (nextStepAfterScopedRebuild("stale", { socketConnected: this.socketUp }) === "rejoin") {
        run.phase = "rejoin";
        return;
      }
      this.finish(run, { rejoined: true });
      return;
    }
    if (run.userRetryQueued) {
      run.userRetryQueued = false;
      this.retryNow();
      return;
    }
    this.startRebuild(run);
    DIRECTIONS.forEach((direction) => this.replace(direction));
    this.socketUp = true;
    this.finish(run, { rejoined: !(this.weather.failsRebuilds && this.chance(0.2)) });
  }

  leaveAndJoinAgain() {
    if (this.run?.serves) this.abandoned.push(this.run.serves);
    this.run = null;
    this.apply({ type: "reset" });
    this.relayOnly = false;
    this.socketUp = true;
    DIRECTIONS.forEach((direction) => this.replace(direction));
  }

  settleAbandoned() {
    const served = this.abandoned.shift();
    if (served) this.apply({ type: "escalation-settled", ...served });
  }

  connect(direction: MediaDirection) {
    this.apply({ type: "transport-connected", direction, transportId: this.transport[direction] });
  }

  calm() {
    this.weather = { cancelsChecks: false, failsRebuilds: false };
    this.socketUp = true;
  }

  check(at: string) {
    for (const direction of DIRECTIONS) {
      const { escalation, rebuildTried, health, deferredRebuild } = this.recovery[direction];
      const serving = this.run?.serves;
      if (
        escalation &&
        (serving?.direction !== direction || serving.transportId !== escalation.transportId)
      ) {
        this.problems.push(`${at}: ${direction} handles ${escalation.transportId} with no run for it`);
      }
      if (rebuildTried !== this.rebuildStarted[direction]) {
        this.problems.push(
          `${at}: ${direction} rebuildTried is ${rebuildTried} but a rebuild ${this.rebuildStarted[direction] ? "started" : "never started"}`,
        );
      }
      if (health === "healthy" && (escalation || rebuildTried || deferredRebuild)) {
        this.problems.push(`${at}: ${direction} is healthy with recovery left over`);
      }
      if (deferredRebuild && !this.run) {
        this.problems.push(`${at}: ${direction} holds a rebuild with nothing in flight`);
      }
    }
  }
}

const playSeed = (seed: number): string | null => {
  const random = mulberry32(seed);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const call = new Call(random, { cancelsChecks: true, failsRebuilds: true });
  const steps = 10 + Math.floor(random() * 50);
  for (let index = 0; index < steps; index++) {
    const direction = pick(DIRECTIONS);
    const action = pick([
      "stall", "stall", "resume", "watch", "watch", "watch", "step", "step", "step", "step",
      "handler-report", "late-report", "connect", "socket-drop", "user-retry", "leave",
      "abandoned-settle",
    ] as const);
    call.trace.push(`${action}:${direction}`);
    if (action === "stall") call.works[direction] = false;
    else if (action === "resume") call.works[direction] = true;
    else if (action === "watch") call.watch(direction);
    else if (action === "step") call.step();
    else if (action === "handler-report") {
      if (!call.works[direction]) call.report(direction, false);
    } else if (action === "late-report") {
      if (!call.works[direction] && call.run) call.report(direction, true);
    } else if (action === "connect") call.connect(direction);
    else if (action === "socket-drop") {
      call.socketUp = false;
      call.startRejoin({ userRetry: false });
    } else if (action === "user-retry") call.startRejoin({ userRetry: true });
    else if (action === "leave") call.leaveAndJoinAgain();
    else call.settleAbandoned();
    call.check(`step ${index} ${action}`);
  }

  call.calm();
  const settled = () =>
    call.run === null &&
    DIRECTIONS.every(
      (direction) =>
        readMediaPathHealth(call.recovery)[direction] ===
        (call.works[direction] ? "healthy" : "blocked"),
    );
  let rounds = 0;
  while (rounds < SETTLE_ROUNDS && !settled()) {
    rounds += 1;
    call.settleAbandoned();
    call.step();
    DIRECTIONS.forEach((direction) => call.watch(direction));
    call.check(`settling round ${rounds}`);
  }
  if (!settled()) {
    call.problems.push(
      `not settled after ${SETTLE_ROUNDS} rounds: works ${JSON.stringify(call.works)}, recovery ${JSON.stringify(call.recovery)}`,
    );
  }
  return call.problems.length > 0
    ? `seed ${seed}: ${[...new Set(call.problems)].slice(0, 3).join("; ")} | ${call.trace.slice(-30).join(" ")}`
    : null;
};

describe("media path recovery under random interleavings", () => {
  it("rebuilds, recovers on proof or reports blocked within a bound, and never disagrees with what happened", () => {
    const [first, last] = process.env.RECOVERY_MODEL_EXTENDED ? [5_001, 205_000] : [1, 5_000];
    const failed: string[] = [];
    for (let seed = first; seed <= last && failed.length < 5; seed++) {
      const failure = playSeed(seed);
      if (failure) failed.push(failure);
    }
    expect(failed).toEqual([]);
  });
});
