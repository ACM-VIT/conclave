import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

// A document larger than one sync response can no longer reach new joiners,
// so it is also the most a document may grow to.
export const MAX_APP_DOC_BYTES = 1024 * 1024;
// A room keeps every app's document when the stage moves to another app, so
// documents are also bounded per room: by count, and by total encoded bytes.
export const MAX_ROOM_APP_DOCS = 8;
export const MAX_ROOM_APP_DOC_BYTES = 4 * 1024 * 1024;
// Yjs client IDs that wrote to a cleared document, per app, kept so a client
// that missed the clear cannot write that content back. Oldest go first.
export const MAX_CLEARED_WRITERS = 4096;
// Yjs client ids are chosen by clients, so the room binds each to the
// participant who first writes or shows presence under it. These bound how
// many ids one participant, and the whole room, may hold.
export const MAX_CLIENT_IDS_PER_PARTICIPANT = 1024;
export const MAX_ROOM_CLIENT_IDS = 16384;

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

export type ContentRefusal =
  | "not_live"
  | "not_synced"
  | "malformed"
  | "unresolved"
  | "unseen_value"
  | "other_app"
  | "cleared"
  | "foreign_id";

export type AppsSnapshot = {
  activeAppId: string | null;
  locked: boolean;
  revision: number;
  savedAppIds: string[];
  docGeneration: number | null;
};

export type StageCommandResult =
  | { ok: true; changed: boolean; awarenessRemoval: AppAwarenessRemoval | null }
  | { ok: false; reason: "stale" | "full" };

type AppDoc = {
  doc: Y.Doc;
  // A new number for every document the room starts, so a client holding a
  // copy of an earlier one can tell it is stale.
  generation: number;
  // Encoded bytes when last measured, plus a conservative estimate of what
  // accepted updates added since.
  measuredBytes: number;
  unmeasuredBytes: number;
};

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

// App ids hold no control characters, so this joins them unambiguously.
const clearedWriterKey = (appId: string, client: number): string =>
  `${appId}\u0000${client}`;

// The live value under `key` of the map `parent` names in `doc`: a root type
// by name, or a nested type by the id of the item holding it.
const liveMapValue = (doc: Y.Doc, parent: unknown, key: string): Y.Item | null => {
  let entries: Map<string, Y.Item> | undefined;
  if (typeof parent === "string") {
    entries = doc.share.get(parent)?._map;
  } else if (parent instanceof Y.ID) {
    if (parent.clock >= Y.getState(doc.store, parent.client)) return null;
    const holder = Y.getItem(doc.store, parent);
    if (holder instanceof Y.Item && holder.content instanceof Y.ContentType) {
      entries = holder.content.type._map;
    }
  }
  const value = entries?.get(key);
  return value && !value.deleted ? value : null;
};

type UpdateFacts = {
  // The Yjs clients the update writes as.
  writers: Set<number>;
  // Every client it writes as, builds on or deletes from.
  touched: Set<number>;
  // Whether the document and the update itself hold everything it refers
  // to. An update that builds on content the room refused does not.
  resolvable: boolean;
  // Live map values it replaces without having seen any value of their key,
  // as a client writing on a copy that never held the room's state does.
  blindlyReplaced: Y.ID[];
};

const readUpdate = (doc: Y.Doc, update: Uint8Array): UpdateFacts => {
  const { structs, ds } = Y.decodeUpdate(update);
  const ends = new Map<number, number>();
  const end = (client: number): number => ends.get(client) ?? Y.getState(doc.store, client);
  const writers = new Set<number>();
  const touched = new Set<number>(ds.clients.keys());
  let resolvable = true;
  for (const struct of structs) {
    const client = struct.id.client;
    writers.add(client);
    touched.add(client);
    if (struct instanceof Y.Skip || struct.id.clock > end(client)) resolvable = false;
    ends.set(client, Math.max(end(client), struct.id.clock + struct.length));
  }
  const blindlyReplaced: Y.ID[] = [];
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const parent: unknown = struct.parent;
    for (const ref of [struct.origin, struct.rightOrigin, parent instanceof Y.ID ? parent : null]) {
      if (!ref) continue;
      touched.add(ref.client);
      if (ref.clock >= end(ref.client)) resolvable = false;
    }
    if (struct.origin === null && struct.rightOrigin === null && struct.parentSub !== null) {
      const replaced = liveMapValue(doc, parent, struct.parentSub);
      if (replaced) blindlyReplaced.push(replaced.id);
    }
  }
  for (const [client, deletes] of ds.clients) {
    for (const { clock, len } of deletes) {
      if (clock + len > end(client)) resolvable = false;
    }
  }
  return { writers, touched, resolvable, blindlyReplaced };
};

type AwarenessEntry = { clientID: number; clock: number; state: string };

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
    JSON.parse(state);
    entries.push({ clientID, clock, state });
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
const createPresence = (): Awareness => new Awareness(new Y.Doc());

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
  private generations = 0;
  private docs: Map<string, AppDoc> = new Map();
  private clearedWriters: Set<string> = new Set();
  private clientIdOwners: Map<number, string> = new Map();
  private clientIdCounts: Map<string, number> = new Map();
  // Writers of every kept document other than the presented one. Documents
  // off the stage take no updates, so this changes only with the stage.
  private otherAppWriters: Set<number> = new Set();
  private awareness: Map<string, Awareness> = new Map();
  private awarenessClientIdsByUser: Map<string, Map<string, Set<number>>> =
    new Map();

  // `participantOf` maps a connection's user id to the participant behind it,
  // which stays the same when that participant rejoins.
  constructor(private readonly participantOf: (userId: string) => string = (userId) => userId) {}

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
    if (this.stage.activeAppId !== appId) return null;
    return this.docs.get(appId)?.doc ?? null;
  }

  present(appId: string, expectedRevision?: number): StageCommandResult {
    if (this.stage.activeAppId === appId) {
      return { ok: true, changed: false, awarenessRemoval: null };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "stale" };
    }
    if (!this.docs.has(appId) && !this.canAdmitDoc()) {
      return { ok: false, reason: "full" };
    }
    const awarenessRemoval = this.leaveStage();
    if (!this.docs.has(appId)) {
      this.generations += 1;
      this.docs.set(appId, {
        doc: new Y.Doc(),
        generation: this.generations,
        measuredBytes: EMPTY_DOC_BYTES,
        unmeasuredBytes: 0,
      });
    }
    this.stage = { activeAppId: appId, locked: false };
    this.stayStart = stateOf(this.docs.get(appId)!.doc);
    this.revision += 1;
    this.refreshOtherAppWriters();
    return { ok: true, changed: true, awarenessRemoval };
  }

  close(expectedRevision?: number): StageCommandResult {
    if (this.stage.activeAppId === null) {
      return { ok: true, changed: false, awarenessRemoval: null };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "stale" };
    }
    const awarenessRemoval = this.leaveStage();
    this.stage = { activeAppId: null, locked: false };
    this.revision += 1;
    this.refreshOtherAppWriters();
    return { ok: true, changed: true, awarenessRemoval };
  }

  /** Destroys an app's document. Discarding the presented app closes the stage. */
  discard(appId: string, expectedRevision?: number): StageCommandResult {
    const entry = this.docs.get(appId);
    if (!entry) {
      return { ok: true, changed: false, awarenessRemoval: null };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "stale" };
    }
    let awarenessRemoval: AppAwarenessRemoval | null = null;
    if (this.stage.activeAppId === appId) {
      awarenessRemoval = this.removeAwareness(appId);
      this.stage = { activeAppId: null, locked: false };
    }
    this.markCleared(appId, writersOf(entry.doc));
    this.destroyDoc(appId, entry);
    this.revision += 1;
    this.refreshOtherAppWriters();
    return { ok: true, changed: true, awarenessRemoval };
  }

  setLocked(locked: boolean, expectedRevision?: number): StageCommandResult {
    if (this.stage.locked === locked) {
      return { ok: true, changed: false, awarenessRemoval: null };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      return { ok: false, reason: "stale" };
    }
    this.stage = { ...this.stage, locked };
    this.revision += 1;
    return { ok: true, changed: true, awarenessRemoval: null };
  }

  /** The mark a socket keeps when the room answers its sync of `appId`. */
  syncMark(appId: string): AppSyncMark | null {
    const doc = this.liveDoc(appId);
    if (!doc) return null;
    return { appId, generation: this.docs.get(appId)!.generation, seen: stateOf(doc) };
  }

  /** Whether `mark` is a sync of the document presented now. */
  isCurrentSync(mark: AppSyncMark | null): mark is AppSyncMark {
    return (
      mark !== null &&
      mark.appId === this.stage.activeAppId &&
      mark.generation === this.docs.get(mark.appId)?.generation
    );
  }

  /**
   * False when an update from `userId` for `appId`, sent by a socket whose
   * sync of the app's current stay is `mark`:
   * - comes from a socket that has not synced the presented document;
   * - replaces a map value without having seen it, when that value was in
   *   the room's copy the socket synced or when this stay began: a client
   *   drawing on a fresh copy before the room's copy reached it writes that;
   * - builds on content the room does not hold, such as content it refused;
   * - writes under a client id bound to another participant, or already in
   *   another app's document;
   * - holds, builds on or deletes content of one of the app's cleared
   *   documents, as a client that missed the clear sends when it resyncs.
   * Accepting it binds its new client ids to the participant, so a
   * participant is only ever blocked by their own writes, or by a host
   * clearing a document they wrote.
   */
  acceptsContent(
    appId: string,
    userId: string,
    update: Uint8Array,
    mark: AppSyncMark | null,
  ): boolean {
    return this.contentRefusal(appId, userId, update, mark) === null;
  }

  /** Why `acceptsContent` refuses an update, or null when it accepts it. */
  contentRefusal(
    appId: string,
    userId: string,
    update: Uint8Array,
    mark: AppSyncMark | null,
  ): ContentRefusal | null {
    const doc = this.liveDoc(appId);
    if (!doc) return "not_live";
    if (!this.isCurrentSync(mark)) return "not_synced";
    let facts: UpdateFacts;
    try {
      facts = readUpdate(doc, update);
    } catch {
      return "malformed";
    }
    if (!facts.resolvable) return "unresolved";
    for (const replaced of facts.blindlyReplaced) {
      if (heldIn(mark.seen, replaced) || heldIn(this.stayStart, replaced)) return "unseen_value";
    }
    for (const client of facts.writers) {
      if (this.otherAppWriters.has(client)) return "other_app";
    }
    for (const client of facts.touched) {
      if (this.clearedWriters.has(clearedWriterKey(appId, client))) return "cleared";
    }
    return this.claimClientIds(this.participantOf(userId), facts.writers) ? null : "foreign_id";
  }

  /**
   * Whether the presented app's document stays within its own limit and the
   * room's once `update` is applied. Records the expected size when it does;
   * the caller then applies it.
   */
  reserveUpdate(appId: string, update: Uint8Array): boolean {
    const entry = this.stage.activeAppId === appId ? this.docs.get(appId) : undefined;
    if (!entry) return false;
    let otherBytes = 0;
    for (const [otherAppId, other] of this.docs) {
      if (otherAppId !== appId) otherBytes += appDocBytes(other);
    }
    const limit = Math.min(MAX_APP_DOC_BYTES, MAX_ROOM_APP_DOC_BYTES - otherBytes);
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
    if (entry.unmeasuredBytes === 0) return;
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

  private markCleared(appId: string, clients: Iterable<number>): void {
    for (const client of clients) {
      const key = clearedWriterKey(appId, client);
      this.clearedWriters.delete(key);
      this.clearedWriters.add(key);
    }
    for (const key of this.clearedWriters) {
      if (this.clearedWriters.size <= MAX_CLEARED_WRITERS) break;
      this.clearedWriters.delete(key);
    }
  }

  // Binds each new client id to `participant`. False when an id belongs to
  // someone else, or when the participant or the room holds as many as allowed.
  private claimClientIds(participant: string, clients: Iterable<number>): boolean {
    const unclaimed: number[] = [];
    for (const client of new Set(clients)) {
      const owner = this.clientIdOwners.get(client);
      if (owner === undefined) unclaimed.push(client);
      else if (owner !== participant) return false;
    }
    if (unclaimed.length === 0) return true;
    const held = this.clientIdCounts.get(participant) ?? 0;
    if (
      held + unclaimed.length > MAX_CLIENT_IDS_PER_PARTICIPANT ||
      this.clientIdOwners.size + unclaimed.length > MAX_ROOM_CLIENT_IDS
    ) {
      return false;
    }
    for (const client of unclaimed) this.clientIdOwners.set(client, participant);
    this.clientIdCounts.set(participant, held + unclaimed.length);
    return true;
  }

  private refreshOtherAppWriters(): void {
    this.otherAppWriters = new Set();
    for (const [appId, entry] of this.docs) {
      if (appId === this.stage.activeAppId) continue;
      for (const client of writersOf(entry.doc)) this.otherAppWriters.add(client);
    }
  }

  private destroyDoc(appId: string, entry: AppDoc): void {
    try {
      entry.doc.destroy();
    } catch {}
    this.docs.delete(appId);
  }

  private removeAwareness(appId: string): AppAwarenessRemoval | null {
    const awareness = this.awareness.get(appId);
    this.awarenessClientIdsByUser.delete(appId);
    if (!awareness) return null;

    const clientIds = Array.from(awareness.getStates().keys());
    let removal: AppAwarenessRemoval | null = null;
    if (clientIds.length > 0) {
      removeAwarenessStates(awareness, clientIds, "app-close");
      removal = { appId, awarenessUpdate: encodeAwarenessUpdate(awareness, clientIds) };
    }

    destroyPresence(awareness);
    this.awareness.delete(appId);
    return removal;
  }

  private getOrCreateAwarenessUserMap(appId: string): Map<string, Set<number>> {
    const existing = this.awarenessClientIdsByUser.get(appId);
    if (existing) return existing;
    const map = new Map<string, Set<number>>();
    this.awarenessClientIdsByUser.set(appId, map);
    return map;
  }

  private trackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.getOrCreateAwarenessUserMap(appId);
    const existing = users.get(userId);
    if (existing) {
      existing.add(clientId);
      return;
    }
    users.set(userId, new Set([clientId]));
  }

  private untrackAwarenessClientForUser(
    appId: string,
    userId: string,
    clientId: number,
  ): void {
    const users = this.awarenessClientIdsByUser.get(appId);
    if (!users) return;
    const clientIds = users.get(userId);
    if (!clientIds) return;
    clientIds.delete(clientId);
    if (clientIds.size === 0) {
      users.delete(userId);
    }
    if (users.size === 0) {
      this.awarenessClientIdsByUser.delete(appId);
    }
  }

  /**
   * Applies presence for the presented app and returns what peers should get,
   * or null when there is nothing to forward. Only the sender's own entries
   * are kept: other people's removals, which a client sends as their cursors
   * time out, are dropped, and an update carrying state under someone else's
   * id is refused.
   */
  applyAwarenessUpdate(
    appId: string,
    awarenessUpdate: Uint8Array,
    userId?: string,
  ): Uint8Array | null {
    const doc = this.liveDoc(appId);
    if (!doc) return null;
    const participant = this.participantOf(userId ?? "socket");
    const own: AwarenessEntry[] = [];
    const claimed: number[] = [];
    for (const entry of decodeAwarenessEntries(awarenessUpdate)) {
      const owner = this.clientIdOwners.get(entry.clientID);
      const removal = JSON.parse(entry.state) === null;
      if (owner === participant || (owner === undefined && !removal)) {
        own.push(entry);
        if (owner === undefined) claimed.push(entry.clientID);
      } else if (!removal) {
        return null;
      }
    }
    if (own.length === 0 || !this.claimClientIds(participant, claimed)) return null;

    const forwarded = encodeAwarenessEntries(own);
    let awareness = this.awareness.get(appId);
    if (!awareness) {
      awareness = createPresence();
      this.awareness.set(appId, awareness);
    }
    applyAwarenessUpdate(awareness, forwarded, userId ?? "socket");
    if (userId) {
      for (const { clientID } of own) {
        if (awareness.getStates().has(clientID)) {
          this.trackAwarenessClientForUser(appId, userId, clientID);
        } else {
          this.untrackAwarenessClientForUser(appId, userId, clientID);
        }
      }
    }
    return forwarded;
  }

  encodeAwarenessSnapshot(appId: string): Uint8Array | null {
    const awareness = this.awareness.get(appId);
    if (!awareness) return null;
    const clientIds = Array.from(awareness.getStates().keys());
    if (clientIds.length === 0) return null;
    return encodeAwarenessUpdate(awareness, clientIds);
  }

  clearUserAwareness(userId: string): AppAwarenessRemoval[] {
    const removals: AppAwarenessRemoval[] = [];

    const appIds = new Set<string>([
      ...this.awareness.keys(),
      ...this.awarenessClientIdsByUser.keys(),
    ]);

    for (const appId of appIds) {
      const awareness = this.awareness.get(appId);
      if (!awareness) {
        continue;
      }

      const users = this.awarenessClientIdsByUser.get(appId);
      const trackedClientIds = users?.get(userId);
      if (users) {
        users.delete(userId);
        if (users.size === 0) {
          this.awarenessClientIdsByUser.delete(appId);
        }
      }

      const removableClientIds = Array.from(trackedClientIds ?? []).filter((id) =>
        awareness.meta.has(id),
      );
      if (removableClientIds.length === 0) {
        continue;
      }

      removeAwarenessStates(awareness, removableClientIds, userId);
      removals.push({
        appId,
        awarenessUpdate: encodeAwarenessUpdate(awareness, removableClientIds),
      });
    }

    return removals;
  }

  /** Room teardown: destroys every document and all presence. */
  clear(): void {
    for (const awareness of this.awareness.values()) {
      destroyPresence(awareness);
    }
    this.awareness.clear();
    this.awarenessClientIdsByUser.clear();

    for (const [appId, entry] of Array.from(this.docs)) {
      this.destroyDoc(appId, entry);
    }
    this.clearedWriters.clear();
    this.otherAppWriters.clear();
    this.clientIdOwners.clear();
    this.clientIdCounts.clear();
    this.stage = { activeAppId: null, locked: false };
    this.revision += 1;
  }
}
