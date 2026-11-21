import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type {
  ConclaveApp,
  AppsAwarenessPayload,
  AppsClosePayload,
  AppsCloseResponse,
  AppsContextValue,
  AppsDiscardPayload,
  AppsDiscardResponse,
  AppsLockPayload,
  AppsLockResponse,
  AppsOpenPayload,
  AppsOpenResponse,
  AppsState,
  AppsSyncPayload,
  AppsSyncResponse,
  AppsUpdatePayload,
  AppUser,
} from "../types/index";

export const AppsContext = createContext<AppsContextValue | null>(null);

export type AppsProviderProps = {
  socket: Socket | null;
  apps: ConclaveApp[];
  user?: AppUser;
  participants?: AppUser[];
  isAdmin?: boolean;
  isReadOnly?: boolean;
  children: React.ReactNode;
};

const ACK_TIMEOUT_MS = 8_000;

const createAwareness = (doc: Y.Doc) => new Awareness(doc);

type AwarenessUpdateEvent = {
  added: number[];
  updated: number[];
  removed: number[];
};

const rosterSignature = (roster: AppUser[]): string =>
  roster
    .map((member) => `${member.id}\u0001${member.name ?? ""}\u0001${member.email ?? ""}`)
    .join("\u0000");

type StageCommandResponse =
  | AppsOpenResponse
  | AppsCloseResponse
  | AppsDiscardResponse
  | AppsLockResponse;

const EMPTY_APPS_STATE: AppsState = {
  activeAppId: null,
  locked: false,
  revision: null,
  savedAppIds: [],
};

const parseAppsState = (value: unknown): AppsState | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    activeAppId?: unknown;
    locked?: unknown;
    revision?: unknown;
    savedAppIds?: unknown;
  };
  const activeAppIdValid =
    typeof record.activeAppId === "string" || record.activeAppId === null;
  if (!activeAppIdValid || typeof record.locked !== "boolean") return null;
  return {
    activeAppId: record.activeAppId as string | null,
    locked: record.locked,
    revision:
      typeof record.revision === "number" && Number.isSafeInteger(record.revision)
        ? record.revision
        : null,
    savedAppIds: Array.isArray(record.savedAppIds)
      ? record.savedAppIds.filter((appId): appId is string => typeof appId === "string")
      : [],
  };
};

const decodeBase64 = (value: string): Uint8Array | null => {
  const maybeBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } }).Buffer;
  if (maybeBuffer) {
    try {
      return Uint8Array.from(maybeBuffer.from(value, "base64"));
    } catch {
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
    return Uint8Array.from(value);
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
  apps,
  user,
  participants,
  isAdmin,
  isReadOnly = false,
  children,
}: AppsProviderProps) {
  const [state, setState] = useState<AppsState>(EMPTY_APPS_STATE);
  const [roster, setRoster] = useState<AppUser[]>(() => participants ?? []);

  useEffect(() => {
    const next = participants ?? [];
    setRoster((previous) =>
      rosterSignature(previous) === rosterSignature(next) ? previous : next
    );
  }, [participants]);

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
  const isReadOnlyRef = useRef(isReadOnly);

  useEffect(() => {
    isReadOnlyRef.current = isReadOnly;
  }, [isReadOnly]);

  const serverStateRef = useRef<AppsState>(EMPTY_APPS_STATE);

  const resetLocalData = useCallback(() => {
    for (const [appId, doc] of docsRef.current.entries()) {
      const handler = docHandlersRef.current.get(appId);
      if (handler) {
        doc.off("update", handler);
      }
      try {
        doc.destroy();
      } catch {}
    }

    for (const [appId, awareness] of awarenessRef.current.entries()) {
      const handler = awarenessHandlersRef.current.get(appId);
      if (handler) {
        awareness.off("update", handler);
      }
      try {
        awareness.destroy();
      } catch {}
    }

    docsRef.current.clear();
    awarenessRef.current.clear();
    docHandlersRef.current.clear();
    awarenessHandlersRef.current.clear();
    pendingInitialUpdatesRef.current.clear();
    initialUpdateSentRef.current.clear();
    serverStateRef.current = EMPTY_APPS_STATE;
    setState(EMPTY_APPS_STATE);
  }, []);

  useEffect(() => {
    if (socketRef.current !== socket) {
      resetLocalData();
    }
    socketRef.current = socket;
  }, [socket, resetLocalData]);

  const discardLocalApp = useCallback((appId: string) => {
    const doc = docsRef.current.get(appId);
    if (doc) {
      const handler = docHandlersRef.current.get(appId);
      if (handler) doc.off("update", handler);
      try {
        doc.destroy();
      } catch {}
    }
    const awareness = awarenessRef.current.get(appId);
    if (awareness) {
      const handler = awarenessHandlersRef.current.get(appId);
      if (handler) awareness.off("update", handler);
      try {
        awareness.destroy();
      } catch {}
    }
    docsRef.current.delete(appId);
    awarenessRef.current.delete(appId);
    docHandlersRef.current.delete(appId);
    awarenessHandlersRef.current.delete(appId);
    pendingInitialUpdatesRef.current.delete(appId);
    initialUpdateSentRef.current.delete(appId);
  }, []);

  // Only the presented app is live. The local copy of an app that leaves the
  // stage is dropped, and presenting it again resyncs whatever the room kept,
  // so a document a host cleared never comes back from a client's memory.
  const applyServerAppsState = useCallback(
    (next: AppsState) => {
      const previous = serverStateRef.current.activeAppId;
      serverStateRef.current = next;
      if (previous && previous !== next.activeAppId) {
        discardLocalApp(previous);
      }
      setState(next);
    },
    [discardLocalApp],
  );

  const registerDocHandlers = useCallback((appId: string, doc: Y.Doc) => {
    if (docHandlersRef.current.has(appId)) return;

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      if (isReadOnlyRef.current) return;
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
    if (isReadOnlyRef.current) return;

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
      if (isReadOnlyRef.current) return;

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

    awareness.on("update", handler);
    awarenessHandlersRef.current.set(appId, handler);
  }, []);

  const getDoc = useCallback(
    (appId: string): Y.Doc => {
      const existing = docsRef.current.get(appId);
      if (existing) return existing;

      const app = apps.find((candidate) => candidate.id === appId);
      const doc = app?.createDoc ? app.createDoc() : new Y.Doc();
      docsRef.current.set(appId, doc);
      registerDocHandlers(appId, doc);
      queueInitialUpdate(appId, doc);
      return doc;
    },
    [apps, registerDocHandlers, queueInitialUpdate]
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
      const next = parseAppsState(response);
      if (next) {
        applyServerAppsState(next);
      }
    });
  }, [applyServerAppsState]);

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
          if (updateForServer.length > 0 && !isReadOnlyRef.current) {
            currentSocket.emit("apps:yjs:update", { appId, update: updateForServer });
          }
        }
      });
    },
    [getDoc, getAwareness]
  );

  useEffect(() => {
    if (!socket) return;

    const handleState = (payload: unknown) => {
      const next = parseAppsState(payload);
      if (next) applyServerAppsState(next);
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
  }, [socket, getDoc, getAwareness, refreshState, applyServerAppsState]);

  useEffect(() => {
    if (!socket) return;

    const flushPending = () => {
      if (isReadOnlyRef.current) return;
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

  const sendStageCommand = useCallback(
    (event: string, payload: object | null): Promise<boolean> => {
      const currentSocket = socketRef.current;
      if (!currentSocket || isReadOnlyRef.current) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        let completed = false;
        const timer = setTimeout(() => {
          if (completed) return;
          completed = true;
          resolve(false);
        }, ACK_TIMEOUT_MS);
        const ack = (response?: StageCommandResponse) => {
          if (completed) return;
          completed = true;
          clearTimeout(timer);
          resolve(Boolean(response?.success));
        };
        if (payload) {
          currentSocket.emit(event, payload, ack);
        } else {
          currentSocket.emit(event, ack);
        }
      });
    },
    [],
  );

  const presentApp = useCallback(
    (appId: string) => {
      if (!apps.some((app) => app.id === appId)) {
        console.warn(`[Apps] Attempted to present unregistered app: ${appId}`);
        return Promise.resolve(false);
      }
      const { revision } = serverStateRef.current;
      const payload: AppsOpenPayload =
        revision === null ? { appId } : { appId, expectedRevision: revision };
      return sendStageCommand("apps:open", payload);
    },
    [apps, sendStageCommand],
  );

  // An older SFU's apps:close takes only the ack.
  const closeApp = useCallback(() => {
    const { revision } = serverStateRef.current;
    const payload: AppsClosePayload | null =
      revision === null ? null : { expectedRevision: revision };
    return sendStageCommand("apps:close", payload);
  }, [sendStageCommand]);

  const clearApp = useCallback(
    (appId: string) => {
      const { revision } = serverStateRef.current;
      if (revision === null) return Promise.resolve(false);
      const payload: AppsDiscardPayload = { appId, expectedRevision: revision };
      return sendStageCommand("apps:discard", payload);
    },
    [sendStageCommand],
  );

  const setLocked = useCallback(
    (locked: boolean) => {
      const payload: AppsLockPayload = { locked };
      return sendStageCommand("apps:lock", payload);
    },
    [sendStageCommand],
  );

  const contextValue = useMemo<AppsContextValue>(
    () => ({
      state,
      apps,
      presentApp,
      closeApp,
      clearApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      user,
      participants: roster,
      isAdmin,
      isReadOnly,
    }),
    [
      state,
      apps,
      presentApp,
      closeApp,
      clearApp,
      setLocked,
      refreshState,
      getDoc,
      getAwareness,
      user,
      roster,
      isAdmin,
      isReadOnly,
    ]
  );

  return <AppsContext.Provider value={contextValue}>{children}</AppsContext.Provider>;
}
