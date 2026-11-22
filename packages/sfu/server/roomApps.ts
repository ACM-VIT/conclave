import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

// A document larger than one sync response can no longer reach new joiners,
// so it is also the most a document may grow to.
export const MAX_APP_DOC_BYTES = 1024 * 1024;
// A room keeps every app's document when the stage moves to another app, so
// documents are also bounded per room: by count, and by total encoded bytes.
export const MAX_ROOM_APP_DOCS = 8;
export const MAX_ROOM_APP_DOC_BYTES = 4 * 1024 * 1024;

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

export type AppsSnapshot = {
  activeAppId: string | null;
  locked: boolean;
  revision: number;
  savedAppIds: string[];
};

export type StageCommandResult =
  | { ok: true; changed: boolean; awarenessRemoval: AppAwarenessRemoval | null }
  | { ok: false; reason: "stale" | "full" };

type AppDoc = {
  doc: Y.Doc;
  // Encoded bytes when last measured, plus a conservative estimate of what
  // accepted updates added since.
  measuredBytes: number;
  unmeasuredBytes: number;
};

const getAwarenessStateUserId = (state: unknown): string | null => {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const record = state as { user?: unknown };
  if (
    !record.user ||
    typeof record.user !== "object" ||
    Array.isArray(record.user)
  ) {
    return null;
  }
  const user = record.user as { id?: unknown };
  return typeof user.id === "string" ? user.id : null;
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
  private docs: Map<string, AppDoc> = new Map();
  private awareness: Map<string, Awareness> = new Map();
  private awarenessClientIdsByUser: Map<string, Map<string, Set<number>>> =
    new Map();

  get activeAppId(): string | null {
    return this.stage.activeAppId;
  }

  get locked(): boolean {
    return this.stage.locked;
  }

  snapshot(): AppsSnapshot {
    return {
      activeAppId: this.stage.activeAppId,
      locked: this.stage.locked,
      revision: this.revision,
      savedAppIds: Array.from(this.docs.keys())
        .filter((appId) => appId !== this.stage.activeAppId)
        .sort(),
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
      this.docs.set(appId, {
        doc: new Y.Doc(),
        measuredBytes: EMPTY_DOC_BYTES,
        unmeasuredBytes: 0,
      });
    }
    this.stage = { activeAppId: appId, locked: false };
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

  /** Applies presence for the presented app. Returns false for any other app. */
  applyAwarenessUpdate(
    appId: string,
    awarenessUpdate: Uint8Array,
    userId?: string,
    clientId?: number,
  ): boolean {
    const doc = this.liveDoc(appId);
    if (!doc) return false;
    let awareness = this.awareness.get(appId);
    if (!awareness) {
      awareness = createPresence();
      this.awareness.set(appId, awareness);
    }
    applyAwarenessUpdate(awareness, awarenessUpdate, userId ?? "socket");
    if (!userId || typeof clientId !== "number" || !Number.isFinite(clientId)) {
      return true;
    }
    if (awareness.getStates().has(clientId)) {
      this.trackAwarenessClientForUser(appId, userId, clientId);
    } else {
      this.untrackAwarenessClientForUser(appId, userId, clientId);
    }
    return true;
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

      const clientIds = new Set<number>(trackedClientIds ?? []);
      if (clientIds.size === 0) {
        for (const [clientId, state] of awareness.getStates().entries()) {
          if (getAwarenessStateUserId(state) === userId) {
            clientIds.add(clientId);
          }
        }
      }

      const removableClientIds = Array.from(clientIds).filter((id) =>
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
    this.stage = { activeAppId: null, locked: false };
    this.revision += 1;
  }
}
