/**
 * The design's scale reference on the real runtime: a room of `people` on the
 * heaviest fixture (Q&A with about 290 questions, everyone upvoting), offered
 * 100 actions a second for ten seconds with a flush every 50 ms.
 *
 * It drives `RoomAuthority` directly. Sockets are stand-ins that count frames
 * and their encoded size, so the CPU measured is the runtime's own: actions,
 * projection, diffing and building each recipient's frame.
 */
import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import {
  AUTHORITY_EVENTS,
  type AuthorityFrame,
  type AuthorityResult,
  type Json,
} from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import {
  createAppsAuthorityRuntime,
  getRoomAuthority,
} from "../../server/apps/authority/index.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import {
  createConnectionContext,
  type ConnectionContext,
} from "../../server/socket/context.js";
import { createSfuState } from "../../server/state.js";
import { qaAuthority } from "@conclave/apps-sdk/qa/server";

export type ScaleReport = {
  people: number;
  questions: number;
  offeredPerSecond: number;
  acceptedPerSecond: number;
  limitedPerSecond: number;
  flushesPerSecond: number;
  /** CPU the runtime spent, in ms per second of load. */
  actCpuMsPerSecond: number;
  flushCpuMsPerSecond: number;
  /** Times a shared projector ran during the load. */
  sharedProjections: number;
  framesPerSecond: number;
  /** The busiest recipient's frames per second. */
  maxFramesPerRecipientPerSecond: number;
  bytesPerPersonPerSecond: number;
  /** Personal rows that reached someone other than their owner. */
  misdeliveredPersonalRows: number;
};

const ACTIONS_PER_SECOND = 100;
const FLUSH_MS = 50;
const SECONDS = 10;
const ACTORS = 49;

const cpuMs = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

type Seat = {
  context: ConnectionContext;
  subscription: string;
  frames: number;
  bytes: number;
  upvoted: Set<string>;
};

/** Counts how often the shared `questions` projector runs. */
const counting = (module: AuthorityModule, counter: { shared: number }): AuthorityModule => {
  const view = module.runtime.views.questions;
  if (view.kind !== "shared") throw new Error("Expected a shared view");
  return {
    contract: module.contract,
    runtime: {
      ...module.runtime,
      views: {
        ...module.runtime.views,
        questions: {
          ...view,
          project: (row, role, room) => {
            counter.shared += 1;
            return view.project(row, role, room);
          },
        },
      },
    },
  };
};

/**
 * `advance` moves the clock the runtime reads. Under vitest that is the fake
 * timer, which also fires the runtime's own flush timer, so the flush cadence
 * measured is the scheduler's. A script patches `Date.now`, where no timer
 * fires, and passes `flushManually` to flush every 50 ms itself.
 */
export const measureAuthorityScale = (
  people: number,
  advance: (ms: number) => void,
  options: { flushManually: boolean } = { flushManually: false },
): ScaleReport => {
  const counter = { shared: 0 };
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({
      instanceId: "authority-scale",
      instanceUrl: "http://localhost",
      ttlMs: 45_000,
    }),
    appsAuthority: createAppsAuthorityRuntime({
      modules: [counting(qaAuthority, counter)],
    }),
  });
  const room = new Room({
    id: "scale",
    clientId: "conclave",
    workerPid: null,
    router: {} as Router,
  });
  state.rooms.set(room.channelId, room);
  const io = { to: () => ({ emit: () => true }) } as unknown as SocketIOServer;
  const authority = getRoomAuthority(state, room)!;

  let misdelivered = 0;
  const seats: Seat[] = [];
  for (let index = 0; index < people; index += 1) {
    const seat: Seat = {
      context: null as unknown as ConnectionContext,
      subscription: `sub-${index}`,
      frames: 0,
      bytes: 0,
      upvoted: new Set(),
    };
    const socket = {
      id: `socket-${index}`,
      data: {},
      connected: true,
      emit(event: string, frame: AuthorityFrame) {
        if (event !== AUTHORITY_EVENTS.frame) return true;
        seat.frames += 1;
        seat.bytes += JSON.stringify(frame).length;
        if (frame.kind === "patch") {
          for (const row of frame.put) {
            if (row.bucket === "myUpvotes" && !seat.upvoted.has(row.key)) {
              misdelivered += 1;
            }
          }
        }
        return true;
      },
    } as unknown as Socket;
    const id = `person${index}@example.com#s`;
    const client =
      index === 0 ? new Admin({ id, socket }) : new Client({ id, socket });
    room.setUserIdentity(id, `person${index}@example.com`, `Person ${index}`);
    room.addClient(client);
    seat.context = createConnectionContext(io, socket, state);
    seat.context.currentRoom = room;
    seat.context.currentClient = client;
    seats.push(seat);
  }

  const capability = authority.capabilities(seats[0].context, { protocols: [1] });
  if (!capability.ok) throw new Error("No capability");
  const entry = capability.value.apps[0];
  for (const seat of seats) {
    authority.subscribe(seat.context, {
      roomEpoch: authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription: seat.subscription,
    });
  }

  let attempt = 0;
  const act = (seat: Seat, action: string, input: unknown): AuthorityResult<Json> =>
    authority.act(seat.context, {
      roomEpoch: authority.roomEpoch,
      subscription: seat.subscription,
      generation: 1,
      operation: { issuedAtMs: Date.now(), nonce: `scale-op-${(attempt += 1)}` },
      action,
      input,
    });

  // Fill the board: 49 people ask three questions, the host answers, twice.
  const ids: string[] = [];
  const askers = seats.slice(1, 1 + ACTORS);
  for (let round = 0; round < 2; round += 1) {
    const asked: string[] = [];
    for (const asker of askers) {
      for (let n = 0; n < 3; n += 1) {
        advance(30_000);
        const result = act(asker, "ask", {
          text: `Question ${attempt} from someone, long enough to look real`,
        });
        if (result.ok) asked.push((result.value as { id: string }).id);
      }
    }
    for (const id of asked) {
      advance(1_000);
      act(seats[0], "moderate", { id, action: "answered" });
    }
    ids.push(...asked);
  }
  advance(60_000);
  authority.flushNow();
  for (const seat of seats) {
    seat.frames = 0;
    seat.bytes = 0;
  }
  counter.shared = 0;

  // The same stream of actions whatever the room size, so runs compare.
  let seed = 12345;
  const random = (max: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };

  let actMs = 0;
  let flushMs = 0;
  let accepted = 0;
  let limited = 0;
  const stepMs = 1000 / ACTIONS_PER_SECOND;
  const total = SECONDS * ACTIONS_PER_SECOND;
  const flushesBefore = authority.stats.flushes;
  for (let step = 0; step < total; step += 1) {
    const advanceStarted = cpuMs();
    advance(stepMs);
    flushMs += cpuMs() - advanceStarted;
    const actor = askers[random(askers.length)];
    const id = ids[random(ids.length)];
    const value = !actor.upvoted.has(id);
    if (value) actor.upvoted.add(id);
    const started = cpuMs();
    const result = act(actor, "upvote", { id, value });
    actMs += cpuMs() - started;
    if (result.ok) {
      accepted += 1;
      if (!value) actor.upvoted.delete(id);
    } else {
      limited += 1;
      if (value) actor.upvoted.delete(id);
    }
    if (options.flushManually && (step + 1) % (FLUSH_MS / stepMs) === 0) {
      const flushStarted = cpuMs();
      authority.flushNow();
      flushMs += cpuMs() - flushStarted;
    }
  }
  advance(FLUSH_MS);

  const frames = seats.reduce((sum, seat) => sum + seat.frames, 0);
  const bytes = seats.reduce((sum, seat) => sum + seat.bytes, 0);
  const report: ScaleReport = {
    people,
    questions: ids.length,
    offeredPerSecond: ACTIONS_PER_SECOND,
    acceptedPerSecond: accepted / SECONDS,
    limitedPerSecond: limited / SECONDS,
    flushesPerSecond: (authority.stats.flushes - flushesBefore) / SECONDS,
    actCpuMsPerSecond: actMs / SECONDS,
    flushCpuMsPerSecond: flushMs / SECONDS,
    sharedProjections: counter.shared,
    framesPerSecond: frames / SECONDS,
    maxFramesPerRecipientPerSecond:
      Math.max(...seats.map((seat) => seat.frames)) / SECONDS,
    bytesPerPersonPerSecond: bytes / SECONDS / people,
    misdeliveredPersonalRows: misdelivered,
  };
  authority.close();
  return report;
};
