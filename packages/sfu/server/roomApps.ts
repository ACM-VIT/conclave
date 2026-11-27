import { APP_DOCUMENT_MAX_BYTES } from "@conclave/apps-sdk/limits";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { readUpdate, updateChangesNothing, type UpdateFacts } from "./apps/documents/updateFacts.js";
import type { AppDocument, AppDocumentPool, Refusal, WorkerProposal } from "./apps/documents/pool.js";
import { Logger } from "../utilities/loggers.js";
import { RoomAppsScheduler, type Pending, type WriteOutcome } from "./roomAppsScheduler.js";

export { readUpdate } from "./apps/documents/updateFacts.js";

// A document larger than one sync response can no longer reach new joiners,
// so it is also the most a document may grow to.
export const MAX_APP_DOC_BYTES = APP_DOCUMENT_MAX_BYTES;
// A room keeps every app's document when the stage moves to another app, so
// documents are also bounded per room: by count, and by total encoded bytes.
export const MAX_ROOM_APP_DOCS = 8;
export const MAX_ROOM_APP_DOC_BYTES = 4 * 1024 * 1024;
export const MAX_CLIENT_IDS_PER_PARTICIPANT = 1024;
export const MAX_NEW_CLIENT_IDS_PER_UPDATE = 8;
export const MAX_PRESENCE_IDS_PER_PARTICIPANT = 4;
export const MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION = 16;

// An update can grow the encoded document by more than its own size: a
// deletion splits existing items, and alternating single-character deletions
// grew a document by about six times the update's bytes in testing. Far from
// the limit the cheap estimate is safe with this margin; near it, measure the
// actual result exactly.
const UPDATE_GROWTH_MARGIN = 16;
const EMPTY_DOC_BYTES = Y.encodeStateAsUpdate(new Y.Doc()).length;

export type AppAwarenessRemoval = {
  appId: string;
  awarenessUpdate: Uint8Array;
};

/**
 * Which app document a socket last synced, and what the room had sent it
 * then. The socket keeps it and hands it back with each update; it holds
 * while that document is presented, across Close and Present.
 */
export type AppSyncMark = {
  readonly appId: string;
  readonly generation: number;
  readonly seen: ReadonlyMap<number, number>;
};

export type WriteRefusal = ContentRefusal | "too-large" | "invalid" | "rate-limited" | "interrupted" | "queue-full" | "timed-out" | "crashed" | "unavailable";

export type WriteIdentity = {
  readonly participant: string;
  readonly host: boolean;
  readonly origin: string;
  readonly mark: AppSyncMark | null;
  readonly assembled?: true;
  readonly separate?: boolean;
};

export type WriteResult = { readonly outcomes: WriteOutcome[]; readonly landed: Uint8Array[] };

export type SyncAnswer =
  | { readonly ok: true; readonly update: Uint8Array; readonly stateVector: Uint8Array; readonly mark: AppSyncMark }
  | { readonly ok: false; readonly reason: "not-live" | "invalid" | "too-large" | "queue-full" | "timed-out" | "crashed" | "unavailable" };

export type DocumentExecutor = {
  write(appId: string, identity: WriteIdentity, updates: Uint8Array[]): Pending<WriteResult>;
  sync(appId: string, stateVector: Uint8Array): Pending<SyncAnswer>;
  changesNothing(appId: string, update: Uint8Array): Pending<boolean>;
};

export type ContentRefusal =
  | "not-live"
  | "not-synced"
  | "locked"
  | "malformed"
  | "unresolved"
  | "unseen-value"
  | "cleared"
  | "foreign-id"
  | "id-limit";

type ClientIdClaim = { participant: string; appId: string };

export type AppsSnapshot = {
  activeAppId: string | null;
  locked: boolean;
  revision: number;
  savedAppIds: string[];
  docGeneration: number | null;
};

export type StageCommand =
  | { readonly kind: "present"; readonly appId: string }
  | { readonly kind: "close" }
  | { readonly kind: "discard"; readonly appId: string }
  | { readonly kind: "lock"; readonly locked: boolean };

export type StagePlan = { ok: true; changed: boolean } | { ok: false; reason: "stale" | "full" };

export type StageCommandResult =
  | { ok: true; changed: boolean; awarenessRemoval: AppAwarenessRemoval | null }
  | { ok: false; reason: "stale" | "full" };

type AppDoc = {
  // A new number for every document the room starts, so a client holding a
  // copy of an earlier one can tell it is stale.
  generation: number;
  // Encoded bytes when last measured, plus a conservative estimate of what
  // accepted updates added since.
  measuredBytes: number;
  unmeasuredBytes: number;
} & ({ doc: Y.Doc; worker?: never } | { worker: AppDocument; doc?: never; seen: ReadonlyMap<number, number> });

const encodedSizeAfter = (doc: Y.Doc, update: Uint8Array): number => {
  const trial = new Y.Doc({ gc: doc.gc });
  try {
    Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(trial, update);
    return Y.encodeStateAsUpdate(trial).length;
  } finally {
    trial.destroy();
  }
};

const appDocBytes = (entry: AppDoc): number =>
  entry.measuredBytes + entry.unmeasuredBytes;

const stateOf = (doc: Y.Doc): Map<number, number> =>
  Y.decodeStateVector(Y.encodeStateVector(doc));

const heldIn = (state: ReadonlyMap<number, number>, id: Y.ID): boolean =>
  id.clock < (state.get(id.client) ?? 0);

const writersOf = (doc: Y.Doc): Iterable<number> =>
  Y.decodeStateVector(Y.encodeStateVector(doc)).keys();

const CLEARED_WRITER_FILTER_BYTES = 32 * 1024;
const CLEARED_WRITER_FILTER_BITS = CLEARED_WRITER_FILTER_BYTES * 8;
const CLEARED_WRITER_PROBES = 6;

const mixClientId = (client: number, seed: number): number => {
  const high = Math.floor(client / 0x1_0000_0000);
  let hash = Math.imul((client >>> 0) ^ seed ^ Math.imul(high, 0x27d4eb2d), 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
};

const clearedWriterBits = (client: number): number[] => {
  const first = mixClientId(client, 0x9e3779b9);
  const step = (mixClientId(client, 0x7f4a7c15) | 1) >>> 0;
  return Array.from(
    { length: CLEARED_WRITER_PROBES },
    (_, probe) => (first + probe * step) % CLEARED_WRITER_FILTER_BITS,
  );
};

type AwarenessEntry = { clientID: number; clock: number; state: string; removal: boolean };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// Decodes an awareness update the way y-protocols does: a count, then for
// each client its id, its clock and its JSON state, "null" for a removal.
// Truncated, trailing or malformed input throws.
const decodeAwarenessEntries = (update: Uint8Array): AwarenessEntry[] => {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const entries: AwarenessEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const length = decoding.readVarUint(decoder);
    if (length > decoder.arr.length - decoder.pos) {
      throw new Error("Truncated awareness update");
    }
    const state = strictUtf8.decode(decoding.readUint8Array(decoder, length));
    entries.push({ clientID, clock, state, removal: JSON.parse(state) === null });
  }
  if (decoding.hasContent(decoder)) throw new Error("Trailing bytes in awareness update");
  return entries;
};

const encodeAwarenessEntries = (entries: AwarenessEntry[]): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.state);
  }
  return encoding.toUint8Array(encoder);
};

// Presence lives for one stay on the stage, on a document of its own: an
// Awareness never lets go of the document it is given.
const createPresence = (): Awareness => {
  const awareness = new Awareness(new Y.Doc());
  awareness.setLocalState(null);
  return awareness;
};

type Cursor = { participant: string; userId: string };

type Presence = {
  awareness: Awareness;
  cursors: Map<number, Cursor>;
  shown: Map<string, number>;
  removed: Map<string, Set<number>>;
  removedBy: Map<number, string>;
};

const removalPacket = (awareness: Awareness, clients: number[]): Uint8Array =>
  encodeAwarenessEntries(
    clients.map((clientID) => ({
      clientID,
      clock: awareness.meta.get(clientID)?.clock ?? 0,
      state: "null",
      removal: true,
    })),
  );

const planPresence = (awareness: Awareness, entries: AwarenessEntry[]) => {
  const clocks = new Map<number, number>();
  const ends = new Map<number, boolean>();
  const applied: AwarenessEntry[] = [];
  for (const entry of entries) {
    const clock = clocks.get(entry.clientID) ?? awareness.meta.get(entry.clientID)?.clock ?? 0;
    const shown = ends.get(entry.clientID) ?? awareness.states.has(entry.clientID);
    if (clock < entry.clock || (clock === entry.clock && entry.removal && shown)) {
      applied.push(entry);
      clocks.set(entry.clientID, entry.clock);
      ends.set(entry.clientID, !entry.removal);
    }
  }
  return { applied, ends };
};

const destroyPresence = (awareness: Awareness): void => {
  try {
    awareness.doc.destroy();
  } catch {}
};

/**
 * A room's apps: which one is presented on the stage, and the collaborative
 * document of every app the room has used.
 *
 * Presenting another app or closing the stage keeps documents; only
 * `discard` or `clear` (room teardown) destroys one. Only the presented app
 * is live: it alone syncs, accepts updates and carries awareness.
 */
export class RoomApps {
  private stage: { activeAppId: string | null; locked: boolean } = {
    activeAppId: null,
    locked: false,
  };
  private revision = 0;
  // The presented document's state when its current stay on the stage
  // began. Every client that writes during the stay has seen at least this.
  private stayStart: ReadonlyMap<number, number> = new Map();
  private stay = {};
  private generations = 0;
  private docs: Map<string, AppDoc> = new Map();
  private clearedWriters: Uint8Array | null = null;
  private clientIdOwners: Map<number, ClientIdClaim> = new Map();
  private clientIdCounts: Map<string, number> = new Map();
  private presenceIds: Map<number, ClientIdClaim> = new Map();
  private presence: Map<string, Presence> = new Map();
  scheduler = new RoomAppsScheduler();
  executor: DocumentExecutor;
  private followers = new Set<() => void>();
  private clears = 0;

  // `participantOf` maps a connection's user id to the participant behind it,
  // which stays the same when that participant rejoins.
  constructor(
    private readonly participantOf: (userId: string) => string = (userId) => userId,
    private readonly pool?: AppDocumentPool,
  ) {
    this.executor = pool ? {
      write: (appId, identity, updates) => this.writeInWorker(appId, identity, updates),
      sync: (appId, vector) => this.syncInWorker(appId, vector),
      changesNothing: async (appId, update) => {
        const entry = this.activeEntry(appId);
        return entry?.worker ? entry.worker.changesNothing(update) : false;
      },
    } : new InProcessDocuments(this);
  }

  get stayToken(): object {
    return this.stay;
  }

  get epoch(): number {
    return this.clears;
  }

  follow(listener: () => void): void {
    this.followers.add(listener);
  }

  unfollow(listener: () => void): void {
    this.followers.delete(listener);
  }

  notifyFollowers(): void {
    for (const listener of [...this.followers]) {
      try {
        listener();
      } catch (error) {
        Logger.warn("[Apps] Following a stage change failed", error);
      }
    }
  }

  get boundClientIdCount(): number {
    return this.clientIdOwners.size;
  }

  get heldPresenceIds(): ReadonlyMap<number, string> {
    return new Map(Array.from(this.presenceIds, ([client, claim]) => [client, claim.participant]));
  }

  get documentWriterCount(): number {
    let writers = 0;
    for (const entry of this.docs.values()) writers += entry.doc ? entry.doc.store.clients.size : entry.seen.size;
    return writers;
  }

  presenceRecordCount(appId: string): number {
    const awareness = this.presence.get(appId)?.awareness;
    if (!awareness) return 0;
    return Array.from(awareness.meta.keys()).filter((client) => client !== awareness.clientID).length;
  }

  get activeAppId(): string | null {
    return this.stage.activeAppId;
  }

  get locked(): boolean {
    return this.stage.locked;
  }

  /** Moves forward with every change to the stage. */
  get stageRevision(): number {
    return this.revision;
  }

  snapshot(): AppsSnapshot {
    const presented = this.stage.activeAppId;
    return {
      activeAppId: presented,
      locked: this.stage.locked,
      revision: this.revision,
      savedAppIds: Array.from(this.docs.keys())
        .filter((appId) => appId !== presented)
        .sort(),
      docGeneration:
        presented === null ? null : (this.docs.get(presented)?.generation ?? null),
    };
  }

  /** The presented app's document, or null when `appId` is not presented. */
  liveDoc(appId: string): Y.Doc | null {
    return this.activeEntry(appId)?.doc ?? null;
  }

  private activeEntry(appId: string): AppDoc | undefined {
    return this.activeAppId === appId ? this.docs.get(appId) : undefined;
  }

  plan(command: StageCommand, expectedRevision?: number): StagePlan {
    const changes =
      command.kind === "present"
        ? this.stage.activeAppId !== command.appId
        : command.kind === "close"
          ? this.stage.activeAppId !== null
          : command.kind === "discard"
            ? this.docs.has(command.appId)
            : this.stage.locked !== command.locked;
    if (!changes) return { ok: true, changed: false };
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "stale" };
    }
    if (command.kind === "present" && !this.docs.has(command.appId) && !this.canAdmitDoc()) {
      return { ok: false, reason: "full" };
    }
    return { ok: true, changed: true };
  }

  apply(command: StageCommand, expectedRevision?: number): StageCommandResult {
    const plan = this.plan(command, expectedRevision);
    if (!plan.ok) return plan;
    if (!plan.changed) return { ok: true, changed: false, awarenessRemoval: null };
    const awarenessRemoval =
      command.kind === "present"
        ? this.showApp(command.appId)
        : command.kind === "close"
          ? this.closeStage()
          : command.kind === "discard"
            ? this.destroyApp(command.appId)
            : this.lockStage(command.locked);
    this.revision += 1;
    return { ok: true, changed: true, awarenessRemoval };
  }

  present(appId: string, expectedRevision?: number): StageCommandResult {
    return this.apply({ kind: "present", appId }, expectedRevision);
  }

  close(expectedRevision?: number): StageCommandResult {
    return this.apply({ kind: "close" }, expectedRevision);
  }

  /** Destroys an app's document. Discarding the presented app closes the stage. */
  discard(appId: string, expectedRevision?: number): StageCommandResult {
    return this.apply({ kind: "discard", appId }, expectedRevision);
  }

  setLocked(locked: boolean, expectedRevision?: number): StageCommandResult {
    return this.apply({ kind: "lock", locked }, expectedRevision);
  }

  private showApp(appId: string): AppAwarenessRemoval | null {
    const awarenessRemoval = this.leaveStage();
    if (!this.docs.has(appId)) {
      this.generations += 1;
      this.docs.set(appId, {
        ...(this.pool ? { worker: this.pool.open(), seen: new Map() } : { doc: new Y.Doc() }),
        generation: this.generations,
        measuredBytes: EMPTY_DOC_BYTES,
        unmeasuredBytes: 0,
      });
    }
    this.stage = { activeAppId: appId, locked: false };
    const entry = this.docs.get(appId)!;
    entry.worker?.retryLoad();
    this.stayStart = entry.doc ? stateOf(entry.doc) : entry.seen;
    this.stay = {};
    return awarenessRemoval;
  }

  private closeStage(): AppAwarenessRemoval | null {
    const awarenessRemoval = this.leaveStage();
    this.stage = { activeAppId: null, locked: false };
    this.stayStart = new Map();
    this.stay = {};
    return awarenessRemoval;
  }

  private destroyApp(appId: string): AppAwarenessRemoval | null {
    const entry = this.docs.get(appId)!;
    let awarenessRemoval: AppAwarenessRemoval | null = null;
    if (this.stage.activeAppId === appId) {
      awarenessRemoval = this.removeAwareness(appId);
      this.stage = { activeAppId: null, locked: false };
      this.stayStart = new Map();
      this.stay = {};
    }
    this.markCleared([...(entry.doc ? writersOf(entry.doc) : entry.seen.keys()), ...this.releaseWriters(appId)]);
    this.destroyDoc(appId, entry);
    return awarenessRemoval;
  }

  private lockStage(locked: boolean): null {
    this.stage = { ...this.stage, locked };
    return null;
  }

  /** The mark a socket keeps when the room answers its sync of `appId`. */
  syncMark(appId: string): AppSyncMark | null {
    const entry = this.activeEntry(appId);
    if (!entry) return null;
    return { appId, generation: entry.generation, seen: entry.doc ? stateOf(entry.doc) : entry.seen };
  }

  /** Whether `mark` is a sync of the document presented now. */
  isCurrentSync(mark: AppSyncMark | null): mark is AppSyncMark {
    return (
      mark !== null &&
      mark.appId === this.stage.activeAppId &&
      mark.generation === this.docs.get(mark.appId)?.generation
    );
  }

  participantFor(userId: string): string {
    return this.participantOf(userId);
  }

  changesNothing(appId: string, update: Uint8Array): boolean {
    const doc = this.liveDoc(appId);
    if (!doc) return false;
    return updateChangesNothing(doc, update);
  }

  private refusalOf(reason: Refusal): Exclude<SyncAnswer, { ok: true }>["reason"] {
    if (reason === "closed") return "not-live";
    if (reason === "missing-dependency" || reason === "malformed" || reason === "unresolved") return "invalid";
    return reason;
  }

  private async writeInWorker(appId: string, identity: WriteIdentity, updates: Uint8Array[]): Promise<WriteResult> {
    const rejected = (reason: WriteRefusal): WriteResult => ({
      outcomes: updates.map(() => reason), landed: [],
    });
    const entry = this.activeEntry(appId);
    if (!entry?.worker) return rejected("not-live");
    const { mark, participant, host } = identity;
    if (!this.isCurrentSync(mark)) return rejected("not-synced");
    if (this.locked && !host) return rejected("locked");
    const stay = this.stay;
    const preflight = (): WriteRefusal | null => {
      if (this.activeEntry(appId) !== entry || stay !== this.stay) return "not-live";
      if (this.locked && !host) return "locked";
      return null;
    };
    const authorize = (candidate: WorkerProposal): WriteRefusal | null => {
      const stale = preflight();
      if (stale) return stale;
      const claims = this.authorizeUpdate(participant, appId, mark, candidate.facts);
      if (typeof claims === "string") return claims;
      if (candidate.bytes > this.documentByteLimit(appId)) return "too-large";
      this.commitClaims(participant, appId, claims);
      entry.measuredBytes = candidate.bytes;
      entry.seen = candidate.seen;
      return null;
    };
    const groups = identity.separate ? updates.map((update) => [update]) : [updates];
    const results = await Promise.all(groups.map((group) =>
      entry.worker.applyValidated(group, identity.assembled === true, { preflight, authorize }),
    ));
    return {
      outcomes: identity.separate
        ? results.map((result) => result.ok ? null : result.reason)
        : updates.map(() => results[0].ok ? null : results[0].reason),
      landed: results.flatMap((result) => result.ok && !result.unchanged ? [result.update] : []),
    };
  }

  private async syncInWorker(appId: string, vector: Uint8Array): Promise<SyncAnswer> {
    const entry = this.activeEntry(appId);
    if (!entry?.worker) return { ok: false, reason: "not-live" };
    const stay = this.stay;
    const result = await entry.worker.sync(vector);
    if (this.activeEntry(appId) !== entry || stay !== this.stay) return { ok: false, reason: "not-live" };
    if (!result.ok) {
      const reason = this.refusalOf(result.reason);
      return { ok: false, reason };
    }
    return { ...result, mark: { appId, generation: entry.generation, seen: Y.decodeStateVector(result.stateVector) } };
  }

  private authorizeUpdate(
    participant: string, appId: string, mark: AppSyncMark, facts: UpdateFacts,
  ): WriteRefusal | number[] {
    if (!facts.resolvable) return "unresolved";
    for (const replaced of facts.blindlyReplaced) {
      if (heldIn(mark.seen, replaced) || heldIn(this.stayStart, replaced)) return "unseen-value";
    }
    for (const client of facts.touched) {
      if (!this.clientIdOwners.has(client) && this.wasCleared(client)) return "cleared";
    }
    return this.planClaims(participant, appId, facts.writers);
  }

  write(
    appId: string,
    participant: string,
    update: Uint8Array,
    mark: AppSyncMark | null,
    options: { origin?: unknown; host?: boolean } = {},
  ): WriteRefusal | null {
    const doc = this.liveDoc(appId);
    if (!doc) return "not-live";
    if (!this.isCurrentSync(mark)) return "not-synced";
    if (this.stage.locked && !options.host) return "locked";
    let facts: UpdateFacts;
    try {
      facts = readUpdate(doc, update);
    } catch {
      return "malformed";
    }
    const claims = this.authorizeUpdate(participant, appId, mark, facts);
    if (typeof claims === "string") return claims;
    if (!this.reserveUpdate(appId, update)) return "too-large";
    try {
      Y.applyUpdate(doc, update, options.origin);
    } catch {
      return "invalid";
    }
    this.commitClaims(participant, appId, claims);
    return null;
  }

  /**
   * Whether the presented app's document stays within its own limit and the
   * room's once `update` is applied. Records the expected size when it does;
   * the caller then applies it.
   */
  reserveUpdate(appId: string, update: Uint8Array): boolean {
    const entry = this.stage.activeAppId === appId ? this.docs.get(appId) : undefined;
    if (!entry?.doc) return false;
    const limit = this.documentByteLimit(appId);
    const growth = update.length * UPDATE_GROWTH_MARGIN;
    if (appDocBytes(entry) + growth <= limit) {
      entry.unmeasuredBytes += growth;
      return true;
    }
    let resulting: number;
    try {
      resulting = encodedSizeAfter(entry.doc, update);
    } catch {
      return false;
    }
    if (resulting > limit) return false;
    entry.measuredBytes = resulting;
    entry.unmeasuredBytes = 0;
    return true;
  }

  private documentByteLimit(appId: string): number {
    let otherBytes = 0;
    for (const [otherAppId, other] of this.docs) {
      if (otherAppId !== appId) otherBytes += appDocBytes(other);
    }
    return Math.min(MAX_APP_DOC_BYTES, MAX_ROOM_APP_DOC_BYTES - otherBytes);
  }

  // A new document needs a free slot and room to grow to a full document.
  private canAdmitDoc(): boolean {
    const presented = this.stage.activeAppId;
    let count = 0;
    let bytes = 0;
    for (const [appId, entry] of this.docs) {
      if (appId === presented) this.measure(entry);
      if (appId === presented && entry.measuredBytes <= EMPTY_DOC_BYTES) continue;
      count += 1;
      bytes += appDocBytes(entry);
    }
    return (
      count < MAX_ROOM_APP_DOCS &&
      bytes + MAX_APP_DOC_BYTES <= MAX_ROOM_APP_DOC_BYTES
    );
  }

  private measure(entry: AppDoc): void {
    if (!entry.doc || entry.unmeasuredBytes === 0) return;
    entry.measuredBytes = Y.encodeStateAsUpdate(entry.doc).length;
    entry.unmeasuredBytes = 0;
  }

  // Takes the presented app off the stage: its presence goes, its document
  // stays unless nobody wrote to it.
  private leaveStage(): AppAwarenessRemoval | null {
    const appId = this.stage.activeAppId;
    if (appId === null) return null;
    const awarenessRemoval = this.removeAwareness(appId);
    const entry = this.docs.get(appId);
    if (entry) {
      this.measure(entry);
      if (entry.measuredBytes <= EMPTY_DOC_BYTES) this.destroyDoc(appId, entry);
    }
    return awarenessRemoval;
  }

  private markCleared(clients: Iterable<number>): void {
    const filter = (this.clearedWriters ??= new Uint8Array(CLEARED_WRITER_FILTER_BYTES));
    for (const client of clients) {
      for (const bit of clearedWriterBits(client)) filter[bit >>> 3] |= 1 << (bit & 7);
    }
  }

  private wasCleared(client: number): boolean {
    const filter = this.clearedWriters;
    if (!filter) return false;
    return clearedWriterBits(client).every((bit) => (filter[bit >>> 3] & (1 << (bit & 7))) !== 0);
  }

  private releaseWriters(appId: string): number[] {
    const released: number[] = [];
    for (const [client, claim] of this.clientIdOwners) {
      if (claim.appId !== appId) continue;
      this.clientIdOwners.delete(client);
      const held = (this.clientIdCounts.get(claim.participant) ?? 1) - 1;
      if (held > 0) this.clientIdCounts.set(claim.participant, held);
      else this.clientIdCounts.delete(claim.participant);
      released.push(client);
    }
    return released;
  }

  private planClaims(
    participant: string,
    appId: string,
    clients: Iterable<number>,
  ): "foreign-id" | "id-limit" | number[] {
    const claims: number[] = [];
    for (const client of new Set(clients)) {
      const owner = this.clientIdOwners.get(client) ?? this.presenceIds.get(client);
      if (owner && (owner.participant !== participant || owner.appId !== appId)) return "foreign-id";
      if (!this.clientIdOwners.has(client)) claims.push(client);
    }
    const held = this.clientIdCounts.get(participant) ?? 0;
    if (
      claims.length > MAX_NEW_CLIENT_IDS_PER_UPDATE ||
      held + claims.length > MAX_CLIENT_IDS_PER_PARTICIPANT
    ) {
      return "id-limit";
    }
    return claims;
  }

  private commitClaims(participant: string, appId: string, claims: number[]): void {
    if (claims.length === 0) return;
    this.releasePresenceIds(claims);
    for (const client of claims) this.clientIdOwners.set(client, { participant, appId });
    this.clientIdCounts.set(participant, (this.clientIdCounts.get(participant) ?? 0) + claims.length);
  }

  private holdPresenceId(client: number, participant: string, appId: string): void {
    this.presenceIds.set(client, { participant, appId });
  }

  private withinCursorLimit(
    presence: Presence,
    participant: string,
    ends: ReadonlyMap<number, boolean>,
  ): boolean {
    let shown = presence.shown.get(participant) ?? 0;
    for (const [client, showing] of ends) {
      const wasShowing = presence.awareness.states.has(client);
      if (showing && !wasShowing) shown += 1;
      if (!showing && wasShowing) shown -= 1;
    }
    return shown <= MAX_PRESENCE_IDS_PER_PARTICIPANT;
  }

  private releasePresenceIds(clients: Iterable<number>): void {
    for (const client of clients) this.presenceIds.delete(client);
  }

  private destroyDoc(appId: string, entry: AppDoc): void {
    try {
      entry.worker?.close();
      entry.doc?.destroy();
    } catch {}
    this.docs.delete(appId);
  }

  private removeAwareness(appId: string): AppAwarenessRemoval | null {
    const presence = this.presence.get(appId);
    if (!presence) return null;
    this.presence.delete(appId);
    let removal: AppAwarenessRemoval | null = null;
    try {
      const clients = Array.from(presence.awareness.getStates().keys());
      if (clients.length > 0) {
        removal = { appId, awarenessUpdate: removalPacket(presence.awareness, clients) };
      }
    } catch (error) {
      Logger.warn(`[Apps] Could not encode the cursor removal for ${appId}`, error);
    }
    destroyPresence(presence.awareness);
    this.releasePresenceIds(
      Array.from(this.presenceIds).filter(([, claim]) => claim.appId === appId).map(([client]) => client),
    );
    return removal;
  }

  private presenceFor(appId: string): Presence {
    const existing = this.presence.get(appId);
    if (existing) return existing;
    const presence: Presence = {
      awareness: createPresence(),
      cursors: new Map(),
      shown: new Map(),
      removed: new Map(),
      removedBy: new Map(),
    };
    presence.awareness.on("update", ({ removed }: { removed: number[] }, origin: unknown) => {
      if (origin === presence || this.presence.get(appId) !== presence) return;
      try {
        this.settlePresence(presence, removed);
      } catch (error) {
        Logger.warn(`[Apps] Could not settle removed cursors for ${appId}`, error);
      }
    });
    this.presence.set(appId, presence);
    return presence;
  }

  private settlePresence(
    presence: Presence,
    clients: Iterable<number>,
    sender?: { participant: string; appId: string; userId: string },
  ): void {
    for (const client of clients) {
      const cursor = presence.cursors.get(client);
      if (presence.awareness.states.has(client)) {
        if (!sender) continue;
        this.forgetRemoved(presence, client);
        if (!cursor) this.countCursor(presence, sender.participant, 1);
        presence.cursors.set(client, { participant: sender.participant, userId: sender.userId });
        if (!this.clientIdOwners.has(client) && !this.presenceIds.has(client)) {
          this.holdPresenceId(client, sender.participant, sender.appId);
        }
        continue;
      }
      if (cursor) {
        presence.cursors.delete(client);
        this.countCursor(presence, cursor.participant, -1);
      }
      this.releasePresenceIds([client]);
      const keeper = cursor?.userId ?? presence.removedBy.get(client) ?? sender?.userId;
      if (keeper !== undefined) this.keepRemoved(presence, client, keeper);
    }
  }

  private countCursor(presence: Presence, participant: string, change: number): void {
    const shown = (presence.shown.get(participant) ?? 0) + change;
    if (shown > 0) presence.shown.set(participant, shown);
    else presence.shown.delete(participant);
  }

  private forgetRemoved(presence: Presence, client: number): void {
    const keeper = presence.removedBy.get(client);
    if (keeper === undefined) return;
    presence.removedBy.delete(client);
    presence.removed.get(keeper)?.delete(client);
  }

  private keepRemoved(presence: Presence, client: number, keeper: string): void {
    this.forgetRemoved(presence, client);
    const removed = presence.removed.get(keeper) ?? new Set<number>();
    presence.removed.set(keeper, removed);
    presence.removedBy.set(client, keeper);
    removed.add(client);
    for (const oldest of removed) {
      if (removed.size <= MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION) return;
      removed.delete(oldest);
      presence.removedBy.delete(oldest);
      if (!presence.awareness.states.has(oldest)) presence.awareness.meta.delete(oldest);
    }
  }

  private forgetConnection(presence: Presence, userId: string): void {
    for (const client of presence.removed.get(userId) ?? []) {
      presence.removedBy.delete(client);
      if (!presence.awareness.states.has(client)) presence.awareness.meta.delete(client);
    }
    presence.removed.delete(userId);
  }

  /**
   * Applies presence for the presented app and returns what peers should get,
   * or null when there is nothing to forward. Only the sender's own entries
   * are kept: other people's removals, which a client sends as their cursors
   * time out, are dropped, and an update carrying state under someone else's
   * id is refused.
   */
  applyAwarenessUpdate(appId: string, awarenessUpdate: Uint8Array, userId: string): Uint8Array | null {
    if (!this.activeEntry(appId)) return null;
    const entries = decodeAwarenessEntries(awarenessUpdate);
    const participant = this.participantOf(userId);
    const presence = this.presenceFor(appId);
    const own: AwarenessEntry[] = [];
    const shownHere = new Set<number>();
    for (const entry of entries) {
      const owner = this.clientIdOwners.get(entry.clientID) ?? this.presenceIds.get(entry.clientID);
      const foreign =
        entry.clientID === presence.awareness.clientID ||
        (owner !== undefined && (owner.participant !== participant || owner.appId !== appId));
      if (foreign) {
        if (!entry.removal) return null;
        continue;
      }
      if (owner === undefined && !entry.removal) shownHere.add(entry.clientID);
      if (owner !== undefined || shownHere.has(entry.clientID)) own.push(entry);
    }
    const { applied, ends } = planPresence(presence.awareness, own);
    if (applied.length === 0 || !this.withinCursorLimit(presence, participant, ends)) return null;

    const forwarded = encodeAwarenessEntries(applied);
    applyAwarenessUpdate(presence.awareness, forwarded, presence);
    this.settlePresence(presence, ends.keys(), { participant, appId, userId });
    return forwarded;
  }

  encodeAwarenessSnapshot(appId: string): Uint8Array | null {
    const awareness = this.presence.get(appId)?.awareness;
    if (!awareness) return null;
    const clientIds = Array.from(awareness.getStates().keys());
    if (clientIds.length === 0) return null;
    return encodeAwarenessUpdate(awareness, clientIds);
  }

  clearUserAwareness(userId: string): AppAwarenessRemoval[] {
    const removals: AppAwarenessRemoval[] = [];
    for (const [appId, presence] of this.presence) {
      try {
        const shown = Array.from(presence.cursors)
          .filter(([, cursor]) => cursor.userId === userId)
          .map(([client]) => client);
        if (shown.length > 0) {
          removals.push({ appId, awarenessUpdate: removalPacket(presence.awareness, shown) });
          removeAwarenessStates(presence.awareness, shown, userId);
        }
        this.forgetConnection(presence, userId);
      } catch (error) {
        Logger.warn(`[Apps] Could not remove the cursors of ${userId} from ${appId}`, error);
      }
    }
    return removals;
  }

  /** Room teardown: destroys every document and all presence. */
  clear(): void {
    this.scheduler.close();
    this.scheduler = new RoomAppsScheduler();
    for (const presence of this.presence.values()) {
      destroyPresence(presence.awareness);
    }
    this.presence.clear();

    for (const [appId, entry] of Array.from(this.docs)) {
      this.destroyDoc(appId, entry);
    }
    this.clearedWriters = null;
    this.clientIdOwners.clear();
    this.clientIdCounts.clear();
    this.presenceIds.clear();
    this.stage = { activeAppId: null, locked: false };
    this.stayStart = new Map();
    this.stay = {};
    this.revision += 1;
    this.clears += 1;
    this.notifyFollowers();
  }
}

const guarded = <T>(label: string, fallback: T, task: () => T): T => {
  try {
    return task();
  } catch (error) {
    Logger.debug(`[Apps] ${label} refused a malformed payload`, error);
    return fallback;
  }
};

class InProcessDocuments implements DocumentExecutor {
  constructor(private readonly apps: RoomApps) {}

  write(appId: string, identity: WriteIdentity, updates: Uint8Array[]): WriteResult {
    if (updates.length === 0) return { outcomes: [], landed: [] };
    const merged = guarded("Merging app updates", null, () =>
      updates.length === 1 ? updates[0] : Y.mergeUpdates(updates),
    );
    const outcome: WriteOutcome =
      merged === null
        ? "malformed"
        : guarded<WriteOutcome>("Writing an app update", "invalid", () =>
            this.apps.write(appId, identity.participant, merged, identity.mark, {
              origin: identity.origin,
              host: identity.host,
            }),
          );
    return { outcomes: updates.map(() => outcome), landed: outcome === null && merged ? [merged] : [] };
  }

  sync(appId: string, stateVector: Uint8Array): SyncAnswer {
    return guarded<SyncAnswer>("Syncing an app", { ok: false, reason: "invalid" }, () => {
      const doc = this.apps.liveDoc(appId);
      const mark = this.apps.syncMark(appId);
      if (!doc || !mark) return { ok: false, reason: "not-live" };
      Y.decodeStateVector(stateVector);
      const update = Y.encodeStateAsUpdate(doc, stateVector);
      if (update.length > MAX_APP_DOC_BYTES) return { ok: false, reason: "too-large" };
      return { ok: true, update, stateVector: Y.encodeStateVector(doc), mark };
    });
  }

  changesNothing(appId: string, update: Uint8Array): boolean {
    return guarded("Checking an app update", false, () => this.apps.changesNothing(appId, update));
  }
}
