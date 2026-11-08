import * as Y from "yjs";
import type {
  AppsAwarenessData,
  AppsCloseResponse,
  AppsLockData,
  AppsLockResponse,
  AppsOpenData,
  AppsOpenResponse,
  AppsState,
  AppsSyncData,
  AppsSyncResponse,
  AppsUpdateData,
} from "../../../types.js";
import { Admin } from "../../../config/classes/Admin.js";
import { Logger } from "../../../utilities/loggers.js";
import type { ConnectionContext } from "../context.js";
import { RATE_LIMITS, takeToken } from "../rateLimit.js";
import { respond } from "./ack.js";

const MAX_APPS_SYNC_BYTES = 64 * 1024;
const MAX_APPS_SYNC_RESPONSE_BYTES = 1024 * 1024;
const MAX_APPS_UPDATE_BYTES = 256 * 1024;
const MAX_APPS_AWARENESS_BYTES = 64 * 1024;
// A document larger than one sync response can no longer reach new joiners,
// so it is also the most a document may grow to.
const MAX_APPS_DOC_BYTES = MAX_APPS_SYNC_RESPONSE_BYTES;

// Encoded size of each document, measured lazily: the last exact measurement
// plus the bytes accepted since. Without a bound, a participant could stream
// 256 KB updates into a room's app until the SFU ran out of memory.
const appDocSizes = new WeakMap<Y.Doc, { measured: number; sinceMeasured: number }>();

/** Whether `update` fits in `doc`, re-measuring only near the limit. */
const reserveAppDocBytes = (doc: Y.Doc, updateBytes: number): boolean => {
  let size = appDocSizes.get(doc);
  if (!size) {
    size = { measured: Y.encodeStateAsUpdate(doc).length, sinceMeasured: 0 };
    appDocSizes.set(doc, size);
  }
  if (size.measured + size.sinceMeasured + updateBytes > MAX_APPS_DOC_BYTES) {
    // Deletions can shrink a document, so measure before refusing.
    if (size.sinceMeasured > 0) {
      size.measured = Y.encodeStateAsUpdate(doc).length;
      size.sinceMeasured = 0;
    }
    if (size.measured + updateBytes > MAX_APPS_DOC_BYTES) return false;
  }
  size.sinceMeasured += updateBytes;
  return true;
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
      context.currentRoom.getOrCreateAppDoc(appId);
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
    (data: AppsSyncData, callback: (response: AppsSyncResponse | { error: string }) => void) => {
      if (!context.currentRoom) {
        respond(callback, { error: "Not in a room" });
        return;
      }
      if (!takeToken(socket, "apps:yjs:sync", RATE_LIMITS.appsYjsSync)) {
        respond(callback, { error: "Too many app sync requests" });
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

      const doc = context.currentRoom.getOrCreateAppDoc(appId);
      const stateVector = toUint8Array(data.syncMessage);
      if (!stateVector) {
        respond(callback, { error: "Invalid sync payload" });
        return;
      }
      if (stateVector.length > MAX_APPS_SYNC_BYTES) {
        respond(callback, { error: "Sync payload too large" });
        return;
      }

      const update = Y.encodeStateAsUpdate(doc, stateVector);
      if (update.length > MAX_APPS_SYNC_RESPONSE_BYTES) {
        respond(callback, { error: "App document too large to sync" });
        return;
      }
      const awarenessSnapshot =
        context.currentRoom.encodeAppAwarenessSnapshot(appId) ?? undefined;
      const awarenessUpdate =
        awarenessSnapshot && awarenessSnapshot.length <= MAX_APPS_AWARENESS_BYTES
          ? awarenessSnapshot
          : undefined;
      respond(callback, {
        syncMessage: update,
        stateVector: Y.encodeStateVector(doc),
        awarenessUpdate,
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

    const doc = context.currentRoom.getOrCreateAppDoc(appId);
    const update = toUint8Array(data.update);
    if (!update || update.length === 0) return;
    if (update.length > MAX_APPS_UPDATE_BYTES) return;
    if (!reserveAppDocBytes(doc, update.length)) {
      Logger.warn(`[Apps] Dropping update for ${appId}: document size limit reached`);
      return;
    }

    try {
      Y.applyUpdate(doc, update, socket.id);
    } catch (error) {
      Logger.warn("[Apps] Dropping invalid Yjs update", error);
      return;
    }

    socket.to(context.currentRoom.channelId).emit("apps:yjs:update", {
      appId,
      update,
    } satisfies AppsUpdateData);
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
