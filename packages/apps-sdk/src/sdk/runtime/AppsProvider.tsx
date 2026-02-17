import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { getAppById, getRegisteredApps, subscribeRegistry } from "../registry/index";
import type {
  AppsAwarenessPayload,
  AppsCloseResponse,
  AppsContextValue,
  AppsLockPayload,
  AppsLockResponse,
  AppsOpenPayload,
  AppsOpenResponse,
  AppsState,
  AppsSyncPayload,
  AppsSyncResponse,
  AppsUpdatePayload,
  AssetUploadHandler,
  AppUser,
} from "../types/index";

export const AppsContext = createContext<AppsContextValue | null>(null);

export type AppsProviderProps = {
  socket: Socket | null;
  user?: AppUser;
  isAdmin?: boolean;
  uploadAsset?: AssetUploadHandler;
  children: React.ReactNode;
};

const ACK_TIMEOUT_MS = 8_000;

const createAwareness = (doc: Y.Doc) => new Awareness(doc);

type AwarenessUpdateEvent = {
  added: number[];
  updated: number[];
  removed: number[];
};

const isAppsState = (value: unknown): value is AppsState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { activeAppId?: unknown; locked?: unknown };
  const activeAppIdValid =
    typeof record.activeAppId === "string" || record.activeAppId === null;
  return activeAppIdValid && typeof record.locked === "boolean";
};

const decodeBase64 = (value: string): Uint8Array | null => {
  const maybeBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer;
  if (maybeBuffer) {
    try {
      return Uint8Array.from(maybeBuffer.from(value, "base64"));
    } catch {
      // continue to atob fallback
    }
  }

  if (typeof atob === "function") {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  }

  return null;
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (typeof value === "object" && "buffer" in (value as ArrayBufferView)) {
    const view = value as ArrayBufferView;
    if (view.buffer instanceof ArrayBuffer) {
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
  }

  if (Array.isArray(value)) {
    const allNumbers = value.every((item) => typeof item === "number");
    if (!allNumbers) return null;
    return Uint8Array.from(value as number[]);
  }

  if (typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      const allNumbers = maybeBuffer.data.every((item) => typeof item === "number");
      if (!allNumbers) return null;
      return Uint8Array.from(maybeBuffer.data);
    }
  }

  if (typeof value === "string") {
    const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
    if (value.length % 4 === 0 && base64Pattern.test(value)) {
      return decodeBase64(value);
    }
  }

  return null;
};

export function AppsProvider({
  socket,
  user,
  isAdmin,
  uploadAsset,
  children,
}: AppsProviderProps) {
  const [state, setState] = useState<AppsState>({ activeAppId: null, locked: false });
  const [registryVersion, setRegistryVersion] = useState(0);

  const docsRef = useRef<Map<string, Y.Doc>>(new Map());
  const awarenessRef = useRef<Map<string, Awareness>>(new Map());
  const pendingInitialUpdatesRef = useRef<Map<string, Uint8Array>>(new Map());
  const initialUpdateSentRef = useRef<Set<string>>(new Set());
  const docHandlersRef = useRef<Map<string, (update: Uint8Array, origin: unknown) => void>>(
    new Map()
  );
  const awarenessHandlersRef = useRef<
    Map<string, (event: AwarenessUpdateEvent, origin: unknown) => void>
  >(new Map());
  const socketRef = useRef<Socket | null>(null);

  const resetLocalData = useCallback(() => {
    for (const [appId, doc] of docsRef.current.entries()) {
      const handler = docHandlersRef.current.get(appId);
      if (handler) {
        doc.off("update", handler);
      }
      try {
        doc.destroy();
      } catch {
        // ignore
      }
    }

    for (const [appId, awareness] of awarenessRef.current.entries()) {
      const handler = awarenessHandlersRef.current.get(appId);
      if (handler) {
        awareness.off("update", handler as unknown as (...args: unknown[]) => void);
      }
      try {
        awareness.destroy();
      } catch {
        // ignore
      }
    }

    docsRef.current.clear();
    awarenessRef.current.clear();
    docHandlersRef.current.clear();
    awarenessHandlersRef.current.clear();
    pendingInitialUpdatesRef.current.clear();
    initialUpdateSentRef.current.clear();
    setState({ activeAppId: null, locked: false });
  }, []);

  useEffect(() => {
    if (socketRef.current !== socket) {
      resetLocalData();
    }
    socketRef.current = socket;
  }, [socket, resetLocalData]);

  useEffect(() => {
    return subscribeRegistry(() => {
      setRegistryVersion((version) => version + 1);
    });
  }, []);

  const registerDocHandlers = useCallback((appId: string, doc: Y.Doc) => {
    if (docHandlersRef.current.has(appId)) return;

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const currentSocket = socketRef.current;
      if (!currentSocket) return;
      const payload: AppsUpdatePayload = { appId, update };
      currentSocket.emit("apps:yjs:update", payload);
    };

    doc.on("update", handler);
    docHandlersRef.current.set(appId, handler);
  }, []);

  const queueInitialUpdate = useCallback((appId: string, doc: Y.Doc) => {
    if (initialUpdateSentRef.current.has(appId)) return;

    const update = Y.encodeStateAsUpdate(doc);
    if (update.length === 0) return;

    const currentSocket = socketRef.current;
    if (currentSocket && currentSocket.connected) {
      currentSocket.emit("apps:yjs:update", { appId, update });
      initialUpdateSentRef.current.add(appId);
      pendingInitialUpdatesRef.current.delete(appId);
      return;
    }

    pendingInitialUpdatesRef.current.set(appId, update);
  }, []);

  const registerAwarenessHandlers = useCallback((appId: string, awareness: Awareness) => {
    if (awarenessHandlersRef.current.has(appId)) return;

    const handler = ({ added, updated, removed }: AwarenessUpdateEvent, origin: unknown) => {
      if (origin === "remote") return;

      const currentSocket = socketRef.current;
      if (!currentSocket || !currentSocket.connected) return;

      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;

      const update = encodeAwarenessUpdate(awareness, changed);
      const payload: AppsAwarenessPayload = {
        appId,
        awarenessUpdate: update,
        clientId: awareness.clientID,
      };
      currentSocket.emit("apps:awareness", payload);
    };

    awareness.on("update", handler as unknown as (...args: unknown[]) => void);
    awarenessHandlersRef.current.set(appId, handler);
  }, []);

  const getDoc = useCallback(
    (appId: string): Y.Doc => {
      const existing = docsRef.current.get(appId);
      if (existing) return existing;

      const app = getAppById(appId);
      const doc = app?.createDoc ? app.createDoc() : new Y.Doc();
      docsRef.current.set(appId, doc);
      registerDocHandlers(appId, doc);
      queueInitialUpdate(appId, doc);
      return doc;
    },
    [registerDocHandlers, queueInitialUpdate]
  );

  const getAwareness = useCallback(
    (appId: string): Awareness => {
      const existing = awarenessRef.current.get(appId);
      if (existing) return existing;

      const doc = getDoc(appId);
      const awareness = createAwareness(doc);
      awarenessRef.current.set(appId, awareness);
      registerAwarenessHandlers(appId, awareness);
      return awareness;
    },
    [getDoc, registerAwarenessHandlers]
  );

  const refreshState = useCallback(() => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return;

    currentSocket.emit("apps:getState", (response?: unknown) => {
      if (isAppsState(response)) {
        setState(response);
      }
    });
  }, []);

  const syncApp = useCallback(
    (appId: string) => {
      const currentSocket = socketRef.current;
      if (!currentSocket || !currentSocket.connected) return;

      const doc = getDoc(appId);
      const awareness = getAwareness(appId);
      const syncMessage = Y.encodeStateVector(doc);
      const payload: AppsSyncPayload = { appId, syncMessage };

      currentSocket.emit("apps:yjs:sync", payload, (response?: AppsSyncResponse) => {
        if (!response?.syncMessage) return;

        const update = toUint8Array(response.syncMessage);
        if (!update || update.length === 0) return;

        try {
          Y.applyUpdate(doc, update, "remote");
        } catch (err) {
          console.warn("[Apps] Failed to apply sync update", err);
        }

        if (response.awarenessUpdate) {
          const awarenessUpdate = toUint8Array(response.awarenessUpdate);
          if (awarenessUpdate && awarenessUpdate.length > 0) {
            try {
              applyAwarenessUpdate(awareness, awarenessUpdate, "remote");
            } catch (err) {
              console.warn("[Apps] Failed to apply awareness update", err);
            }
          }
        }

        if (response.stateVector) {
          const serverVector = toUint8Array(response.stateVector);
          if (!serverVector) return;
          const updateForServer = Y.encodeStateAsUpdate(doc, serverVector);
          if (updateForServer.length > 0) {
            currentSocket.emit("apps:yjs:update", { appId, update: updateForServer });
          }
        }
      });
    },
    [getDoc, getAwareness]
  );

  useEffect(() => {
    if (!socket) return;

    const handleState = (next: unknown) => {
      if (!isAppsState(next)) return;
      setState(next);
    };

    const handleUpdate = (payload: AppsUpdatePayload) => {
      const doc = getDoc(payload.appId);
      const update = toUint8Array(payload.update);
      if (!update || update.length === 0) return;

      try {
        Y.applyUpdate(doc, update, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply update", err);
      }
    };

    const handleAwareness = (payload: AppsAwarenessPayload) => {
      const awareness = getAwareness(payload.appId);
      const awarenessUpdate = toUint8Array(payload.awarenessUpdate);
      if (!awarenessUpdate || awarenessUpdate.length === 0) return;

      try {
        applyAwarenessUpdate(awareness, awarenessUpdate, "remote");
      } catch (err) {
        console.warn("[Apps] Failed to apply awareness update", err);
      }
    };

    socket.on("apps:state", handleState);
    socket.on("apps:yjs:update", handleUpdate);
    socket.on("apps:awareness", handleAwareness);

    refreshState();

    return () => {
      socket.off("apps:state", handleState);
      socket.off("apps:yjs:update", handleUpdate);
      socket.off("apps:awareness", handleAwareness);
    };
  }, [socket, getDoc, getAwareness, refreshState]);

  useEffect(() => {
    if (!socket) return;

    const flushPending = () => {
      const pending = pendingInitialUpdatesRef.current;
      if (pending.size === 0) return;

      for (const [appId, update] of pending.entries()) {
        socket.emit("apps:yjs:update", { appId, update });
        initialUpdateSentRef.current.add(appId);
        pending.delete(appId);
      }
    };

    flushPending();
    socket.on("connect", flushPending);
    return () => {
      socket.off("connect", flushPending);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket || !state.activeAppId) return;
    syncApp(state.activeAppId);
  }, [socket, state.activeAppId, syncApp]);

  const openApp = useCallback(async (appId: string, options?: Record<string, unknown>) => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;
    if (!getAppById(appId)) {
      console.warn(`[Apps] Attempted to open unregistered app: ${appId}`);
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const payload: AppsOpenPayload = { appId, options };
      currentSocket.emit("apps:open", payload, (response?: AppsOpenResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, []);

  const closeApp = useCallback(async () => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      currentSocket.emit("apps:close", (response?: AppsCloseResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, []);

  const setLocked = useCallback(async (locked: boolean) => {
    const currentSocket = socketRef.current;
    if (!currentSocket) return false;

    return new Promise<boolean>((resolve) => {
      let completed = false;
      const timer = setTimeout(() => {
        if (completed) return;
        completed = true;
        resolve(false);
      }, ACK_TIMEOUT_MS);

      const payload: AppsLockPayload = { locked };
      currentSocket.emit("apps:lock", payload, (response?: AppsLockResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(Boolean(response?.success));
      });
    });
  }, []);

  const contextValue = useMemo<AppsContextValue>(
    () => ({
      state,
      apps: getRegisteredApps(),
      openApp,
      closeApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      user,
      isAdmin,
      uploadAsset,
    }),
    [
      state,
      registryVersion,
      openApp,
      closeApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      user,
      isAdmin,
      uploadAsset,
    ]
  );

  return <AppsContext.Provider value={contextValue}>{children}</AppsContext.Provider>;
}
