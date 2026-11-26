import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_PATH_RECOVERY,
  INITIAL_MEDIA_PATH_WATCH,
  MEDIA_PATH_STALL_MS,
  advanceMediaPathRecovery,
  advanceMediaPathWatch,
  deliveredRtpBytes,
  judgeDeliveryWindow,
  mediaReachedFarEnd,
  pathCarriesWhatIsSent,
  planMediaPathFailure,
  readMediaPathHealth,
  takeDeferredRebuilds,
  type FailedPath,
  type MediaDirection,
  type MediaPathReading,
  type MediaPathRecovery,
  type MediaPathRecoveryEvent,
  type MediaPathWatch,
  type PathEvidence,
  type SendingProducer,
  type SentStream,
  type StreamDelivery,
} from "../src/app/lib/media-path-recovery";
import {
  nextStepAfterScopedRebuild,
  planReconnectSettlement,
  planScopedRebuild,
  type PathProbe,
} from "../src/app/lib/reconnect-request-policy";

const DIRECTIONS = ["producer", "consumer"] as const;
const STREAMS = ["mic", "camera", "screen"] as const satisfies readonly SentStream[];
const SETTLE_ROUNDS = 40;
const SETTLE_STEP_MS = 7_500;
const SAMPLE_GAPS_MS = [2_500, 2_500, 2_500, 5_000, MEDIA_PATH_STALL_MS];
const CHECK_WINDOW_MS = 2_000;
const PACKETS_PER_SECOND = 50;

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
  tornDown: boolean;
  phase: "credentials" | "check" | "rejoin";
  userRetryQueued: boolean;
};

type Weather = {
  cancelsChecks: boolean;
  failsRebuilds: boolean;
  losesReplies: boolean;
};

type Stream = {
  wanted: boolean;
  producerId: string | null;
  sending: boolean;
  arrives: boolean;
  sent: number;
  arrived: number;
  sentSinceWatchStart: number;
  arrivedSinceWatchStart: number;
  sentSinceSample: number;
  samplesInWatch: number;
};

const UNWATCHED = {
  sentSinceWatchStart: 0,
  arrivedSinceWatchStart: 0,
  sentSinceSample: 0,
  samplesInWatch: 0,
};

type Allowed = { proven?: MediaDirection; userRetry?: boolean; reset?: boolean };

class Call {
  recovery: MediaPathRecovery = INITIAL_MEDIA_PATH_RECOVERY;
  transport: Record<MediaDirection, string> = { producer: "send-1", consumer: "recv-1" };
  works: Record<MediaDirection, boolean> = { producer: true, consumer: true };
  streams: Record<(typeof STREAMS)[number], Stream>;
  socketUp = true;
  relayOnly = false;
  repliesDown = false;
  run: Run | null = null;
  abandoned: Served[] = [];
  rebuildStarted: Record<MediaDirection, boolean> = { producer: false, consumer: false };
  knownFailing = new Set<SentStream>();
  held: Record<MediaDirection, { transportId: string; silent: boolean } | null> = {
    producer: null,
    consumer: null,
  };
  trace: string[] = [];
  problems: string[] = [];
  private watches: Record<MediaDirection, MediaPathWatch> = {
    producer: INITIAL_MEDIA_PATH_WATCH,
    consumer: INITIAL_MEDIA_PATH_WATCH,
  };
  private now = 0;
  private received = 0;
  private reachedSinceSample: Record<MediaDirection, number> = { producer: 0, consumer: 0 };
  private reachedInWindow: Record<MediaDirection, number> = { producer: 0, consumer: 0 };
  private receiverReportAt: number | null = null;
  private nextTransport = 2;
  private nextProducer = 1;

  constructor(
    private readonly random: () => number,
    private weather: Weather,
  ) {
    const stream = (wanted: boolean): Stream => ({
      wanted,
      producerId: null,
      sending: true,
      arrives: true,
      sent: 0,
      arrived: 0,
      ...UNWATCHED,
    });
    this.streams = { mic: stream(true), camera: stream(this.chance(0.7)), screen: stream(this.chance(0.3)) };
    this.publishWanted();
  }

  private chance(odds: number) {
    return this.random() < odds;
  }

  private publish(name: (typeof STREAMS)[number]) {
    const stream = this.streams[name];
    if (!stream.wanted || stream.producerId !== null) return;
    Object.assign(stream, {
      producerId: `${name}-${this.nextProducer++}`,
      sent: 0,
      arrived: 0,
      ...UNWATCHED,
    });
  }

  publishWanted() {
    STREAMS.forEach((name) => this.publish(name));
  }

  republish(name: (typeof STREAMS)[number]) {
    this.publish(name);
  }

  toggleWanted(name: (typeof STREAMS)[number]) {
    if (name === "mic") return;
    const stream = this.streams[name];
    stream.wanted = !stream.wanted;
    if (stream.wanted) this.publish(name);
    else stream.producerId = null;
  }

  private startWatch(direction: MediaDirection) {
    this.watches[direction] = INITIAL_MEDIA_PATH_WATCH;
    this.reachedSinceSample[direction] = 0;
    if (direction !== "producer") return;
    for (const name of STREAMS) Object.assign(this.streams[name], UNWATCHED);
  }

  resetWatch(direction: MediaDirection) {
    this.startWatch(direction);
  }

  private pass(ms: number) {
    this.now += ms;
    const packets = Math.round((ms / 1_000) * PACKETS_PER_SECOND);
    let published = false;
    for (const name of STREAMS) {
      const stream = this.streams[name];
      if (stream.producerId === null) continue;
      published = true;
      if (!stream.sending) continue;
      stream.sent += packets;
      stream.sentSinceWatchStart += packets;
      stream.sentSinceSample += packets;
      if (!this.works.producer || !stream.arrives) continue;
      stream.arrived += packets;
      stream.arrivedSinceWatchStart += packets;
    }
    if (published && this.works.producer) {
      this.receiverReportAt = this.now;
      this.reachedSinceSample.producer += packets;
      this.reachedInWindow.producer += packets;
    }
    if (!this.works.consumer) return;
    this.received += packets;
    this.reachedSinceSample.consumer += packets;
    this.reachedInWindow.consumer += packets;
  }

  private published(): SendingProducer[] {
    return STREAMS.flatMap((name) => {
      const { producerId } = this.streams[name];
      return producerId === null ? [] : [{ stream: name, producerId, mid: name }];
    });
  }

  private read(direction: MediaDirection): MediaPathReading {
    if (direction === "consumer") {
      return { direction: "recv", rtpBytes: this.received * 100, receiverReportAt: null, sent: {} };
    }
    const published = this.published();
    return {
      direction: "send",
      rtpBytes: published.reduce((bytes, { stream }) => bytes + this.streams[stream as (typeof STREAMS)[number]].sent * 100, 0),
      receiverReportAt: this.receiverReportAt,
      sent: Object.fromEntries(
        published.map(({ stream, mid }) => [
          mid,
          { packetsSent: this.streams[stream as (typeof STREAMS)[number]].sent, receiverReportAt: null },
        ]),
      ),
    };
  }

  private counts(): Record<string, number> | null {
    if (this.repliesDown || (this.weather.losesReplies && this.chance(0.2))) return null;
    return Object.fromEntries(
      this.published().map(({ stream, producerId }) => [
        producerId,
        this.streams[stream as (typeof STREAMS)[number]].arrived,
      ]),
    );
  }

  private forget(direction: MediaDirection) {
    this.rebuildStarted[direction] = false;
    this.held[direction] = null;
    if (this.run?.serves?.direction === direction) this.run.countsAsRebuild = false;
  }

  private commit(next: MediaPathRecovery, at: string, allowed: Allowed = {}) {
    const before = this.recovery;
    this.recovery = next;
    for (const direction of DIRECTIONS) {
      const proven = allowed.proven === direction || allowed.reset === true;
      if (before[direction].health === "blocked" && next[direction].health !== "blocked" && !proven) {
        this.problems.push(`${at}: ${direction} left blocked with no proof and no new call`);
      }
      if (
        before[direction].rebuildTried &&
        !next[direction].rebuildTried &&
        !proven &&
        allowed.userRetry !== true
      ) {
        this.problems.push(`${at}: ${direction} got its rebuild back with no proof and no Try again`);
      }
    }
  }

  private apply(event: Exclude<MediaPathRecoveryEvent, { type: "path-sampled" }>) {
    const next = advanceMediaPathRecovery(this.recovery, event);
    if (event.type === "user-retry" || event.type === "reset") {
      DIRECTIONS.forEach((direction) => this.forget(direction));
      this.knownFailing.clear();
    }
    this.commit(next, event.type, {
      userRetry: event.type === "user-retry",
      reset: event.type === "reset",
    });
  }

  private observe(direction: MediaDirection, evidence: PathEvidence, at: string, exact: boolean) {
    const reached = exact ? this.reachedInWindow : this.reachedSinceSample;
    if (evidence.reached && reached[direction] === 0) {
      this.problems.push(`${at}: ${direction} was seen reaching the far end with the path down throughout`);
    }
    reached[direction] = 0;
    const failingBefore = new Set(this.knownFailing);
    const judged = Object.entries(evidence.streams) as Array<[(typeof STREAMS)[number], StreamDelivery]>;
    for (const [name, delivery] of judged) {
      const stream = this.streams[name];
      if (!exact) {
        if (stream.samplesInWatch === 0 && delivery !== "unconfirmed") {
          this.problems.push(`${at}: ${name} judged ${delivery} on the first sample of its watch`);
        }
        if (delivery === "delivered" && stream.arrivedSinceWatchStart === 0) {
          this.problems.push(`${at}: ${name} judged delivered with nothing arrived since its watch began`);
        }
        if (
          delivery === "undelivered" &&
          stream.sentSinceWatchStart === stream.arrivedSinceWatchStart
        ) {
          this.problems.push(`${at}: ${name} judged undelivered with nothing lost since its watch began`);
        }
        if (delivery === "quiet" && stream.sentSinceSample > 0) {
          this.problems.push(`${at}: ${name} judged quiet over a sample in which it sent`);
        }
        stream.samplesInWatch += 1;
        stream.sentSinceSample = 0;
      }
      if (delivery === "undelivered") this.knownFailing.add(name);
      if (delivery === "delivered") this.knownFailing.delete(name);
    }
    const proven =
      evidence.reached &&
      (direction === "consumer" || this.knownFailing.size === 0) &&
      judged.every(
        ([name, delivery]) =>
          delivery === "delivered" || (delivery === "quiet" && !failingBefore.has(name)),
      );
    if (proven) this.forget(direction);
    this.commit(
      advanceMediaPathRecovery(this.recovery, { type: "path-sampled", direction, evidence }),
      at,
      proven ? { proven: direction } : {},
    );
  }

  private window(direction: MediaDirection, at: string): { evidence: PathEvidence; carried: boolean } {
    this.reachedInWindow[direction] = 0;
    const start = this.read(direction);
    const sfuStart = direction === "producer" ? this.counts() : null;
    this.pass(CHECK_WINDOW_MS);
    const end = this.read(direction);
    const sfuEnd = direction === "producer" ? this.counts() : null;
    const producers = direction === "producer" ? this.published() : [];
    const evidence: PathEvidence =
      direction === "consumer"
        ? { reached: deliveredRtpBytes(start, end) > 0, streams: {} }
        : {
            reached: mediaReachedFarEnd(start, end, false),
            streams: judgeDeliveryWindow({ start, end, producers, sfuStart, sfuEnd, sfuReports: true }),
          };
    const worlds = producers.map(({ stream }) => ({
      stream,
      world: this.streams[stream as (typeof STREAMS)[number]],
    }));
    const answered = direction === "consumer" || (sfuStart !== null && sfuEnd !== null);
    for (const { stream, world } of worlds) {
      const expected: StreamDelivery = !answered
        ? "unconfirmed"
        : !world.sending
          ? "quiet"
          : world.arrives && this.works.producer
            ? "delivered"
            : "undelivered";
      if (evidence.streams[stream] !== expected) {
        this.problems.push(
          `${at}: ${stream} judged ${evidence.streams[stream]} over a window that was ${expected}`,
        );
      }
    }
    const carried = pathCarriesWhatIsSent(evidence, this.recovery[direction].failingStreams);
    const shouldCarry =
      this.works[direction] &&
      answered &&
      (direction === "consumer" || worlds.some(({ world }) => world.sending)) &&
      worlds.every(({ stream, world }) =>
        world.sending ? world.arrives : !this.knownFailing.has(stream),
      );
    if (carried !== shouldCarry) {
      this.problems.push(
        `${at}: the path was taken as ${carried ? "carrying" : "not carrying"} what is sent when it was ${shouldCarry ? "" : "not "}carrying it`,
      );
    }
    return { evidence, carried };
  }

  private replace(direction: MediaDirection) {
    this.held[direction] = null;
    this.transport[direction] = `${direction === "producer" ? "send" : "recv"}-${this.nextTransport++}`;
    this.startWatch(direction);
    if (direction === "producer") STREAMS.forEach((name) => (this.streams[name].producerId = null));
  }

  failingNow(direction: MediaDirection): boolean {
    if (!this.works[direction]) return true;
    return (
      direction === "producer" &&
      STREAMS.some((name) => {
        const stream = this.streams[name];
        return stream.producerId !== null && stream.sending && !stream.arrives;
      })
    );
  }

  report(direction: MediaDirection, silentWhileConnected: boolean) {
    this.escalate(direction, {
      transportId: this.transport[direction],
      reason: silentWhileConnected ? "carried no media" : "could not connect",
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
    this.commit(recovery, `${direction} failure`);
    this.trace.push(`${direction}:${step}`);
    if (step === "report-blocked") {
      if (!wasBlocked && !this.rebuildStarted[direction]) {
        this.problems.push(`${direction} reported blocked before any rebuild started`);
      }
      this.held[direction] = null;
      return;
    }
    if (step === "wait-for-reconnect") {
      const held = this.held[direction];
      this.held[direction] = {
        transportId: path.transportId,
        silent:
          path.silentWhileConnected ||
          (held?.transportId === path.transportId && held.silent),
      };
      return;
    }
    if (step === "already-escalated") return;
    if (this.run) {
      this.problems.push(`${direction} asked for a rebuild while a run was in flight`);
      return;
    }
    if (step === "reconnect-relay-only") this.relayOnly = true;
    this.run = {
      serves: { direction, transportId: path.transportId },
      countsAsRebuild: true,
      tornDown: false,
      phase: "credentials",
      userRetryQueued: false,
    };
  }

  watch(direction: MediaDirection, gapMs: number) {
    if (this.recovery[direction].escalation !== null) {
      this.startWatch(direction);
      return;
    }
    this.pass(gapMs);
    const result = advanceMediaPathWatch(this.watches[direction], {
      ...this.read(direction),
      at: this.now,
      connectionState: "connected",
      expectsMedia: direction === "consumer" || this.published().length > 0,
      framesOptional: false,
      sending:
        direction === "producer"
          ? { producers: this.published(), sfuCounts: this.counts(), sfuReports: true }
          : undefined,
      knownFailing: this.recovery[direction].failingStreams,
    });
    const firstSample = this.watches[direction].lastReading === null;
    this.watches[direction] = result.watch;
    this.observe(direction, result.evidence, `${direction} sample`, false);
    const sendsKnownFailure = this.published().some(({ stream }) => this.knownFailing.has(stream));
    if (direction === "producer" && !firstSample && sendsKnownFailure && result.condition === "flowing") {
      this.problems.push("producer sample: a stream known to be failing is being sent and the path reads as flowing");
    }
    if (result.stalledForMs < MEDIA_PATH_STALL_MS || this.run) return;
    this.startWatch(direction);
    this.apply({ type: "trouble", direction });
    const at = `${direction} check after an ICE restart`;
    const { evidence, carried } = this.window(direction, at);
    this.observe(direction, evidence, at, true);
    if (!carried) this.report(direction, true);
  }

  startRejoin({ userRetry }: { userRetry: boolean }) {
    if (this.run) {
      if (userRetry) this.run.userRetryQueued = true;
      return;
    }
    if (userRetry) this.retryNow();
    this.run = {
      serves: null,
      countsAsRebuild: false,
      tornDown: false,
      phase: "rejoin",
      userRetryQueued: false,
    };
  }

  private retryNow() {
    this.apply({ type: "user-retry" });
    this.relayOnly = false;
  }

  private startRebuild(run: Run) {
    if (!run.serves) return;
    const { direction } = run.serves;
    if (run.countsAsRebuild && !run.tornDown) {
      if (this.rebuildStarted[direction]) {
        this.problems.push(`${direction} was torn down again with no proof since its last rebuild`);
      }
      this.rebuildStarted[direction] = true;
      run.tornDown = true;
    }
    this.apply({ type: "rebuild-started", ...run.serves });
  }

  private finish(run: Run, { rejoined }: { rejoined: boolean }) {
    if (run.serves) this.apply({ type: "escalation-settled", ...run.serves });
    this.run = null;
    const taken = takeDeferredRebuilds(this.recovery);
    this.commit(taken.recovery, "a settled run");
    for (const direction of DIRECTIONS) {
      const held = this.held[direction];
      this.held[direction] = null;
      if (
        held &&
        !taken.deferred.some(
          (path) => path.direction === direction && path.transportId === held.transportId,
        )
      ) {
        this.problems.push(`a settled run found no rebuild held for ${direction} ${held.transportId}`);
      }
    }
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
      const cancelled = !failedPathChanged && this.weather.cancelsChecks && this.chance(0.2);
      const at = `${direction} check before a rebuild`;
      const checked = failedPathChanged || cancelled ? null : this.window(direction, at);
      const probe: PathProbe = cancelled ? "cancelled" : checked?.carried ? "carrying" : "not-carrying";
      if (checked) this.observe(direction, checked.evidence, at, true);
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
    this.publishWanted();
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
    this.publishWanted();
  }

  settleAbandoned() {
    const served = this.abandoned.shift();
    if (served) this.apply({ type: "escalation-settled", ...served });
  }

  connect(direction: MediaDirection) {
    if (this.held[direction]?.silent === false) this.held[direction] = null;
    this.apply({ type: "transport-connected", direction, transportId: this.transport[direction] });
  }

  calm() {
    this.weather = { cancelsChecks: false, failsRebuilds: false, losesReplies: false };
    this.socketUp = true;
    this.repliesDown = false;
    for (const name of STREAMS) {
      const stream = this.streams[name];
      stream.sending = true;
      if (this.knownFailing.has(name)) stream.wanted = true;
    }
  }

  expected(direction: MediaDirection) {
    return this.failingNow(direction) ? "blocked" : "healthy";
  }

  check(at: string) {
    const failing = [...this.recovery.producer.failingStreams].sort().join(",");
    const known = [...this.knownFailing].sort().join(",");
    if (failing !== known) {
      this.problems.push(`${at}: the record names [${failing}] failing but [${known}] were seen failing and not arriving since`);
    }
    if (this.recovery.consumer.failingStreams.length > 0) {
      this.problems.push(`${at}: the receive path names sent streams`);
    }
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

const ACTIONS = [
  "stall", "stall", "resume", "watch", "watch", "watch", "watch", "watch", "step", "step", "step", "step",
  "handler-report", "late-report", "connect", "socket-drop", "user-retry", "leave", "abandoned-settle",
  "drop-stream", "drop-stream", "heal-stream", "quiet-stream", "quiet-stream", "wake-stream",
  "toggle-stream", "republish", "republish", "lose-replies", "answer-replies", "watch-reset",
] as const;

const playSeed = (seed: number): string | null => {
  const random = mulberry32(seed);
  const pick = <T,>(values: readonly T[]) => values[Math.floor(random() * values.length)];
  const call = new Call(random, { cancelsChecks: true, failsRebuilds: true, losesReplies: true });
  const steps = 10 + Math.floor(random() * 70);
  for (let index = 0; index < steps; index++) {
    const direction = pick(DIRECTIONS);
    const stream = pick(STREAMS);
    const action = pick(ACTIONS);
    call.trace.push(`${action}:${direction}:${stream}`);
    if (action === "stall") call.works[direction] = false;
    else if (action === "resume") call.works[direction] = true;
    else if (action === "watch") call.watch(direction, pick(SAMPLE_GAPS_MS));
    else if (action === "step") call.step();
    else if (action === "handler-report") {
      if (!call.works[direction]) call.report(direction, false);
    } else if (action === "late-report") {
      if (call.failingNow(direction) && call.run) call.report(direction, true);
    } else if (action === "connect") call.connect(direction);
    else if (action === "socket-drop") {
      call.socketUp = false;
      call.startRejoin({ userRetry: false });
    } else if (action === "user-retry") call.startRejoin({ userRetry: true });
    else if (action === "leave") call.leaveAndJoinAgain();
    else if (action === "abandoned-settle") call.settleAbandoned();
    else if (action === "drop-stream") call.streams[stream].arrives = false;
    else if (action === "heal-stream") call.streams[stream].arrives = true;
    else if (action === "quiet-stream") call.streams[stream].sending = false;
    else if (action === "wake-stream") call.streams[stream].sending = true;
    else if (action === "toggle-stream") call.toggleWanted(stream);
    else if (action === "republish") call.republish(stream);
    else if (action === "lose-replies") call.repliesDown = true;
    else if (action === "answer-replies") call.repliesDown = false;
    else call.resetWatch(direction);
    call.check(`step ${index} ${action}`);
  }

  call.calm();
  const settled = () =>
    call.run === null &&
    DIRECTIONS.every(
      (direction) => readMediaPathHealth(call.recovery)[direction] === call.expected(direction),
    );
  let rounds = 0;
  while (rounds < SETTLE_ROUNDS && !settled()) {
    rounds += 1;
    call.settleAbandoned();
    call.step();
    call.publishWanted();
    DIRECTIONS.forEach((direction) => call.watch(direction, SETTLE_STEP_MS));
    call.check(`settling round ${rounds}`);
  }
  if (!settled()) {
    call.problems.push(
      `not settled after ${SETTLE_ROUNDS} rounds: wanted ${DIRECTIONS.map((direction) => `${direction} ${call.expected(direction)}`).join(", ")}, recovery ${JSON.stringify(call.recovery)}`,
    );
  }
  return call.problems.length > 0
    ? `seed ${seed}: ${[...new Set(call.problems)].slice(0, 3).join("; ")} | ${call.trace.slice(-30).join(" ")}`
    : null;
};

describe("media path recovery under random interleavings", () => {
  it("rebuilds once, clears only on proof, reports blocked within a bound, and never disagrees with what happened", () => {
    const [first, last] = process.env.RECOVERY_MODEL_EXTENDED ? [5_001, 205_000] : [1, 5_000];
    const failed: string[] = [];
    for (let seed = first; seed <= last && failed.length < 5; seed++) {
      const failure = playSeed(seed);
      if (failure) failed.push(failure);
    }
    expect(failed).toEqual([]);
  });
});
