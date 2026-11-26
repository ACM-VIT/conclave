import type {
  ActionInput,
  ActionName,
  ActionReceipt,
  AuthorityContract,
  QueryInput,
  QueryName,
  QueryOutput,
  ViewName,
  ViewRow,
} from "#authority/contract";
import type { Json } from "#authority/schema";
import {
  AUTHORITY_EVENTS,
  AUTHORITY_LIMITS,
  AUTHORITY_PROTOCOL,
  type ActRequest,
  type AuthorityAppEntry,
  type AuthorityCapability,
  type AuthorityFailure,
  type AuthorityFailureCode,
  type AuthorityFrame,
  type AuthorityGrants,
  type AuthorityResult,
  type AuthorityRevokeReason,
  type CapabilitiesRequest,
  type OperationId,
  type ProjectedRow,
  type QueryReply,
  type QueryRequest,
  type ReplaceFrame,
  type SubscribeRequest,
} from "#authority/wire";

type SocketListener = (...args: unknown[]) => void;

/** The part of a socket.io client socket this needs. */
export type AuthoritySocket = {
  readonly connected: boolean;
  on(event: string, listener: SocketListener): unknown;
  off(event: string, listener: SocketListener): unknown;
  emit(event: string, ...args: unknown[]): unknown;
};

export type AuthorityClientOptions = {
  socket: AuthoritySocket;
  /** How long to wait for an ack before treating it as lost. */
  ackTimeoutMs?: number;
  now?: () => number;
  /**
   * Whether the socket is in its room already. A client made before the
   * join asks nothing until `joined` is called. True when left out.
   */
  joined?: boolean;
};

export type CapabilityState =
  /** Not answered yet. Apps stay hidden. */
  | { kind: "unknown" }
  /** The server has no authority runtime, or none this client speaks. */
  | { kind: "unsupported" }
  | { kind: "ready"; capability: AuthorityCapability };

export type AuthorityView<C extends AuthorityContract> = {
  readonly [K in ViewName<C>]: ReadonlyMap<string, ViewRow<C, K>>;
};

export type AuthoritySessionState<C extends AuthorityContract> =
  /** This server does not offer the app to this connection. */
  | { kind: "unsupported" }
  | { kind: "connecting" }
  /** The server withdrew the view. Everything held was forgotten. */
  | { kind: "revoked"; reason: AuthorityRevokeReason }
  | {
      kind: "ready";
      view: AuthorityView<C>;
      /** What this connection may call. The server checks again on use. */
      actions: ReadonlySet<ActionName<C>>;
      /** Actions refused only for want of a verified identity. */
      needsIdentity: ReadonlySet<ActionName<C>>;
      queries: ReadonlySet<QueryName<C>>;
      /**
       * The view's own version, which only ever goes up. An action's answer
       * names one, and once this has reached it the view shows the action.
       */
      revision: number;
      /** The server's clock, for countdowns that ignore local skew. */
      serverNowMs(): number;
    };

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const NOT_JOINED_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];
const RETRY_PAUSE_MS = 400;
/** The first wait before a refused subscribe is asked again, doubling each time. */
const SUBSCRIBE_RETRY_MS = 500;
const SUBSCRIBE_RETRY_MAX_MS = 30_000;
const NONCE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const randomId = (length = 20): string => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  return id;
};

const failure = (code: AuthorityFailureCode): AuthorityFailure => ({
  ok: false,
  code,
});

const LOST = Symbol("lost");

type Listener = () => void;

type ActionLifetime = {
  ended: "forbidden" | "unknown-outcome" | null;
  waits: Set<Listener>;
};

const actionLifetime = (): ActionLifetime => ({ ended: null, waits: new Set() });

/** Codes that mean "ask again once the view is back", not "refused". */
const RESUBSCRIBE_CODES: ReadonlySet<AuthorityFailureCode> = new Set([
  "stale-generation",
  "not-subscribed",
  "stale-epoch",
  "not-in-room",
]);

/**
 * The client half of the authority transport for one socket: the capability
 * exchange, and one session per app. React-free, so the web hook, tests and
 * a native embed share it.
 */
export class AuthorityClient {
  private state: CapabilityState = { kind: "unknown" };
  private readonly listeners = new Set<Listener>();
  private readonly sessions = new Map<string, AuthoritySession<AuthorityContract>>();
  private readonly socket: AuthoritySocket;
  private readonly ackTimeoutMs: number;
  private readonly localNow: () => number;
  private negotiation = 0;
  private notJoinedAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The app said it left its room. Nothing is asked until it rejoins. */
  private away: boolean;
  private disposed = false;
  /** The server's clock less this one's, as its capability answer told it. */
  private offsetMs: number | null = null;

  constructor(options: AuthorityClientOptions) {
    this.away = options.joined === false;
    this.socket = options.socket;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.localNow = options.now ?? (() => Date.now());
    this.socket.on(AUTHORITY_EVENTS.frame, this.onFrame);
    this.socket.on(AUTHORITY_EVENTS.capabilitiesChanged, this.onCapabilitiesChanged);
    this.socket.on("connect", this.onConnect);
    this.socket.on("disconnect", this.onDisconnect);
    if (this.socket.connected) this.refresh();
  }

  get capabilities(): CapabilityState {
    return this.state;
  }

  /** The server's clock less this one's, from its last capability answer, if any. */
  get serverOffsetMs(): number | null {
    return this.offsetMs;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The server's entry for an app this client can render, if offered. */
  entryFor(contract: AuthorityContract): AuthorityAppEntry | null {
    if (this.state.kind !== "ready") return null;
    return (
      this.state.capability.apps.find(
        (entry) => entry.app === contract.id && entry.major === contract.major,
      ) ?? null
    );
  }

  /**
   * Asks the server what it offers. Call after joining a room; it is also
   * called on every reconnect. A server that never answers is one without
   * the runtime, and every app stays hidden.
   */
  refresh(): void {
    if (this.disposed || this.away || !this.socket.connected) return;
    this.clearRetry();
    const attempt = ++this.negotiation;
    const request: CapabilitiesRequest = { protocols: [AUTHORITY_PROTOCOL] };
    void this.request<AuthorityResult<AuthorityCapability>>(
      AUTHORITY_EVENTS.capabilities,
      request,
    ).then((reply) => {
      if (this.disposed || attempt !== this.negotiation) return;
      if (reply === LOST) {
        this.setCapabilities({ kind: "unsupported" });
        return;
      }
      if (reply.ok) {
        this.notJoinedAttempts = 0;
        if (Number.isFinite(reply.value.serverNowMs)) {
          this.offsetMs = reply.value.serverNowMs - this.localNow();
        }
        this.setCapabilities({ kind: "ready", capability: reply.value });
        return;
      }
      if (reply.code === "not-in-room" || reply.code === "rate-limited") {
        // Asked before the join finished. Try again shortly.
        const wait = NOT_JOINED_RETRY_MS[this.notJoinedAttempts];
        if (wait !== undefined) {
          this.notJoinedAttempts += 1;
          this.retryTimer = setTimeout(() => this.refresh(), wait);
          return;
        }
      }
      this.setCapabilities({ kind: "unsupported" });
    });
  }

  /** Starts a new attempt budget. Call when the room is (re)joined. */
  joined(): void {
    this.away = false;
    this.notJoinedAttempts = 0;
    this.refresh();
  }

  /**
   * Call when the room is left on a socket that stays open. Every view is
   * forgotten, and nothing the room left behind still sends is taken up,
   * until `joined` is called again.
   */
  left(): void {
    if (this.away) return;
    this.away = true;
    this.negotiation += 1;
    this.clearRetry();
    this.setCapabilities({ kind: "unknown" });
  }

  open<C extends AuthorityContract>(contract: C): AuthoritySession<C> {
    let session = this.sessions.get(contract.id);
    if (!session) {
      session = new AuthoritySession<AuthorityContract>(this, contract);
      this.sessions.set(contract.id, session);
    }
    session.retain();
    return session as unknown as AuthoritySession<C>;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRetry();
    this.socket.off(AUTHORITY_EVENTS.frame, this.onFrame);
    this.socket.off(AUTHORITY_EVENTS.capabilitiesChanged, this.onCapabilitiesChanged);
    this.socket.off("connect", this.onConnect);
    this.socket.off("disconnect", this.onDisconnect);
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.listeners.clear();
  }

  /* ---- Used by sessions -------------------------------------------------- */

  /** @internal */
  forget(session: AuthoritySession<AuthorityContract>): void {
    if (this.sessions.get(session.contract.id) === session) {
      this.sessions.delete(session.contract.id);
    }
  }

  /** @internal Emits with an ack, resolving `LOST` when none arrives. */
  request<Reply>(
    event: string,
    payload: unknown,
    within = Number.POSITIVE_INFINITY,
    lifetime?: ActionLifetime,
  ): Promise<Reply | typeof LOST> {
    return new Promise((resolve) => {
      if (!this.socket.connected || within <= 0 || lifetime?.ended) {
        resolve(LOST);
        return;
      }
      let settled = false;
      const finish = (result: Reply | typeof LOST) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifetime?.waits.delete(lost);
        resolve(result);
      };
      const lost = () => finish(LOST);
      const timer = setTimeout(lost, Math.max(0, Math.min(this.ackTimeoutMs, within)));
      lifetime?.waits.add(lost);
      this.socket.emit(event, payload, (reply: unknown) => finish(reply as Reply));
    });
  }

  /** @internal */
  send(event: string, payload: unknown): void {
    if (this.socket.connected) this.socket.emit(event, payload);
  }

  /** @internal */
  now(): number {
    return this.localNow();
  }

  /* ---- Socket events ----------------------------------------------------- */

  private readonly onFrame: SocketListener = (frame) => {
    if (!isFrame(frame)) return;
    for (const session of this.sessions.values()) session.receive(frame);
  };

  private readonly onCapabilitiesChanged: SocketListener = (payload) => {
    const capability = payload as Partial<AuthorityCapability> | null;
    if (
      this.away ||
      capability?.protocol !== AUTHORITY_PROTOCOL ||
      typeof capability.roomEpoch !== "string" ||
      !Array.isArray(capability.apps)
    ) {
      return;
    }
    this.negotiation += 1;
    this.setCapabilities({
      kind: "ready",
      capability: capability as AuthorityCapability,
    });
  };

  private readonly onConnect: SocketListener = () => {
    this.notJoinedAttempts = 0;
    this.refresh();
  };

  private readonly onDisconnect: SocketListener = () => {
    this.negotiation += 1;
    this.clearRetry();
    this.setCapabilities({ kind: "unknown" });
  };

  private setCapabilities(next: CapabilityState): void {
    this.state = next;
    for (const session of this.sessions.values()) session.capabilitiesChanged();
    for (const listener of [...this.listeners]) listener();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

type Rows = Map<string, ReadonlyMap<string, Json>>;

/**
 * One app's view on one socket: subscribes, applies frames, and sends actions
 * and queries. It holds exactly what the server sent it and nothing else.
 */
export class AuthoritySession<C extends AuthorityContract> {
  private state: AuthoritySessionState<C> = { kind: "connecting" };
  private readonly listeners = new Set<Listener>();
  private readonly readyWaiters = new Set<Listener>();
  private actionLifetime = actionLifetime();
  private readonly streams = new Map<
    string,
    { generation: number; parts: string[]; settle(result: AuthorityResult<Json>): void }
  >();
  private refs = 0;
  private closed = false;
  private subscription: string | null = null;
  private subscribedEpoch: string | null = null;
  private generation = 0;
  private seq = 0;
  private incoming: { generation: number; frames: ReplaceFrame[] } | null = null;
  private rows: Rows = new Map();
  private revision = 0;
  /**
   * The server counts a view's versions per subscription, from one. What the
   * subscriptions before this one reached is added on, so the version shown
   * here only ever goes up, and an answer is read the same way.
   */
  private revisionBase = 0;
  private revisionOf: string | null = null;
  private clockOffsetMs = 0;
  /** A frame has told this session the server's time. */
  private clockKnown = false;
  /** Refused subscribes in a row, for how long to wait before the next. */
  private refusals = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartEpoch: string | null = null;

  constructor(
    private readonly client: AuthorityClient,
    readonly contract: C,
  ) {
    this.capabilitiesChanged();
  }

  getState = (): AuthoritySessionState<C> => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** @internal */
  retain(): void {
    this.refs += 1;
  }

  /** Ends this holder's use. The subscription closes with the last one. */
  release(): void {
    this.refs -= 1;
    if (this.refs > 0) return;
    this.close();
    this.client.forget(this);
  }

  /** @internal */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endActions("unknown-outcome");
    this.clearRestart();
    this.unsubscribe();
    this.failStreams();
    this.listeners.clear();
  }

  /**
   * Sends an action and resolves with the server's answer. If the answer is
   * lost, or the view is being replaced, the same operation id is sent again
   * until it is answered or the id expires, so one press is one action however
   * many times it is sent. A resend stays in the room the action was first
   * sent to: if the socket is in another room by then, or the room was
   * recreated, the action ends as `unknown-outcome`.
   */
  async act<K extends ActionName<C>>(
    action: K,
    input: ActionInput<C, K>,
  ): Promise<AuthorityResult<ActionReceipt<C, K>>> {
    // Stamped once the view is in, so with the server's clock as it is told.
    let operation: OperationId | null = null;
    const deadline =
      this.client.now() + AUTHORITY_LIMITS.operationMaxAgeMs - RETRY_PAUSE_MS * 4;
    let sentToEpoch: string | null = null;
    let mayHaveRun = false;
    const lifetime = this.actionLifetime;
    const timeLeft = () => deadline - this.client.now();
    const waitWithin = (ms: number) => pause(Math.min(ms, timeLeft()), lifetime);
    const unanswered = (code: AuthorityFailureCode) =>
      failure(mayHaveRun ? "unknown-outcome" : code);
    const stopped = () => {
      if (lifetime.ended) return unanswered(lifetime.ended);
      return timeLeft() <= 0 ? failure("unknown-outcome") : null;
    };

    for (;;) {
      const beforeReady = stopped();
      if (beforeReady) return beforeReady;
      // Only a view that is on its way is worth waiting for.
      if (this.state.kind === "unsupported") return unanswered("unsupported");
      if (this.state.kind === "revoked") return unanswered("forbidden");
      const ready = await this.whenReady(timeLeft(), lifetime);
      const afterReady = stopped();
      if (afterReady) return afterReady;
      if (!ready) continue;
      const epoch = this.subscribedEpoch;
      if (this.state.kind !== "ready" || !this.subscription || !epoch) continue;
      // A new room keeps no record of the operation and would run it afresh.
      if (sentToEpoch !== null && epoch !== sentToEpoch) {
        return failure("unknown-outcome");
      }
      sentToEpoch = epoch;
      operation ??= { issuedAtMs: Math.round(this.serverNow()), nonce: randomId() };

      const request: ActRequest = {
        roomEpoch: epoch,
        subscription: this.subscription,
        generation: this.generation,
        operation,
        action,
        input,
      };
      const base = this.revisionBase;
      const hadUnansweredAttempt = mayHaveRun;
      mayHaveRun = true;
      const reply = await this.client.request<AuthorityResult<Json>>(
        AUTHORITY_EVENTS.act,
        request,
        timeLeft(),
        lifetime,
      );
      const retryAfterResubscribe =
        reply !== LOST && !reply.ok && RESUBSCRIBE_CODES.has(reply.code);
      const rateLimited = reply !== LOST && !reply.ok && reply.code === "rate-limited";
      if (retryAfterResubscribe || rateLimited) mayHaveRun = hadUnansweredAttempt;
      const afterReply = stopped();
      if (afterReply) return afterReply;
      if (reply === LOST) {
        await waitWithin(RETRY_PAUSE_MS);
        continue;
      }
      if (rateLimited && mayHaveRun) {
        const wait = Math.max(RETRY_PAUSE_MS, reply.retryAfterMs ?? 0);
        if (wait >= timeLeft()) return failure("unknown-outcome");
        await waitWithin(wait);
        continue;
      }
      if (retryAfterResubscribe) {
        if (reply.code === "stale-epoch" || reply.code === "not-in-room") {
          this.client.refresh();
        }
        // The replacement view usually arrives ahead of this refusal. When
        // it has, send again at once under the new generation.
        const replaced =
          this.state.kind === "ready" && this.generation !== request.generation;
        if (!replaced) await waitWithin(RETRY_PAUSE_MS);
        continue;
      }
      const answer =
        reply.ok && reply.revision !== undefined
          ? { ...reply, revision: base + reply.revision }
          : reply;
      return answer as AuthorityResult<ActionReceipt<C, K>>;
    }
  }

  /** A one-shot read. The result goes to this caller and is not kept. */
  async query<K extends QueryName<C>>(
    query: K,
    input: QueryInput<C, K>,
  ): Promise<AuthorityResult<QueryOutput<C, K>>> {
    const epoch = this.subscribedEpoch;
    if (this.state.kind !== "ready" || !this.subscription || !epoch) {
      return failure("not-subscribed");
    }
    const generation = this.generation;
    const request: QueryRequest = {
      roomEpoch: epoch,
      subscription: this.subscription,
      generation,
      request: randomId(),
      query,
      input,
    };
    // Registered before sending: the first part can arrive before the ack.
    const streamed = new Promise<AuthorityResult<Json>>((settle) => {
      this.streams.set(request.request, { generation, parts: [], settle });
    });

    const reply = await this.client.request<QueryReply>(
      AUTHORITY_EVENTS.query,
      request,
    );
    let result: AuthorityResult<Json>;
    if (reply === LOST) result = failure("unknown-outcome");
    else if (!reply.ok) result = reply;
    else if ("streamed" in reply) result = await streamed;
    else result = { ok: true, value: reply.value };
    this.streams.delete(request.request);

    // A role change or reconnect while the read was in flight voids it.
    if (result.ok && (this.closed || this.generation !== generation)) {
      return failure("stale-generation");
    }
    return result as AuthorityResult<QueryOutput<C, K>>;
  }

  /* ---- Driven by the client --------------------------------------------- */

  /** @internal */
  capabilitiesChanged(): void {
    if (this.closed) return;
    const capabilities = this.client.capabilities;
    if (capabilities.kind === "unknown") {
      this.clearRestart();
      this.refusals = 0;
      this.reset({ kind: "connecting" });
      return;
    }
    const entry = this.client.entryFor(this.contract);
    if (!entry || capabilities.kind !== "ready") {
      this.clearRestart();
      this.refusals = 0;
      this.reset({ kind: "unsupported" });
      return;
    }
    const epoch = capabilities.capability.roomEpoch;
    if (this.subscription && this.subscribedEpoch === epoch) return;
    // Refused a moment ago in this same room: the wait already set asks again.
    if (this.restartTimer && this.restartEpoch === epoch) return;
    this.start(entry, epoch);
  }

  /** @internal */
  receive(frame: AuthorityFrame): void {
    if (this.closed || frame.subscription !== this.subscription) return;
    this.clockOffsetMs = frame.serverNowMs - this.client.now();
    this.clockKnown = true;

    if (frame.kind === "query" || frame.kind === "queryAbort") {
      this.receiveQuery(frame);
      return;
    }
    if (frame.kind === "revoke") {
      // Withdrawn: asking again would only be refused.
      this.clearRestart();
      this.subscription = null;
      this.reset({ kind: "revoked", reason: frame.reason }, { keepSubscription: true });
      return;
    }
    if (frame.generation < this.generation) return;

    if (frame.kind === "replace") {
      if (!this.incoming || this.incoming.generation !== frame.generation) {
        if (frame.part !== 0) {
          this.resubscribe();
          return;
        }
        this.incoming = { generation: frame.generation, frames: [] };
        // The view is on its way after all: a wait to ask again is moot.
        this.clearRestart();
        // A replacement means what is held may no longer be this viewer's
        // to see. When it comes in parts, forget the old view now and not
        // when the last part lands.
        if (!frame.last) {
          this.generation = frame.generation;
          this.seq = 0;
          this.rows = new Map();
          this.failStreams();
          this.setState({ kind: "connecting" });
        }
      }
      if (frame.part !== this.incoming.frames.length) {
        this.resubscribe();
        return;
      }
      this.incoming.frames.push(frame);
      if (frame.last) this.install(this.incoming.frames);
      return;
    }

    // A patch for a view not yet installed, or out of order: start over.
    if (frame.generation !== this.generation || frame.seq !== this.seq + 1) {
      this.resubscribe();
      return;
    }
    this.seq = frame.seq;
    const next: Rows = new Map(this.rows);
    const touched = new Map<string, Map<string, Json>>();
    const bucketOf = (name: string): Map<string, Json> => {
      let bucket = touched.get(name);
      if (!bucket) {
        bucket = new Map(next.get(name));
        touched.set(name, bucket);
        next.set(name, bucket);
      }
      return bucket;
    };
    for (const ref of frame.remove) bucketOf(ref.bucket).delete(ref.key);
    for (const row of frame.put) bucketOf(row.bucket).set(row.key, row.value);
    this.rows = next;
    if (frame.revision !== undefined) this.revision = this.revisionBase + frame.revision;
    if (this.state.kind === "ready") {
      this.setState({
        ...this.state,
        view: this.viewOf(next),
        revision: this.revision,
        ...(frame.grants ? grantSets(frame.grants) : {}),
      });
    }
  }

  /* ---- Internals --------------------------------------------------------- */

  private start(entry: AuthorityAppEntry, epoch: string): void {
    this.clearRestart();
    this.unsubscribe();
    this.failStreams();
    this.subscription = randomId();
    this.subscribedEpoch = epoch;
    this.generation = 0;
    this.seq = 0;
    this.incoming = null;
    this.rows = new Map();
    this.setState({ kind: "connecting" });

    const subscription = this.subscription;
    const request: SubscribeRequest = {
      roomEpoch: epoch,
      instance: entry.instance,
      app: entry.app,
      major: entry.major,
      subscription,
    };
    void this.client
      .request<AuthorityResult<null>>(AUTHORITY_EVENTS.subscribe, request)
      .then((reply) => {
        if (this.closed || this.subscription !== subscription) return;
        if (reply === LOST) {
          // Only the answer was lost when the view has come or is coming.
          // Otherwise it may yet come, and installing it cancels this, or the
          // server refused and nothing follows: ask again after a wait.
          if (this.generation === 0 && this.incoming === null) this.restartLater(epoch);
          return;
        }
        if (reply.ok) return;
        this.subscription = null;
        if (reply.code === "forbidden") {
          this.reset({ kind: "revoked", reason: "forbidden" }, { keepSubscription: true });
          return;
        }
        // Only the server's capability answer says an app is not offered.
        // Any other refusal passes: the view is still on its way, and is
        // asked for again after a wait that grows each time.
        this.reset({ kind: "connecting" }, { keepSubscription: true });
        this.restartLater(epoch);
        if (
          reply.code === "stale-epoch" ||
          reply.code === "not-in-room" ||
          reply.code === "unknown-app"
        ) {
          this.client.refresh();
        }
      });
  }

  /** Asks for the view again later, waiting longer after each refusal. */
  private restartLater(epoch: string): void {
    this.clearRestart();
    const wait = Math.min(SUBSCRIBE_RETRY_MAX_MS, SUBSCRIBE_RETRY_MS * 2 ** this.refusals);
    this.refusals += 1;
    this.restartEpoch = epoch;
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null;
        this.restartEpoch = null;
        const pointless = this.closed || this.incoming !== null || this.state.kind === "revoked";
        if (!pointless) this.resubscribe();
      },
      // Spread out, so clients refused together do not all ask again together.
      wait * (0.75 + Math.random() * 0.25),
    );
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restartEpoch = null;
  }

  /** Drops the current subscription and asks for a fresh one. */
  private resubscribe(): void {
    const entry = this.client.entryFor(this.contract);
    const capabilities = this.client.capabilities;
    if (!entry || capabilities.kind !== "ready") {
      this.reset({ kind: "connecting" });
      return;
    }
    this.start(entry, capabilities.capability.roomEpoch);
  }

  private install(frames: ReplaceFrame[]): void {
    const rows: Rows = new Map();
    const buckets = new Map<string, Map<string, Json>>();
    const put = (row: ProjectedRow): void => {
      let bucket = buckets.get(row.bucket);
      if (!bucket) {
        bucket = new Map();
        buckets.set(row.bucket, bucket);
        rows.set(row.bucket, bucket);
      }
      bucket.set(row.key, row.value);
    };
    for (const frame of frames) for (const row of frame.rows) put(row);

    this.refusals = 0;
    this.clearRestart();
    this.generation = frames[0].generation;
    this.seq = 0;
    this.incoming = null;
    this.rows = rows;
    if (frames[0].subscription !== this.revisionOf) {
      this.revisionBase = this.revision;
      this.revisionOf = frames[0].subscription;
    }
    this.revision = this.revisionBase + (frames[0].revision ?? 0);
    this.failStreams();
    this.setState({
      kind: "ready",
      view: this.viewOf(rows),
      revision: this.revision,
      ...grantSets(frames[0].grants),
      serverNowMs: () => this.serverNow(),
    });
    for (const waiter of [...this.readyWaiters]) waiter();
  }

  private viewOf(rows: Rows): AuthorityView<C> {
    const view: Record<string, ReadonlyMap<string, Json>> = {};
    for (const name of Object.keys(this.contract.views)) {
      view[name] = rows.get(name) ?? EMPTY_BUCKET;
    }
    return view as AuthorityView<C>;
  }

  private receiveQuery(
    frame: Extract<AuthorityFrame, { kind: "query" | "queryAbort" }>,
  ): void {
    const stream = this.streams.get(frame.request);
    if (!stream) return;
    if (frame.kind === "queryAbort" || frame.part !== stream.parts.length) {
      this.streams.delete(frame.request);
      stream.settle(failure("stale-generation"));
      return;
    }
    stream.parts.push(frame.data);
    if (!frame.last) return;
    this.streams.delete(frame.request);
    try {
      stream.settle({ ok: true, value: JSON.parse(stream.parts.join("")) as Json });
    } catch {
      stream.settle(failure("unknown-outcome"));
    }
  }

  private failStreams(): void {
    for (const [request, stream] of [...this.streams]) {
      this.streams.delete(request);
      stream.settle(failure("stale-generation"));
    }
  }

  private unsubscribe(): void {
    if (!this.subscription) return;
    this.client.send(AUTHORITY_EVENTS.unsubscribe, {
      subscription: this.subscription,
    });
    this.subscription = null;
  }

  /** Forgets everything held, so nothing privileged outlives its grant. */
  private reset(
    state: AuthoritySessionState<C>,
    options?: { keepSubscription?: boolean },
  ): void {
    if (!options?.keepSubscription) this.unsubscribe();
    this.subscribedEpoch = null;
    this.generation = 0;
    this.seq = 0;
    this.incoming = null;
    this.rows = new Map();
    this.failStreams();
    this.setState(state);
  }

  private setState(next: AuthoritySessionState<C>): void {
    const unchanged =
      this.state.kind === next.kind &&
      (next.kind === "connecting" || next.kind === "unsupported");
    if (unchanged) return;
    this.state = next;
    if (next.kind === "revoked") {
      this.endActions(next.reason === "forbidden" ? "forbidden" : "unknown-outcome");
      this.actionLifetime = actionLifetime();
    }
    for (const listener of [...this.listeners]) listener();
  }

  private endActions(reason: NonNullable<ActionLifetime["ended"]>): void {
    const lifetime = this.actionLifetime;
    lifetime.ended = reason;
    for (const done of lifetime.waits) done();
  }

  /** Resolves true once the view is ready, false when `timeoutMs` passes. */
  private whenReady(timeoutMs: number, lifetime: ActionLifetime): Promise<boolean> {
    if (timeoutMs <= 0 || lifetime.ended) return Promise.resolve(false);
    if (this.state.kind === "ready") return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        lifetime.waits.delete(done);
        this.readyWaiters.delete(done);
        resolve(this.state.kind === "ready" && !lifetime.ended);
      };
      const timer = setTimeout(done, Math.min(timeoutMs, 1_000));
      this.readyWaiters.add(done);
      lifetime.waits.add(done);
    });
  }

  private serverNow(): number {
    const offset = this.clockKnown ? this.clockOffsetMs : (this.client.serverOffsetMs ?? 0);
    return this.client.now() + offset;
  }
}

const EMPTY_BUCKET: ReadonlyMap<string, Json> = new Map();

/** What a viewer may do, as the sets a renderer reads. */
const grantSets = (grants: AuthorityGrants | undefined) => ({
  actions: new Set(grants?.actions ?? []),
  needsIdentity: new Set(grants?.needsIdentity ?? []),
  queries: new Set(grants?.queries ?? []),
});

const FRAME_KINDS: ReadonlySet<unknown> = new Set([
  "replace",
  "patch",
  "revoke",
  "query",
  "queryAbort",
]);

/** Enough of a shape check to route a frame. The server is the authority. */
const isFrame = (value: unknown): value is AuthorityFrame => {
  if (value === null || typeof value !== "object") return false;
  const frame = value as Partial<AuthorityFrame>;
  return (
    typeof frame.subscription === "string" &&
    typeof frame.generation === "number" &&
    FRAME_KINDS.has(frame.kind)
  );
};

const pause = (ms: number, lifetime: ActionLifetime): Promise<void> => {
  if (ms <= 0 || lifetime.ended) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      lifetime.waits.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    lifetime.waits.add(done);
  });
};
