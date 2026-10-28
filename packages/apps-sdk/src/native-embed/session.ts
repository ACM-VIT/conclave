// The embed's half of one app session (S60 13 f, S60R 25): it owns the Y.Doc and Awareness the renderer draws from,
// says `ready` with its state vector, applies the authoritative `snapshot` (then sends only what the room lacks), applies
// later room updates, and sends its own updates and coalesced awareness. After a reconnect native sends `resync`; the
// embed answers `sync` with its state vector and the same snapshot-then-diff rule runs again, so nothing reaches the
// room twice. Local edits made before the snapshot, while reconnecting or while read-only are not sent; the next diff
// carries whatever the room still lacks. A `close` (app closed or replaced) invalidates the session for good.

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { NativeTransport } from "./bridge";
import {
  HOST_COMMAND_TYPES,
  NATIVE_EMBED_BUNDLE_VERSION,
  NATIVE_EMBED_LIMITS,
  base64FromBytes,
  bytesFromBase64,
  decodeHostMessage,
  encodeEnvelope,
  type EmbedToNativeType,
  type Envelope,
  type NativeToEmbedType,
  type RejectionReason,
  type SessionScope,
  type WhiteboardTool,
} from "./protocol";

export type HostStatus = {
  readOnly: boolean;
  connection: "live" | "reconnecting";
  reduceMotion: boolean;
  pencilOnly: boolean;
  userId: string;
  userName: string;
};

export type EmbedStatusPayload = {
  tool: WhiteboardTool;
  color: string;
  strokeWidth: number;
  filled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  pageId: string;
  pageName: string;
  pages: { id: string; name: string }[];
  elementCount: number;
  editorCount: number;
};

/** Spin the Wheel page data (ACT-8, `status.app`; bounds in `WHEEL_LIMITS`). */
export type WheelAppStatus = {
  kind: "wheel";
  entries: { id: string; label: string }[];
  /** Newest first. */
  results: { id: string; label: string; byName: string }[];
  removeWinner: boolean;
  sounds: boolean;
  spinning: boolean;
  /** The last spin that settled live in this embed (never a replayed one), for the native "Winner: %@". */
  winnerSpinId: string;
  winnerLabel: string;
};

/** Watch Together page data (ACT-8, `status.app`; bounds in `WATCH_LIMITS`). */
export type WatchAppStatus = {
  kind: "watch";
  videoId: string;
  title: string;
  playback: "playing" | "paused" | "none";
  queue: { id: string; videoId: string; title: string; byName: string }[];
  requests: { id: string; videoId: string; title: string; byId: string; byName: string }[];
  myRequestId: string;
  requestDeclined: boolean;
};

/** A Wheel or Watch embed's status: only the page data (native keeps its Whiteboard defaults). */
export type AppStatusPayload = { app: WheelAppStatus | WatchAppStatus };

export type CommandResult = { ok: boolean; error?: string; pngBase64?: string };
export type CommandHandler = (envelope: Envelope<NativeToEmbedType>) => CommandResult;

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/** Until the host says otherwise the embed is read-only, so nothing is sent before native has scoped it. */
const INITIAL_HOST_STATUS: HostStatus = {
  readOnly: true,
  connection: "live",
  reduceMotion: false,
  pencilOnly: false,
  userId: "",
  userName: "",
};

const COMMAND_TYPES: ReadonlySet<string> = new Set<string>(HOST_COMMAND_TYPES);

const AWARENESS_INTERVAL_MS = 50;
const REMOTE = "remote";

export class NativeEmbedSession {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly scope: SessionScope;
  /** Rejected host messages by reason (never content), for the contract test and debugging. */
  readonly rejections: RejectionReason[] = [];

  private readonly transport: NativeTransport;
  private host: HostStatus = INITIAL_HOST_STATUS;
  private synced = false;
  private closed = false;
  private requestNumber = 0;
  private readonly seen: string[] = [];
  private readonly listeners = new Set<() => void>();
  private commandHandler: CommandHandler | null = null;
  private readonly pendingAwareness = new Set<number>();
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus = "";

  constructor(transport: NativeTransport, scope: SessionScope, doc: Y.Doc) {
    this.transport = transport;
    this.scope = scope;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
    transport.onMessage((raw) => this.receive(raw));
  }

  /** Announces the bundle and asks for the authoritative snapshot. */
  start(): void {
    this.send("ready", {
      bundleVersion: NATIVE_EMBED_BUNDLE_VERSION,
      appId: this.scope.appId,
      stateVector: base64FromBytes(Y.encodeStateVector(this.doc)),
    });
  }

  get hostStatus(): HostStatus {
    return this.host;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The renderer re-reads host status, sync and close through this. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setCommandHandler(handler: CommandHandler | null): void {
    this.commandHandler = handler;
  }

  /** The renderer's status (tool, ink, history, pages, presence, or a Wheel or Watch page's data); sent only on change. */
  sendStatus(status: EmbedStatusPayload | AppStatusPayload): void {
    if (this.closed) return;
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.send("status", status);
  }

  sendResize(width: number, height: number): void {
    if (this.closed) return;
    this.send("resize", { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) });
  }

  /** One host message; returns why it was dropped ("none" when handled). */
  receive(raw: unknown): RejectionReason {
    if (this.closed) return this.reject("staleAppSession");
    const decoded = decodeHostMessage(raw, this.scope);
    if (!decoded.ok) return this.reject(decoded.reason);
    const envelope = decoded.envelope;
    if (this.seen.includes(envelope.requestId)) return this.reject("duplicateRequest");
    this.seen.push(envelope.requestId);
    if (this.seen.length > NATIVE_EMBED_LIMITS.requestMemory) this.seen.shift();
    const payload = envelope.payload;
    switch (envelope.type) {
      case "snapshot":
        return this.applySnapshot(payload);
      case "update": {
        const update = bytesFromBase64(payload.update, NATIVE_EMBED_LIMITS.updateBytes);
        if (!update.ok) return this.reject(update.reason);
        if (update.bytes.length > 0) this.applyRemoteUpdate(update.bytes);
        return "none";
      }
      case "awareness": {
        const update = bytesFromBase64(payload.update, NATIVE_EMBED_LIMITS.awarenessBytes);
        if (!update.ok) return this.reject(update.reason);
        if (update.bytes.length > 0) {
          try {
            applyAwarenessUpdate(this.awareness, update.bytes, REMOTE);
          } catch {
            return this.reject("badPayload");
          }
        }
        return "none";
      }
      case "status":
        this.applyHostStatus(payload);
        return "none";
      case "resync":
        this.synced = false;
        this.send("sync", { stateVector: base64FromBytes(Y.encodeStateVector(this.doc)) });
        this.notify();
        return "none";
      case "close":
        this.close();
        return "none";
      default:
        if (!COMMAND_TYPES.has(envelope.type)) return this.reject("unknownType");
        this.runCommand(envelope);
        return "none";
    }
  }

  /** Stops sending for good (app closed or replaced). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.awarenessTimer !== null) clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
    this.pendingAwareness.clear();
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.notify();
  }

  private applySnapshot(payload: Record<string, unknown>): RejectionReason {
    const sync = bytesFromBase64(payload.syncMessage, NATIVE_EMBED_LIMITS.snapshotBytes);
    if (!sync.ok) return this.reject(sync.reason);
    const awareness = bytesFromBase64(payload.awarenessUpdate, NATIVE_EMBED_LIMITS.awarenessBytes);
    if (!awareness.ok) return this.reject(awareness.reason);
    const vector = bytesFromBase64(payload.stateVector, NATIVE_EMBED_LIMITS.snapshotBytes);
    if (!vector.ok) return this.reject(vector.reason);
    if (sync.bytes.length > 0) this.applyRemoteUpdate(sync.bytes);
    if (awareness.bytes.length > 0) {
      try {
        applyAwarenessUpdate(this.awareness, awareness.bytes, REMOTE);
      } catch {
        // A bad presence snapshot is not fatal; the next cursor move refreshes it.
      }
    }
    this.synced = true;
    if (vector.bytes.length > 0) this.sendMissing(vector.bytes);
    this.notify();
    return "none";
  }

  /** After a snapshot: only what the room lacks (Yjs encodes an empty diff as two bytes). */
  private sendMissing(serverVector: Uint8Array): void {
    if (this.host.readOnly || this.host.connection !== "live") return;
    let diff: Uint8Array;
    try {
      diff = Y.encodeStateAsUpdate(this.doc, serverVector);
    } catch {
      return;
    }
    if (diff.length <= 2 || diff.length > NATIVE_EMBED_LIMITS.updateBytes) return;
    this.send("update", { update: base64FromBytes(diff) });
  }

  private applyRemoteUpdate(bytes: Uint8Array): void {
    try {
      Y.applyUpdate(this.doc, bytes, REMOTE);
    } catch {
      this.rejections.push("badPayload");
    }
  }

  private applyHostStatus(payload: Record<string, unknown>): void {
    const wasReadOnly = this.host.readOnly;
    this.host = {
      readOnly: payload.readOnly === true,
      connection: payload.connection === "reconnecting" ? "reconnecting" : "live",
      reduceMotion: payload.reduceMotion === true,
      pencilOnly: payload.pencilOnly === true,
      userId: typeof payload.userId === "string" ? payload.userId.slice(0, 128) : "",
      userName: typeof payload.userName === "string" ? payload.userName.slice(0, 128) : "",
    };
    // Unlocked after a snapshot: send what was drawn meanwhile only through the next resync diff, never here.
    if (wasReadOnly !== this.host.readOnly) this.lastStatus = "";
    this.notify();
  }

  private runCommand(envelope: Envelope<NativeToEmbedType>): void {
    const handler = this.commandHandler;
    let result: CommandResult = { ok: false, error: "notReady" };
    if (handler) {
      try {
        result = handler(envelope);
      } catch {
        result = { ok: false, error: "failed" };
      }
    }
    const payload: Record<string, unknown> = { ok: result.ok };
    if (result.error) payload.error = result.error.slice(0, 64);
    if (result.pngBase64) payload.pngBase64 = result.pngBase64;
    this.send("ack", payload, envelope.requestId);
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE || this.closed || !this.synced) return;
    if (this.host.readOnly || this.host.connection !== "live") return;
    if (update.length > NATIVE_EMBED_LIMITS.updateBytes) return;
    this.send("update", { update: base64FromBytes(update) });
  };

  private readonly handleAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    if (origin === REMOTE || this.closed) return;
    for (const id of change.added) this.pendingAwareness.add(id);
    for (const id of change.updated) this.pendingAwareness.add(id);
    for (const id of change.removed) this.pendingAwareness.add(id);
    if (this.awarenessTimer === null) this.awarenessTimer = setTimeout(this.flushAwareness, AWARENESS_INTERVAL_MS);
  };

  private readonly flushAwareness = (): void => {
    this.awarenessTimer = null;
    const changed = [...this.pendingAwareness];
    this.pendingAwareness.clear();
    if (changed.length === 0 || this.closed || !this.synced || this.host.connection !== "live") return;
    const update = encodeAwarenessUpdate(this.awareness, changed);
    if (update.length === 0 || update.length > NATIVE_EMBED_LIMITS.awarenessBytes) return;
    this.send("awareness", { update: base64FromBytes(update), clientId: this.awareness.clientID });
  };

  private send(type: EmbedToNativeType, payload: Record<string, unknown>, requestId?: string): void {
    this.requestNumber += 1;
    const id = requestId ?? `e-${this.requestNumber}`;
    const message = encodeEnvelope(type, this.scope, id, payload);
    if (message.length > NATIVE_EMBED_LIMITS.envelopeCharacters) return;
    this.transport.post(message);
  }

  private reject(reason: RejectionReason): RejectionReason {
    this.rejections.push(reason);
    if (this.rejections.length > 32) this.rejections.shift();
    return reason;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Narrowing helper for command payloads. */
export const payloadString = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  return typeof value === "string" ? value : "";
};

export const payloadNumber = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const payloadBoolean = (payload: Record<string, unknown>, key: string): boolean | null => {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
};
