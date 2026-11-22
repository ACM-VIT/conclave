import { randomBytes, randomInt } from "node:crypto";
import type { Socket } from "socket.io";
import {
  AUTHORITY_EVENTS,
  AUTHORITY_PROTOCOL,
  type ActRequest,
  type AuthorityAppEntry,
  type AuthorityCapability,
  type AuthorityFailure,
  type AuthorityFrame,
  type AuthorityResult,
  type AuthorityRevokeReason,
  type CapabilitiesRequest,
  type Json,
  type PatchFrame,
  type QueryReply,
  type QueryRequest,
  type ReplaceFrame,
  type SubscribeRequest,
} from "@conclave/apps-sdk/authority";
import type {
  AuthorityModule,
  AuthorityRandom,
  Role,
  RoomPolicy,
  Subject,
} from "@conclave/apps-sdk/authority/server";
import type { Client } from "../../../config/classes/Client.js";
import type { Room } from "../../../config/classes/Room.js";
import type { ConnectionContext } from "../../socket/context.js";
import type { IdentityAdapter } from "./identity.js";
import { AuthorityInstance, type Actor } from "./instance.js";
import type { AuthorityLimits } from "./limits.js";
import type { SizedRow, ViewOps } from "./views.js";

export type SocketPressure = { packets: number; bytes: number };

export type RoomAuthorityOptions = {
  room: Room;
  modules: readonly AuthorityModule[];
  /** The room's mode and flags, read fresh on every request and flush. */
  policy: () => RoomPolicy;
  /** Whether `room` is still the room registered for its channel. */
  isLive: () => boolean;
  identity: IdentityAdapter;
  limits: AuthorityLimits;
  /** How much a socket has queued but not yet written. */
  pressure: (socket: Socket) => SocketPressure;
  /** Recompute every view after each flush and throw on drift. */
  verifyViews: boolean;
  random?: AuthorityRandom;
};

type Subscription = {
  id: string;
  context: ConnectionContext;
  socket: Socket;
  instance: AuthorityInstance;
  /** The exact seat this subscription was bound to. */
  client: Client;
  actor: Actor;
  generation: number;
  seq: number;
  /** Snapshot parts still to send. Patches wait behind them. */
  transfer: { frames: ReplaceFrame[]; next: number } | null;
  backlog: PatchFrame[];
  /** The socket fell behind. Patches are skipped until it is replaced. */
  lagging: boolean;
  dropped: boolean;
};

type Watcher = { context: ConnectionContext; signature: string };

export type RoomAuthorityStats = {
  replaces: number;
  patches: number;
  revokes: number;
  /** Times a socket fell behind and was sent a fresh snapshot instead. */
  resnapshots: number;
  /** Sockets disconnected because their queue was full. */
  disconnects: number;
  flushes: number;
};

const failure = (
  code: AuthorityFailure["code"],
  extra?: { reason?: string; retryAfterMs?: number },
): AuthorityFailure => ({ ok: false, code, ...extra });

const cryptoRandom: AuthorityRandom = {
  next: () => randomInt(0, 2 ** 32) / 2 ** 32,
  int: (maxExclusive) => randomInt(0, maxExclusive),
  shuffle: (list) => {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = randomInt(0, index + 1);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  },
};

const samePolicy = (a: RoomPolicy, b: RoomPolicy): boolean =>
  a.mode === b.mode && a.qaEnabled === b.qaEnabled;

const sameActor = (a: Actor, b: Actor): boolean =>
  a.subject === b.subject && a.role === b.role && a.verified === b.verified;

/** Splits a snapshot into parts of at most `chunkBytes`, one row at least. */
const partsOf = (rows: SizedRow[], chunkBytes: number): SizedRow[][] => {
  const parts: SizedRow[][] = [[]];
  let size = 0;
  for (const sized of rows) {
    const current = parts[parts.length - 1];
    if (current.length > 0 && size + sized.bytes > chunkBytes) {
      parts.push([sized]);
      size = sized.bytes;
    } else {
      current.push(sized);
      size += sized.bytes;
    }
  }
  return parts;
};

/**
 * Every authority app in one room: who is subscribed, what each of them has
 * been sent, and when to flush and wake. The app's rules live in its module
 * and `AuthorityInstance`. What lives here is what no app author writes:
 *
 * - Membership. Each request and each frame resolves the connection against
 *   the room as it is now. A saved room or client is never trusted, because a
 *   kick removes the seat without closing the socket and a second connection
 *   replaces the seat while the first socket stays open.
 * - Delivery. Changes are coalesced and sent as whole-row patches, each
 *   connection getting only its role's rows and its own. Equal views send
 *   nothing.
 * - Recovery. A socket that falls behind is sent a fresh snapshot once it
 *   catches up, or is disconnected when its queue is full.
 */
export class RoomAuthority {
  /** New for every room object, so nothing outlives a restart unnoticed. */
  readonly roomEpoch = randomBytes(12).toString("base64url");
  readonly stats: RoomAuthorityStats = {
    replaces: 0,
    patches: 0,
    revokes: 0,
    resnapshots: 0,
    disconnects: 0,
    flushes: 0,
  };

  private readonly room: Room;
  private readonly limits: AuthorityLimits;
  private readonly instances = new Map<string, AuthorityInstance>();
  private readonly bySocket = new Map<string, Map<string, Subscription>>();
  private readonly byInstance = new Map<AuthorityInstance, Set<Subscription>>();
  private readonly watchers = new Map<string, Watcher>();
  private flushTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private lagTimer: NodeJS.Timeout | null = null;
  private wakeAt: number | null = null;
  private lastFlushAt = 0;
  private lastNow = 0;
  private closed = false;

  constructor(private readonly options: RoomAuthorityOptions) {
    this.room = options.room;
    this.limits = options.limits;
    const policy = options.policy();
    for (const module of options.modules) {
      const instance = new AuthorityInstance(
        `${module.contract.id}.${randomBytes(9).toString("base64url")}`,
        module,
        policy,
        {
          limits: options.limits,
          random: options.random ?? cryptoRandom,
          verifyViews: options.verifyViews,
        },
      );
      this.instances.set(instance.id, instance);
      this.byInstance.set(instance, new Set());
    }
  }

  /* ---- Requests ---------------------------------------------------------- */

  capabilities(
    context: ConnectionContext,
    request: CapabilitiesRequest,
  ): AuthorityResult<AuthorityCapability> {
    if (!request.protocols.includes(AUTHORITY_PROTOCOL)) {
      return failure("unsupported");
    }
    const bound = this.bind(context);
    if (!bound) return failure("not-in-room");
    this.syncPolicy();
    const apps = this.appsFor(bound.actor);
    this.watchers.set(context.socket.id, {
      context,
      signature: JSON.stringify(apps),
    });
    return { ok: true, value: this.capability(apps) };
  }

  subscribe(
    context: ConnectionContext,
    request: SubscribeRequest,
  ): AuthorityResult<null> {
    const bound = this.bind(context);
    if (!bound) return failure("not-in-room");
    if (request.roomEpoch !== this.roomEpoch) return failure("stale-epoch");
    this.syncPolicy();

    const instance = this.instances.get(request.instance);
    if (
      !instance ||
      instance.appId !== request.app ||
      instance.module.contract.major !== request.major
    ) {
      return failure("unknown-app");
    }
    if (!instance.canView(bound.actor)) return failure("forbidden");

    let subscriptions = this.bySocket.get(context.socket.id);
    if (!subscriptions) {
      subscriptions = new Map();
      this.bySocket.set(context.socket.id, subscriptions);
    }
    if (subscriptions.has(request.subscription)) return failure("invalid-input");
    if (subscriptions.size >= this.limits.subscriptionsPerSocket) {
      return failure("capacity");
    }

    const subscription: Subscription = {
      id: request.subscription,
      context,
      socket: context.socket,
      instance,
      client: bound.client,
      actor: bound.actor,
      generation: 1,
      seq: 0,
      transfer: null,
      backlog: [],
      lagging: false,
      dropped: false,
    };
    subscriptions.set(subscription.id, subscription);
    this.byInstance.get(instance)!.add(subscription);
    this.sendReplace(subscription);
    return { ok: true, value: null };
  }

  unsubscribe(context: ConnectionContext, subscriptionId: string): void {
    const subscription = this.bySocket
      .get(context.socket.id)
      ?.get(subscriptionId);
    if (subscription) this.drop(subscription);
  }

  act(context: ConnectionContext, request: ActRequest): AuthorityResult<Json> {
    const target = this.target(context, request);
    if (!target.ok) return target;
    const { subscription } = target;
    const result = subscription.instance.act(
      subscription.actor,
      request.action,
      request.input,
      request.operation,
      this.now(),
    );
    this.afterWrite(subscription.instance);
    return result;
  }

  query(context: ConnectionContext, request: QueryRequest): QueryReply {
    const target = this.target(context, request);
    if (!target.ok) return target;
    const { subscription } = target;
    const result = subscription.instance.query(
      subscription.actor,
      request.query,
      request.input,
      this.now(),
    );
    if (!result.ok) return result;

    const text = JSON.stringify(result.value);
    if (Buffer.byteLength(text) <= this.limits.chunkBytes) return result;
    this.streamQuery(subscription, request, text);
    return { ok: true, streamed: true };
  }

  /* ---- Membership -------------------------------------------------------- */

  /**
   * Someone joined, left, was removed, replaced or promoted. Every
   * subscription is checked against the room as it is now. A missed call
   * only delays this: nothing is ever sent without the same check.
   */
  membershipChanged(): void {
    this.scheduleSweep();
  }

  /** The room's mode or a flag changed. */
  policyChanged(): void {
    this.scheduleSweep();
  }

  dropSocket(socketId: string): void {
    this.watchers.delete(socketId);
    for (const subscription of [...(this.bySocket.get(socketId)?.values() ?? [])]) {
      this.drop(subscription);
    }
  }

  close(): void {
    if (this.closed) return;
    // Closing a room does not close its sockets. Tell each one that still
    // holds a view to forget it, or it would keep showing the room's last
    // state for as long as the tab stays open.
    for (const subscriptions of [...this.bySocket.values()]) {
      for (const subscription of [...subscriptions.values()]) {
        this.revoke(subscription, "closed");
      }
    }
    this.closed = true;
    for (const timer of [this.flushTimer, this.sweepTimer, this.wakeTimer, this.lagTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.flushTimer = this.sweepTimer = this.wakeTimer = this.lagTimer = null;
    this.bySocket.clear();
    this.byInstance.clear();
    this.watchers.clear();
    this.instances.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Flushes pending view changes now. For tests and orderly shutdown. */
  flushNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }

  /* ---- Binding ----------------------------------------------------------- */

  /**
   * The seat behind a connection as the room knows it now, or null. Checks
   * that the room is still registered, that it still holds this exact client
   * object on this exact socket, and that the socket is connected. A client
   * in the room's map has been admitted; the waiting room is a separate map.
   */
  private bind(context: ConnectionContext): { client: Client; actor: Actor } | null {
    if (this.closed || !this.options.isLive()) return null;
    const client = context.currentClient;
    if (context.currentRoom !== this.room || !client) return null;
    if (this.room.getClient(client.id) !== client) return null;
    if (client.socket !== context.socket || !context.socket.connected) {
      return null;
    }
    const identity = this.options.identity.resolve(this.room, client);
    if (!identity) return null;
    const role: Role = client.isWebinarAttendee
      ? "attendee"
      : client.isObserver
        ? "observer"
        : this.room.isAdminClient(client)
          ? "moderator"
          : "member";
    return {
      client,
      actor: {
        subject: identity.subject,
        verified: identity.verified,
        role,
        displayName: this.room.getDisplayNameForUser(client.id) || "Guest",
      },
    };
  }

  /**
   * Brings one subscription in line with the room. It ends when its seat is
   * gone or may no longer view the app, and restarts under a new generation
   * when the seat's role or identity changed, so a promoted host gets the
   * host's rows at once and a demoted one loses them.
   */
  private refresh(subscription: Subscription): "live" | "replaced" | "gone" {
    if (subscription.dropped) return "gone";
    const bound = this.bind(subscription.context);
    if (!bound || bound.client !== subscription.client) {
      this.revoke(subscription, "forbidden");
      return "gone";
    }
    if (!subscription.instance.canView(bound.actor)) {
      this.revoke(subscription, "forbidden");
      return "gone";
    }
    if (!sameActor(subscription.actor, bound.actor)) {
      this.regenerate(subscription, bound.actor);
      return "replaced";
    }
    subscription.actor = bound.actor;
    return "live";
  }

  private target(
    context: ConnectionContext,
    request: { roomEpoch: string; subscription: string; generation: number },
  ): { ok: true; subscription: Subscription } | AuthorityFailure {
    if (!this.bind(context)) return failure("not-in-room");
    if (request.roomEpoch !== this.roomEpoch) return failure("stale-epoch");
    this.syncPolicy();
    const subscription = this.bySocket
      .get(context.socket.id)
      ?.get(request.subscription);
    if (!subscription) return failure("not-subscribed");
    const state = this.refresh(subscription);
    if (state === "gone") return failure("not-subscribed");
    if (state === "replaced" || request.generation !== subscription.generation) {
      return failure("stale-generation");
    }
    return { ok: true, subscription };
  }

  /* ---- Policy and capabilities ------------------------------------------ */

  /** Applies a changed room policy: every view is rebuilt and resent. */
  private syncPolicy(): void {
    const policy = this.options.policy();
    for (const instance of this.instances.values()) {
      if (samePolicy(instance.policy, policy)) continue;
      instance.setPolicy(policy);
      for (const subscription of [...this.byInstance.get(instance)!]) {
        const bound = this.bind(subscription.context);
        if (
          !bound ||
          bound.client !== subscription.client ||
          !instance.canView(bound.actor)
        ) {
          this.revoke(subscription, "forbidden");
        } else {
          this.regenerate(subscription, bound.actor);
        }
      }
    }
  }

  private appsFor(actor: Actor): AuthorityAppEntry[] {
    const apps: AuthorityAppEntry[] = [];
    for (const instance of this.instances.values()) {
      if (!instance.canView(actor)) continue;
      apps.push({
        instance: instance.id,
        app: instance.appId,
        major: instance.module.contract.major,
        surface: instance.module.contract.surface,
      });
    }
    return apps;
  }

  private capability(apps: AuthorityAppEntry[]): AuthorityCapability {
    return {
      protocol: AUTHORITY_PROTOCOL,
      roomEpoch: this.roomEpoch,
      serverNowMs: this.now(),
      apps,
    };
  }

  private scheduleSweep(): void {
    if (this.closed || this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweep();
    }, 0);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    if (this.closed) return;
    this.syncPolicy();
    for (const subscriptions of [...this.bySocket.values()]) {
      for (const subscription of [...subscriptions.values()]) {
        this.refresh(subscription);
      }
    }
    for (const [socketId, watcher] of [...this.watchers]) {
      const bound = this.bind(watcher.context);
      if (!bound) {
        this.watchers.delete(socketId);
        continue;
      }
      const apps = this.appsFor(bound.actor);
      const signature = JSON.stringify(apps);
      if (signature === watcher.signature) continue;
      watcher.signature = signature;
      watcher.context.socket.emit(
        AUTHORITY_EVENTS.capabilitiesChanged,
        this.capability(apps),
      );
    }
  }

  /* ---- Delivery ---------------------------------------------------------- */

  private afterWrite(instance: AuthorityInstance): void {
    if (instance.hasPendingChanges) this.scheduleFlush(false);
    this.armWake();
  }

  /**
   * At once when the room has been quiet, so one vote feels instant, and at
   * most once per interval when it is busy, so a hundred actions a second
   * become twenty frames.
   */
  private scheduleFlush(immediate: boolean): void {
    if (this.closed) return;
    if (this.flushTimer) {
      if (!immediate) return;
      clearTimeout(this.flushTimer);
    }
    const wait = immediate
      ? 0
      : Math.max(0, this.lastFlushAt + this.limits.flushIntervalMs - this.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.closed) return;
    this.lastFlushAt = this.now();
    this.stats.flushes += 1;
    this.syncPolicy();
    for (const instance of this.instances.values()) {
      const subscriptions = this.byInstance.get(instance)!;
      // Every recipient is checked against the room before anything leaves.
      for (const subscription of [...subscriptions]) this.refresh(subscription);

      const roles = new Set<Role>();
      const subjects = new Set<Subject>();
      for (const subscription of subscriptions) {
        roles.add(subscription.actor.role);
        subjects.add(subscription.actor.subject);
      }
      const changes = instance.flushViews({ roles, subjects });
      if (changes.shared.size === 0 && changes.personal.size === 0) continue;
      for (const subscription of [...subscriptions]) {
        const shared = changes.shared.get(subscription.actor.role);
        const personal = changes.personal.get(subscription.actor.subject);
        if (shared || personal) this.sendPatch(subscription, shared, personal);
      }
    }
  }

  private sendPatch(
    subscription: Subscription,
    shared: ViewOps | undefined,
    personal: ViewOps | undefined,
  ): void {
    // A lagging subscription is caught up by a whole replacement later.
    if (subscription.lagging || subscription.dropped) return;
    if (!this.hasRoom(subscription)) return;

    const bytes = (shared?.bytes ?? 0) + (personal?.bytes ?? 0);
    if (bytes > this.limits.patchBytes) {
      this.regenerate(subscription, subscription.actor);
      return;
    }
    subscription.seq += 1;
    const frame: PatchFrame = {
      kind: "patch",
      subscription: subscription.id,
      generation: subscription.generation,
      serverNowMs: this.now(),
      seq: subscription.seq,
      put: [...(shared?.put ?? []), ...(personal?.put ?? [])],
      remove: [...(shared?.remove ?? []), ...(personal?.remove ?? [])],
    };
    if (!subscription.transfer) {
      this.emit(subscription, frame);
      return;
    }
    if (subscription.backlog.length >= this.limits.backlogFrames) {
      // Too much changed while the snapshot was in flight: start over.
      this.regenerate(subscription, subscription.actor);
      return;
    }
    subscription.backlog.push(frame);
  }

  /** A whole view under a new generation. */
  private regenerate(subscription: Subscription, actor: Actor): void {
    subscription.actor = actor;
    subscription.generation += 1;
    this.sendReplace(subscription);
  }

  private sendReplace(subscription: Subscription): void {
    subscription.seq = 0;
    subscription.transfer = null;
    subscription.backlog = [];
    subscription.lagging = false;
    if (!this.hasRoom(subscription)) return;

    const rows = subscription.instance.snapshot(subscription.actor);
    const bytes = rows.reduce((total, sized) => total + sized.bytes, 0);
    if (bytes > this.limits.snapshotBytes) {
      this.revoke(subscription, "too-large");
      return;
    }
    const now = this.now();
    const parts = partsOf(rows, this.limits.chunkBytes);
    const frames = parts.map(
      (part, index): ReplaceFrame => ({
        kind: "replace",
        subscription: subscription.id,
        generation: subscription.generation,
        serverNowMs: now,
        part: index,
        last: index === parts.length - 1,
        rows: part.map((sized) => sized.row),
        ...(index === 0
          ? { grants: subscription.instance.grants(subscription.actor, now) }
          : {}),
      }),
    );
    this.stats.replaces += 1;
    this.emit(subscription, frames[0]);
    if (frames.length === 1) return;
    subscription.transfer = { frames, next: 1 };
    this.continueTransfer(subscription, subscription.generation);
  }

  /**
   * Sends the next part of a large snapshot on a later turn of the event
   * loop, after checking the recipient again. A seat removed between two
   * parts gets no more of them.
   */
  private continueTransfer(subscription: Subscription, generation: number): void {
    setImmediate(() => {
      const transfer = subscription.transfer;
      if (
        subscription.dropped ||
        subscription.generation !== generation ||
        !transfer
      ) {
        return;
      }
      if (this.refresh(subscription) !== "live") return;
      if (!this.hasRoom(subscription)) return;
      this.emit(subscription, transfer.frames[transfer.next]);
      transfer.next += 1;
      if (transfer.next < transfer.frames.length) {
        this.continueTransfer(subscription, generation);
        return;
      }
      subscription.transfer = null;
      const backlog = subscription.backlog;
      subscription.backlog = [];
      for (const frame of backlog) this.emit(subscription, frame);
    });
  }

  private streamQuery(
    subscription: Subscription,
    request: QueryRequest,
    text: string,
  ): void {
    // Characters, not bytes: a slice must not split a UTF-16 pair's bytes.
    const size = Math.max(1, Math.floor(this.limits.chunkBytes / 3));
    const total = Math.ceil(text.length / size);
    const generation = subscription.generation;
    const send = (part: number): void => {
      setImmediate(() => {
        const base = {
          subscription: subscription.id,
          generation,
          serverNowMs: this.now(),
          request: request.request,
        };
        // Access is checked again before each part leaves.
        const allowed =
          !subscription.dropped &&
          subscription.generation === generation &&
          this.refresh(subscription) === "live" &&
          subscription.instance.mayQuery(
            subscription.actor,
            request.query,
            this.now(),
          );
        if (!allowed) {
          if (!subscription.dropped) {
            this.emit(subscription, { ...base, kind: "queryAbort" });
          }
          return;
        }
        this.emit(subscription, {
          ...base,
          kind: "query",
          part,
          last: part === total - 1,
          data: text.slice(part * size, (part + 1) * size),
        });
        if (part < total - 1) send(part + 1);
      });
    };
    send(0);
  }

  /**
   * Whether the socket can take another frame. One that has fallen behind is
   * marked lagging and caught up later with a fresh snapshot. One whose queue
   * is full is disconnected: it is too far behind for any signalling.
   */
  private hasRoom(subscription: Subscription): boolean {
    const pressure = this.options.pressure(subscription.socket);
    if (
      pressure.packets > this.limits.socketHardPackets ||
      pressure.bytes > this.limits.socketHardBytes
    ) {
      this.stats.disconnects += 1;
      const socket = subscription.socket;
      this.dropSocket(socket.id);
      socket.disconnect(true);
      return false;
    }
    if (
      pressure.packets > this.limits.socketSoftPackets ||
      pressure.bytes > this.limits.socketSoftBytes
    ) {
      subscription.lagging = true;
      subscription.transfer = null;
      subscription.backlog = [];
      this.scheduleLagCheck();
      return false;
    }
    return true;
  }

  private scheduleLagCheck(): void {
    if (this.closed || this.lagTimer) return;
    this.lagTimer = setTimeout(() => {
      this.lagTimer = null;
      for (const subscriptions of [...this.bySocket.values()]) {
        for (const subscription of [...subscriptions.values()]) {
          if (!subscription.lagging) continue;
          if (this.refresh(subscription) !== "live") continue;
          // Sends a fresh snapshot, or marks it lagging again.
          this.regenerate(subscription, subscription.actor);
          if (!subscription.lagging && !subscription.dropped) {
            this.stats.resnapshots += 1;
          }
        }
      }
    }, this.limits.lagRecheckMs);
    this.lagTimer.unref?.();
  }

  private emit(subscription: Subscription, frame: AuthorityFrame): void {
    if (frame.kind === "patch") this.stats.patches += 1;
    subscription.socket.emit(AUTHORITY_EVENTS.frame, frame);
  }

  private revoke(subscription: Subscription, reason: AuthorityRevokeReason): void {
    if (subscription.dropped) return;
    this.drop(subscription);
    if (!subscription.socket.connected) return;
    this.stats.revokes += 1;
    // Carries no data, so it is safe for any socket that held the view.
    subscription.socket.emit(AUTHORITY_EVENTS.frame, {
      kind: "revoke",
      subscription: subscription.id,
      generation: subscription.generation,
      serverNowMs: this.now(),
      reason,
    } satisfies AuthorityFrame);
  }

  private drop(subscription: Subscription): void {
    subscription.dropped = true;
    subscription.transfer = null;
    subscription.backlog = [];
    this.byInstance.get(subscription.instance)?.delete(subscription);
    const subscriptions = this.bySocket.get(subscription.socket.id);
    subscriptions?.delete(subscription.id);
    if (subscriptions?.size === 0) this.bySocket.delete(subscription.socket.id);
  }

  /* ---- Timers ------------------------------------------------------------ */

  /** One timer for the room, set to the earliest deadline of any app. */
  private armWake(): void {
    if (this.closed) return;
    let earliest: number | null = null;
    for (const instance of this.instances.values()) {
      const due = instance.nextTimerAt();
      if (due !== null && (earliest === null || due < earliest)) earliest = due;
    }
    if (earliest === this.wakeAt && this.wakeTimer) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = earliest;
    if (earliest === null) return;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeAt = null;
        this.wake();
      },
      Math.max(0, earliest - this.now()),
    );
    this.wakeTimer.unref?.();
  }

  private wake(): void {
    if (this.closed || !this.options.isLive()) return;
    this.syncPolicy();
    const now = this.now();
    let changed = false;
    for (const instance of this.instances.values()) {
      changed = instance.runDueTimers(now) || changed;
    }
    // A deadline people are watching should not wait out the interval.
    if (changed) this.scheduleFlush(true);
    this.armWake();
  }

  /** The server clock, never running backwards. */
  private now(): number {
    this.lastNow = Math.max(this.lastNow, Date.now());
    return this.lastNow;
  }
}
