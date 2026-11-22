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
  type AuthorityGrants,
  type AuthorityResult,
  type AuthorityRevokeReason,
  type CapabilitiesRequest,
  type Json,
  type ProjectedRow,
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
import type { HeldRows, LiveAudiences, SizedRow, ViewOps } from "./views.js";

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
  /**
   * A snapshot in parts on its way: the parts, the next to send, and what
   * the parts sent so far carried. Nothing else is sent until the last part
   * has gone, and then one catch-up from what was carried to the view now.
   */
  transfer: {
    frames: ReplaceFrame[];
    next: number;
    /** Parts sent so far, which numbers the next one. */
    sent: number;
    held: HeldRows;
  } | null;
  /** The socket fell behind. Patches are skipped until it is replaced. */
  lagging: boolean;
  /**
   * The version of the app's views its last snapshot was read at. A flush
   * tells it only what changed after that.
   */
  viewVersion: number;
  /** What it was last told it may do, to send that again only when it changes. */
  grantsSent: string;
  /** The room's policy changed, so what it may do is worked out again. */
  grantsDue: boolean;
  /**
   * Its view version: how many times its view, and nothing else, has fully
   * caught up with a change. Frames carry it, and an action's answer names
   * the one that shows the action.
   */
  viewRevision: number;
  /** A version an answer named that has yet to be sent. */
  promised: number;
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

/** The longest delay a Node timer counts. It runs a longer one after 1 ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const samePolicy = (a: RoomPolicy, b: RoomPolicy): boolean =>
  a.mode === b.mode && a.qaEnabled === b.qaEnabled;

const sameActor = (a: Actor, b: Actor): boolean =>
  a.subject === b.subject && a.role === b.role && a.verified === b.verified;

/** Notes the rows a part of a snapshot carried, as it carried them. */
const carried = (held: HeldRows, part: ReplaceFrame): void => {
  for (const row of part.rows) {
    const rows = held.get(row.bucket);
    if (rows) rows.set(row.key, row.value);
    else held.set(row.bucket, new Map([[row.key, row.value]]));
  }
};

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
  private pruneTimer: NodeJS.Timeout | null = null;
  /** Apps a viewer has left since their unheld views were last forgotten. */
  private readonly left = new Set<AuthorityInstance>();
  /** Apps whose viewers are due a word on what they may now do. */
  private readonly grantsDue = new Set<AuthorityInstance>();
  /** Apps with a view version promised to someone and not yet sent. */
  private readonly promising = new Set<AuthorityInstance>();
  /** Streamed results waiting for their socket to catch up. */
  private readonly stalled = new Set<NodeJS.Timeout>();
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
      lagging: false,
      viewVersion: 0,
      grantsSent: "",
      grantsDue: false,
      viewRevision: 0,
      promised: 0,
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
    const { instance, actor } = subscription;
    const writesBefore = instance.writes;
    const result = instance.act(
      actor,
      request.action,
      request.input,
      request.operation,
      this.now(),
    );
    this.afterWrite(instance);
    if (!result.ok) return result;
    const wrote = instance.writes > writesBefore;
    return { ...result, revision: this.answerRevision(subscription, wrote) };
  }

  /**
   * The view version an answer names: the one the actor's view will have
   * once it shows what they did. It depends on nothing but their own view
   * and their own action, so it says nothing of what others did out of their
   * sight. An action that wrote something gets the next version, and that
   * version is sent at the next flush whatever the write turned out to change
   * in their view, so it is always reached. One that wrote nothing, a replay
   * among them, gets the version they hold, or one already promised.
   */
  private answerRevision(subscription: Subscription, wrote: boolean): number {
    if (wrote) {
      subscription.promised = subscription.viewRevision + 1;
      this.promising.add(subscription.instance);
      this.scheduleFlush(false);
    }
    return Math.max(subscription.viewRevision, subscription.promised);
  }

  /**
   * The view version a frame brings a subscription to. It moves on only when
   * the frame completes what is owed to the view: rows changed, or a version
   * an answer promised. Removals from a large clear still to come hold it
   * back, so a client that reached an answer's version holds all of it.
   */
  private nextRevision(subscription: Subscription, changed: boolean): number {
    const { viewRevision, promised, instance, actor } = subscription;
    if (!changed && promised <= viewRevision) return viewRevision;
    return instance.owes(actor) ? viewRevision : viewRevision + 1;
  }

  query(context: ConnectionContext, request: QueryRequest): QueryReply {
    const target = this.target(context, request);
    if (!target.ok) return target;
    const { subscription } = target;
    // A result can be a megabyte. A socket that is not keeping up is sent
    // none until it has caught up.
    const congestion = this.congestion(subscription.socket);
    if (congestion === "full") this.disconnect(subscription.socket);
    if (congestion !== "clear") {
      return failure("busy", { retryAfterMs: this.limits.lagRecheckMs });
    }
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
    for (const timer of [
      this.flushTimer,
      this.sweepTimer,
      this.wakeTimer,
      this.lagTimer,
      this.pruneTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.flushTimer = this.sweepTimer = this.wakeTimer = this.lagTimer = null;
    this.pruneTimer = null;
    this.left.clear();
    for (const timer of this.stalled) clearTimeout(timer);
    this.stalled.clear();
    this.bySocket.clear();
    this.byInstance.clear();
    this.watchers.clear();
    this.instances.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** How many audiences' views are kept, across the room's apps. */
  get viewsHeld(): { roles: number; subjects: number } {
    const held = { roles: 0, subjects: 0 };
    for (const instance of this.instances.values()) {
      const { roles, subjects } = instance.viewsHeld;
      held.roles += roles;
      held.subjects += subjects;
    }
    return held;
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
   * when the room's policy or the seat's role or identity changed, so a
   * promoted host gets the host's rows at once and a demoted one loses them.
   * Every path that sends later than the request that asked, such as the
   * next part of a snapshot or of a query result, goes through here first.
   */
  private refresh(subscription: Subscription): "live" | "replaced" | "gone" {
    if (subscription.dropped) return "gone";
    const generation = subscription.generation;
    this.syncPolicy();
    if (subscription.dropped) return "gone";
    if (subscription.generation !== generation) return "replaced";
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

  /**
   * Applies a changed room policy. Each app projects its rows again, and a
   * viewer who may still see the app is sent only what came out different
   * for them, with what they may now do. A switch that changes nobody's
   * view, such as one that only decides who may take part, sends no rows:
   * in a room of 5,000 it is 5,000 small frames and not 5,000 whole views.
   */
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
        } else if (
          // A snapshot still on its way was built under the old policy, and
          // may hold rows this viewer may no longer see: it starts over.
          subscription.transfer ||
          !sameActor(subscription.actor, bound.actor)
        ) {
          this.regenerate(subscription, bound.actor);
        } else {
          subscription.grantsDue = true;
        }
      }
      this.grantsDue.add(instance);
      this.scheduleFlush(true);
    }
  }

  /** What a viewer may now do, if that is not what they were last told. */
  private changedGrants(subscription: Subscription): AuthorityGrants | undefined {
    subscription.grantsDue = false;
    const grants = subscription.instance.grants(subscription.actor, this.now());
    const sent = JSON.stringify(grants);
    if (sent === subscription.grantsSent) return undefined;
    subscription.grantsSent = sent;
    return grants;
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

      const changes = instance.flushViews(this.audiencesOf(instance));
      this.left.delete(instance);
      const grantsDue = this.grantsDue.delete(instance);
      const promised = this.promising.delete(instance);
      if (
        changes.shared.size === 0 &&
        changes.personal.size === 0 &&
        !grantsDue &&
        !promised
      ) {
        continue;
      }
      for (const subscription of [...subscriptions]) {
        // One whose snapshot is still in parts is caught up after its last
        // part, from what the parts carried. Nothing is held for it here.
        if (subscription.transfer) continue;
        // Each is told from its own snapshot on: a change that snapshot
        // already had, or a row gone before it was read, is not sent.
        const shared = changes.shared
          .get(subscription.actor.role)
          ?.for(subscription.viewVersion);
        const personal = changes.personal
          .get(subscription.actor.subject)
          ?.for(subscription.viewVersion);
        const grants = subscription.grantsDue
          ? this.changedGrants(subscription)
          : undefined;
        const revision = this.nextRevision(subscription, Boolean(shared || personal));
        if (shared || personal || grants || revision !== subscription.viewRevision) {
          this.sendPatch(subscription, shared, personal, grants, revision);
        }
        // Held back by removals still owed: sent with the flush that ends them.
        if (subscription.promised > subscription.viewRevision) this.promising.add(instance);
      }
    }
    // A large clear is told to its viewers a batch per flush.
    for (const instance of this.instances.values()) {
      if (instance.hasPendingChanges) {
        this.scheduleFlush(false);
        break;
      }
    }
  }

  /** The roles and subjects that hold a view of the app right now. */
  private audiencesOf(instance: AuthorityInstance): LiveAudiences {
    const roles = new Set<Role>();
    const subjects = new Set<Subject>();
    for (const subscription of this.byInstance.get(instance) ?? []) {
      roles.add(subscription.actor.role);
      subjects.add(subscription.actor.subject);
    }
    return { roles, subjects };
  }

  /**
   * A viewer left an app, or changed role. Once nobody holds an audience's
   * view it is forgotten, at the pace of a flush and whether or not the room
   * ever writes again, so a quiet room does not keep the views of everyone
   * who has passed through it.
   */
  private viewerLeft(instance: AuthorityInstance): void {
    if (this.closed) return;
    this.left.add(instance);
    if (this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      for (const left of this.left) left.keepViews(this.audiencesOf(left));
      this.left.clear();
    }, this.limits.flushIntervalMs);
    this.pruneTimer.unref?.();
  }

  private sendPatch(
    subscription: Subscription,
    shared: ViewOps | undefined,
    personal: ViewOps | undefined,
    grants: AuthorityGrants | undefined,
    revision: number,
  ): void {
    // A lagging subscription is caught up by a whole replacement later, and
    // one with a snapshot in parts by its catch-up after the last part.
    if (subscription.lagging || subscription.dropped || subscription.transfer) return;
    if (!this.hasRoom(subscription)) return;

    const bytes = (shared?.bytes ?? 0) + (personal?.bytes ?? 0);
    if (bytes > this.limits.patchBytes) {
      this.regenerate(subscription, subscription.actor);
      return;
    }
    subscription.seq += 1;
    subscription.viewRevision = revision;
    this.emit(subscription, {
      kind: "patch",
      subscription: subscription.id,
      generation: subscription.generation,
      serverNowMs: this.now(),
      seq: subscription.seq,
      put: [...(shared?.put ?? []), ...(personal?.put ?? [])],
      remove: [...(shared?.remove ?? []), ...(personal?.remove ?? [])],
      revision,
      ...(grants ? { grants } : {}),
    });
  }

  /** A whole view under a new generation. */
  private regenerate(subscription: Subscription, actor: Actor): void {
    if (
      subscription.actor.role !== actor.role ||
      subscription.actor.subject !== actor.subject
    ) {
      this.viewerLeft(subscription.instance);
    }
    subscription.actor = actor;
    subscription.generation += 1;
    this.sendReplace(subscription);
  }

  private sendReplace(subscription: Subscription): void {
    subscription.seq = 0;
    subscription.transfer = null;
    subscription.lagging = false;
    if (!this.hasRoom(subscription)) return;

    const { rows, version } = subscription.instance.snapshot(subscription.actor);
    subscription.viewVersion = version;
    const bytes = rows.reduce((total, sized) => total + sized.bytes, 0);
    if (bytes > this.limits.snapshotBytes) {
      this.revoke(subscription, "too-large");
      return;
    }
    // A whole view as committed now: it shows whatever was owed.
    subscription.viewRevision += 1;
    const now = this.now();
    const grants = subscription.instance.grants(subscription.actor, now);
    subscription.grantsSent = JSON.stringify(grants);
    subscription.grantsDue = false;
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
        ...(index === 0 ? { grants, revision: subscription.viewRevision } : {}),
      }),
    );
    this.stats.replaces += 1;
    this.emit(subscription, frames[0]);
    if (frames.length === 1) return;
    const held: HeldRows = new Map();
    carried(held, frames[0]);
    subscription.transfer = { frames, next: 1, sent: 1, held };
    this.continueTransfer(subscription, subscription.generation);
  }

  /**
   * The rows of a later part of a snapshot, as they may be sent now. The
   * parts were all cut from one view when the snapshot began, and a part
   * waits a turn or more for its place. A row that has been hidden in the
   * meantime is left out, and one that has changed goes as it is now, so no
   * part carries what was withdrawn before it left. A row can have grown, so
   * the part is cut to the part size again: what does not fit is returned,
   * to go in the part after. The catch-up after the last part brings the
   * viewer the rest of what changed.
   */
  private asCommitted(
    subscription: Subscription,
    planned: ProjectedRow[],
  ): { rows: ProjectedRow[]; rest: ProjectedRow[] } {
    const view = subscription.instance.committedView(subscription.actor);
    const rows: ProjectedRow[] = [];
    let bytes = 0;
    for (let index = 0; index < planned.length; index += 1) {
      const row = planned[index];
      const value = view.get(row.bucket, row.key);
      if (value === undefined) continue;
      const size = view.bytes(row.bucket, row.key);
      // At least one row a part, as when the parts were first cut.
      if (rows.length > 0 && bytes + size > this.limits.chunkBytes) {
        return { rows, rest: planned.slice(index) };
      }
      rows.push(value === row.value ? row : { ...row, value });
      bytes += size;
    }
    return { rows, rest: [] };
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
      const planned = transfer.frames[transfer.next];
      const { rows, rest } = this.asCommitted(subscription, planned.rows);
      if (rest.length > 0) transfer.frames[transfer.next] = { ...planned, rows: rest };
      else transfer.next += 1;
      const part: ReplaceFrame = {
        ...planned,
        serverNowMs: this.now(),
        part: transfer.sent,
        last: transfer.next === transfer.frames.length,
        rows,
      };
      transfer.sent += 1;
      this.emit(subscription, part);
      carried(transfer.held, part);
      if (transfer.next < transfer.frames.length) {
        this.continueTransfer(subscription, generation);
        return;
      }
      subscription.transfer = null;
      this.catchUp(subscription, transfer.held);
    });
  }

  /**
   * Tells a viewer whose snapshot's last part has just gone what changed
   * while the parts were on their way: what the parts carried, set against
   * their view as committed now. It is one patch, read at this moment, so it
   * never sends a row older than one the viewer already has, nor one their
   * view no longer has. A socket that is behind is sent nothing, and gets a
   * whole view once it drains, like any other frame that finds it so.
   */
  private catchUp(subscription: Subscription, held: HeldRows): void {
    const { ops, version } = subscription.instance.catchUp(subscription.actor, held);
    subscription.viewVersion = version;
    const grants = subscription.grantsDue ? this.changedGrants(subscription) : undefined;
    const changed = ops.put.length > 0 || ops.remove.length > 0;
    const revision = this.nextRevision(subscription, changed);
    if (!changed && !grants && revision === subscription.viewRevision) return;
    this.sendPatch(subscription, ops, undefined, grants, revision);
  }

  /**
   * Sends a large result in parts, each on a later turn of the event loop.
   * Access is checked again before each part leaves. A part waits while the
   * socket is behind, so the result reaches a slow reader at the reader's
   * pace, and the result is cut off if the socket stays behind.
   */
  private streamQuery(
    subscription: Subscription,
    request: QueryRequest,
    text: string,
  ): void {
    // Characters, not bytes: a slice must not split a UTF-16 pair's bytes.
    const size = Math.max(1, Math.floor(this.limits.chunkBytes / 3));
    const total = Math.ceil(text.length / size);
    const generation = subscription.generation;
    const base = () => ({
      subscription: subscription.id,
      generation,
      serverNowMs: this.now(),
      request: request.request,
    });
    const abort = (): void => {
      if (subscription.dropped) return;
      this.emit(subscription, { ...base(), kind: "queryAbort" });
    };
    const send = (part: number, waitedMs: number): void => {
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
        abort();
        return;
      }
      const congestion = this.congestion(subscription.socket);
      if (congestion === "full") {
        this.disconnect(subscription.socket);
        return;
      }
      if (congestion === "behind") {
        if (waitedMs >= this.limits.queryStallMs) {
          abort();
          return;
        }
        const wait = this.limits.lagRecheckMs;
        const timer = setTimeout(() => {
          this.stalled.delete(timer);
          send(part, waitedMs + wait);
        }, wait);
        timer.unref?.();
        this.stalled.add(timer);
        return;
      }
      this.emit(subscription, {
        ...base(),
        kind: "query",
        part,
        last: part === total - 1,
        data: text.slice(part * size, (part + 1) * size),
      });
      if (part < total - 1) setImmediate(() => send(part + 1, 0));
    };
    setImmediate(() => send(0, 0));
  }

  /** How far a socket's unsent queue has grown. */
  private congestion(socket: Socket): "clear" | "behind" | "full" {
    const pressure = this.options.pressure(socket);
    if (
      pressure.packets > this.limits.socketHardPackets ||
      pressure.bytes > this.limits.socketHardBytes
    ) {
      return "full";
    }
    if (
      pressure.packets > this.limits.socketSoftPackets ||
      pressure.bytes > this.limits.socketSoftBytes
    ) {
      return "behind";
    }
    return "clear";
  }

  /** Ends a socket whose queue is full: too far behind for any signalling. */
  private disconnect(socket: Socket): void {
    this.stats.disconnects += 1;
    this.dropSocket(socket.id);
    socket.disconnect(true);
  }

  /**
   * Whether the socket can take another frame of this view. One that has
   * fallen behind is marked lagging and caught up later with a fresh
   * snapshot. One whose queue is full is disconnected.
   */
  private hasRoom(subscription: Subscription): boolean {
    const congestion = this.congestion(subscription.socket);
    if (congestion === "full") {
      this.disconnect(subscription.socket);
      return false;
    }
    if (congestion === "behind") {
      subscription.lagging = true;
      subscription.transfer = null;
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
    this.byInstance.get(subscription.instance)?.delete(subscription);
    const subscriptions = this.bySocket.get(subscription.socket.id);
    subscriptions?.delete(subscription.id);
    if (subscriptions?.size === 0) this.bySocket.delete(subscription.socket.id);
    this.viewerLeft(subscription.instance);
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
      // A deadline further off wakes the room early, finds nothing due and
      // arms the rest of the wait.
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - this.now())),
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
