import type { Router } from "mediasoup/types";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { vi } from "vitest";
import {
  AUTHORITY_EVENTS,
  AuthorityClient,
  type AuthorityContract,
  type AuthorityFrame,
  type AuthorityResult,
  type AuthoritySession,
  type AuthoritySocket,
  type Json,
  type OperationId,
} from "@conclave/apps-sdk/authority";
import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";
import { Admin } from "../../config/classes/Admin.js";
import { Client } from "../../config/classes/Client.js";
import { Room } from "../../config/classes/Room.js";
import {
  createAppsAuthorityRuntime,
  getRoomAuthority,
  type AppsAuthorityRuntime,
} from "../../server/apps/authority/index.js";
import type { RoomAuthority } from "../../server/apps/authority/roomAuthority.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import {
  createConnectionContext,
  type ConnectionContext,
} from "../../server/socket/context.js";
import { registerAuthorityHandlers } from "../../server/socket/handlers/authorityHandlers.js";
import { createSfuState, type SfuState } from "../../server/state.js";
import { getOrCreateWebinarRoomConfig } from "../../server/webinar.js";

type Listener = (...args: unknown[]) => void;

/** What crosses a socket is JSON, so both directions are copied through it. */
const overWire = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

export type PersonRole = "host" | "participant" | "attendee";

export type Person = {
  /** The identity key: an email for a signed-in person, `guest-...` for a guest. */
  userKey: string;
  name: string;
  role: PersonRole;
};

export const person = (
  userKey: string,
  name: string,
  role: PersonRole = "participant",
): Person => ({ userKey, name, role });

/**
 * A pair of in-memory sockets: what the server emits reaches the client's
 * listeners, and a client emit runs the server's handler. Delivery is
 * synchronous; payloads are copied through JSON as a real socket would.
 */
const makeSocketPair = (
  id: string,
  onServerEmit: (event: string, payload: unknown) => void,
  onDirectEmit: (event: string) => void = () => {},
) => {
  const serverHandlers = new Map<string, Listener[]>();
  const clientListeners = new Map<string, Set<Listener>>();
  const call = (listeners: Iterable<Listener> | undefined, ...args: unknown[]) => {
    for (const listener of [...(listeners ?? [])]) {
      (listener)(...args);
    }
  };
  /** What reaches the client, already encoded: an emit or a broadcast. */
  const receive = (event: string, wire: unknown): void => {
    onServerEmit(event, wire);
    if (client.connected) call(clientListeners.get(event), wire);
  };

  const client = {
    connected: true,
    on(event: string, listener: Listener) {
      const listeners = clientListeners.get(event) ?? new Set();
      listeners.add(listener);
      clientListeners.set(event, listeners);
    },
    off(event: string, listener: Listener) {
      clientListeners.get(event)?.delete(listener);
    },
    emit(event: string, payload?: unknown, ack?: (reply: unknown) => void) {
      if (!client.connected) return;
      call(
        serverHandlers.get(event),
        overWire(payload),
        ack ? (reply: unknown) => ack(overWire(reply)) : undefined,
      );
    },
  };

  const server = {
    id,
    data: {},
    connected: true,
    conn: { writeBuffer: [] as unknown[] },
    on(event: string, listener: Listener) {
      serverHandlers.set(event, [...(serverHandlers.get(event) ?? []), listener]);
      return server;
    },
    emit(event: string, payload?: unknown) {
      onDirectEmit(event);
      receive(event, overWire(payload));
      return true;
    },
    disconnect() {
      if (!server.connected) return server;
      server.connected = false;
      client.connected = false;
      call(serverHandlers.get("disconnect"), "server namespace disconnect");
      call(clientListeners.get("disconnect"), "io server disconnect");
      return server;
    },
    join: vi.fn(),
    leave: vi.fn(),
    to: () => ({ emit: vi.fn() }),
  };

  return {
    server: server as unknown as Socket,
    client: client satisfies AuthoritySocket,
    receive,
    /** Whether the server registered a handler for this event. */
    serverHandles: (event: string) => serverHandlers.has(event),
  };
};

export type Sent = { tab: Tab; frame: AuthorityFrame };

/** One connected tab. It knows nothing but what the server sent it. */
export class Tab<C extends AuthorityContract = AuthorityContract> {
  readonly frames: AuthorityFrame[] = [];
  constructor(
    readonly who: Person,
    readonly seat: Client,
    readonly context: ConnectionContext,
    readonly socket: AuthoritySocket,
    readonly client: AuthorityClient,
    readonly session: AuthoritySession<C>,
    private readonly harness: Harness,
  ) {}

  get state() {
    return this.session.getState();
  }

  /** A row this tab holds, or null. */
  row(bucket: string, key: string): Json | null {
    const state = this.session.getState();
    if (state.kind !== "ready") return null;
    const rows = (state.view as Record<string, ReadonlyMap<string, Json>>)[bucket];
    return rows?.get(key) ?? null;
  }

  rows(bucket: string): Json[] {
    const state = this.session.getState();
    if (state.kind !== "ready") return [];
    const rows = (state.view as Record<string, ReadonlyMap<string, Json>>)[bucket];
    return [...(rows?.values() ?? [])];
  }

  /** Everything held, as sorted `[bucket, key, value]` triples. */
  held(): string {
    const state = this.session.getState();
    if (state.kind !== "ready") return "[]";
    const triples: [string, string, Json][] = [];
    for (const [bucket, rows] of Object.entries(
      state.view as Record<string, ReadonlyMap<string, Json>>,
    )) {
      for (const [key, value] of rows) triples.push([bucket, key, value]);
    }
    return JSON.stringify(triples.sort());
  }

  act(action: string, input: unknown = null): Promise<AuthorityResult<Json>> {
    return this.harness.settle(
      (this.session as unknown as AuthoritySession<AuthorityContract>).act(
        action,
        input as never,
      ) as Promise<AuthorityResult<Json>>,
    );
  }

  query(query: string, input: unknown = null): Promise<AuthorityResult<Json>> {
    return this.harness.settle(
      (this.session as unknown as AuthoritySession<AuthorityContract>).query(
        query,
        input as never,
      ) as Promise<AuthorityResult<Json>>,
    );
  }

  /** A raw request on this tab's socket, for what the session never sends. */
  raw<Reply>(event: string, payload: unknown): Promise<Reply> {
    return new Promise((resolve) => {
      this.socket.emit(event, payload, (reply: unknown) => resolve(reply as Reply));
    });
  }

  /** Sends an action with a chosen operation id on the live subscription. */
  actWith(
    operation: OperationId,
    action: string,
    input: unknown,
  ): Promise<AuthorityResult<Json>> {
    const last = [...this.frames]
      .reverse()
      .find((frame) => frame.kind === "replace" && frame.part === 0);
    if (!last) throw new Error("This tab has no view yet");
    return this.raw(AUTHORITY_EVENTS.act, {
      roomEpoch: this.harness.authority.roomEpoch,
      subscription: last.subscription,
      generation: last.generation,
      operation,
      action,
      input,
    });
  }
}

export type HarnessOptions = {
  /** Null stands for an SFU that does not run authority apps at all. */
  runtime?: Partial<AppsAuthorityRuntime> | null;
  roomId?: string;
};

/**
 * A real `Room`, real seats and the real authority runtime and handlers,
 * joined to real client sessions by in-memory sockets. Run under fake
 * timers: the clock only moves when a test moves it.
 */
export class Harness {
  readonly state: SfuState;
  readonly room: Room;
  readonly tabs: Tab[] = [];
  private readonly log: Sent[] = [];
  private delivered = 0;
  private sequence = 0;
  /** Each server emit to one socket, by event: one encoding each. */
  readonly directEmits = new Map<string, number>();
  /** Each broadcast: one encoding, written to this many sockets. */
  readonly broadcasts: { event: string; sockets: number }[] = [];
  private readonly receivers = new Map<string, (event: string, wire: unknown) => void>();
  private readonly io = {
    to: () => ({ emit: vi.fn() }),
    // A local broadcast to sockets by id, as socket.io does it: the payload
    // is encoded once and the same bytes go to each socket.
    local: {
      to: (ids: string | string[]) => ({
        emit: (event: string, payload: unknown) => {
          const sockets = [ids].flat();
          const wire = overWire(payload);
          this.broadcasts.push({ event, sockets: sockets.length });
          for (const id of sockets) this.receivers.get(id)?.(event, wire);
          return true;
        },
      }),
    },
  } as unknown as SocketIOServer;

  constructor(
    private readonly modules: readonly AuthorityModule[],
    options: HarnessOptions = {},
  ) {
    this.state = createSfuState({
      roomRegistry: new LocalRoomRegistry({
        instanceId: "authority-harness",
        instanceUrl: "http://localhost",
        ttlMs: 45_000,
      }),
      appsAuthority:
        options.runtime === null
          ? null
          : createAppsAuthorityRuntime({
              modules,
              verifyViews: true,
              ...options.runtime,
            }),
    });
    const router = {
      closed: false,
      close: () => {
        router.closed = true;
      },
    };
    this.room = new Room({
      id: options.roomId ?? "room",
      clientId: "conclave",
      workerPid: null,
      router: router as unknown as Router,
    });
    this.state.rooms.set(this.room.channelId, this.room);
  }

  get authority(): RoomAuthority {
    const authority = getRoomAuthority(this.state, this.room);
    if (!authority) throw new Error("The room has no authority runtime");
    return authority;
  }

  setWebinar(enabled: boolean, qaEnabled = true): void {
    const config = getOrCreateWebinarRoomConfig(
      this.state.webinarConfigs,
      this.room.channelId,
    );
    config.enabled = enabled;
    config.qaEnabled = qaEnabled;
    this.authority.policyChanged();
  }

  /** A person opens a tab: a seat in the room and a session for `contract`. */
  async open<C extends AuthorityContract>(
    who: Person,
    contract: C,
    options: {
      session?: string;
      /** The `email` claim of a signed-in join token. */
      tokenEmail?: string;
      /**
       * Open without moving any timer, so no flush that was waiting runs:
       * the snapshot is read in the middle of whatever is pending.
       */
      quiet?: boolean;
    } = {},
  ): Promise<Tab<C>> {
    this.sequence += 1;
    const sessionId = options.session ?? `s${this.sequence}`;
    const seatId = `${who.userKey}#${sessionId}`;
    let tab: Tab<C> | null = null;
    const pair = makeSocketPair(
      `socket-${this.sequence}`,
      (event, payload) => {
        if (event !== AUTHORITY_EVENTS.frame || !tab) return;
        const frame = payload as AuthorityFrame;
        tab.frames.push(frame);
        this.log.push({ tab: tab, frame });
      },
      (event) => this.directEmits.set(event, (this.directEmits.get(event) ?? 0) + 1),
    );
    this.receivers.set(pair.server.id, pair.receive);
    const seat =
      who.role === "host"
        ? new Admin({ id: seatId, socket: pair.server })
        : new Client({
            id: seatId,
            socket: pair.server,
            mode: who.role === "attendee" ? "webinar_attendee" : "participant",
          });
    this.room.setUserIdentity(seatId, who.userKey, who.name);
    if (who.role === "host" && !this.room.hostUserKey) {
      this.room.hostUserKey = who.userKey;
    }
    this.room.addClient(seat);

    const context = createConnectionContext(this.io, pair.server, this.state);
    context.currentRoom = this.room;
    context.currentClient = seat;
    if (options.tokenEmail) {
      (pair.server.data as { user?: unknown }).user = { email: options.tokenEmail };
    }
    // As the SFU does: no runtime, no authority handler on the socket.
    if (this.state.appsAuthority) registerAuthorityHandlers(context);

    const client = new AuthorityClient({ socket: pair.client });
    const session = client.open(contract);
    tab = new Tab(who, seat, context, pair.client, client, session, this);
    this.tabs.push(tab);
    client.joined();
    if (options.quiet) {
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    } else {
      await this.idle();
    }
    return tab;
  }

  /**
   * Resolves a promise that needs timers or microtasks to run. Turns the
   * event loop without moving the clock first, then in small steps, so a
   * retry pause inside the client does not stall the test.
   */
  async settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    for (let turn = 0; turn < 40 && !done; turn += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    for (let turn = 0; turn < 100 && !done; turn += 1) {
      await vi.advanceTimersByTimeAsync(100);
    }
    return tracked;
  }

  /** Lets pending microtasks and zero-delay timers run. */
  async idle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  /**
   * Runs chains of zero-delay work, such as a snapshot sent in parts. Fake
   * timers give a timer scheduled from inside another a 1 ms delay, so each
   * turn moves the clock by that much.
   */
  async drain(): Promise<void> {
    for (let turn = 0; turn < 40; turn += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
  }

  /** Flushes view changes now and returns the frames that went out. */
  async deliver(): Promise<Sent[]> {
    await this.idle();
    this.authority.flushNow();
    await this.idle();
    const batch = this.log.slice(this.delivered);
    this.delivered = this.log.length;
    return batch;
  }

  /** Moves the clock, running any timers that fall due. */
  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await this.deliver();
  }

  /**
   * Every tab's patched copy equals a fresh snapshot the server would give
   * that tab now. The tab holds only what it was sent, so this shows the
   * patch stream alone reproduces the server's view.
   */
  async converged(): Promise<boolean> {
    await this.deliver();
    let same = true;
    for (const tab of this.tabs) {
      const state = tab.session.getState();
      if (state.kind !== "ready") continue;
      const fresh = await this.snapshotFor(tab);
      if (fresh !== tab.held()) same = false;
    }
    this.delivered = this.log.length;
    return same;
  }

  /** A fresh whole view for a tab's seat, through a throwaway subscription. */
  private async snapshotFor(tab: Tab): Promise<string> {
    const entry = tab.client.entryFor(tab.session.contract);
    if (!entry) return "[]";
    this.sequence += 1;
    const subscription = `probe-${this.sequence}`;
    const start = tab.frames.length;
    await tab.raw(AUTHORITY_EVENTS.subscribe, {
      roomEpoch: this.authority.roomEpoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription,
    });
    await this.idle();
    const triples: [string, string, Json][] = [];
    for (const frame of tab.frames.slice(start)) {
      if (frame.subscription !== subscription || frame.kind !== "replace") continue;
      for (const row of frame.rows) triples.push([row.bucket, row.key, row.value]);
    }
    tab.socket.emit(AUTHORITY_EVENTS.unsubscribe, { subscription });
    return JSON.stringify(triples.sort());
  }
}
