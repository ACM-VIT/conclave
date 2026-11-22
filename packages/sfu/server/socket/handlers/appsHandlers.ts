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
  AppsSyncResponse,
  AppsUpdateData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type { Refusal } from "../../apps/documents/pool.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_UPDATE_BYTES = 256 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;

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
  closed: { error: "App not active" },
  unavailable: { error: "App document unavailable" },
};

const UPDATE_REFUSALS: Partial<Record<Refusal, string>> = {
  "too-large": "document size limit reached",
  invalid: "invalid Yjs update",
  "timed-out": "update took longer than the deadline",
  crashed: "the document worker failed on it",
  "queue-full": "too many updates are waiting",
  unavailable: "the document could not be rebuilt",
};

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

  socket.on(
    "apps:yjs:sync",
    (data: AppsSyncData, callback: (response: AppsSyncResponse | AppsSyncError) => void) => {
      if (!context.currentRoom) {
        respond(callback, retryLater("Not in a room", 500));
        return;
      }
      if (!takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync)) {
        respond(callback, retryLater("Too many app sync requests", 500));
        return;
      }

      const appId = normalizeAppId(data?.appId);
      if (!appId) {
        respond(callback, { error: "Invalid app id" });
        return;
      }

      if (context.currentRoom.appsState.activeAppId !== appId) {
        respond(callback, { error: "App not active" });
        return;
      }

      const stateVector = toUint8Array(data.syncMessage);
      if (!stateVector) {
        respond(callback, { error: "Invalid sync payload" });
        return;
      }
      if (stateVector.length > MAX_APPS_SYNC_BYTES) {
        respond(callback, { error: "Sync payload too large" });
        return;
      }

      const room = context.currentRoom;
      void room.getOrCreateAppDoc(appId, documents).sync(stateVector).then((result) => {
        if (!result.ok) {
          respond(callback, SYNC_REFUSALS[result.reason]);
          return;
        }
        const awarenessSnapshot = room.encodeAppAwarenessSnapshot(appId) ?? undefined;
        const awarenessUpdate =
          awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES
            ? awarenessSnapshot
            : undefined;
        respond(callback, {
          syncMessage: result.update,
          stateVector: result.stateVector,
          awarenessUpdate,
        });
      });
    }
  );

  socket.on("apps:yjs:update", (data: AppsUpdateData) => {
    if (!context.currentRoom || !context.currentClient) return;
    if (context.currentClient.isObserver) return;
    if (!takeToken(socket, "apps:yjs:update", RATE_LIMITS.appsYjsUpdate)) return;

    const appId = normalizeAppId(data?.appId);
    if (!appId) return;
    if (context.currentRoom.appsState.activeAppId !== appId) return;

    if (
      context.currentRoom.appsState.locked &&
      (!(context.currentClient instanceof Admin) || context.currentClient.isObserver)
    ) {
      return;
    }

    const update = toUint8Array(data.update);
    if (!update || update.length === 0) return;
    if (update.length > MAX_APPS_UPDATE_BYTES) return;

    const { channelId } = context.currentRoom;
    void context.currentRoom
      .getOrCreateAppDoc(appId, documents)
      .apply(update)
      .then((result) => {
        if (!result.ok) {
          const why = UPDATE_REFUSALS[result.reason];
          if (why) Logger.warn(`[Apps] Dropping update for ${appId}: ${why}`);
          return;
        }
        socket.to(channelId).emit("apps:yjs:update", {
          appId,
          update,
        } satisfies AppsUpdateData);
      });
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
