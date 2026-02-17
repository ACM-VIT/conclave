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
import { respond } from "./ack.js";

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
  };
};

export const registerAppsHandlers = (context: ConnectionContext): void => {
  const { socket, io } = context;

  socket.on("apps:getState", (callback: (state: AppsState) => void) => {
    callback(getRoomAppsState(context));
  });

  socket.on(
    "apps:open",
    (data: AppsOpenData, callback: (response: AppsOpenResponse) => void) => {
      if (!context.currentRoom || !context.currentClient) {
        respond(callback, { success: false, error: "Not in a room" });
        return;
      }

      if (!(context.currentClient instanceof Admin)) {
        respond(callback, { success: false, error: "Only admins can open apps" });
        return;
      }

      const appId = data?.appId?.trim();
      if (!appId) {
        respond(callback, { success: false, error: "Missing app id" });
        return;
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

    if (!(context.currentClient instanceof Admin)) {
      respond(callback, { success: false, error: "Only admins can close apps" });
      return;
    }

    const activeAppId = context.currentRoom.appsState.activeAppId;
    if (activeAppId) {
      const awarenessUpdate = context.currentRoom.clearAppAwareness(activeAppId);
      if (awarenessUpdate) {
        io.to(context.currentRoom.channelId).emit("apps:awareness", {
          appId: activeAppId,
          awarenessUpdate,
        } satisfies AppsAwarenessData);
      }
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

      if (!(context.currentClient instanceof Admin)) {
        respond(callback, { success: false, error: "Only admins can lock apps" });
        return;
      }

      context.currentRoom.appsState.locked = Boolean(data?.locked);
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

      const appId = data?.appId?.trim();
      if (!appId) {
        respond(callback, { error: "Missing app id" });
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

      const update = Y.encodeStateAsUpdate(doc, stateVector);
      const awarenessUpdate =
        context.currentRoom.encodeAppAwarenessSnapshot(appId) ?? undefined;
      respond(callback, {
        syncMessage: update,
        stateVector: Y.encodeStateVector(doc),
        awarenessUpdate,
      });
    }
  );

  socket.on("apps:yjs:update", (data: AppsUpdateData) => {
    if (!context.currentRoom || !context.currentClient) return;

    const appId = data?.appId?.trim();
    if (!appId) return;
    if (context.currentRoom.appsState.activeAppId !== appId) return;

    if (context.currentRoom.appsState.locked && !(context.currentClient instanceof Admin)) {
      return;
    }

    const doc = context.currentRoom.getOrCreateAppDoc(appId);
    const update = toUint8Array(data.update);
    if (!update || update.length === 0) return;

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

    const appId = data?.appId?.trim();
    if (!appId) return;
    if (context.currentRoom.appsState.activeAppId !== appId) return;
    const awarenessUpdate = toUint8Array(data.awarenessUpdate);
    if (!awarenessUpdate || awarenessUpdate.length === 0) return;
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
