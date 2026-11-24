import { APP_DOCUMENT_UPDATE_MAX_BYTES } from "@conclave/apps-sdk/limits";
import type {
  AppsAwarenessData,
  AppsCloseResponse,
  AppsLockData,
  AppsLockResponse,
  AppsOpenData,
  AppsOpenResponse,
  AppsState,
  AppsSyncData,
  AppsSyncError,
  AppsRefusedData,
  AppsSyncResponse,
  AppsUpdateData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type { Room } from "../../../config/classes/Room.js";
import { MAX_APP_DOCUMENT_BYTES, type AppDocument, type Refusal } from "../../apps/documents/pool.js";
import { readChangePart, STAGED_CHANGE_IDLE_MS } from "../../apps/documents/staging.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;
const MAX_REPLICA_ID_LENGTH = 64;
const REMEMBERED_REFUSED_REPLICAS = 16;
const LEGACY_SYNC_HOLD_MS = 25_000;
const MAX_OPEN_LEGACY_SYNCS = 4;
const WHOLE_CHANGES_SUFFIX = ":whole-changes";

const wholeChangesChannel = (channelId: string): string => `${channelId}${WHOLE_CHANGES_SUFFIX}`;

const retryLater = (error: string, retryAfterMs: number): AppsSyncError => ({
  error,
  retryable: true,
  retryAfterMs,
});

const SYNC_REFUSALS: Record<Refusal, AppsSyncError> = {
  "too-large": { error: "App document too large to sync" },
  invalid: { error: "Invalid sync payload" },
  "timed-out": retryLater("App document sync timed out", 250),
  crashed: retryLater("App document sync failed", 250),
  "queue-full": retryLater("App document is busy", 250),
  "missing-dependency": { error: "Invalid sync payload" },
  closed: { error: "App not active" },
  unavailable: { error: "App document unavailable" },
};

const UPDATE_REFUSALS: Partial<Record<Refusal, string>> = {
  "too-large": "document size limit reached",
  invalid: "invalid Yjs update",
  "timed-out": "update took longer than the deadline",
  crashed: "the document worker failed on it",
  "queue-full": "too many updates are waiting",
  "missing-dependency": "it builds on a change the document does not have",
  unavailable: "the document could not be rebuilt",
};

const normalizeReplicaId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REPLICA_ID_LENGTH ? value : undefined;

type SyncScope = { room: Room; appId: string; document: AppDocument };

const MAX_APP_ID_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const normalizeAppId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const appId = value.trim();
  if (
    !appId ||
    appId.length > MAX_APP_ID_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(appId)
  ) {
    return null;
  }
  return appId;
};

const emitAppAwarenessRemoval = (
  context: ConnectionContext,
  appId: string,
  awarenessUpdate: Uint8Array | null,
): void => {
  if (!awarenessUpdate) {
    return;
  }
  context.io.to(context.currentRoom!.channelId).emit("apps:awareness", {
    appId,
    awarenessUpdate,
  } satisfies AppsAwarenessData);
};

const decodeBase64 = (value: string): Uint8Array | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  try {
    return Uint8Array.from(Buffer.from(trimmed, "base64"));
  } catch {
    return null;
  }
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "number")) return null;
    return Uint8Array.from(value);
  }
  if (typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      if (!maybeBuffer.data.every((item) => typeof item === "number")) {
        return null;
      }
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  if (typeof value === "string") {
    return decodeBase64(value);
  }
  return null;
};

const getRoomAppsState = (context: ConnectionContext): AppsState => {
  if (!context.currentRoom) {
    return { activeAppId: null, locked: false };
  }
  return {
    activeAppId: context.currentRoom.appsState.activeAppId,
    locked: context.currentRoom.appsState.locked,
    roomId: context.currentRoom.id,
  };
};

export const registerAppsHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;
  const documents = context.state.appDocuments;

  socket.on("apps:getState", (callback: (state: AppsState) => void) => {
    respond(callback, getRoomAppsState(context));
  });

  socket.on(
    "apps:open",
    (data: AppsOpenData, callback: (response: AppsOpenResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }

      if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Only admins can open apps" });
        return;
      }

      const appId = normalizeAppId(data?.appId);
      if (!appId) {
        respond(callback, { success: false, error: "Invalid app id" });
        return;
      }

      const previousAppId = context.currentRoom.appsState.activeAppId;
      if (previousAppId && previousAppId !== appId) {
        emitAppAwarenessRemoval(
          context,
          previousAppId,
          context.currentRoom.clearAppState(previousAppId),
        );
      }

      context.currentRoom.appsState.activeAppId = appId;
      context.currentRoom.getOrCreateAppDoc(appId, documents);
      context.currentRoom.getOrCreateAppAwareness(appId);

      const state = getRoomAppsState(context);
      io.to(context.currentRoom.channelId).emit("apps:state", state);
      respond(callback, { success: true, activeAppId: state.activeAppId ?? undefined });
    }
  );

  socket.on("apps:close", (callback: (response: AppsCloseResponse) => void) => {
    if (!context.currentRoom || !context.currentClient) {
      respond(callback, { success: false, error: "Not in a room" });
      return;
    }

    if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
      respond(callback, { success: false, error: "Only admins can close apps" });
      return;
    }

    const activeAppId = context.currentRoom.appsState.activeAppId;
    if (activeAppId) {
      emitAppAwarenessRemoval(
        context,
        activeAppId,
        context.currentRoom.clearAppState(activeAppId),
      );
    }

    context.currentRoom.appsState.activeAppId = null;
    context.currentRoom.appsState.locked = false;
    const state = getRoomAppsState(context);
    io.to(context.currentRoom.channelId).emit("apps:state", state);
    respond(callback, { success: true });
  });

  socket.on(
    "apps:lock",
    (data: AppsLockData, callback: (response: AppsLockResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }

      if (!(context.currentClient instanceof Admin) || context.currentClient.isObserver) {
        respond(callback, { success: false, error: "Only admins can lock apps" });
        return;
      }

      if (typeof data?.locked !== "boolean") {
        respond(callback, { success: false, error: "Invalid app lock state" });
        return;
      }

      context.currentRoom.appsState.locked = data.locked;
      const state = getRoomAppsState(context);
      io.to(context.currentRoom.channelId).emit("apps:state", state);
      respond(callback, { success: true, locked: state.locked });
    }
  );

  const openLegacySyncs = new Set<() => void>();
  type StagedChange = {
    document: AppDocument;
    appId: string;
    replicaId: string | undefined;
    id: string;
    count: number;
    parts: Uint8Array[];
    bytes: number;
    idle?: ReturnType<typeof setTimeout>;
    unwatch: () => void;
  };
  let staged: StagedChange | null = null;
  const dropStaged = (): void => {
    if (!staged) return;
    clearTimeout(staged.idle);
    staged.unwatch();
    context.state.appChangeStaging.give(staged.bytes);
    staged = null;
  };
  socket.on("disconnect", () => {
    for (const stop of [...openLegacySyncs]) stop();
    dropStaged();
  });
  socket.on("joinRoom", () => {
    dropStaged();
    for (const joined of [...socket.rooms]) {
      if (joined.endsWith(WHOLE_CHANGES_SUFFIX)) void socket.leave(joined);
    }
  });

  const activeDocument = (room: Room, appId: string): AppDocument | null =>
    room.appsState.activeAppId === appId ? room.getOrCreateAppDoc(appId, documents) : null;

  const scopeOf = (data: AppsSyncData): SyncScope | AppsSyncError => {
    const room = context.currentRoom;
    if (!room) return retryLater("Not in a room", 500);
    const appId = normalizeAppId(data?.appId);
    if (!appId) return { error: "Invalid app id" };
    const document = activeDocument(room, appId);
    if (!document) return { error: "App not active" };
    return { room, appId, document };
  };

  const isCurrent = ({ room, appId, document }: SyncScope): boolean =>
    context.currentRoom === room && activeDocument(room, appId) === document;

  const paySync = (): boolean => takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync);
  const tooManySyncs = (): AppsSyncError => retryLater("Too many app sync requests", 500);

  const syncIn = async (scope: SyncScope, data: AppsSyncData): Promise<AppsSyncResponse | AppsSyncError> => {
    if (!isCurrent(scope)) return { error: "App not active" };
    const stateVector = toUint8Array(data.syncMessage);
    if (!stateVector) return { error: "Invalid sync payload" };
    if (stateVector.length > MAX_APPS_SYNC_BYTES) return { error: "Sync payload too large" };

    const result = await scope.document.sync(stateVector);
    if (!isCurrent(scope)) return { error: "App not active" };
    if (!result.ok) return SYNC_REFUSALS[result.reason];
    if (data.wholeChanges === true) void socket.join(wholeChangesChannel(scope.room.channelId));
    const awarenessSnapshot = scope.room.encodeAppAwarenessSnapshot(scope.appId) ?? undefined;
    return {
      syncMessage: result.update,
      stateVector: result.stateVector,
      stagesParts: true,
      awarenessUpdate:
        awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES ? awarenessSnapshot : undefined,
    };
  };

  const holdSync = (scope: SyncScope, data: AppsSyncData, callback: (response: AppsSyncResponse | AppsSyncError) => void): void => {
    if (openLegacySyncs.size >= MAX_OPEN_LEGACY_SYNCS) {
      respond(callback, { error: "Too many app sync requests" });
      return;
    }
    let lastError = "App document is busy";
    let paid = false;
    let settled = false;
    let retry: NodeJS.Timeout | undefined;
    const stop = (): void => {
      settled = true;
      clearTimeout(retry);
      clearTimeout(deadline);
      openLegacySyncs.delete(stop);
    };
    const settle = (outcome: AppsSyncResponse | AppsSyncError): void => {
      if (settled) return;
      stop();
      respond(callback, outcome);
    };
    const deadline = setTimeout(() => settle({ error: lastError }), LEGACY_SYNC_HOLD_MS);
    openLegacySyncs.add(stop);
    const attempt = (): void => {
      paid ||= paySync();
      void (paid ? syncIn(scope, data) : Promise.resolve(tooManySyncs())).then((outcome) => {
        if (settled) return;
        if (!("error" in outcome) || !outcome.retryable) {
          settle(outcome);
          return;
        }
        lastError = outcome.error;
        retry = setTimeout(attempt, outcome.retryAfterMs ?? 250);
      });
    };
    attempt();
  };

  socket.on(
    "apps:yjs:sync",
    (data: AppsSyncData, callback: (response: AppsSyncResponse | AppsSyncError) => void) => {
      const scope = scopeOf(data);
      const canRetry = data?.canRetry === true;
      if ("error" in scope) {
        respond(callback, canRetry ? scope : { error: scope.error });
        return;
      }
      if (!canRetry) {
        holdSync(scope, data, callback);
        return;
      }
      if (!paySync()) {
        respond(callback, tooManySyncs());
        return;
      }
      void syncIn(scope, data).then((outcome) => respond(callback, outcome));
    }
  );

  const joinParts = (parts: Uint8Array[]): Uint8Array => {
    const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.length;
    }
    return whole;
  };

  const refusedReplicas: string[] = [];
  const signalRefused = (appId: string, replicaId: string | undefined, reason: string): void => {
    if (!replicaId || refusedReplicas.includes(replicaId)) return;
    refusedReplicas.push(replicaId);
    if (refusedReplicas.length > REMEMBERED_REFUSED_REPLICAS) refusedReplicas.shift();
    socket.emit("apps:yjs:refused", { appId, replicaId, reason } satisfies AppsRefusedData);
  };

  const commit = (room: Room, appId: string, replicaId: string | undefined, update: Uint8Array, assembled: boolean): void => {
    const { channelId } = room;
    const document = room.getOrCreateAppDoc(appId, documents);
    void (assembled ? document.applyAssembled(update) : document.apply(update)).then((result) => {
      if (!result.ok) {
        const why = UPDATE_REFUSALS[result.reason];
        if (why) Logger.warn(`[Apps] Dropping update for ${appId}: ${why}`);
        if (result.reason !== "closed") signalRefused(appId, replicaId, result.reason);
        return;
      }
      if (update.length <= APP_DOCUMENT_UPDATE_MAX_BYTES) {
        socket.to(channelId).emit("apps:yjs:update", { appId, update } satisfies AppsUpdateData);
        return;
      }
      const whole = wholeChangesChannel(channelId);
      socket.to(whole).emit("apps:yjs:update", { appId, update } satisfies AppsUpdateData);
      const reload = socket.to(channelId).except(whole);
      const { activeAppId, locked } = room.appsState;
      reload.emit("apps:state", { activeAppId: null, locked, roomId: room.id } satisfies AppsState);
      reload.emit("apps:state", { activeAppId, locked, roomId: room.id } satisfies AppsState);
    });
  };

  socket.on("apps:yjs:update", (data: AppsUpdateData) => {
    const room = context.currentRoom;
    if (!room || !context.currentClient) return;
    if (context.currentClient.isObserver) return;

    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    if (room.appsState.activeAppId !== appId) return;
    const replicaId = normalizeReplicaId(data?.replicaId);
    const refuse = (reason: string): void => {
      dropStaged();
      signalRefused(appId, replicaId, reason);
    };

    if (!takeToken(socket, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) {
      refuse("rate-limited");
      return;
    }
    if (room.appsState.locked && (!(context.currentClient instanceof Admin) || context.currentClient.isObserver)) {
      refuse("locked");
      return;
    }

    const update = toUint8Array(data.update);
    if (!update || update.length === 0) {
      refuse("invalid");
      return;
    }
    if (update.length > APP_DOCUMENT_UPDATE_MAX_BYTES) {
      refuse("too-large");
      return;
    }

    const part = readChangePart(data?.part);
    if (part === "invalid") {
      refuse("interrupted");
      return;
    }
    if (!part) {
      dropStaged();
      commit(room, appId, replicaId, update, false);
      return;
    }
    const document = room.getOrCreateAppDoc(appId, documents);
    if (part.index === 0) {
      dropStaged();
      staged = { document, appId, replicaId, id: part.id, count: part.count, parts: [], bytes: 0, unwatch: document.onClose(dropStaged) };
    }
    const change = staged;
    if (
      !change ||
      change.document !== document ||
      change.appId !== appId ||
      change.id !== part.id ||
      change.count !== part.count ||
      change.parts.length !== part.index
    ) {
      refuse("interrupted");
      return;
    }
    if (change.bytes + update.length > MAX_APP_DOCUMENT_BYTES) {
      refuse("too-large");
      return;
    }
    if (!context.state.appChangeStaging.take(update.length)) {
      refuse("queue-full");
      return;
    }
    change.parts.push(update);
    change.bytes += update.length;
    clearTimeout(change.idle);
    if (change.parts.length < change.count) {
      change.idle = setTimeout(() => {
        if (staged !== change) return;
        dropStaged();
        signalRefused(change.appId, change.replicaId, "timed-out");
      }, STAGED_CHANGE_IDLE_MS);
      return;
    }
    dropStaged();
    commit(room, appId, replicaId, joinParts(change.parts), true);
  });

  socket.on("apps:awareness", (data: AppsAwarenessData) => {
    if (!context.currentRoom || !context.currentClient) return;
    if (context.currentClient.isObserver) return;
    // High-frequency event: drop (ignore) when over budget rather than process.
    if (!takeToken(socket, "apps:awareness", RATE_LIMITS.appsAwareness)) return;

    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    if (context.currentRoom.appsState.activeAppId !== appId) return;
    const awarenessUpdate = toUint8Array(data.awarenessUpdate);
    if (!awarenessUpdate || awarenessUpdate.length === 0) return;
    if (awarenessUpdate.length > MAX_APPS_AWARENESS_BYTES) return;
    const clientId =
      typeof data.clientId === "number" && Number.isFinite(data.clientId)
        ? data.clientId
        : undefined;

    try {
      context.currentRoom.applyAppAwarenessUpdate(
        appId,
        awarenessUpdate,
        context.currentClient.id,
        clientId,
      );
    } catch (error) {
      Logger.warn("[Apps] Dropping invalid awareness update", error);
      return;
    }

    socket.to(context.currentRoom.channelId).emit("apps:awareness", {
      appId,
      awarenessUpdate,
      clientId: data.clientId,
    } satisfies AppsAwarenessData);
  });
};
