import { describe, expect, it } from "vitest";
import {
  planRelayRefresh,
  reconcileRelayPaths,
  takeRelayRefreshTry,
  type RelayRefreshChain,
} from "../src/app/lib/relay-credentials";

type Direction = "producer" | "consumer";
type Stage = "refresh" | "policy" | "create" | "producers" | "finish";
type PathTransport = { offeredRelay: boolean; carryingMedia: boolean };

type World = {
  providerUp: boolean;
  directWorks: boolean;
  wanted: boolean;
  relayUsable: boolean;
  transports: Record<Direction, PathTransport>;
  chain: RelayRefreshChain;
  timerArmed: boolean;
  requestInFlight: boolean;
  rebuild: { directions: Direction[]; stage: Stage } | null;
  queuedFailures: Direction[];
  moves: number;
  trace: string[];
};

const DIRECTIONS: Direction[] = ["producer", "consumer"];

const reconcile = (world: World, budget: "keep" | "renew" = "keep") => {
  const plan = reconcileRelayPaths(
    {
      wanted: world.wanted,
      relayUsable: world.relayUsable,
      busy: world.rebuild !== null,
      transports: DIRECTIONS.map((direction) => ({
        direction,
        ...world.transports[direction],
      })),
      chain: world.chain,
      timerArmed: world.timerArmed,
      requestInFlight: world.requestInFlight,
    },
    budget,
  );
  world.chain = plan.chain;
  if (plan.cancelTimer) world.timerArmed = false;
  if (plan.armRefresh) world.timerArmed = true;
  if (plan.moveOntoRelay.length > 0) {
    world.moves += 1;
    world.trace.push(`move ${plan.moveOntoRelay.join("+")}`);
    world.rebuild = { directions: plan.moveOntoRelay, stage: "policy" };
  }
};

const answer = (world: World) => {
  world.relayUsable = world.relayUsable || world.providerUp;
  reconcile(world);
};

const startRebuild = (world: World, direction: Direction) => {
  if (world.rebuild) {
    if (!world.queuedFailures.includes(direction)) world.queuedFailures.push(direction);
    return;
  }
  world.rebuild = { directions: [direction], stage: "refresh" };
};

const step = (world: World) => {
  const rebuild = world.rebuild;
  if (!rebuild) return;
  switch (rebuild.stage) {
    case "refresh":
      rebuild.stage = "policy";
      answer(world);
      return;
    case "policy":
      rebuild.stage = "create";
      world.wanted = true;
      reconcile(world, "renew");
      return;
    case "create":
      rebuild.stage = "producers";
      for (const direction of rebuild.directions) {
        world.transports[direction] = { offeredRelay: world.relayUsable, carryingMedia: false };
      }
      reconcile(world);
      return;
    case "producers":
      rebuild.stage = "finish";
      reconcile(world);
      return;
    case "finish": {
      world.rebuild = null;
      const queued = world.queuedFailures.shift();
      if (queued) startRebuild(world, queued);
      reconcile(world);
      return;
    }
  }
};

const fireTimer = (world: World) => {
  world.timerArmed = false;
  world.chain = takeRelayRefreshTry(
    planRelayRefresh(world.chain, {
      wanted: world.wanted,
      relayUsable: world.relayUsable,
      budget: "keep",
    }),
  );
  if (world.chain) world.requestInFlight = true;
};

const settleRequest = (world: World) => {
  world.requestInFlight = false;
  answer(world);
  reconcile(world);
};

const carryMedia = (world: World, direction: Direction) => {
  const transport = world.transports[direction];
  if (transport.offeredRelay || world.directWorks) transport.carryingMedia = true;
  reconcile(world);
};

const drain = (world: World) => {
  for (let i = 0; i < 2_000; i++) {
    if (world.rebuild) step(world);
    else if (world.requestInFlight) settleRequest(world);
    else if (world.timerArmed) fireTimer(world);
    else {
      const moves = world.moves;
      for (const direction of DIRECTIONS) carryMedia(world, direction);
      if (world.moves === moves && !world.rebuild && !world.timerArmed) return;
    }
  }
  throw new Error(`never settled: ${world.trace.join(", ")}`);
};

const violations = (world: World): Direction[] =>
  DIRECTIONS.filter((direction) => {
    const { offeredRelay, carryingMedia } = world.transports[direction];
    return world.wanted && world.relayUsable && !carryingMedia && !offeredRelay;
  });

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const randomWorld = (random: () => number): World => {
  const relayUsable = random() < 0.5;
  return {
    providerUp: random() < 0.5,
    directWorks: random() < 0.5,
    wanted: random() < 0.7,
    relayUsable,
    transports: {
      producer: { offeredRelay: relayUsable, carryingMedia: random() < 0.5 },
      consumer: { offeredRelay: relayUsable, carryingMedia: random() < 0.5 },
    },
    chain: null,
    timerArmed: false,
    requestInFlight: false,
    rebuild: null,
    queuedFailures: [],
    moves: 0,
    trace: [],
  };
};

const EVENTS = [
  "provider",
  "expire",
  "failure",
  "step",
  "timer",
  "answer",
  "media",
] as const;

const play = (seed: number) => {
  const random = mulberry32(seed);
  const world = randomWorld(random);
  let failures = 0;
  for (let i = 0; i < 40; i++) {
    const event = EVENTS[Math.floor(random() * EVENTS.length)];
    const direction = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
    world.trace.push(event === "media" || event === "failure" ? `${event} ${direction}` : event);
    if (event === "provider") world.providerUp = !world.providerUp;
    else if (event === "expire") world.relayUsable = false;
    else if (event === "failure" && failures < 3) {
      failures += 1;
      startRebuild(world, direction);
    } else if (event === "step") step(world);
    else if (event === "timer" && world.timerArmed && !world.requestInFlight) fireTimer(world);
    else if (event === "answer" && world.requestInFlight) settleRequest(world);
    else if (event === "media") carryMedia(world, direction);
  }
  drain(world);
  return world;
};

describe("moving a transport onto the relay, whatever the order of events", () => {
  it("moves the receive path once credentials return while its rebuild waits for the producer list", () => {
    const world: World = {
      providerUp: false,
      directWorks: false,
      wanted: true,
      relayUsable: false,
      transports: {
        producer: { offeredRelay: true, carryingMedia: true },
        consumer: { offeredRelay: true, carryingMedia: true },
      },
      chain: null,
      timerArmed: false,
      requestInFlight: false,
      rebuild: null,
      queuedFailures: [],
      moves: 0,
      trace: [],
    };
    startRebuild(world, "consumer");
    step(world);
    step(world);
    step(world);
    expect(world.transports.consumer).toEqual({ offeredRelay: false, carryingMedia: false });
    expect(world.timerArmed).toBe(true);

    world.providerUp = true;
    fireTimer(world);
    settleRequest(world);
    expect(world.relayUsable).toBe(true);
    expect(world.rebuild?.stage).toBe("producers");

    step(world);
    step(world);
    drain(world);

    expect(world.moves).toBe(1);
    expect(world.transports.consumer).toEqual({ offeredRelay: true, carryingMedia: true });
    expect(violations(world)).toEqual([]);
  });

  it("keeps a transport that carries media on a direct path when credentials return", () => {
    const world = randomWorld(mulberry32(1));
    Object.assign(world, { providerUp: false, directWorks: true, wanted: true, relayUsable: false });
    startRebuild(world, "consumer");
    drain(world);
    expect(world.transports.consumer).toEqual({ offeredRelay: false, carryingMedia: true });

    world.providerUp = true;
    startRebuild(world, "producer");
    drain(world);

    expect(world.relayUsable).toBe(true);
    expect(world.transports.consumer).toEqual({ offeredRelay: false, carryingMedia: true });
  });

  it("leaves no transport that needs the relay off it once a relay is usable", () => {
    const failed: Array<{ seed: number; trace: string }> = [];
    for (let seed = 1; seed <= 3_000; seed++) {
      const world = play(seed);
      if (violations(world).length > 0 || world.moves > 4) {
        failed.push({ seed, trace: world.trace.join(", ") });
      }
    }
    expect(failed).toEqual([]);
  });
});
