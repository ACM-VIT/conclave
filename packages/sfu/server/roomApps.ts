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

export type WriteRefusal = ContentRefusal | "too-large" | "invalid";

export type ContentRefusal =
  | "not-live"
  | "not-synced"
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

export type UpdateFacts = {
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

export const readUpdate = (doc: Y.Doc, update: Uint8Array): UpdateFacts => {
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
      const integrated =
        ref.client === struct.id.client
          ? ref.clock < struct.id.clock
          : ref.clock < Y.getState(doc.store, ref.client);
      if (!integrated) resolvable = false;
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

type Presence = {
  awareness: Awareness;
  holders: Map<number, string>;
  removed: Map<string, Set<number>>;
};

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
  private generations = 0;
  private docs: Map<string, AppDoc> = new Map();
  private clearedWriters: Set<string> = new Set();
  private clientIdOwners: Map<number, ClientIdClaim> = new Map();
  private clientIdCounts: Map<string, number> = new Map();
  private presenceIds: Map<number, ClientIdClaim> = new Map();
  private presenceIdCounts: Map<string, number> = new Map();
  private presence: Map<string, Presence> = new Map();

  // `participantOf` maps a connection's user id to the participant behind it,
  // which stays the same when that participant rejoins.
  constructor(private readonly participantOf: (userId: string) => string = (userId) => userId) {}

  get boundClientIdCount(): number {
    return this.clientIdOwners.size;
  }

  get heldPresenceIds(): ReadonlyMap<number, string> {
    return new Map(Array.from(this.presenceIds, ([client, claim]) => [client, claim.participant]));
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

  write(
    appId: string,
    userId: string,
    update: Uint8Array,
    mark: AppSyncMark | null,
    origin?: unknown,
  ): WriteRefusal | null {
    const doc = this.liveDoc(appId);
    if (!doc) return "not-live";
    if (!this.isCurrentSync(mark)) return "not-synced";
    let facts: UpdateFacts;
    try {
      facts = readUpdate(doc, update);
    } catch {
      return "malformed";
    }
    if (!facts.resolvable) return "unresolved";
    for (const replaced of facts.blindlyReplaced) {
      if (heldIn(mark.seen, replaced) || heldIn(this.stayStart, replaced)) return "unseen-value";
    }
    for (const client of facts.touched) {
      if (this.clearedWriters.has(clearedWriterKey(appId, client))) return "cleared";
    }
    const participant = this.participantOf(userId);
    const claims = this.planClaims(participant, appId, facts.writers);
    if (typeof claims === "string") return claims;
    if (!this.reserveUpdate(appId, update)) return "too-large";
    try {
      Y.applyUpdate(doc, update, origin);
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
    for (const client of clients) this.clearedWriters.add(clearedWriterKey(appId, client));
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
    this.presenceIdCounts.set(participant, (this.presenceIdCounts.get(participant) ?? 0) + 1);
  }

  private withinPresenceLimit(participant: string, ends: ReadonlyMap<number, boolean>): boolean {
    let held = this.presenceIdCounts.get(participant) ?? 0;
    for (const [client, shown] of ends) {
      if (this.clientIdOwners.has(client)) continue;
      const holding = this.presenceIds.has(client);
      if (shown && !holding) held += 1;
      if (!shown && holding) held -= 1;
    }
    return held <= MAX_PRESENCE_IDS_PER_PARTICIPANT;
  }

  private releasePresenceIds(clients: Iterable<number>): void {
    for (const client of clients) {
      const claim = this.presenceIds.get(client);
      if (!claim) continue;
      this.presenceIds.delete(client);
      const held = (this.presenceIdCounts.get(claim.participant) ?? 1) - 1;
      if (held > 0) this.presenceIdCounts.set(claim.participant, held);
      else this.presenceIdCounts.delete(claim.participant);
    }
  }

  private destroyDoc(appId: string, entry: AppDoc): void {
    try {
      entry.doc.destroy();
    } catch {}
    this.docs.delete(appId);
  }

  private removeAwareness(appId: string): AppAwarenessRemoval | null {
    const presence = this.presence.get(appId);
    if (!presence) return null;

    const clientIds = Array.from(presence.awareness.getStates().keys());
    let removal: AppAwarenessRemoval | null = null;
    if (clientIds.length > 0) {
      removeAwarenessStates(presence.awareness, clientIds, "app-close");
      removal = { appId, awarenessUpdate: encodeAwarenessUpdate(presence.awareness, clientIds) };
    }

    destroyPresence(presence.awareness);
    this.presence.delete(appId);
    this.releasePresenceIds(
      Array.from(this.presenceIds).filter(([, claim]) => claim.appId === appId).map(([client]) => client),
    );
    return removal;
  }

  private presenceFor(appId: string): Presence {
    const existing = this.presence.get(appId);
    if (existing) return existing;
    const presence: Presence = { awareness: createPresence(), holders: new Map(), removed: new Map() };
    presence.awareness.on("update", ({ removed }: { removed: number[] }, origin: unknown) => {
      if (origin !== presence) this.settlePresence(presence, removed);
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
      const holder = presence.holders.get(client);
      if (presence.awareness.states.has(client)) {
        if (!sender) continue;
        if (holder !== undefined) presence.removed.get(holder)?.delete(client);
        presence.holders.set(client, sender.userId);
        if (!this.clientIdOwners.has(client) && !this.presenceIds.has(client)) {
          this.holdPresenceId(client, sender.participant, sender.appId);
        }
        continue;
      }
      this.releasePresenceIds([client]);
      const keeper = holder ?? sender?.userId;
      if (keeper !== undefined) this.keepRemoved(presence, client, keeper);
    }
  }

  private keepRemoved(presence: Presence, client: number, holder: string): void {
    const removed = presence.removed.get(holder) ?? new Set<number>();
    presence.removed.set(holder, removed);
    presence.holders.set(client, holder);
    removed.delete(client);
    removed.add(client);
    for (const oldest of removed) {
      if (removed.size <= MAX_REMOVED_PRESENCE_IDS_PER_CONNECTION) return;
      removed.delete(oldest);
      presence.holders.delete(oldest);
      presence.awareness.meta.delete(oldest);
    }
  }

  private forgetConnection(presence: Presence, userId: string): void {
    for (const client of presence.removed.get(userId) ?? []) {
      presence.holders.delete(client);
      presence.awareness.meta.delete(client);
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
    if (!this.liveDoc(appId)) return null;
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
    if (applied.length === 0 || !this.withinPresenceLimit(participant, ends)) return null;

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
      const shown = Array.from(presence.holders)
        .filter(([client, holder]) => holder === userId && presence.awareness.states.has(client))
        .map(([client]) => client);
      if (shown.length > 0) {
        removeAwarenessStates(presence.awareness, shown, userId);
        removals.push({ appId, awarenessUpdate: encodeAwarenessUpdate(presence.awareness, shown) });
      }
      this.forgetConnection(presence, userId);
    }
    return removals;
  }

  /** Room teardown: destroys every document and all presence. */
  clear(): void {
    for (const presence of this.presence.values()) {
      destroyPresence(presence.awareness);
    }
    this.presence.clear();

    for (const [appId, entry] of Array.from(this.docs)) {
      this.destroyDoc(appId, entry);
    }
    this.clearedWriters.clear();
    this.clientIdOwners.clear();
    this.clientIdCounts.clear();
    this.presenceIds.clear();
    this.presenceIdCounts.clear();
    this.stage = { activeAppId: null, locked: false };
    this.revision += 1;
  }
}
